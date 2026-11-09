// Two real Postgres connections. PGlite is one backend, so it cannot run this race.
// The sibling script contract-v02.mjs records the pre-commit lock mode on PGlite.
// Run against a scratch server:
//   docker run -d --rm --name pashadhara-adv -e POSTGRES_HOST_AUTH_METHOD=trust -p 15432:5432 postgres:15
//   DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres node adversarial/contract-concurrency.mjs
// The database must be empty. The script loads schema.sql. Port 54329 is inside Windows' excluded range.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const pgMod = await import(process.env.PG_MODULE ? pathToFileURL(process.env.PG_MODULE).href : "pg");
const pg = pgMod.default ?? pgMod;

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("MISSED\tno DATABASE_URL");
  process.exit(1);
}
const { Client } = pg;
const schema = readFileSync(new URL("../packages/contract/schema.sql", import.meta.url), "utf8");
const admin = new Client({ connectionString: url });
await admin.connect();
await admin.query(schema);
const uuid = () => crypto.randomUUID();
const errText = (e) => `${e.code ?? ""} ${String(e.message ?? e).replace(/\s+/g, " ").slice(0, 180)}`;

async function fund(cap = 1000) {
  const seller = (await admin.query("insert into sellers (name, paypal_email) values ('s','s@x.com') returning id")).rows[0].id;
  const lease = (await admin.query(
    "insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',$1,$1) returning id",
    [cap],
  )).rows[0].id;
  const auth = (await admin.query(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
     values ($1,$2,$3,'created', now() + interval '3 days', now() + interval '29 days') returning id`,
    [lease, "AUTH-" + uuid(), cap],
  )).rows[0].id;
  const g = uuid();
  await admin.query(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'HOLD_AVAILABLE','D',$3,'authorize',$4),
     ($1,$2,'BUYER_COMMITMENT','C',$3,'authorize',$4)`,
    [g, lease, cap, "auth-" + uuid()],
  );
  await admin.query("update leases set state='active' where id=$1", [lease]);
  return { seller, lease, auth };
}

function client() {
  const c = new Client({ connectionString: url });
  return c;
}

async function pair(isolation) {
  const a = client();
  const b = client();
  await a.connect();
  await b.connect();
  for (const c of [a, b]) {
    await c.query("set statement_timeout = '8s'");
    await c.query("set deadlock_timeout = '200ms'");
    await c.query(`begin isolation level ${isolation}`);
  }
  return {
    a, b,
    async end() {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    },
  };
}

// Inserts both block on the lease row lock. Commit the first finisher so the waiter can run.
async function lockedRace(isolation, aSql, bSql) {
  const { a, b, end } = await pair(isolation);
  try {
    const ia = a.query(aSql.text, aSql.params).then(() => "a", (e) => ({ who: "a", err: errText(e) }));
    const ib = b.query(bSql.text, bSql.params).then(() => "b", (e) => ({ who: "b", err: errText(e) }));
    const first = await Promise.race([ia, ib]);
    if (typeof first !== "string") return [first.err, "peer-not-run"];
    const winner = first === "a" ? a : b;
    const loserInsert = first === "a" ? ib : ia;
    let winnerCommit = "commit";
    try { await winner.query("commit"); } catch (e) { winnerCommit = errText(e); }
    const second = await loserInsert;
    const loser = first === "a" ? b : a;
    let loserEnd = typeof second === "string" ? "insert-ok" : second.err;
    if (typeof second === "string") {
      try { await loser.query("commit"); loserEnd = "commit"; } catch (e) { loserEnd = errText(e); }
    }
    return [`${first}:${winnerCommit}`, `${first === "a" ? "b" : "a"}:${loserEnd}`];
  } finally {
    await end();
  }
}

// Both inserts should finish (key-share locks do not conflict). The clash is at COMMIT.
async function commitRace(isolation, aSql, bSql) {
  const { a, b, end } = await pair(isolation);
  try {
    const inserted = await Promise.allSettled([
      a.query(aSql.text, aSql.params),
      b.query(bSql.text, bSql.params),
    ]);
    const ins = inserted.map((s) => s.status === "fulfilled" ? "insert" : errText(s.reason));
    const settled = await Promise.allSettled([a.query("commit"), b.query("commit")]);
    const com = settled.map((s) => s.status === "fulfilled" ? "commit" : errText(s.reason));
    return [`a:${ins[0]}/${com[0]}`, `b:${ins[1]}/${com[1]}`];
  } finally {
    await end();
  }
}

const capLease = await fund(1000);
const captureSql = (lease, auth, amt) => ({
  text: "insert into captures (lease_id, authorization_id, amount_minor, status) values ($1,$2,$3,'completed')",
  params: [lease, auth, amt],
});

{
  const r = await lockedRace(
    "read committed",
    captureSql(capLease.lease, capLease.auth, 600),
    captureSql(capLease.lease, capLease.auth, 600),
  );
  const sum = (await admin.query(
    "select coalesce(sum(amount_minor),0)::text as s from captures where lease_id=$1",
    [capLease.lease],
  )).rows[0].s;
  console.log(`RACE\tread-committed capture 600+600\t${r.join(" || ")}\tsum=${sum}`);
}

const rr = await fund(1000);
{
  const r = await lockedRace(
    "repeatable read",
    captureSql(rr.lease, rr.auth, 600),
    captureSql(rr.lease, rr.auth, 600),
  );
  const sum = (await admin.query(
    "select coalesce(sum(amount_minor),0)::text as s from captures where lease_id=$1",
    [rr.lease],
  )).rows[0].s;
  console.log(`RACE\trepeatable-read capture 600+600\t${r.join(" || ")}\tsum=${sum}`);
}

const ser = await fund(1000);
{
  const r = await lockedRace(
    "serializable",
    captureSql(ser.lease, ser.auth, 600),
    captureSql(ser.lease, ser.auth, 600),
  );
  const sum = (await admin.query(
    "select coalesce(sum(amount_minor),0)::text as s from captures where lease_id=$1",
    [ser.lease],
  )).rows[0].s;
  console.log(`RACE\tserializable capture 600+600\t${r.join(" || ")}\tsum=${sum}`);
}

function ledgerCommit(lease, amt, ref) {
  const g = uuid();
  return {
    text: `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
      ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4),
      ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
    params: [g, lease, amt, ref],
  };
}

const led = await fund(1000);
{
  const r = await commitRace(
    "read committed",
    ledgerCommit(led.lease, 800, "a-" + uuid()),
    ledgerCommit(led.lease, 800, "b-" + uuid()),
  );
  const bal = (await admin.query(
    `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as s
       from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'`,
    [led.lease],
  )).rows[0].s;
  console.log(`RACE\tread-committed ledger 800+800 on hold 1000\t${r.join(" || ")}\tcommitted=${bal}`);
}

const ledRr = await fund(1000);
{
  const r = await commitRace(
    "repeatable read",
    ledgerCommit(ledRr.lease, 800, "a-" + uuid()),
    ledgerCommit(ledRr.lease, 800, "b-" + uuid()),
  );
  const bal = (await admin.query(
    `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as s
       from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'`,
    [ledRr.lease],
  )).rows[0].s;
  console.log(`RACE\trepeatable-read ledger 800+800 on hold 1000\t${r.join(" || ")}\tcommitted=${bal}`);
}

await admin.end();
console.log("DONE");
