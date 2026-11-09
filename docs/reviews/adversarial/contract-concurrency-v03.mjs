// Two connections on Postgres 15. Port of contract-concurrency.mjs for contract v0.3.
// Also: mixed isolation, exposure and payout races, and lock_lease removed (owner replace, then app search_path).
//   docker run -d --rm --name pashadhara-adv -e POSTGRES_HOST_AUTH_METHOD=trust -p 15432:5432 postgres:15
//   DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres node adversarial/contract-concurrency-v03.mjs
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
const roles = readFileSync(new URL("../packages/contract/roles.sql", import.meta.url), "utf8");
const uuid = () => crypto.randomUUID();
const errText = (e) => `${e.code ?? ""} ${String(e.message ?? e).replace(/\s+/g, " ").slice(0, 170)}`;

const REAL_LOCK = `
create or replace function lock_lease(p_lease uuid) returns lease_state language plpgsql as $$
declare st lease_state;
begin
  update leases set state = state where id = p_lease returning state into st;
  if st is null then
    raise exception 'Unknown lease %', p_lease using errcode = 'foreign_key_violation';
  end if;
  return st;
end $$;`;
const NOOP_LOCK = `
create or replace function lock_lease(p_lease uuid) returns lease_state language plpgsql as $$
declare st lease_state;
begin
  select state into st from leases where id = p_lease;
  if st is null then
    raise exception 'Unknown lease %', p_lease using errcode = 'foreign_key_violation';
  end if;
  return st;
end $$;`;

const admin = new Client({ connectionString: url });
await admin.connect();
await admin.query("drop schema public cascade; create schema public;");
await admin.query("grant all on schema public to postgres;");
await admin.query(schema);
await admin.query(roles);
console.log(`RUNTIME\tPostgres ${(await admin.query("show server_version")).rows[0].server_version}`);

async function fund(cap = 1000, limit = null) {
  const seller = (await admin.query(
    "insert into sellers (name, paypal_email, payout_hold_seconds) values ('s','s@x.com',30) returning id",
  )).rows[0].id;
  const lease = (await admin.query(
    "insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',$1,$2) returning id",
    [cap, limit ?? cap],
  )).rows[0].id;
  const auth = (await admin.query(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
     values ($1,$2,$3,'created', now() + interval '3 days', now() + interval '29 days') returning id`,
    [lease, "AUTH-" + uuid(), cap],
  )).rows[0].id;
  const g = uuid();
  await admin.query(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'HOLD_AVAILABLE','D',$3,'authorize',$4), ($1,$2,'BUYER_COMMITMENT','C',$3,'authorize',$4)`,
    [g, lease, cap, "auth-" + uuid()],
  );
  await admin.query("update leases set state='active' where id=$1", [lease]);
  return { seller, lease, auth };
}
async function commitUsage(lease, amt) {
  const g = uuid();
  await admin.query(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
    [g, lease, amt, "u-" + uuid()],
  );
}
function captureIntent(lease, auth, amt) {
  return async (c) => {
    const call = uuid();
    await c.query(
      "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')",
      [call, lease, uuid(), amt],
    );
    await c.query(
      "insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,'intent')",
      [lease, auth, call, amt],
    );
  };
}
function captureComplete(lease, auth, amt, tag) {
  return async (c) => {
    const call = uuid();
    const cap = uuid();
    await c.query(
      "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')",
      [call, lease, uuid(), amt],
    );
    await c.query(
      "insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,$5,'intent')",
      [cap, lease, auth, call, amt],
    );
    await c.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [call]);
    await c.query("update paypal_calls set state='succeeded', http_status=201, response='{}'::jsonb where id=$1", [call]);
    await c.query(
      "update captures set status='completed', fee_minor=0, paypal_capture_id=$2 where id=$1",
      [cap, tag + "-" + cap.slice(0, 8)],
    );
    const g = uuid();
    await c.query(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,'CAPTURED_GROSS','D',$3,'capture',$4), ($1,$2,'COMMITTED_UNSETTLED','C',$3,'capture',$4)`,
      [g, lease, amt, cap],
    );
  };
}
function ledger(lease, amt) {
  return async (c) => {
    const g = uuid();
    await c.query(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
      [g, lease, amt, "c-" + uuid()],
    );
  };
}

async function race(isoA, isoB, bodyA, bodyB) {
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect();
  await b.connect();
  try {
    await a.query(`begin isolation level ${isoA}`);
    await b.query(`begin isolation level ${isoB}`);
    for (const c of [a, b]) {
      await c.query("set local statement_timeout = '8s'");
      await c.query("set local deadlock_timeout = '250ms'");
    }
    const ia = bodyA(a).then(() => "a", (e) => ({ who: "a", err: errText(e) }));
    const ib = bodyB(b).then(() => "b", (e) => ({ who: "b", err: errText(e) }));
    const first = await Promise.race([ia, ib]);
    if (typeof first !== "string") {
      const other = await (first.who === "a" ? ib : ia);
      return [`${first.who}:${first.err}`, `${typeof other === "string" ? other : other.who}:${typeof other === "string" ? "wrote-uncommitted" : other.err}`];
    }
    const winner = first === "a" ? a : b;
    const loserP = first === "a" ? ib : ia;
    const loser = first === "a" ? b : a;
    let win = "commit";
    try { await winner.query("commit"); } catch (e) { win = errText(e); }
    const second = await loserP;
    let lose = typeof second === "string" ? "wrote" : second.err;
    if (typeof second === "string") {
      try { await loser.query("commit"); lose = "commit"; } catch (e) { lose = errText(e); }
    }
    return [`${first}:${win}`, `${first === "a" ? "b" : "a"}:${lose}`];
  } finally {
    await a.query("rollback").catch(() => {});
    await b.query("rollback").catch(() => {});
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
}
async function sums(lease) {
  const caps = (await admin.query(
    `select count(*)::int as n, coalesce(sum(amount_minor),0)::text as s,
            coalesce(sum(amount_minor) filter (where status in ('intent','pending','completed','unknown','reversed')),0)::text as counted
       from captures where lease_id=$1`,
    [lease],
  )).rows[0];
  const comm = (await admin.query(
    `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as s
       from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'`,
    [lease],
  )).rows[0].s;
  const pay = (await admin.query(
    "select count(*)::int as n, coalesce(sum(amount_minor) filter (where state <> 'failed'),0)::text as s from payouts where lease_id=$1",
    [lease],
  )).rows[0];
  return `captures=${caps.n} sum=${caps.s} counted=${caps.counted} committed=${comm} payouts=${pay.n}/${pay.s}`;
}
async function report(name, isoA, isoB, lease, bodyA, bodyB) {
  const r = await race(isoA, isoB, bodyA, bodyB);
  console.log(`RACE\t${name}\t${r.join(" || ")}\t${await sums(lease)}`);
}

{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("V02 read-committed intent 600+600", "read committed", "read committed", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("V02 repeatable-read intent 600+600", "repeatable read", "repeatable read", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("mixed RC then RR intent 600+600", "read committed", "repeatable read", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("V02 repeatable-read completed 600+600", "repeatable read", "repeatable read", L.lease, captureComplete(L.lease, L.auth, 600, "A"), captureComplete(L.lease, L.auth, 600, "B"));
}
{
  const L = await fund();
  await report("V02 read-committed ledger 800+800", "read committed", "read committed", L.lease, ledger(L.lease, 800), ledger(L.lease, 800));
}
{
  const L = await fund();
  await report("V02 repeatable-read ledger 800+800", "repeatable read", "repeatable read", L.lease, ledger(L.lease, 800), ledger(L.lease, 800));
}
{
  const L = await fund(1000, 500);
  await report("exposure 400+400 on limit 500", "read committed", "read committed", L.lease, ledger(L.lease, 400), ledger(L.lease, 400));
}
{
  const L = await fund(1000, 500);
  await report("repeatable-read exposure 400+400 on limit 500", "repeatable read", "repeatable read", L.lease, ledger(L.lease, 400), ledger(L.lease, 400));
}

// Accrual and payout races. Net captured is 200. Two sessions each try to take all of it.
{
  const L = await fund();
  await commitUsage(L.lease, 200);
  const cap = uuid();
  const call = uuid();
  const g = uuid();
  await admin.query("begin");
  await admin.query("insert into paypal_calls (id, lease_id, op, request_id, state) values ($1,$2,'capture',$3,'intent')", [call, L.lease, uuid()]);
  await admin.query("insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,200,'intent')", [cap, L.lease, L.auth, call]);
  await admin.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [call]);
  await admin.query("update paypal_calls set state='succeeded', http_status=201, response='{}'::jsonb where id=$1", [call]);
  await admin.query("update captures set status='completed', fee_minor=0, paypal_capture_id=$2 where id=$1", [cap, "PP-" + cap.slice(0, 8)]);
  await admin.query(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'CAPTURED_GROSS','D',200,'capture',$3), ($1,$2,'COMMITTED_UNSETTLED','C',200,'capture',$3)`,
    [g, L.lease, cap],
  );
  await admin.query("commit");
  const accrue = (lease, seller) => async (c) => {
    const id = uuid();
    await c.query(
      `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,$3,'SELLER_COST','D',200,'accrue',$4), ($1,$2,$3,'SELLER_PAYABLE','C',200,'accrue',$4)`,
      [uuid(), lease, seller, id],
    );
  };
  const other = (await admin.query("insert into sellers (name, paypal_email) values ('o','o@x.com') returning id")).rows[0].id;
  await report("accrual 200+200 on net 200", "read committed", "read committed", L.lease, accrue(L.lease, L.seller), accrue(L.lease, other));
}
{
  const L = await fund();
  await commitUsage(L.lease, 200);
  const cap = uuid();
  const call = uuid();
  const g = uuid();
  const ag = uuid();
  await admin.query("begin");
  await admin.query("insert into paypal_calls (id, lease_id, op, request_id, state) values ($1,$2,'capture',$3,'intent')", [call, L.lease, uuid()]);
  await admin.query("insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,200,'intent')", [cap, L.lease, L.auth, call]);
  await admin.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [call]);
  await admin.query("update paypal_calls set state='succeeded', http_status=201, response='{}'::jsonb where id=$1", [call]);
  await admin.query("update captures set status='completed', fee_minor=0, paypal_capture_id=$2 where id=$1", [cap, "PP-" + cap.slice(0, 8)]);
  await admin.query(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'CAPTURED_GROSS','D',200,'capture',$3), ($1,$2,'COMMITTED_UNSETTLED','C',200,'capture',$3)`,
    [g, L.lease, cap],
  );
  await admin.query(
    `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,$3,'SELLER_COST','D',200,'accrue',$4), ($1,$2,$3,'SELLER_PAYABLE','C',200,'accrue',$4)`,
    [ag, L.lease, L.seller, "ac-" + uuid()],
  );
  await admin.query("commit");
  await report(
    "payout 200+200 on accrual 200",
    "read committed",
    "read committed",
    L.lease,
    async (c) => {
      await c.query(
        `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
         values ($1,$2,'metered',200,'queued', now() + interval '30 seconds')`,
        [L.lease, L.seller],
      );
    },
    async (c) => {
      await c.query(
        `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
         values ($1,$2,'metered',200,'queued', now() + interval '30 seconds')`,
        [L.lease, L.seller],
      );
    },
  );
}

// The cap trigger calls lock_lease. Replace that function with a read and repeat the repeatable-read race.
await admin.query(NOOP_LOCK);
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("NOOP lock repeatable-read intent 600+600", "repeatable read", "repeatable read", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("NOOP lock read-committed intent 600+600", "read committed", "read committed", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  await report("NOOP lock repeatable-read completed 600+600", "repeatable read", "repeatable read", L.lease, captureComplete(L.lease, L.auth, 600, "N"), captureComplete(L.lease, L.auth, 600, "M"));
}
await admin.query(REAL_LOCK);

// App role, fresh sessions: shadow lock_lease via search_path and race under repeatable read.
{
  const L = await fund();
  await commitUsage(L.lease, 1000);
  const shadow = (body) => async (c) => {
    await c.query("set local role pashadhara_app");
    await c.query(
      `create function pg_temp.lock_lease(p_lease uuid) returns public.lease_state language sql as $$
         select state from public.leases where id = p_lease $$`,
    );
    await c.query("set local search_path = pg_temp, public");
    await body(c);
  };
  await report(
    "app search_path shadows lock_lease, repeatable-read intent 600+600",
    "repeatable read",
    "repeatable read",
    L.lease,
    shadow(captureIntent(L.lease, L.auth, 600)),
    shadow(captureIntent(L.lease, L.auth, 600)),
  );
}

// Owner disables triggers. One over-cap insert, no race required, recorded here because it needs a real owner.
{
  const L = await fund(100);
  await admin.query("alter table captures disable trigger captures_insert");
  await admin.query("alter table captures disable trigger captures_commit_checks");
  const call = uuid();
  await admin.query("insert into paypal_calls (id, lease_id, op, request_id, state) values ($1,$2,'capture',$3,'intent')", [call, L.lease, uuid()]);
  await admin.query(
    "insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,100000,'intent')",
    [L.lease, L.auth, call],
  );
  console.log(`RACE\towner disables cap trigger\t${await sums(L.lease)}`);
  await admin.query("alter table captures enable trigger captures_insert");
  await admin.query("alter table captures enable trigger captures_commit_checks");
}

await admin.end();
console.log("DONE");
