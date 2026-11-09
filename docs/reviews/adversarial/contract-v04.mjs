// Contract v0.4 attacks. Port of contract-v03.mjs.
// v0.4 rejects the v0.3 setup: commit ref_id is a job or a served tool call,
// accrual ref_id is a paying decision or a served tool call, a completed capture
// needs its succeeded call with id, amount and fee in the stored response,
// payouts need their own payout call, and verdicts have rounds.
// Every attack runs as pashadhara_app. The role is NOLOGIN, so this connects as
// the throwaway superuser, applies schema.sql and roles.sql, then SET ROLE.
//
//   docker run -d --rm --name pashadhara-adv-v04 -e POSTGRES_HOST_AUTH_METHOD=trust -p 15435:5432 postgres:15
//   node adversarial/contract-v04.mjs
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
const errText = (e) => `${e.code ?? ""} ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 220)}`;
const captureBody = (id, amt, fee, feeText = null) => JSON.stringify({
  id,
  status: "COMPLETED",
  amount: { currency_code: "USD", value: dollars(amt) },
  seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: feeText ?? dollars(fee) } },
});
const FULL = JSON.stringify([{ min_score: 0, pay_bps: 10000 }]);
const PARTIAL = JSON.stringify([{ min_score: 60, pay_bps: 5000 }, { min_score: 90, pay_bps: 10000 }]);

const c = new Client({ connectionString: url });
for (let i = 0; i < 30; i++) {
  try { await c.connect(); break; } catch (e) {
    if (i === 29) throw e;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function line(kind, name, detail) { console.log(`${kind}\t${name}\t${detail}`); }
async function rollback() { try { await c.query("rollback"); } catch { /* not in a transaction */ } }
async function works(name, fn) {
  try { line("WORKS", name, await fn()); }
  catch (e) { await rollback(); line("MISSED", name, errText(e)); }
}
async function holds(name, fn) {
  try { await fn(); line("BROKEN-CONTROL", name, "was allowed"); }
  catch (e) { await rollback(); line("HOLDS", name, errText(e)); }
}

await c.query("drop schema public cascade; create schema public; grant all on schema public to postgres;");
await c.query(schema);
await c.query(roles);
const ver = (await c.query("show server_version")).rows[0].server_version;
console.log(`RUNTIME\tPostgres ${ver}`);
await c.query("set role pashadhara_app");
const who = (await c.query("select current_user, session_user")).rows[0];
console.log(`RUNTIME\tcurrent_user=${who.current_user} session_user=${who.session_user}`);

const q = (sql, params) => c.query(sql, params);
const one = async (sql, params) => (await c.query(sql, params)).rows[0];

async function seller(hold = 30, email = null) {
  email ??= `s-${uuid()}@x.com`;
  return (await one(
    "insert into sellers (name, paypal_email, payout_hold_seconds) values ('s',$2,$1) returning id",
    [hold, email],
  )).id;
}
async function fund(cap = 1000, limit = null, hold = 30) {
  const s = await seller(hold);
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
async function job(lease, sellerId, amount, rubric = FULL) {
  return (await one(
    "insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,$3,$4::jsonb) returning id",
    [lease, sellerId, amount, rubric],
  )).id;
}
async function reserve(lease, jobId, amount) {
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'COMMITTED_UNSETTLED','D',$3,'commit',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'commit',$4)`,
    [g, lease, amount, jobId],
  );
  return g;
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
  } catch (e) { await q("rollback"); throw e; }
  return { toolId, callId, group: g };
}
async function succeedCall(lease, op, response = {}) {
  const id = (await one(
    "insert into paypal_calls (lease_id, op, request_id, state) values ($1,$2,$3,'intent') returning id",
    [lease, op, uuid()],
  )).id;
  await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [id]);
  await q(
    "update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1",
    [id, JSON.stringify(response)],
  );
  return id;
}
async function completeCapture(lease, auth, amt, fee, dec = null, feeText = null) {
  const capId = uuid();
  const callId = uuid();
  const pp = "PP-" + capId;
  await q("begin");
  try {
    await q(
      "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')",
      [callId, lease, uuid(), amt],
    );
    await q(
      "insert into captures (id, lease_id, authorization_id, call_id, decision_id, amount_minor, status) values ($1,$2,$3,$4,$5,$6,'intent')",
      [capId, lease, auth, callId, dec, amt],
    );
    await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
    await q(
      "update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1",
      [callId, captureBody(pp, amt, fee, feeText)],
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
  } catch (e) { await q("rollback"); throw e; }
  return { capId, callId, pp };
}
const verdict = (jobId, provider, v, score, round = 1) => q(
  "insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,$2,'m',$3,$4,$5)",
  [jobId, provider, v, score, round],
);
async function decide(lease, jobId, outcome, amount, derived = {}) {
  return (await one(
    "insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,$3,$4,$5::jsonb) returning id",
    [lease, jobId, outcome, amount, JSON.stringify(derived)],
  )).id;
}
async function accrue(lease, sellerId, amount, ref) {
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,$3,'SELLER_COST','D',$4,'accrue',$5), ($1,$2,$3,'SELLER_PAYABLE','C',$4,'accrue',$5)`,
    [g, lease, sellerId, amount, ref],
  );
}
async function payoutRow(lease, sellerId, source, dec, amt) {
  return (await one(
    `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
     values ($1,$2,$3,$4,$5,'queued', now() + interval '30 seconds') returning id`,
    [lease, sellerId, source, dec, amt],
  )).id;
}
async function balances(lease) {
  const rows = (await q(
    `select account,
            sum(case when account in ('BUYER_COMMITMENT','SELLER_PAYABLE')
                     then case direction when 'C' then amount_minor else -amount_minor end
                     else case direction when 'D' then amount_minor else -amount_minor end end)::text as bal
       from ledger_entries where lease_id=$1 group by account order by account`,
    [lease],
  )).rows;
  return rows.map((r) => `${r.account}=${r.bal}`).join(" ");
}
async function committedOf(lease) {
  const r = await one(
    `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as c
       from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'`,
    [lease],
  );
  return r.c;
}
async function releaseJob(L, amount) {
  const j = await job(L.lease, L.seller, amount);
  await reserve(L.lease, j, amount);
  await verdict(j, "openai", "pass", 95);
  await verdict(j, "anthropic", "pass", 95);
  const dec = await decide(L.lease, j, "release", amount, { min_score: 95, pay_bps: 10000 });
  return { job: j, dec };
}
async function paidJob(L, amount = 500, fee = 52) {
  const rel = await releaseJob(L, amount);
  const cap = await completeCapture(L.lease, L.auth, amount, fee, rel.dec);
  await accrue(L.lease, L.seller, amount - fee, rel.dec);
  return { ...rel, ...cap, net: amount - fee };
}
async function postReturn(lease, jobId, amount) {
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'HOLD_AVAILABLE','D',$3,'return',$4), ($1,$2,'COMMITTED_UNSETTLED','C',$3,'return',$4)`,
    [g, lease, amount, jobId],
  );
}
async function voidRemainder(lease, amount) {
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'RELEASED','D',$3,'void',$4), ($1,$2,'HOLD_AVAILABLE','C',$3,'void',$4)`,
    [g, lease, amount, "void-" + uuid()],
  );
}

const delayed = [];

// ---------- control: a legal v0.4 path still completes ----------
await works("control a released job captures, accrues, and the lease closes", async () => {
  const L = await fund(1000);
  const p = await paidJob(L, 400, 52);
  await succeedCall(L.lease, "void", { id: "VOID-1" });
  await q("update authorizations set status='voided' where id=$1", [L.auth]);
  await voidRemainder(L.lease, 600);
  await q("update leases set state='closed' where id=$1", [L.lease]);
  const st = await one("select state from leases where id=$1", [L.lease]);
  return `lease=${st.state} net_accrued=${p.net} ${await balances(L.lease)}`;
});

await works("control a disagreement hold then a new round of passes releases", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500);
  await verdict(j, "openai", "pass", 95);
  await verdict(j, "anthropic", "fail", 10);
  await decide(L.lease, j, "hold", 0, {});
  await verdict(j, "xai", "pass", 96, 2);
  await verdict(j, "google", "pass", 97, 2);
  const dec = await decide(L.lease, j, "release", 500, { min_score: 96, pay_bps: 10000 });
  return `decision=${dec}`;
});

await works("control boolean precheck_failed true voids only with zero verdicts", async () => {
  const L = await fund(100);
  const j = await job(L.lease, L.seller, 100);
  const dec = await decide(L.lease, j, "void", 0, { precheck_failed: true });
  return `decision=${dec}`;
});

// ---------- A. Served usage returns through a different job ----------
await holds("A control a served tool call id cannot be the return ref", async () => {
  const L = await fund(1000);
  const m = await meter(L.lease, L.seller, 300);
  await postReturn(L.lease, m.callId, 300);
});

await works("A a different unpaid job returns the served tool's commit, then the lease closes", async () => {
  const L = await fund(1000);
  const m = await meter(L.lease, L.seller, 300);
  const decoy = await job(L.lease, L.seller, 300);
  await postReturn(L.lease, decoy, 300);
  const tool = await one("select status from tool_calls where id=$1", [m.callId]);
  const jobs = await one("select count(*)::int as n from jobs where lease_id=$1", [L.lease]);
  const caps = await one("select count(*)::int as n from captures where lease_id=$1", [L.lease]);
  await succeedCall(L.lease, "void", { id: "VOID-A" });
  await q("update authorizations set status='voided' where id=$1", [L.auth]);
  await voidRemainder(L.lease, 1000);
  await q("update leases set state='closed' where id=$1", [L.lease]);
  const st = await one("select state from leases where id=$1", [L.lease]);
  return `tool=${tool.status} decoy_jobs=${jobs.n} captures=${caps.n} committed=${await committedOf(L.lease)} lease=${st.state} ${await balances(L.lease)}`;
});

await works("A2 one group serves a tool and returns a different job, so committed never moves", async () => {
  const L = await fund(1000);
  const toolId = "t-" + uuid();
  const callId = uuid();
  const decoy = await job(L.lease, L.seller, 300);
  await q("insert into tools (id, seller_id, name, price_minor) values ($1,$2,'t',300)", [toolId, L.seller]);
  const g = uuid();
  await q("begin");
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'COMMITTED_UNSETTLED','D',300,'commit',$3),
     ($1,$2,'HOLD_AVAILABLE','C',300,'commit',$3),
     ($1,$2,'HOLD_AVAILABLE','D',300,'return',$4),
     ($1,$2,'COMMITTED_UNSETTLED','C',300,'return',$4)`,
    [g, L.lease, callId, decoy],
  );
  await q(
    `insert into tool_calls (id, lease_id, tool_id, idempotency_key, price_minor, status, ledger_group_id)
     values ($1,$2,$3,$4,300,'served',$5)`,
    [callId, L.lease, toolId, "k-" + callId, g],
  );
  await q("commit");
  const tool = await one("select status from tool_calls where id=$1", [callId]);
  return `tool=${tool.status} committed=${await committedOf(L.lease)} hold_moved=${await balances(L.lease)}`;
});

// ---------- B. Capture need not name the decision that reserved the money ----------
await works("B a capture with no decision spends a released job and accrual becomes impossible", async () => {
  const L = await fund(1000);
  const rel = await releaseJob(L, 500);
  const cap = await completeCapture(L.lease, L.auth, 500, 52, null);
  let accrueJob = "allowed";
  try { await accrue(L.lease, L.seller, 448, rel.dec); }
  catch (e) { accrueJob = "blocked:" + errText(e).slice(0, 110); }
  await q("update authorizations set status='captured' where id=$1", [L.auth]);
  await succeedCall(L.lease, "void", { id: "VOID-B" });
  await voidRemainder(L.lease, 500);
  await q("update leases set state='closed' where id=$1", [L.lease]);
  const row = await one(
    `select c.decision_id::text as decision_id, l.state, a.status as auth
       from captures c join leases l on l.id=c.lease_id join authorizations a on a.id=$2
      where c.id=$1`,
    [cap.capId, L.auth],
  );
  return `capture_decision=${row.decision_id} accrue=${accrueJob} lease=${row.state} auth=${row.auth} ${await balances(L.lease)}`;
});

await works("B2 that capture's net is accrued to a different seller's tool call", async () => {
  const L = await fund(2000);
  const rel = await releaseJob(L, 500);
  await completeCapture(L.lease, L.auth, 500, 52, null);
  const attacker = await seller(30, `attacker-${uuid()}@x.com`);
  const m = await meter(L.lease, attacker, 448);
  await accrue(L.lease, attacker, 448, m.callId);
  let jobAccrue = "allowed";
  try { await accrue(L.lease, L.seller, 448, rel.dec); }
  catch (e) { jobAccrue = "blocked:" + errText(e).slice(0, 80); }
  const pay = await one(
    `select seller_id, sum(case direction when 'C' then amount_minor else -amount_minor end)::text as bal
       from ledger_entries where lease_id=$1 and account='SELLER_PAYABLE' group by seller_id`,
    [L.lease],
  );
  return `attacker_payable=${pay.bal} attacker_is_job_seller=${pay.seller_id === L.seller} job_accrue=${jobAccrue} ${await balances(L.lease)}`;
});

// ---------- C. Partial decision ----------
await works("C partial pays 250 and a second capture with no decision takes the reserved rest", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500, PARTIAL);
  await reserve(L.lease, j, 500);
  await verdict(j, "openai", "pass", 70);
  await verdict(j, "anthropic", "pass", 80);
  const dec = await decide(L.lease, j, "partial", 250, { min_score: 70, pay_bps: 5000 });
  let ret = "allowed";
  try { await postReturn(L.lease, j, 250); }
  catch (e) { ret = "blocked:" + errText(e).slice(0, 80); }
  await completeCapture(L.lease, L.auth, 250, 52, dec);
  await accrue(L.lease, L.seller, 198, dec);
  const rest = await completeCapture(L.lease, L.auth, 250, 52, null);
  const linked = await one("select decision_id is null as naked from captures where id=$1", [rest.capId]);
  return `return=${ret} naked_second=${linked.naked} committed=${await committedOf(L.lease)} ${await balances(L.lease)}`;
});

await works("C2 without that second capture the partial remainder cannot return and the lease cannot close", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500, PARTIAL);
  await reserve(L.lease, j, 500);
  await verdict(j, "openai", "pass", 70);
  await verdict(j, "anthropic", "pass", 80);
  const dec = await decide(L.lease, j, "partial", 250, { min_score: 70, pay_bps: 5000 });
  await completeCapture(L.lease, L.auth, 250, 52, dec);
  await accrue(L.lease, L.seller, 198, dec);
  let ret = "allowed";
  try { await postReturn(L.lease, j, 250); } catch (e) { ret = "blocked:" + errText(e).slice(0, 70); }
  let closed = "allowed";
  try { await q("update leases set state='closed' where id=$1", [L.lease]); }
  catch (e) { closed = "blocked:" + errText(e).slice(0, 90); }
  return `return=${ret} close=${closed} committed=${await committedOf(L.lease)}`;
});

// ---------- D. Job payout cannot be retried ----------
await works("D a cancelled job payout cannot be replaced and the seller stays payable", async () => {
  const L = await fund(2000);
  const p = await paidJob(L, 500, 52);
  const pid = await payoutRow(L.lease, L.seller, "job", p.dec, p.net);
  await q("update payouts set state='failed' where id=$1", [pid]);
  let retry = "allowed";
  try { await payoutRow(L.lease, L.seller, "job", p.dec, p.net); }
  catch (e) { retry = "blocked:" + errText(e).slice(0, 100); }
  let asMetered = "allowed";
  try { await payoutRow(L.lease, L.seller, "metered", null, p.net); }
  catch (e) { asMetered = "blocked:" + errText(e).slice(0, 80); }
  const rows = await one("select state from payouts where id=$1", [pid]);
  return `cancelled=${rows.state} retry=${retry} metered=${asMetered} ${await balances(L.lease)}`;
});

await works("D2 attaching a call that then fails from intent bricks the payout", async () => {
  const L = await fund(2000);
  const p = await paidJob(L, 500, 52);
  const pid = await payoutRow(L.lease, L.seller, "job", p.dec, p.net);
  const callId = (await one(
    "insert into paypal_calls (lease_id, op, request_id, amount_minor, state) values ($1,'payout',$2,1,'intent') returning id",
    [L.lease, uuid()],
  )).id;
  await q("update payouts set call_id=$2 where id=$1", [pid, callId]);
  await q("update paypal_calls set state='failed' where id=$1", [callId]);
  let sent = "allowed", cancel = "allowed", detach = "allowed", retry = "allowed";
  try { await q("update payouts set state='sent' where id=$1", [pid]); } catch (e) { sent = "blocked:" + errText(e).slice(0, 70); }
  try { await q("update payouts set state='failed' where id=$1", [pid]); } catch (e) { cancel = "blocked:" + errText(e).slice(0, 70); }
  try { await q("update payouts set call_id=null where id=$1", [pid]); } catch (e) { detach = "blocked:" + errText(e).slice(0, 60); }
  try { await payoutRow(L.lease, L.seller, "job", p.dec, p.net); } catch (e) { retry = "blocked:" + errText(e).slice(0, 60); }
  const call = await one("select state, response is null as no_body from paypal_calls where id=$1", [callId]);
  return `call=${call.state} no_body=${call.no_body} sent=${sent} cancel=${cancel} detach=${detach} retry=${retry}`;
});

await works("E appeal sets held_at, and a return of the released job is impossible", async () => {
  const L = await fund(2000);
  const p = await paidJob(L, 500, 52);
  const pid = await payoutRow(L.lease, L.seller, "job", p.dec, p.net);
  for (const st of ["delivered", "judging", "decided", "held"]) {
    await q("update jobs set state=$2 where id=$1", [p.job, st]);
  }
  const held = await one("select held_at is not null as h from payouts where id=$1", [pid]);
  let clear = "allowed";
  try { await q("update payouts set held_at=null where id=$1", [pid]); }
  catch (e) { clear = "blocked:" + errText(e).slice(0, 50); }
  await q("update jobs set state='judging' where id=$1", [p.job]);
  await q("update jobs set state='decided' where id=$1", [p.job]);
  let ret = "allowed";
  try { await postReturn(L.lease, p.job, 500); } catch (e) { ret = "blocked:" + errText(e).slice(0, 70); }
  let retry = "allowed";
  try { await payoutRow(L.lease, L.seller, "job", p.dec, 1); } catch (e) { retry = "blocked:" + errText(e).slice(0, 60); }
  delayed.push(async () => {
    const due = await one("select release_at <= now() as due, held_at is not null as held from payouts where id=$1", [pid]);
    let sent = "allowed";
    try {
      const callId = (await one(
        "insert into paypal_calls (lease_id, op, request_id, state) values ($1,'payout',$2,'intent') returning id",
        [L.lease, uuid()],
      )).id;
      await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
      await q("update payouts set state='sent', call_id=$2 where id=$1", [pid, callId]);
    } catch (e) { sent = "blocked:" + errText(e).slice(0, 90); }
    line("WORKS", "E after the hold window the appealed payout still cannot be sent", `due=${due.due} held_at=${due.held} sent=${sent}`);
  });
  return `held_at=${held.h} clear=${clear} job_back_to=decided return=${ret} retry=${retry}`;
});

// ---------- F. One payout call backs two payouts. Built now, sent after the hold. ----------
await works("F setup two job payouts that will share one payout call", async () => {
  const L = await fund(5000);
  const a = await paidJob(L, 500, 52);
  const b = await paidJob(L, 500, 52);
  const p1 = await payoutRow(L.lease, L.seller, "job", a.dec, a.net);
  const p2 = await payoutRow(L.lease, L.seller, "job", b.dec, b.net);
  const callId = (await one(
    "insert into paypal_calls (lease_id, op, request_id, amount_minor, state) values ($1,'payout',$2,1,'intent') returning id",
    [L.lease, uuid()],
  )).id;
  delayed.push(async () => {
    await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
    await q("update payouts set call_id=$2 where id=$1", [p1, callId]);
    await q("update payouts set call_id=$2 where id=$1", [p2, callId]);
    await q("update payouts set state='sent' where id=$1", [p1]);
    await q("update payouts set state='sent' where id=$1", [p2]);
    await q(
      `update paypal_calls set state='succeeded', http_status=201,
         response='{"batch_header":{"payout_batch_id":"BATCH-SHARED","batch_status":"SUCCESS"}}'::jsonb,
         resolved_at=now() where id=$1`,
      [callId],
    );
    await q("update payouts set state='success', paypal_batch_id='BATCH-SHARED' where id=$1", [p1]);
    await q("update payouts set state='success', paypal_batch_id='BATCH-SHARED' where id=$1", [p2]);
    const g1 = uuid();
    const g2 = uuid();
    await q(
      `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,$3,'SELLER_PAYABLE','D',$4,'payout',$5), ($1,$2,null,'CAPTURED_GROSS','C',$4,'payout',$5)`,
      [g1, L.lease, L.seller, a.net, p1],
    );
    await q(
      `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,$3,'SELLER_PAYABLE','D',$4,'payout',$5), ($1,$2,null,'CAPTURED_GROSS','C',$4,'payout',$5)`,
      [g2, L.lease, L.seller, b.net, p2],
    );
    const n = await one(
      `select count(*)::int as rows, count(distinct call_id)::int as calls,
              count(distinct paypal_batch_id)::int as batches,
              sum(amount_minor)::text as paid
         from payouts where id in ($1,$2)`,
      [p1, p2],
    );
    const call = await one("select amount_minor::text as amt, state from paypal_calls where id=$1", [callId]);
    line("WORKS", "F one payout call of 1 cent and one batch id settle two payouts",
      `rows=${n.rows} calls=${n.calls} batches=${n.batches} paid=${n.paid} call_amount=${call.amt} call_state=${call.state} ${await balances(L.lease)}`);
  });
  return `payouts=${p1},${p2} call=${callId} call_amount_minor=1`;
});

// ---------- G. A required hold unlocks a round that can void a unanimous pass ----------
await works("G a hold after the first pass lets round 2 void both passes", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500);
  await reserve(L.lease, j, 500);
  await verdict(j, "openai", "pass", 95, 1);
  await decide(L.lease, j, "hold", 0, {});
  await verdict(j, "anthropic", "pass", 96, 1);
  await verdict(j, "openai", "fail", 10, 2);
  await verdict(j, "anthropic", "fail", 11, 2);
  const dec = await decide(L.lease, j, "void", 0, {});
  const rounds = (await q(
    "select round, judge_provider, verdict from verdicts where job_id=$1 order by round, judge_provider",
    [j],
  )).rows.map((r) => `r${r.round}:${r.judge_provider}=${r.verdict}`).join(",");
  const outcome = await one("select outcome from decisions where id=$1", [dec]);
  await postReturn(L.lease, j, 500);
  let release = "allowed";
  try { await decide(L.lease, j, "release", 500, { min_score: 96, pay_bps: 10000 }); }
  catch (e) { release = "blocked:" + errText(e).slice(0, 50); }
  return `outcome=${outcome.outcome} ${rounds} reserve_returned committed=${await committedOf(L.lease)} later_release=${release}`;
});

await works("G2 the same two passes release when no hold was inserted first", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500);
  await verdict(j, "openai", "pass", 95, 1);
  await verdict(j, "anthropic", "pass", 96, 1);
  const dec = await decide(L.lease, j, "release", 500, { min_score: 95, pay_bps: 10000 });
  return `outcome=release decision=${dec}`;
});

await holds("G control round 2 is refused when there has been no hold", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500);
  await verdict(j, "openai", "pass", 95, 1);
  await verdict(j, "anthropic", "pass", 96, 1);
  await verdict(j, "openai", "fail", 10, 2);
});

// ---------- H. Lease expired bricks accrual ----------
await works("H expired after a capture refuses accrual and cannot become active again", async () => {
  const L = await fund(1000);
  const m = await meter(L.lease, L.seller, 300);
  await completeCapture(L.lease, L.auth, 300, 52, null);
  await q("update leases set state='expired' where id=$1", [L.lease]);
  let acc = "allowed", back = "allowed";
  try { await accrue(L.lease, L.seller, 248, m.callId); } catch (e) { acc = "blocked:" + errText(e).slice(0, 70); }
  try { await q("update leases set state='active' where id=$1", [L.lease]); } catch (e) { back = "blocked:" + errText(e).slice(0, 60); }
  const st = await one("select state from leases where id=$1", [L.lease]);
  return `state=${st.state} accrue=${acc} back=${back} ${await balances(L.lease)}`;
});

// ---------- I. Reversal leaves payable with no clawback ----------
await works("I reversal after accrual leaves the seller payable and blocks a new payout", async () => {
  const L = await fund(2000);
  const p = await paidJob(L, 500, 52);
  await q("begin");
  await q("update captures set status='reversed' where id=$1", [p.capId]);
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'CHARGEBACK_LOSS','D',500,'reversal',$3), ($1,$2,'CAPTURED_GROSS','C',500,'reversal',$3)`,
    [uuid(), L.lease, p.capId],
  );
  await q("commit");
  let pay = "allowed";
  try { await payoutRow(L.lease, L.seller, "job", p.dec, p.net); }
  catch (e) { pay = "blocked:" + errText(e).slice(0, 80); }
  let claw = "allowed";
  try {
    await q(
      `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values
       ($1,$2,$3,'SELLER_PAYABLE','D',$4,'payout',$5)`,
      [uuid(), L.lease, L.seller, p.net, "claw-" + uuid()],
    );
  } catch (e) { claw = "blocked:" + errText(e).slice(0, 60); }
  return `new_payout=${pay} clawback_leg=${claw} ${await balances(L.lease)}`;
});

// ---------- Decline with no PayPal evidence ----------
await works("J a capture is declined and written off while its call is still intent, then the lease closes", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 1000);
  await reserve(L.lease, j, 1000);
  const capId = uuid();
  const callId = uuid();
  await q("begin");
  await q(
    "insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,1000,'intent')",
    [callId, L.lease, uuid()],
  );
  await q(
    "insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,1000,'intent')",
    [capId, L.lease, L.auth, callId],
  );
  await q("update captures set status='declined' where id=$1", [capId]);
  await q("commit");
  const mid = await one(
    "select c.status, p.state, p.response is null as no_body from captures c join paypal_calls p on p.id=c.call_id where c.id=$1",
    [capId],
  );
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'WRITTEN_OFF','D',1000,'writeoff',$3), ($1,$2,'COMMITTED_UNSETTLED','C',1000,'writeoff',$3)`,
    [uuid(), L.lease, capId],
  );
  await q("update paypal_calls set state='failed' where id=$1", [callId]);
  await q("update authorizations set status='expired' where id=$1", [L.auth]);
  await q("update leases set state='closed' where id=$1", [L.lease]);
  const end = await one(
    `select l.state as lease, a.status as auth, p.state as call, p.http_status, p.response is null as no_body, c.status as capture
       from leases l join authorizations a on a.lease_id=l.id join captures c on c.lease_id=l.id join paypal_calls p on p.id=c.call_id
      where l.id=$1`,
    [L.lease],
  );
  const calls = await one(
    "select count(*) filter (where state='succeeded')::int as succeeded from paypal_calls where lease_id=$1",
    [L.lease],
  );
  return `at_decline capture=${mid.status} call=${mid.state} no_body=${mid.no_body}; closed lease=${end.lease} auth=${end.auth} call=${end.call} http=${end.http_status} no_body=${end.no_body} capture=${end.capture} succeeded_calls=${calls.succeeded} ${await balances(L.lease)}`;
});

// ---------- K. Authorization terminal status with no call ----------
await works("K created can become expired, denied, or captured with no PayPal call", async () => {
  const out = [];
  for (const status of ["expired", "denied", "captured"]) {
    const L = await fund(100);
    await q("update authorizations set status=$2 where id=$1", [L.auth, status]);
    const n = await one("select count(*)::int as n from paypal_calls where lease_id=$1", [L.lease]);
    const row = await one("select status from authorizations where id=$1", [L.auth]);
    out.push(`${status}=${row.status}/calls=${n.n}`);
  }
  return out.join(" ");
});

await holds("K a child on the same day is still refused, expired parent or not", async () => {
  const L = await fund(1000);
  await q("update authorizations set status='expired' where id=$1", [L.auth]);
  await q(
    `insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     values ($1,$2,$3,1000,'created', now(), now() + interval '3 days', now() + interval '29 days')`,
    [L.lease, L.auth, "AUTH-" + uuid()],
  );
});

// ---------- L. The role cannot log in. RESET ROLE returns to the session owner. ----------
await works("L pashadhara_app is nologin, and RESET ROLE returns to the session user", async () => {
  let login = "connected";
  const attempt = new Client({ connectionString: "postgres://pashadhara_app@127.0.0.1:15435/postgres" });
  try { await attempt.connect(); await attempt.end(); }
  catch (e) { login = errText(e).slice(0, 120); }
  await q("reset role");
  const back = await one("select current_user, session_user");
  await q("set role pashadhara_app");
  return `login=${login} after_reset=${back.current_user} session=${back.session_user}`;
});

// ---------- M. Fee text that rounds to zero ----------
await works("M PayPal fee text 0.001 completes as fee 0 and the gross is accrued", async () => {
  const L = await fund(1000);
  const m = await meter(L.lease, L.seller, 300);
  const cap = await completeCapture(L.lease, L.auth, 300, 0, null, "0.001");
  await accrue(L.lease, L.seller, 300, m.callId);
  const fee = await one("select fee_minor::text as f from captures where id=$1", [cap.capId]);
  const body = await one("select response #>> '{seller_receivable_breakdown,paypal_fee,value}' as fee from paypal_calls where id=$1", [cap.callId]);
  return `stored_fee_text=${body.fee} fee_minor=${fee.f} ${await balances(L.lease)}`;
});

// ---------- N. Deferred timing ----------
await holds("N SET CONSTRAINTS IMMEDIATE rejects the first leg of a balanced commit", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 100);
  await q("begin");
  await q("set constraints ledger_commit_checks immediate");
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id)
     values ($1,$2,'COMMITTED_UNSETTLED','D',100,'commit',$3)`,
    [uuid(), L.lease, j],
  );
});

await holds("N a completed capture cannot commit without its posting", async () => {
  const L = await fund(1000);
  await meter(L.lease, L.seller, 100);
  const capId = uuid();
  const callId = uuid();
  const pp = "PP-" + capId;
  await q("begin");
  await q("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,100,'intent')", [callId, L.lease, uuid()]);
  await q("insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,100,'intent')", [capId, L.lease, L.auth, callId]);
  await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
  await q("update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb where id=$1", [callId, captureBody(pp, 100, 52)]);
  await q("update captures set status='completed', fee_minor=52, paypal_capture_id=$2 where id=$1", [capId, pp]);
  await q("commit");
});

// ---------- Ported v0.3 attacks that should now hold ----------
await holds("V03 over cap", async () => {
  const L = await fund(1000);
  await meter(L.lease, L.seller, 1000);
  await completeCapture(L.lease, L.auth, 1001, 0);
});
await holds("V03 reversed then declined", async () => {
  const L = await fund(1000);
  const rel = await releaseJob(L, 200);
  const cap = await completeCapture(L.lease, L.auth, 200, 0, rel.dec);
  await q("begin");
  await q("update captures set status='reversed' where id=$1", [cap.capId]);
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'CHARGEBACK_LOSS','D',200,'reversal',$3), ($1,$2,'CAPTURED_GROSS','C',200,'reversal',$3)`,
    [uuid(), L.lease, cap.capId],
  );
  await q("commit");
  await q("update captures set status='declined' where id=$1", [cap.capId]);
});
await holds("V03 second in-flight capture", async () => {
  const L = await fund(1000);
  await meter(L.lease, L.seller, 300);
  const a = uuid();
  const callA = uuid();
  await q("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,100,'intent')", [callA, L.lease, uuid()]);
  await q("insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,100,'intent')", [a, L.lease, L.auth, callA]);
  await q("update captures set status='pending' where id=$1", [a]);
  const callB = uuid();
  await q("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,100,'intent')", [callB, L.lease, uuid()]);
  await q("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,100,'intent')", [L.lease, L.auth, callB]);
});
await holds("V03 accrue to a seller with no job and no tool call", async () => {
  const L = await fund(1000);
  const rel = await releaseJob(L, 300);
  await completeCapture(L.lease, L.auth, 300, 52, rel.dec);
  const stranger = await seller(30, `stranger-${uuid()}@x.com`);
  await accrue(L.lease, stranger, 248, rel.dec);
});
await holds("V03 fee posting 0 when the response says 0.59", async () => {
  const L = await fund(1000);
  await meter(L.lease, L.seller, 300);
  await completeCapture(L.lease, L.auth, 300, 0, null, "0.59");
});
await holds("V03 two captures share one call", async () => {
  const L = await fund(1000);
  await meter(L.lease, L.seller, 300);
  const callId = uuid();
  await q("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,200,'intent')", [callId, L.lease, uuid()]);
  await q("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,200,'intent')", [L.lease, L.auth, callId]);
  await q("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,100,'intent')", [L.lease, L.auth, callId]);
});
await holds("V03 rewrite a succeeded response", async () => {
  const L = await fund(1000);
  const rel = await releaseJob(L, 50);
  const cap = await completeCapture(L.lease, L.auth, 50, 0, rel.dec);
  await q("update paypal_calls set response='{\"id\":\"EVIL\"}'::jsonb, http_status=500 where id=$1", [cap.callId]);
});
await holds("V03 honor_until 400 days out", async () => {
  const s = await seller();
  const lease = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await q(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     values ($1,$2,1000,'created', now() - interval '10 days', now() + interval '400 days', now() + interval '400 days')`,
    [lease, "AUTH-" + uuid()],
  );
  return s;
});
await holds("V03 precheck_failed false voids one unsure", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500);
  await verdict(j, "openai", "unsure", 50);
  await decide(L.lease, j, "void", 0, { precheck_failed: false });
});
await holds("V03 precheck_failed string true voids with zero judges", async () => {
  const L = await fund(1000);
  const j = await job(L.lease, L.seller, 500);
  await decide(L.lease, j, "void", 0, { precheck_failed: "true" });
});
await holds("V03 rubric that pays a worse score more", async () => {
  const L = await fund(1000);
  await job(L.lease, L.seller, 500, JSON.stringify([{ min_score: 0, pay_bps: 10000 }, { min_score: 90, pay_bps: 0 }]));
});
await holds("V03 rewrite payout amount", async () => {
  const L = await fund(2000);
  const p = await paidJob(L, 500, 52);
  const pid = await payoutRow(L.lease, L.seller, "job", p.dec, p.net);
  await q("update payouts set amount_minor=999999 where id=$1", [pid]);
});
await holds("V03 app creates a temp table", async () => {
  await q("create temp table leases (id uuid, cap_minor bigint)");
});
await holds("V03 app updates kernel_settings", async () => {
  await q("update kernel_settings set value='400 days' where key='created_at_slack'");
});
await holds("V03 app disables the cap trigger", async () => {
  await q("alter table captures disable trigger captures_insert");
});
await holds("V03 authorize of 1 cent then active", async () => {
  const lease = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await q(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     values ($1,$2,1000,'created', now(), now() + interval '3 days', now() + interval '29 days')`,
    [lease, "AUTH-" + uuid()],
  );
  const g = uuid();
  await q(
    `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
     ($1,$2,'HOLD_AVAILABLE','D',1,'authorize',$3), ($1,$2,'BUYER_COMMITMENT','C',1,'authorize',$3)`,
    [g, lease, "auth-" + uuid()],
  );
  await q("update leases set state='active' where id=$1", [lease]);
});
await holds("V03 sent call failed with a null response", async () => {
  const L = await fund(100);
  const id = (await one("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'capture',$2,'intent') returning id", [L.lease, uuid()])).id;
  await q("update paypal_calls set state='sent', sent_at=now() where id=$1", [id]);
  await q("update paypal_calls set state='failed' where id=$1", [id]);
});
await holds("V03 deliveries jump by a million", async () => {
  const id = "WH-" + uuid();
  await q("insert into webhook_events (id, event_type, resource, signature_verified) values ($1,'X','{}',true)", [id]);
  await q("update webhook_events set deliveries=1000000 where id=$1", [id]);
});
await holds("V03 tool price update", async () => {
  const L = await fund(100);
  await q("insert into tools (id, seller_id, name, price_minor) values ($1,$2,'t',25)", ["price-" + uuid(), L.seller]);
  const id = (await one("select id from tools where seller_id=$1", [L.seller])).id;
  await q("update tools set price_minor=999999 where id=$1", [id]);
});
await holds("V03 void posting without a void call", async () => {
  const L = await fund(1000);
  await voidRemainder(L.lease, 1000);
});
await holds("V03 close while the authorization is live", async () => {
  const L = await fund(1000);
  await succeedCall(L.lease, "void", { id: "VOID-X" });
  await voidRemainder(L.lease, 1000);
  await q("update leases set state='closed' where id=$1", [L.lease]);
});
await holds("V03 day-0 child", async () => {
  const L = await fund(1000);
  await succeedCall(L.lease, "reauthorize", { id: "RE-1" });
  await q("update authorizations set status='superseded' where id=$1", [L.auth]);
  await q(
    `insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     values ($1,$2,$3,1000,'created', now(), now() + interval '3 days', now() + interval '29 days')`,
    [L.lease, L.auth, "AUTH-" + uuid()],
  );
});
await holds("V03 succeeded capture regressed to declined", async () => {
  const L = await fund(1000);
  const rel = await releaseJob(L, 100);
  const cap = await completeCapture(L.lease, L.auth, 100, 0, rel.dec);
  await q("update captures set status='declined' where id=$1", [cap.capId]);
});

// ---------- time-dependent sends ----------
{
  const due = await one("select coalesce(extract(epoch from (min(release_at) - now())), 0) as s from payouts");
  const waitMs = Math.max(0, Math.ceil(Number(due.s) * 1000) + 400);
  console.log(`RUNTIME\twaiting ${waitMs}ms for payout release_at`);
  await new Promise((r) => setTimeout(r, waitMs));
}
for (const fn of delayed) {
  try { await fn(); }
  catch (e) { await rollback(); line("MISSED", "delayed", errText(e)); }
}

console.log("RUNTIME\tdone");
await c.end();
