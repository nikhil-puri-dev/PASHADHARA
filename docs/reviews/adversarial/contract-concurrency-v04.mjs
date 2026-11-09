// Two connections on Postgres 15. Port of contract-concurrency-v03.mjs for contract v0.4.
// v0.4 rejects the v0.3 setup: each commit refs its own job, a completed capture
// needs a succeeded call whose stored response matches id, amount and fee, and
// an accrual refs a served tool call or a paying decision.
// Both race connections SET ROLE pashadhara_app. The role is NOLOGIN, so this
// connects as the throwaway superuser, applies schema.sql and roles.sql, then
// sets the role. Owner-only steps are labeled OWNER and are not app attacks.
//
//   docker run -d --rm --name pashadhara-adv-v04 -e POSTGRES_HOST_AUTH_METHOD=trust -p 15435:5432 postgres:15
//   node adversarial/contract-concurrency-v04.mjs
//
// Refuses any database that is not 127.0.0.1:15435.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pg = require(process.env.PG_MODULE ?? "pg");
const { Client } = pg;

const url = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:15435/postgres";
const parsed = new URL(url);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.port !== "15435") {
  console.log("MISSED\trefusing database\t" + parsed.host);
  process.exit(1);
}

const schema = readFileSync(new URL("../packages/contract/schema.sql", import.meta.url), "utf8");
const roles = readFileSync(new URL("../packages/contract/roles.sql", import.meta.url), "utf8");
const uuid = () => crypto.randomUUID();
const dollars = (cents) => (cents / 100).toFixed(2);
const errText = (e) => `${e.code ?? ""} ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 180)}`;
const FULL = JSON.stringify([{ min_score: 0, pay_bps: 10000 }]);
const captureBody = (id, amt, fee) => JSON.stringify({
  id,
  status: "COMPLETED",
  amount: { currency_code: "USD", value: dollars(amt) },
  seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: dollars(fee) } },
});
const REAL_LOCK = `
create or replace function lock_lease(p_lease uuid) returns public.lease_state language plpgsql set search_path = pg_catalog, pg_temp as $$
declare st public.lease_state;
begin
  update public.leases set state = state where id = p_lease returning state into st;
  if st is null then
    raise exception 'Unknown lease %', p_lease using errcode = 'foreign_key_violation';
  end if;
  return st;
end $$;`;
const NOOP_LOCK = `
create or replace function lock_lease(p_lease uuid) returns public.lease_state language plpgsql set search_path = pg_catalog, pg_temp as $$
declare st public.lease_state;
begin
  select state into st from public.leases where id = p_lease;
  if st is null then
    raise exception 'Unknown lease %', p_lease using errcode = 'foreign_key_violation';
  end if;
  return st;
end $$;`;

const admin = new Client({ connectionString: url });
await admin.connect();
await admin.query("drop schema public cascade; create schema public; grant all on schema public to postgres;");
await admin.query(schema);
await admin.query(roles);
console.log(`RUNTIME\tPostgres ${(await admin.query("show server_version")).rows[0].server_version}`);
await admin.query("set role pashadhara_app");
const who = (await admin.query("select current_user, session_user")).rows[0];
console.log(`RUNTIME\tcurrent_user=${who.current_user} session_user=${who.session_user}`);

const q = (sql, params) => admin.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];

async function seller() {
  return (await one(
    "insert into sellers (name, paypal_email, payout_hold_seconds) values ('s',$1,30) returning id",
    [`s-${uuid()}@x.com`],
  )).id;
}
async function fund(cap = 1000, limit = null) {
  const s = await seller();
  const lease = (await one(
    "insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',$1,$2) returning id",
    [cap, limit ?? cap],
  )).id;
  const auth = (await one(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     values ($1,$2,$3,'created', now(), now() + interval '3 days', now() + interval '29 days') returning id`,
    [lease, "AUTH-" + uuid(), cap],
  )).id;
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'HOLD_AVAILABLE','D',$3,'authorize',$4), ($1,$2,'BUYER_COMMITMENT','C',$3,'authorize',$4)`,
    [g, lease, cap, "auth-" + uuid()],
  );
  await q("update leases set state='active' where id=$1", [lease]);
  return { seller: s, lease, auth, cap };
}
async function job(lease, sellerId, amount) {
  return (await one(
    "insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,$3,$4::jsonb) returning id",
    [lease, sellerId, amount, FULL],
  )).id;
}
async function reserve(lease, jobId, amount) {
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
    [g, lease, amount, jobId],
  );
}
async function meter(lease, sellerId, price) {
  const toolId = "t-" + uuid();
  const callId = uuid();
  const g = uuid();
  await q("insert into tools (id, seller_id, name, price_minor) values ($1,$2,'t',$3)", [toolId, sellerId, price]);
  await q("begin");
  try {
    await q(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
      [g, lease, price, callId],
    );
    await q(
      `insert into tool_calls (id, lease_id, tool_id, idempotency_key, price_minor, status, ledger_group_id)
       values ($1,$2,$3,$4,$5,'served',$6)`,
      [callId, lease, toolId, "k-" + callId, price, g],
    );
    await q("commit");
  } catch (e) {
    await q("rollback");
    throw e;
  }
  return callId;
}
async function completeCapture(lease, auth, amt, fee = 0) {
  const capId = uuid();
  const callId = uuid();
  const pp = "PP-" + capId.slice(0, 8);
  await q("begin");
  try {
    await q(
      "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')",
      [callId, lease, uuid(), amt],
    );
    await q(
      "insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,$5,'intent')",
      [capId, lease, auth, callId, amt],
    );
    await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
    await q(
      "update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1",
      [callId, captureBody(pp, amt, fee)],
    );
    await q(
      "update captures set status='completed', fee_minor=$2, paypal_capture_id=$3, settled_at=now() where id=$1",
      [capId, fee, pp],
    );
    const g = uuid();
    const legs = [["CAPTURED_GROSS", "D", amt], ["COMMITTED_UNSETTLED", "C", amt]];
    if (fee > 0) legs.push(["PAYPAL_FEES", "D", fee], ["CAPTURED_GROSS", "C", fee]);
    for (const [account, dir, a] of legs) {
      await q(
        `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id)
         values ($1,$2,$3,$4,$5,'capture',$6)`,
        [g, lease, account, dir, a, capId],
      );
    }
    await q("commit");
  } catch (e) {
    await q("rollback");
    throw e;
  }
  return capId;
}
async function accrue(lease, sellerId, amount, ref) {
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,$3,'SELLER_COST','D',$4,'accrue',$5), ($1,$2,$3,'SELLER_PAYABLE','C',$4,'accrue',$5)`,
    [g, lease, sellerId, amount, ref],
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
function captureComplete(lease, auth, amt) {
  return async (c) => {
    const call = uuid();
    const cap = uuid();
    const pp = "PP-" + cap.slice(0, 8);
    await c.query(
      "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')",
      [call, lease, uuid(), amt],
    );
    await c.query(
      "insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,$5,'intent')",
      [cap, lease, auth, call, amt],
    );
    await c.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [call]);
    await c.query(
      "update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1",
      [call, captureBody(pp, amt, 0)],
    );
    await c.query(
      "update captures set status='completed', fee_minor=0, paypal_capture_id=$2, settled_at=now() where id=$1",
      [cap, pp],
    );
    const g = uuid();
    await c.query(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,'CAPTURED_GROSS','D',$3,'capture',$4), ($1,$2,'COMMITTED_UNSETTLED','C',$3,'capture',$4)`,
      [g, lease, amt, cap],
    );
  };
}
function ledger(lease, sellerId, amt) {
  return async (c) => {
    const j = (await c.query(
      "insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,$3,$4::jsonb) returning id",
      [lease, sellerId, amt, FULL],
    )).rows[0].id;
    const g = uuid();
    await c.query(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
      [g, lease, amt, j],
    );
  };
}
function accrueBody(lease, sellerId, ref, amt) {
  return async (c) => {
    await c.query(
      `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,$3,'SELLER_COST','D',$4,'accrue',$5), ($1,$2,$3,'SELLER_PAYABLE','C',$4,'accrue',$5)`,
      [uuid(), lease, sellerId, amt, ref],
    );
  };
}
function returnBody(lease, jobId, amt) {
  return async (c) => {
    await c.query(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,'HOLD_AVAILABLE','D',$3,'return',$4), ($1,$2,'COMMITTED_UNSETTLED','C',$3,'return',$4)`,
      [uuid(), lease, amt, jobId],
    );
  };
}

async function race(isoA, isoB, bodyA, bodyB) {
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect();
  await b.connect();
  try {
    await a.query("set deadlock_timeout = '250ms'");
    await b.query("set deadlock_timeout = '250ms'");
    await a.query("set role pashadhara_app");
    await b.query("set role pashadhara_app");
    await a.query(`begin isolation level ${isoA}`);
    await b.query(`begin isolation level ${isoB}`);
    for (const c of [a, b]) {
      await c.query("set local statement_timeout = '8s'");
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
  const caps = (await q(
    `select count(*)::int as n,
            coalesce(sum(amount_minor) filter (where status in ('intent','pending','completed','unknown','reversed')),0)::text as counted
       from captures where lease_id=$1`,
    [lease],
  )).rows[0];
  const comm = (await q(
    `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as s
       from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'`,
    [lease],
  )).rows[0].s;
  const cost = (await q(
    `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as s
       from ledger_entries where lease_id=$1 and account='SELLER_COST'`,
    [lease],
  )).rows[0].s;
  const pay = (await q(
    "select count(*)::int as n, coalesce(sum(amount_minor) filter (where state <> 'failed'),0)::text as s from payouts where lease_id=$1",
    [lease],
  )).rows[0];
  return `captures=${caps.n} counted=${caps.counted} committed=${comm} seller_cost=${cost} payouts=${pay.n}/${pay.s}`;
}
async function report(name, isoA, isoB, lease, bodyA, bodyB) {
  const r = await race(isoA, isoB, bodyA, bodyB);
  console.log(`RACE\t${name}\t${r.join(" || ")}\t${await sums(lease)}`);
}

{
  const probe = new Client({ connectionString: url });
  await probe.connect();
  await probe.query("set role pashadhara_app");
  const w = (await probe.query("select current_user, session_user")).rows[0];
  console.log(`RUNTIME\trace_user=${w.current_user} session=${w.session_user}`);
  await probe.end();
}

{
  const L = await fund();
  const j = await job(L.lease, L.seller, 1000);
  await reserve(L.lease, j, 1000);
  await report("intent 600+600 read committed", "read committed", "read committed", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  const j = await job(L.lease, L.seller, 1000);
  await reserve(L.lease, j, 1000);
  await report("intent 600+600 repeatable read", "repeatable read", "repeatable read", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  const j = await job(L.lease, L.seller, 1000);
  await reserve(L.lease, j, 1000);
  await report("intent 600+600 mixed RC then RR", "read committed", "repeatable read", L.lease, captureIntent(L.lease, L.auth, 600), captureIntent(L.lease, L.auth, 600));
}
{
  const L = await fund();
  const j = await job(L.lease, L.seller, 1000);
  await reserve(L.lease, j, 1000);
  await report("completed 600+600 repeatable read", "repeatable read", "repeatable read", L.lease, captureComplete(L.lease, L.auth, 600), captureComplete(L.lease, L.auth, 600));
}
{
  const L = await fund();
  await report("ledger 800+800 read committed", "read committed", "read committed", L.lease, ledger(L.lease, L.seller, 800), ledger(L.lease, L.seller, 800));
}
{
  const L = await fund();
  await report("ledger 800+800 repeatable read", "repeatable read", "repeatable read", L.lease, ledger(L.lease, L.seller, 800), ledger(L.lease, L.seller, 800));
}
{
  const L = await fund(1000, 500);
  await report("exposure 400+400 on limit 500 read committed", "read committed", "read committed", L.lease, ledger(L.lease, L.seller, 400), ledger(L.lease, L.seller, 400));
}
{
  const L = await fund(1000, 500);
  await report("exposure 400+400 on limit 500 repeatable read", "repeatable read", "repeatable read", L.lease, ledger(L.lease, L.seller, 400), ledger(L.lease, L.seller, 400));
}

{
  const L = await fund();
  const a = await meter(L.lease, L.seller, 200);
  const b = await meter(L.lease, L.seller, 200);
  await completeCapture(L.lease, L.auth, 200, 0);
  await report("accrual 200+200 on net 200", "read committed", "read committed", L.lease, accrueBody(L.lease, L.seller, a, 200), accrueBody(L.lease, L.seller, b, 200));
}
{
  const L = await fund();
  const a = await meter(L.lease, L.seller, 200);
  const b = await meter(L.lease, L.seller, 200);
  await completeCapture(L.lease, L.auth, 200, 0);
  await report(
    "accrual 200+200 on net 200 repeatable read",
    "repeatable read",
    "repeatable read",
    L.lease,
    accrueBody(L.lease, L.seller, a, 200),
    accrueBody(L.lease, L.seller, b, 200),
  );
}
{
  const L = await fund();
  const call = await meter(L.lease, L.seller, 200);
  await completeCapture(L.lease, L.auth, 200, 0);
  await accrue(L.lease, L.seller, 200, call);
  const body = async (c) => {
    await c.query(
      `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
       values ($1,$2,'metered',200,'queued', now() + interval '31 seconds')`,
      [L.lease, L.seller],
    );
  };
  await report("metered payout 200+200 on accrual 200", "read committed", "read committed", L.lease, body, body);
}
{
  const L = await fund();
  const call = await meter(L.lease, L.seller, 200);
  await completeCapture(L.lease, L.auth, 200, 0);
  await accrue(L.lease, L.seller, 200, call);
  const body = async (c) => {
    await c.query(
      `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
       values ($1,$2,'metered',200,'queued', now() + interval '31 seconds')`,
      [L.lease, L.seller],
    );
  };
  await report("metered payout 200+200 on accrual 200 repeatable read", "repeatable read", "repeatable read", L.lease, body, body);
}

{
  const L = await fund(1500);
  const reserved = await job(L.lease, L.seller, 500);
  await reserve(L.lease, reserved, 500);
  const d1 = await job(L.lease, L.seller, 500);
  const d2 = await job(L.lease, L.seller, 500);
  await report("return 500+500 on one commit of 500", "read committed", "read committed", L.lease, returnBody(L.lease, d1, 500), returnBody(L.lease, d2, 500));
}
{
  const L = await fund(1500);
  const reserved = await job(L.lease, L.seller, 500);
  await reserve(L.lease, reserved, 500);
  const d1 = await job(L.lease, L.seller, 500);
  const d2 = await job(L.lease, L.seller, 500);
  await report("return 500+500 on one commit of 500 repeatable read", "repeatable read", "repeatable read", L.lease, returnBody(L.lease, d1, 500), returnBody(L.lease, d2, 500));
}

// Round 1 is two passes, but a hold was inserted after the first pass, so round 2 is open.
// A inserts release and does not commit. B inserts two round-2 fails and commits.
// Verdict insert does not call lock_lease. The decision trigger does not run again at commit.
async function verdictCase() {
  const L = await fund();
  const j = await job(L.lease, L.seller, 500);
  await reserve(L.lease, j, 500);
  await q(
    "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'openai','m','pass',95,1)",
    [j],
  );
  await q(
    "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'hold',0,'{}'::jsonb)",
    [L.lease, j],
  );
  await q(
    "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'anthropic','m','pass',96,1)",
    [j],
  );
  return { L, j };
}
async function orderedVerdict(iso) {
  const { L, j } = await verdictCase();
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect();
  await b.connect();
  let detail = "";
  try {
    await a.query("set role pashadhara_app");
    await b.query("set role pashadhara_app");
    await a.query(`begin isolation level ${iso}`);
    await b.query(`begin isolation level ${iso}`);
    await a.query("set local statement_timeout = '8s'");
    await b.query("set local statement_timeout = '8s'");
    try {
      await a.query(
        "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'release',500,$3::jsonb)",
        [L.lease, j, JSON.stringify({ min_score: 95, pay_bps: 10000 })],
      );
      detail += "a_insert=ok";
    } catch (e) {
      detail += "a_insert=" + errText(e);
    }
    try {
      await b.query(
        "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'openai','m','fail',10,2)",
        [j],
      );
      await b.query(
        "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'anthropic','m','fail',11,2)",
        [j],
      );
      await b.query("commit");
      detail += " b_commit=ok";
    } catch (e) {
      detail += " b=" + errText(e);
      await b.query("rollback").catch(() => {});
    }
    try {
      await a.query("commit");
      detail += " a_commit=ok";
    } catch (e) {
      detail += " a_commit=" + errText(e);
      await a.query("rollback").catch(() => {});
    }
    const dec = (await q(
      "select coalesce(string_agg(outcome || ':' || amount_minor::text, ','), 'none') as s from decisions where job_id=$1 and outcome <> 'hold'",
      [j],
    )).rows[0].s;
    const vs = (await q(
      `select coalesce(string_agg(round::text || ':' || judge_provider || '=' || verdict, ',' order by round, judge_provider), 'none') as s
         from verdicts where job_id=$1`,
      [j],
    )).rows[0].s;
    console.log(`RACE\tverdict release then round-2 fails ${iso}\t${detail}\tdecision=${dec} verdicts=${vs} ${await sums(L.lease)}`);
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
}
await orderedVerdict("read committed");
await orderedVerdict("repeatable read");

{
  const { j } = await verdictCase();
  const release = async (c) => {
    await c.query(
      "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'release',500,$3::jsonb)",
      [(await c.query("select lease_id from jobs where id=$1", [j])).rows[0].lease_id, j, JSON.stringify({ min_score: 95, pay_bps: 10000 })],
    );
  };
  const fails = async (c) => {
    await c.query(
      "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'openai','m','fail',10,2)",
      [j],
    );
    await c.query(
      "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'anthropic','m','fail',11,2)",
      [j],
    );
  };
  const r = await race("read committed", "read committed", release, fails);
  const dec = (await q(
    "select coalesce(string_agg(outcome || ':' || amount_minor::text, ','), 'none') as s from decisions where job_id=$1 and outcome <> 'hold'",
    [j],
  )).rows[0].s;
  const vs = (await q(
    `select coalesce(string_agg(round::text || ':' || judge_provider || '=' || verdict, ',' order by round, judge_provider), 'none') as s
       from verdicts where job_id=$1`,
    [j],
  )).rows[0].s;
  console.log(`RACE\tverdict parallel release vs round-2 fails\t${r.join(" || ")}\tdecision=${dec} verdicts=${vs}`);
}

{
  const { j } = await verdictCase();
  const b = new Client({ connectionString: url });
  await b.connect();
  await b.query("set role pashadhara_app");
  await b.query(
    "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'openai','m','fail',10,2)",
    [j],
  );
  await b.query(
    "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'anthropic','m','fail',11,2)",
    [j],
  );
  await b.end();
  try {
    await q(
      "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'release',500,$3::jsonb)",
      [(await one("select lease_id from jobs where id=$1", [j])).lease_id, j, JSON.stringify({ min_score: 95, pay_bps: 10000 })],
    );
    console.log("BROKEN-CONTROL\tround-2 fails already visible still released\tallowed");
  } catch (e) {
    await q("rollback").catch(() => {});
    console.log(`HOLDS\tround-2 fails already visible, release is refused\t${errText(e)}`);
  }
}

try {
  await q(
    `create function pg_temp.lock_lease(p_lease uuid) returns public.lease_state language sql as $$
       select state from public.leases where id = p_lease $$`,
  );
  console.log("BROKEN-CONTROL\tapp creates pg_temp.lock_lease\tallowed");
} catch (e) {
  await q("rollback").catch(() => {});
  console.log(`HOLDS\tapp cannot create pg_temp.lock_lease\t${errText(e)}`);
}
try {
  await q("reset role");
  console.log("BROKEN-CONTROL\tapp reset role\tdid not throw, current_user=" + (await one("select current_user as u")).u);
  await q("set role pashadhara_app");
} catch (e) {
  console.log(`HOLDS\tapp cannot reset role\t${errText(e)}`);
}

// Appeal, then cancel the queued payout (no PayPal call), then try to replace it.
{
  const L = await fund();
  const jid = await job(L.lease, L.seller, 500);
  await reserve(L.lease, jid, 500);
  await q("insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'openai','m','pass',95,1)", [jid]);
  await q("insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'anthropic','m','pass',96,1)", [jid]);
  const dec = (await one(
    "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'release',500,$3::jsonb) returning id",
    [L.lease, jid, JSON.stringify({ min_score: 95, pay_bps: 10000 })],
  )).id;
  const capId = uuid();
  const callId = uuid();
  const pp = "PP-" + capId.slice(0, 8);
  await q("begin");
  await q(
    "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,500,'intent')",
    [callId, L.lease, uuid()],
  );
  await q(
    "insert into captures (id, lease_id, authorization_id, call_id, decision_id, amount_minor, status) values ($1,$2,$3,$4,$5,500,'intent')",
    [capId, L.lease, L.auth, callId, dec],
  );
  await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
  await q(
    "update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1",
    [callId, captureBody(pp, 500, 52)],
  );
  await q(
    "update captures set status='completed', fee_minor=52, paypal_capture_id=$2, settled_at=now() where id=$1",
    [capId, pp],
  );
  const g = uuid();
  for (const [account, dir, amt] of [["CAPTURED_GROSS", "D", 500], ["COMMITTED_UNSETTLED", "C", 500], ["PAYPAL_FEES", "D", 52], ["CAPTURED_GROSS", "C", 52]]) {
    await q(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id)
       values ($1,$2,$3,$4,$5,'capture',$6)`,
      [g, L.lease, account, dir, amt, capId],
    );
  }
  await q("commit");
  await accrue(L.lease, L.seller, 448, dec);
  const pid = (await one(
    `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
     values ($1,$2,'job',$3,448,'queued', now() + interval '31 seconds') returning id`,
    [L.lease, L.seller, dec],
  )).id;
  for (const st of ["delivered", "judging", "decided", "held"]) {
    await q("update jobs set state=$2 where id=$1", [jid, st]);
  }
  let cancel = "ok";
  try {
    await q("update payouts set state='failed' where id=$1", [pid]);
  } catch (e) {
    cancel = errText(e);
    await q("rollback").catch(() => {});
  }
  let retry = "ok";
  try {
    await q(
      `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
       values ($1,$2,'job',$3,448,'queued', now() + interval '31 seconds')`,
      [L.lease, L.seller, dec],
    );
  } catch (e) {
    retry = errText(e);
    await q("rollback").catch(() => {});
  }
  const row = await one("select state, held_at is not null as held from payouts where id=$1", [pid]);
  console.log(`EXTRA\tappeal then cancel then replace\tcancel=${cancel} row=${row.state} held_at=${row.held} retry=${retry}`);
}

// A login role that is only a member of pashadhara_app. RESET ROLE must not return to postgres.
{
  await q("reset role");
  await q(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'kernel_login') then
        create role kernel_login login nosuperuser noinherit;
      end if;
    end $$;
  `);
  await q("grant pashadhara_app to kernel_login");
  const k = new Client({ connectionString: "postgres://kernel_login@127.0.0.1:15435/postgres" });
  try {
    await k.connect();
    await k.query("set role pashadhara_app");
    const mid = (await k.query("select current_user, session_user")).rows[0];
    await k.query("reset role");
    const after = (await k.query("select current_user, session_user")).rows[0];
    let disable = "allowed";
    try {
      await k.query("alter table captures disable trigger captures_insert");
    } catch (e) {
      disable = errText(e);
    }
    console.log(`EXTRA\tkernel_login reset role\tmid=${mid.current_user}/${mid.session_user} after=${after.current_user}/${after.session_user} disable=${disable}`);
  } catch (e) {
    console.log(`EXTRA\tkernel_login connect\t${errText(e)}`);
  } finally {
    await k.end().catch(() => {});
  }
  await q("set role pashadhara_app");
}

// OWNER only. The app cannot replace lock_lease. With the row lock removed, repeatable read
// lets both commits of 800 land, because the deferred check does not see the other transaction.
{
  await q("reset role");
  await q(NOOP_LOCK);
  await q("set role pashadhara_app");
  const L = await fund();
  await report("OWNER noop lock ledger 800+800 repeatable read", "repeatable read", "repeatable read", L.lease, ledger(L.lease, L.seller, 800), ledger(L.lease, L.seller, 800));
  await q("reset role");
  await q(REAL_LOCK);
  await q("set role pashadhara_app");
}

{
  await q("reset role");
  await q("alter table captures disable trigger captures_insert");
  await q("alter table captures disable trigger captures_commit_checks");
  await q("set role pashadhara_app");
  const L = await fund(100);
  const call = uuid();
  let inserted = "ok";
  try {
    await q("begin");
    await q(
      "insert into paypal_calls (id, lease_id, op, request_id, state) values ($1,$2,'capture',$3,'intent')",
      [call, L.lease, uuid()],
    );
    await q(
      "insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,100000,'intent')",
      [L.lease, L.auth, call],
    );
    await q("commit");
  } catch (e) {
    inserted = errText(e);
    await q("rollback").catch(() => {});
  }
  console.log(`RACE\tOWNER disables cap trigger, app inserts 100000 on cap 100\t${inserted}\t${await sums(L.lease)}`);
  await q("reset role");
  await q("alter table captures enable trigger captures_insert");
  await q("alter table captures enable trigger captures_commit_checks");
  await q("set role pashadhara_app");
}

// A payout that reaches sent, then the call fails, then a replacement. One hold window.
{
  const L = await fund();
  const jid = await job(L.lease, L.seller, 500);
  await reserve(L.lease, jid, 500);
  await q("insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'openai','m','pass',95,1)", [jid]);
  await q("insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,'anthropic','m','pass',96,1)", [jid]);
  const dec = (await one(
    "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'release',500,$3::jsonb) returning id",
    [L.lease, jid, JSON.stringify({ min_score: 95, pay_bps: 10000 })],
  )).id;
  const capId = uuid();
  const callId = uuid();
  const pp = "PP-" + capId.slice(0, 8);
  await q("begin");
  await q("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,500,'intent')", [callId, L.lease, uuid()]);
  await q(
    "insert into captures (id, lease_id, authorization_id, call_id, decision_id, amount_minor, status) values ($1,$2,$3,$4,$5,500,'intent')",
    [capId, L.lease, L.auth, callId, dec],
  );
  await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
  await q(
    "update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1",
    [callId, captureBody(pp, 500, 52)],
  );
  await q("update captures set status='completed', fee_minor=52, paypal_capture_id=$2, settled_at=now() where id=$1", [capId, pp]);
  const g = uuid();
  for (const [account, dir, amt] of [["CAPTURED_GROSS", "D", 500], ["COMMITTED_UNSETTLED", "C", 500], ["PAYPAL_FEES", "D", 52], ["CAPTURED_GROSS", "C", 52]]) {
    await q(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,$3,$4,$5,'capture',$6)`,
      [g, L.lease, account, dir, amt, capId],
    );
  }
  await q("commit");
  await accrue(L.lease, L.seller, 448, dec);
  const pid = (await one(
    `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
     values ($1,$2,'job',$3,448,'queued', now() + interval '31 seconds') returning id`,
    [L.lease, L.seller, dec],
  )).id;
  const waitMs = Number((await one(
    "select ceil(extract(epoch from (release_at - now())) * 1000)::int + 300 as ms from payouts where id=$1",
    [pid],
  )).ms);
  console.log(`RUNTIME\twaiting ${waitMs}ms for payout release_at`);
  await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));
  const pcall = uuid();
  let sent = "ok";
  let failed = "ok";
  let retry = "ok";
  try {
    await q("begin");
    await q(
      "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'payout',$3,448,'intent')",
      [pcall, L.lease, uuid()],
    );
    await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [pcall]);
    await q("update payouts set call_id=$2, state='sent' where id=$1", [pid, pcall]);
    await q("commit");
  } catch (e) {
    sent = errText(e);
    await q("rollback").catch(() => {});
  }
  try {
    await q("begin");
    await q(
      "update paypal_calls set state='failed', http_status=422, response='{\"name\":\"RECEIVER_UNREGISTERED\"}'::jsonb, resolved_at=now() where id=$1",
      [pcall],
    );
    await q("update payouts set state='failed' where id=$1", [pid]);
    await q("commit");
  } catch (e) {
    failed = errText(e);
    await q("rollback").catch(() => {});
  }
  try {
    await q(
      `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
       values ($1,$2,'job',$3,448,'queued', now() + interval '31 seconds')`,
      [L.lease, L.seller, dec],
    );
  } catch (e) {
    retry = errText(e);
    await q("rollback").catch(() => {});
  }
  const row = await one("select state from payouts where id=$1", [pid]);
  const call = await one("select state, response is not null as body from paypal_calls where id=$1", [pcall]);
  console.log(`EXTRA\tsent then failed payout cannot be replaced\tsent=${sent} failed=${failed} row=${row?.state} call=${call?.state} body=${call?.body} retry=${retry}`);
}

await admin.end();
console.log("RUNTIME\tdone");
