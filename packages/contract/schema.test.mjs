// Run: npm i @electric-sql/pglite (outside this folder or as a dev dependency), then: node schema.test.mjs [-v]
// Loads schema.sql and roles.sql into an in-memory Postgres and tries to break the invariants.
// The whole suite runs as the application role pashadhara_app, because that is the role the kernel uses. Owner-only steps say so.
// Includes regressions from docs/reviews/001-contract.md, docs/reviews/002-contract-v03.md and docs/reviews/003-contract-v04.md. Takes about 35 seconds (it waits out the 30 second payout hold).
// Not covered here: real multi-connection races (pglite is one backend). concurrency.test.mjs covers those on Postgres 15.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const roles = readFileSync(new URL("./roles.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(schema);
await db.exec(roles);

let pass = 0, fail = 0;
const verbose = process.argv.includes("-v");
async function blocked(name, fn, match) {
  try { await fn(); console.log("FAIL (not blocked):", name); fail++; }
  catch (e) {
    const m = String(e.message);
    if (!match || m.includes(match)) { pass++; if (verbose) console.log("ok   blocked:", name, "->", m.slice(0, 100)); }
    else { console.log("FAIL (wrong error):", name, "->", m.slice(0, 160)); fail++; }
  }
}
async function allowed(name, fn) {
  try { await fn(); pass++; if (verbose) console.log("ok   allowed:", name); }
  catch (e) { console.log("FAIL (should be allowed):", name, "->", String(e.message).slice(0, 180)); fail++; }
}
const one = async (q, p) => (await db.query(q, p)).rows[0];
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dollars = (c) => (c / 100).toFixed(2);

// Owner-only steps (settings, trigger-disable demos). Everything else runs as the application role.
async function asOwner(fn) { await db.exec("reset role"); try { return await fn(); } finally { await db.exec("set role pashadhara_app"); } }
await db.exec("set role pashadhara_app");

// ---------- helpers that behave like the kernel ----------
async function mkSeller(hold = 30, email = "s@x.com") {
  return (await one("insert into sellers (name, paypal_email, payout_hold_seconds) values ('s',$2,$1) returning id", [hold, email])).id;
}
async function posting(lease, refType, refId, lines) {
  const g = uuid();
  await db.transaction(async (tx) => {
    for (const [account, dir, amt, seller] of lines)
      await tx.query("insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,$3,$4,$5,$6,$7,$8)",
        [g, lease, seller ?? null, account, dir, amt, refType, refId]);
  });
  return g;
}
const P = {
  authorize: (l, x) => posting(l, "authorize", "auth-" + uuid(), [["HOLD_AVAILABLE", "D", x], ["BUYER_COMMITMENT", "C", x]]),
  accrue: (l, s, a, ref) => posting(l, "accrue", ref, [["SELLER_COST", "D", a, s], ["SELLER_PAYABLE", "C", a, s]]),
  payout: (l, s, a, ref) => posting(l, "payout", ref, [["SELLER_PAYABLE", "D", a, s], ["CAPTURED_GROSS", "C", a]]),
  voidRem: (l, r) => posting(l, "void", "v-" + uuid(), [["RELEASED", "D", r], ["HOLD_AVAILABLE", "C", r]]),
  ret: (l, r, jobId) => posting(l, "return", jobId, [["HOLD_AVAILABLE", "D", r], ["COMMITTED_UNSETTLED", "C", r]]),
  writeoff: (l, c, capId) => posting(l, "writeoff", capId, [["WRITTEN_OFF", "D", c], ["COMMITTED_UNSETTLED", "C", c]]),
  reversal: (l, capId, r) => posting(l, "reversal", capId, [["CHARGEBACK_LOSS", "D", r], ["CAPTURED_GROSS", "C", r]]),
};
// ageDays: authorization created that many days ago (needs the owner to widen created_at_slack, as a real clock would have made it true)
async function mkLease(cap = 1000, opts = {}) {
  const age = opts.ageDays ?? 0;
  const l = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',$1,$2) returning id", [cap, opts.limit ?? cap])).id;
  const insertAuth = () => one(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
    values ($1,$2,$3,'created', now() - make_interval(days => $4), now() - make_interval(days => $4) + interval '3 days', now() - make_interval(days => $4) + interval '29 days') returning id`,
    [l, "AUTH-" + uuid(), cap, age]);
  const a = age > 0 ? await asOwner(async () => {
    await db.query("update kernel_settings set value='30 days' where key='created_at_slack'");
    try { await db.exec("set role pashadhara_app"); return (await insertAuth()).id; } finally { await db.exec("reset role"); await db.query("update kernel_settings set value='1 minute' where key='created_at_slack'"); }
  }) : (await insertAuth()).id;
  await P.authorize(l, cap);
  await db.query("update leases set state='active' where id=$1", [l]);
  return { lease: l, auth: a };
}
// Metered usage: a real tool call served with its commit posting (ref_id is the tool call id).
let toolSeq = 0;
async function meter(lease, seller, price) {
  const toolId = "tool-" + (++toolSeq), callId = uuid();
  await db.query("insert into tools (id, seller_id, name, price_minor) values ($1,$2,$1,$3)", [toolId, seller, price]);
  const g = uuid();
  await db.transaction(async (tx) => {
    for (const [account, dir] of [["COMMITTED_UNSETTLED", "D"], ["HOLD_AVAILABLE", "C"]])
      await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,$3,$4,$5,'commit',$6)", [g, lease, account, dir, price, callId]);
    await tx.query("insert into tool_calls (id, lease_id, tool_id, idempotency_key, price_minor, status, ledger_group_id) values ($1,$2,$3,$4,$5,'served',$6)", [callId, lease, toolId, "k-" + callId, price, g]);
  });
  return { toolId, callId, group: g };
}
const reserve = (lease, jobId, amount) => posting(lease, "commit", jobId, [["COMMITTED_UNSETTLED", "D", amount], ["HOLD_AVAILABLE", "C", amount]]);
const captureResponse = (id, amt, fee) => JSON.stringify({ id, status: "COMPLETED", amount: { currency_code: "USD", value: dollars(amt) }, seller_receivable_breakdown: { paypal_fee: { value: dollars(fee) } } });
async function allocate(tx, lease, capture, amount, decision = null) {
  const refs=(await tx.query(`select e.ref_id, least(e.amount_minor
    - coalesce((select sum(amount_minor) from ledger_entries where lease_id=$1 and ref_id=e.ref_id and ref_type='return' and account='COMMITTED_UNSETTLED'),0),coalesce(d.amount_minor,e.amount_minor))
    - coalesce((select sum(amount_minor) from capture_allocations where lease_id=$1 and ref_id=e.ref_id),0) as remaining
    from ledger_entries e left join jobs j on j.id::text=e.ref_id
    left join decisions d on d.job_id=j.id and d.outcome in ('release','partial')
    where e.lease_id=$1 and e.ref_type='commit' and e.account='COMMITTED_UNSETTLED'
      and (($2::uuid is not null and d.id=$2) or ($2::uuid is null and (d.id is not null or exists(select 1 from tool_calls t where t.id::text=e.ref_id and t.status='served'))))
    order by e.id`,[lease,decision])).rows;
  let left=BigInt(amount);
  for(const r of refs) { const take=BigInt(r.remaining)<left?BigInt(r.remaining):left; if(take<=0n) continue;
    await tx.query('insert into capture_allocations(capture_id,lease_id,ref_id,amount_minor) values($1,$2,$3,$4)',[capture,lease,r.ref_id,take.toString()]); left-=take; if(left===0n) break;
  }
}
async function startCapture(lease, auth, amt, dec = null, explicit = null) {
  const capId = uuid(), callId = uuid();
  await db.transaction(async (tx) => {
    await tx.query("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')", [callId, lease, uuid(), amt]);
    await tx.query("insert into captures (id, lease_id, authorization_id, call_id, decision_id, amount_minor, status) values ($1,$2,$3,$4,$5,$6,'intent')", [capId, lease, auth, callId, dec, amt]);
    if(explicit===null) await allocate(tx,lease,capId,amt,dec);
    else for(const [ref,value] of explicit) await tx.query('insert into capture_allocations(capture_id,lease_id,ref_id,amount_minor) values($1,$2,$3,$4)',[capId,lease,ref,value]);
  });
  return { capId, callId };
}
async function finishCall(callId, response) {
  await db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
  await db.query("update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb, resolved_at=now() where id=$1", [callId, response]);
}
async function completeCapture(lease, auth, amt, fee, dec = null, explicit = null) {
  const capId = uuid(), callId = uuid(), ppId = "PP-" + capId;
  await db.transaction(async (tx) => {
    await tx.query("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,$4,'intent')", [callId, lease, uuid(), amt]);
    await tx.query("insert into captures (id, lease_id, authorization_id, call_id, decision_id, amount_minor, status) values ($1,$2,$3,$4,$5,$6,'intent')", [capId, lease, auth, callId, dec, amt]);
    if(explicit===null) await allocate(tx,lease,capId,amt,dec);
    else for(const [ref,value] of explicit) await tx.query('insert into capture_allocations(capture_id,lease_id,ref_id,amount_minor) values($1,$2,$3,$4)',[capId,lease,ref,value]);
    await tx.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
    await tx.query("update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb where id=$1", [callId, captureResponse(ppId, amt, fee)]);
    await tx.query("update captures set status='completed', fee_minor=$2, paypal_capture_id=$3, settled_at=now() where id=$1", [capId, fee, ppId]);
    const g = uuid();
    const rows = [["CAPTURED_GROSS", "D", amt], ["COMMITTED_UNSETTLED", "C", amt], ...(fee ? [["PAYPAL_FEES", "D", fee], ["CAPTURED_GROSS", "C", fee]] : [])];
    for (const [account, dir, a] of rows)
      await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,$3,$4,$5,'capture',$6)", [g, lease, account, dir, a, capId]);
  });
  return capId;
}
async function succeedCall(lease, op, response = "{}") {
  const id = (await one("insert into paypal_calls (lease_id, op, request_id, state) values ($1,$2,$3,'intent') returning id", [lease, op, uuid()])).id;
  await finishCall(id, response); return id;
}
async function voidAuth(lease, auth) { await succeedCall(lease, "void"); await db.query("update authorizations set status='voided' where id=$1", [auth]); }
async function supersede(lease, auth) { await succeedCall(lease, "reauthorize"); await db.query("update authorizations set status='superseded' where id=$1", [auth]); }
const RUBRIC = JSON.stringify([{ min_score: 60, pay_bps: 5000 }, { min_score: 90, pay_bps: 10000 }]);
async function mkJob(lease, seller, amount = 500, rubric = RUBRIC) {
  return (await one("insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,$3,$4) returning id", [lease, seller, amount, rubric])).id;
}
const verdict = (job, provider, v, score, round = 1) => db.query("insert into verdicts (job_id, judge_provider, model, verdict, score, round) values ($1,$2,'m',$3,$4,$5)", [job, provider, v, score, round]);
const decide = (lease, job, outcome, amount, derived = {}) =>
  db.query("insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,$3,$4,$5) returning id", [lease, job, outcome, amount, JSON.stringify(derived)]);
// A full paid job: reserve, two passes, release, completed capture tied to the decision, accrual to the job's seller.
async function paidJob(L, seller, amount = 500, fee = 52) {
  const job = await mkJob(L.lease, seller, amount);
  await reserve(L.lease, job, amount);
  await verdict(job, "openai", "pass", 95); await verdict(job, "anthropic", "pass", 92);
  const dec = (await decide(L.lease, job, "release", amount, { min_score: 92, pay_bps: 10000 })).rows[0].id;
  const cap = await completeCapture(L.lease, L.auth, amount, fee, dec);
  await P.accrue(L.lease, seller, amount - fee, dec);
  return { job, dec, cap };
}
const SELLER = await mkSeller(30);

// ================= Happy path =================
const H = await mkLease(1000);
const hm = await meter(H.lease, SELLER, 300);
await allowed("meter 300, capture 300 with fee 52, accrue 248 to the tool's seller", async () => {
  await completeCapture(H.lease, H.auth, 300, 52); await P.accrue(H.lease, SELLER, 248, hm.callId);
});
await blocked("I13 accrual beyond net captured", async () => { const m = await meter(H.lease, SELLER, 25); await P.accrue(H.lease, SELLER, 25, m.callId); }, "I13");

// ================= The role must be able to move money, and names cannot be shadowed (reviews 002 F1 F2) =================
await allowed("F1 application role commits a capture and a balanced ledger group", async () => { const L = await mkLease(500); await meter(L.lease, SELLER, 100); await completeCapture(L.lease, L.auth, 100, 0 + 52); });
await blocked("F2 temp tables cannot be created by the application role", () => db.exec("create temp table leases (id uuid)"), "permission denied");
await blocked("F2 temp-table shadow cannot beat the cap", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 1000);
  await asOwner(() => db.exec(`create temp table leases (id uuid, cap_minor bigint, state text);
    create temp table authorizations (id uuid, amount_minor bigint, status text);
    create temp table captures (lease_id uuid, authorization_id uuid, amount_minor bigint, status text, decision_id uuid, id uuid);
    insert into pg_temp.leases select '${L.lease}', 5000000, 'active'; insert into pg_temp.authorizations select '${L.auth}', 5000000, 'created';
    set search_path = pg_temp, public`));
  try {
    const callId = uuid();
    await db.query("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,5000,'intent')", [callId, L.lease, uuid()]);
    await db.query("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,5000,'intent')", [L.lease, L.auth, callId]);
  } finally {
    await asOwner(async () => { await db.exec("reset search_path"); await db.exec("drop table if exists pg_temp.leases, pg_temp.authorizations, pg_temp.captures"); });
  }
}, "");
await allowed("trigger and lock functions pin their search_path", async () => {
  const r = await one("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.prokind='f' and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))");
  if (r.n !== 0) throw new Error(r.n + " public functions have no pinned search_path");
});
await allowed("F8 lock_lease really updates the lease row (a SELECT would let repeatable read overspend)", async () => {
  const r = await one("select prosrc from pg_proc where proname='lock_lease'");
  if (!/update\s+public\.leases\s+set\s+state\s*=\s*state/i.test(r.prosrc)) throw new Error("lock_lease no longer updates the row");
});

// ================= I2 shape, I17 capture linkage =================
await blocked("I2 unbalanced group", () => posting(H.lease, "commit", "x1", [["COMMITTED_UNSETTLED", "D", 10], ["HOLD_AVAILABLE", "C", 11]]), "I2");
await blocked("B6 free-form posting", () => posting(H.lease, "commit", "x2", [["BUYER_COMMITMENT", "D", 5], ["PAYPAL_FEES", "C", 5]]), "I2");
await blocked("B2 group spanning two leases", async () => {
  const o = await mkLease(500); const g = uuid();
  await db.transaction(async (tx) => {
    await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,'COMMITTED_UNSETTLED','D',5,'commit','span-1')", [g, H.lease]);
    await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,'HOLD_AVAILABLE','C',5,'commit','span-1')", [g, o.lease]);
  });
}, "");
await blocked("commit posting that matches no job or tool call", () => posting(H.lease, "commit", "made-up", [["COMMITTED_UNSETTLED", "D", 5], ["HOLD_AVAILABLE", "C", 5]]), "I17");
await blocked("F4 capture posting with no capture row", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 600);
  await posting(L.lease, "capture", "not-a-capture-id", [["CAPTURED_GROSS", "D", 600], ["COMMITTED_UNSETTLED", "C", 600]]);
}, "I17");
await blocked("F4 completed capture never posted to the ledger", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 600);
  const { capId, callId } = await startCapture(L.lease, L.auth, 600); const pp = "PPY" + capId;
  await finishCall(callId, captureResponse(pp, 600, 52));
  await db.query("update captures set status='completed', fee_minor=52, paypal_capture_id=$2 where id=$1", [capId, pp]);
}, "I17");
await blocked("F4 return while a capture is in flight", async () => {
  const L = await mkLease(1000); const job = await mkJob(L.lease, SELLER, 1000); await reserve(L.lease, job, 1000);
  await verdict(job,'openai','pass',95); await verdict(job,'anthropic','pass',95); await decide(L.lease,job,'release',1000,{min_score:95,pay_bps:10000});
  await startCapture(L.lease, L.auth, 1000); await P.ret(L.lease, 1000, job);
}, "I17");
await blocked("F4 authorize posting of 1 cent, then the lease goes active (F7)", async () => {
  const l = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await db.query(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
    values ($1,'AUTH-tiny',1000,'created', now() + interval '3 days', now() + interval '29 days')`, [l]);
  await P.authorize(l, 1);
  await db.query("update leases set state='active' where id=$1", [l]);
}, "I16");

// ================= I3 =================
await blocked("I3 ledger update", () => db.query("update ledger_entries set amount_minor = 1"), "permission denied");
await blocked("I3 ledger delete", () => db.query("delete from ledger_entries"), "permission denied");
await blocked("B7 truncate", () => db.query("truncate ledger_entries"), "permission denied");
await blocked("I3 ledger update even as owner", () => asOwner(() => db.query("update ledger_entries set amount_minor = 1")), "I3");
await blocked("B7 owner truncate", () => asOwner(() => db.query("truncate ledger_entries")), "I3");

// ================= I4 / I16 / I13 =================
await blocked("I4 commit beyond hold", async () => { const L = await mkLease(100); await meter(L.lease, SELLER, 101); }, "");
await blocked("B1 hold of 10,000,000", async () => { const L = await mkLease(100); await posting(L.lease, "return", "big", [["HOLD_AVAILABLE", "D", 10000000], ["COMMITTED_UNSETTLED", "C", 10000000]]); }, "I");
await blocked("second authorize posting on an active lease", () => P.authorize(H.lease, 5), "refused");
await blocked("B3 duplicate posting for one reference", async () => {
  const L = await mkLease(1000); const m = await meter(L.lease, SELLER, 300);
  await posting(L.lease, "commit", m.callId, [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
}, "ledger_one_posting_per_ref");
await blocked("B5 payout posting without a payout row", () => P.payout(H.lease, SELLER, 1, "po-fake"), "I13");

// ================= Reversals (F3) =================
await allowed("reversal: capture reversed and a full reversal posting in one transaction", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const c = await completeCapture(L.lease, L.auth, 300, 52);
  await db.transaction(async (tx) => {
    await tx.query("update captures set status='reversed' where id=$1", [c]);
    const g = uuid();
    await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,'CHARGEBACK_LOSS','D',300,'reversal',$3), ($1,$2,'CAPTURED_GROSS','C',300,'reversal',$3)", [g, L.lease, c]);
  });
});
await blocked("F3 reversed capture with no reversal posting", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const c = await completeCapture(L.lease, L.auth, 300, 52);
  await db.query("update captures set status='reversed' where id=$1", [c]);
}, "I17");
await blocked("F3 reversal of 1 cent against a 300 capture", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const c = await completeCapture(L.lease, L.auth, 300, 52);
  await db.query("update captures set status='reversed' where id=$1", [c]); await P.reversal(L.lease, c, 1);
}, "I17");
await blocked("reversal of a capture that is not reversed", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const c = await completeCapture(L.lease, L.auth, 300, 52); await P.reversal(L.lease, c, 300);
}, "I17");
await allowed("declined capture: write off the served usage against that capture", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300);
  const { capId, callId } = await startCapture(L.lease, L.auth, 300);
  await finishCall(callId, '{"status":"DECLINED"}');
  await db.transaction(async tx=>{ await tx.query("update captures set status='declined' where id=$1",[capId]); await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'WRITTEN_OFF','D',300,'writeoff',$3),($1,$2,'COMMITTED_UNSETTLED','C',300,'writeoff',$3)",[uuid(),L.lease,capId]); });
});
await blocked("F10 writeoff with no declined capture", async () => {
  const L = await mkLease(1000); const m = await meter(L.lease, SELLER, 300); await P.writeoff(L.lease, 300, m.callId);
}, "I17");
await blocked("F10 return of a served tool call's usage", async () => { const L = await mkLease(1000); const m = await meter(L.lease, SELLER, 25); await P.ret(L.lease, 25, m.callId); }, "I17");

// ================= Seller identity and fees (F3) =================
await blocked("F3 accrue to a seller who did not serve the usage", async () => {
  const L = await mkLease(1000); const stranger = await mkSeller(30, "stranger@x.com");
  const m = await meter(L.lease, SELLER, 300); await completeCapture(L.lease, L.auth, 300, 52); await P.accrue(L.lease, stranger, 248, m.callId);
}, "I17");
await blocked("F3 accrual above the tool call price", async () => {
  const L = await mkLease(1000); const m = await meter(L.lease, SELLER, 100); await meter(L.lease, SELLER, 300); await completeCapture(L.lease, L.auth, 400, 52); await P.accrue(L.lease, SELLER, 200, m.callId);
}, "I17");
await blocked("F3 accrual that matches nothing", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); await completeCapture(L.lease, L.auth, 300, 52); await P.accrue(L.lease, SELLER, 100, "made-up");
}, "I17");
await blocked("F3 fee of 0 when PayPal reported 59", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300);
  const { capId, callId } = await startCapture(L.lease, L.auth, 300); const pp = "PPF" + capId;
  await finishCall(callId, captureResponse(pp, 300, 59));
  await db.query("update captures set status='completed', fee_minor=0, paypal_capture_id=$2 where id=$1", [capId, pp]);
}, "I17");
await blocked("F9 capture completed while its call is still intent", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300);
  const { capId } = await startCapture(L.lease, L.auth, 300);
  await db.query("update captures set status='completed', fee_minor=52, paypal_capture_id='PPG' where id=$1", [capId]);
}, "I17");
await blocked("F9 two captures on one call", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const a = await startCapture(L.lease, L.auth, 100);
  await finishCall(a.callId,'{"status":"DECLINED"}');
  await db.transaction(async tx=>{ await tx.query("update captures set status='declined' where id=$1",[a.capId]); await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'WRITTEN_OFF','D',100,'writeoff',$3),($1,$2,'COMMITTED_UNSETTLED','C',100,'writeoff',$3)",[uuid(),L.lease,a.capId]); });
  await db.query("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,100,'intent')", [L.lease, L.auth, a.callId]);
}, "I6");
await blocked("F9 succeeded response rewritten", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const { callId } = await startCapture(L.lease, L.auth, 300);
  await finishCall(callId, captureResponse("PPH", 300, 52)); await db.query("update paypal_calls set response='{\"id\":\"EVIL\"}'::jsonb where id=$1", [callId]);
}, "frozen");
await blocked("F7 capture fee rewritten after it is set", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 100); const c = await completeCapture(L.lease, L.auth, 100, 30); await db.query("update captures set fee_minor = 0 where id=$1", [c]);
}, "frozen");
await blocked("F7 paypal_capture_id rewritten", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 100); const c = await completeCapture(L.lease, L.auth, 100, 30); await db.query("update captures set paypal_capture_id = 'OTHER' where id=$1", [c]);
}, "frozen");
await blocked("F7 paypal_order_id rewritten", async () => {
  const L = await mkLease(1000); await db.query("update leases set paypal_order_id='ORD-1' where id=$1", [L.lease]); await db.query("update leases set paypal_order_id='ORDER-ATTACKER' where id=$1", [L.lease]);
}, "frozen");

// ================= I18 exposure limit and honor period =================
await blocked("F9 commit beyond the unsettled exposure limit", async () => { const L = await mkLease(1000, { limit: 0 }); await meter(L.lease, SELLER, 10); }, "I18");
await allowed("commit up to the exposure limit", async () => { const L = await mkLease(1000, { limit: 400 }); await meter(L.lease, SELLER, 400); });
await blocked("F9 commit after the honor period", async () => { const L = await mkLease(1000, { ageDays: 4 }); await meter(L.lease, SELLER, 10); }, "I18");
await blocked("F9 honor_until moved forward", async () => { const L = await mkLease(1000, { ageDays: 4 });
  await db.query("update authorizations set honor_until = now() + interval '400 days' where id=$1", [L.auth]); }, "permission denied");
await blocked("F9 honor_until moved forward even by the owner", async () => { const L = await mkLease(1000, { ageDays: 4 });
  await asOwner(() => db.query("update authorizations set honor_until = now() + interval '400 days' where id=$1", [L.auth])); }, "Immutable");
await blocked("F6 root with honor_until 400 days out", async () => {
  const l = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await db.query(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
    values ($1,'AUTH-long',1000,'created', now(), now() + interval '400 days', now() + interval '401 days')`, [l]);
}, "I8");
await blocked("F6 root backdated beyond the allowed clock slack", async () => {
  const l = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await db.query(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
    values ($1,'AUTH-old',1000,'created', now() - interval '10 days', now() - interval '7 days', now() + interval '19 days')`, [l]);
}, "I8");
await blocked("F6 root created in the future", async () => {
  const l = (await one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await db.query(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
    values ($1,'AUTH-fut',1000,'created', now() + interval '1 day', now() + interval '4 days', now() + interval '30 days')`, [l]);
}, "I8");

// ================= I1 caps, state machines, in-flight =================
const L2 = await mkLease(1000);
await meter(L2.lease, SELLER, 1000);
await blocked("capture must be inserted as intent", async () => {
  const callId = uuid(); await db.query("insert into paypal_calls (id, lease_id, op, request_id, state) values ($1,$2,'capture',$3,'intent')", [callId, L2.lease, uuid()]);
  await db.query("insert into captures (lease_id, authorization_id, call_id, amount_minor, status, fee_minor, paypal_capture_id) values ($1,$2,$3,10,'completed',0,'PPZ')", [L2.lease, L2.auth, callId]);
}, "intent");
await db.query("update paypal_calls set state='failed' where lease_id=$1 and state='intent'", [L2.lease]);
await blocked("I6 capture without a capture call row", () => db.query("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,10,'intent')", [L2.lease, L2.auth, uuid()]), "");
await allowed("capture 600", () => completeCapture(L2.lease, L2.auth, 600, 52));
await blocked("I1 capture over cap", () => startCapture(L2.lease, L2.auth, 401), "I1");
await allowed("capture exactly the remaining 400", () => completeCapture(L2.lease, L2.auth, 400, 52));
await blocked("A2 move capture to another lease", async () => { const o = await mkLease(5000); await db.query("update captures set lease_id=$1 where lease_id=$2", [o.lease, L2.lease]); }, "permission denied");
await blocked("A3 capture using another lease's authorization", async () => { const o = await mkLease(5000); const x = await mkLease(100); await meter(x.lease, SELLER, 50); await startCapture(x.lease, o.auth, 50); }, "foreign key");
await blocked("A5 raise lease cap", () => db.query("update leases set cap_minor = 999999 where id=$1", [L2.lease]), "permission denied");
await blocked("A6 raise authorization amount", () => db.query("update authorizations set amount_minor = 999999 where id=$1", [L2.auth]), "permission denied");
await blocked("A4 capture on a voided authorization", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 10); await voidAuth(L.lease, L.auth); await startCapture(L.lease, L.auth, 10);
}, "Capture refused");
await blocked("F10 void status without a succeeded void call", async () => { const L = await mkLease(1000); await db.query("update authorizations set status='voided' where id=$1", [L.auth]); }, "void");
await blocked("F3 voided authorization resurrected", async () => {
  const L = await mkLease(1000); await voidAuth(L.lease, L.auth); await db.query("update authorizations set status='created' where id=$1", [L.auth]);
}, "not allowed");
await blocked("F3 superseded authorization resurrected", async () => {
  const L = await mkLease(1000); await supersede(L.lease, L.auth); await db.query("update authorizations set status='partially_captured' where id=$1", [L.auth]);
}, "not allowed");
const L3 = await mkLease(1000); await meter(L3.lease, SELLER, 1000);
const cap3 = await completeCapture(L3.lease, L3.auth, 1000, 52);
await allowed("completed to reversed with its reversal posting", () => db.transaction(async (tx) => {
  await tx.query("update captures set status='reversed' where id=$1", [cap3]);
  const g = uuid();
  await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,'CHARGEBACK_LOSS','D',1000,'reversal',$3), ($1,$2,'CAPTURED_GROSS','C',1000,'reversal',$3)", [g, L3.lease, cap3]);
}));
await blocked("F1 reversed to declined frees the cap", () => db.query("update captures set status='declined' where id=$1", [cap3]), "terminal");
await blocked("F1 reversed capture still consumes the cap", () => startCapture(L3.lease, L3.auth, 1), "I1");
await blocked("F1 completed to declined", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 100); const c = await completeCapture(L.lease, L.auth, 100, 52); await db.query("update captures set status='declined' where id=$1", [c]);
}, "not allowed");
await blocked("F1 declined to completed", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 100); const { capId, callId } = await startCapture(L.lease, L.auth, 100);
  await finishCall(callId, '{"status":"DECLINED"}');
  await db.transaction(async tx=>{await tx.query("update captures set status='declined' where id=$1",[capId]); await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'WRITTEN_OFF','D',100,'writeoff',$3),($1,$2,'COMMITTED_UNSETTLED','C',100,'writeoff',$3)",[uuid(),L.lease,capId]);});
  await db.query("update captures set status='completed', fee_minor=52, paypal_capture_id='PPD' where id=$1", [capId]);
}, "terminal");
await blocked("F1 pending and unknown rows are in flight too", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 300); const a = await startCapture(L.lease, L.auth, 100);
  await db.query("update captures set status='pending' where id=$1", [a.capId]); await finishCall(a.callId, "{}"); await startCapture(L.lease, L.auth, 100);
}, "one_capture_in_flight");
await blocked("completed capture without a fee", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 100); const a = await startCapture(L.lease, L.auth, 100);
  await db.query("update captures set status='completed' where id=$1", [a.capId]);
}, "");

// ================= I5 / I7 PayPal call states =================
const L4 = await mkLease(1000);
await allowed("capture call intent", () => db.query("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'capture',$2,'intent')", [L4.lease, uuid()]));
await blocked("I5 second money call in flight", () => db.query("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'void',$2,'intent')", [L4.lease, uuid()]), "one_money_call_in_flight");
await allowed("get calls do not block", () => db.query("insert into paypal_calls (lease_id, op, request_id, state, sent_at) values ($1,'get',$2,'sent', now())", [L4.lease, uuid()]));
await blocked("duplicate request_id", async () => { const r = uuid(); const L = await mkLease(100);
  await db.query("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'get',$2,'intent')", [L.lease, r]);
  await db.query("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'get',$2,'intent')", [L.lease, r]); }, "request_id");
await blocked("F3 sent call flipped to failed with no response", async () => {
  const L = await mkLease(100); const id = (await one("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'capture',$2,'intent') returning id", [L.lease, uuid()])).id;
  await db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [id]); await db.query("update paypal_calls set state='failed' where id=$1", [id]);
}, "I7");
await blocked("F3 sent call cannot fail straight from intent after sending", async () => {
  const L = await mkLease(100); const id = (await one("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'capture',$2,'intent') returning id", [L.lease, uuid()])).id;
  await db.query("update paypal_calls set state='failed', sent_at=now() where id=$1", [id]);
}, "cannot fail");
await allowed("sent call resolved to failed with a PayPal response", async () => {
  const L = await mkLease(100); const id = (await one("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'capture',$2,'intent') returning id", [L.lease, uuid()])).id;
  await db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [id]);
  await db.query("update paypal_calls set state='unknown' where id=$1", [id]);
  await db.query("update paypal_calls set state='failed', response='{\"status\":\"none found\"}'::jsonb where id=$1", [id]);
});
await blocked("terminal call state cannot change", async () => {
  const L = await mkLease(100); const id = (await one("insert into paypal_calls (lease_id, op, request_id, state) values ($1,'capture',$2,'intent') returning id", [L.lease, uuid()])).id;
  await db.query("update paypal_calls set state='failed' where id=$1", [id]); await db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [id]);
}, "not allowed");

// ================= I8 lineage =================
const L5 = await mkLease(1000, { ageDays: 4 });
await blocked("I8 second root authorization", () => db.query(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
  values ($1,'AUTH-root2',1000,'captured', now() + interval '3 days', now() + interval '20 days')`, [L5.lease]), "I8");
await blocked("I8 two live authorizations", () => db.query(`insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
  values ($1,$2,'AUTH-live2',1000,'created', now() + interval '3 days', now() + interval '25 days')`, [L5.lease, L5.auth]), "I8");
const R = await mkLease(1000, { ageDays: 4 });
await supersede(R.lease, R.auth);
const kid = (lease, parent, amt, tag) => db.query(`insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
  values ($1,$2,$3,$4,'created', now() + interval '3 days', now() + interval '25 days')`, [lease, parent, "AUTH-" + tag, amt]);
await blocked("D3 parent from another lease", async () => { const o = await mkLease(1000, { ageDays: 4 }); await kid(R.lease, o.auth, 1000, "xl"); }, "foreign key");
await blocked("I8 reauth amount must equal the remaining cap", () => kid(R.lease, R.auth, 900, "bad"), "I8");
await allowed("I8 reauth after the honor period at exact remaining cap", () => kid(R.lease, R.auth, 1000, "ok1"));
await blocked("F3 day-0 child authorization", async () => {
  const L = await mkLease(1000); await supersede(L.lease, L.auth); await kid(L.lease, L.auth, 1000, "early");
}, "I8");
await blocked("F6 child dated in the future to fake the 3-day gap", async () => {
  const L = await mkLease(1000); await supersede(L.lease, L.auth);
  await db.query(`insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
    values ($1,$2,'AUTH-fake',1000,'created', now() + interval '3 days', now() + interval '6 days', now() + interval '25 days')`, [L.lease, L.auth]);
}, "I8");
await blocked("F6 grandchild (second reauthorization) until a logged day-4 test says it works", async () => {
  const L = await mkLease(1000, { ageDays: 4 }); await supersede(L.lease, L.auth); await kid(L.lease, L.auth, 1000, "c1");
  const child = (await one("select id from authorizations where paypal_authorization_id='AUTH-c1'")).id;
  await db.query("update authorizations set status='partially_captured' where id=$1", [child]); await supersede(L.lease, child); await kid(L.lease, child, 1000, "c2");
}, "I8");

// ================= Jobs, verdicts, decisions =================
const L6 = await mkLease(5000);
await blocked("rubric must be valid", () => mkJob(L6.lease, SELLER, 500, JSON.stringify([{ min_score: 50, pay_bps: 20000 }])), "Rubric");
await blocked("rubric must not be empty", () => mkJob(L6.lease, SELLER, 500, "[]"), "Rubric");
await blocked("F5 rubric that pays a worse score more", () => mkJob(L6.lease, SELLER, 500, JSON.stringify([{ min_score: 0, pay_bps: 10000 }, { min_score: 90, pay_bps: 0 }])), "Rubric");
await blocked("F5 rubric with duplicate min_score", () => mkJob(L6.lease, SELLER, 500, JSON.stringify([{ min_score: 50, pay_bps: 5000 }, { min_score: 50, pay_bps: 5000 }])), "Rubric");
const j1 = await mkJob(L6.lease, SELLER, 500); await reserve(L6.lease, j1, 500);
await blocked("provider outside the allow-list", () => verdict(j1, "acme", "pass", 90), "foreign key");
await blocked("provider case variants are not providers", () => verdict(j1, "OpenAI", "pass", 90), "foreign key");
await allowed("job hash set before any verdict", () => db.query("update jobs set deliverable_hash='h1' where id=$1", [j1]));
await verdict(j1, "openai", "pass", 95);
await blocked("hash frozen once a verdict exists", () => db.query("update jobs set deliverable_hash='h2' where id=$1", [j1]), "frozen");
await blocked("C7 same provider twice in a round", () => verdict(j1, "openai", "pass", 95), "verdicts_job_id_judge_provider_round_key");
await blocked("C1 release with one provider only", () => decide(L6.lease, j1, "release", 500, { min_score: 95, pay_bps: 10000 }), "I11");
await allowed("one provider so far: hold", () => decide(L6.lease, j1, "hold", 0));
await allowed("second verdict may arrive in the same round after a hold", () => verdict(j1, "anthropic", "pass", 92));
await blocked("I10 release amount must equal the derived amount", () => decide(L6.lease, j1, "release", 400, { min_score: 92, pay_bps: 10000 }), "I10");
await blocked("I10 derived_from must record the real score", () => decide(L6.lease, j1, "release", 500, { min_score: 100, pay_bps: 10000 }), "I10");
await blocked("F10 void after two passes would rob the seller", () => decide(L6.lease, j1, "void", 0), "I10");
await blocked("F10 hold after two passes", () => decide(L6.lease, j1, "hold", 0), "I10");
const dec1 = (await decide(L6.lease, j1, "release", 500, { min_score: 92, pay_bps: 10000 })).rows[0].id;
await blocked("verdict after a final decision", () => verdict(j1, "xai", "pass", 99), "already decided");
await blocked("second final decision", () => decide(L6.lease, j1, "release", 500, { min_score: 92, pay_bps: 10000 }), "one_final_decision_per_job");
const j2 = await mkJob(L6.lease, SELLER, 500); await reserve(L6.lease, j2, 500);
await verdict(j2, "openai", "pass", 70); await verdict(j2, "anthropic", "pass", 80);
await blocked("partial: full release not allowed at score 70", () => decide(L6.lease, j2, "release", 500, { min_score: 70, pay_bps: 5000 }), "I10");
await blocked("partial: wrong amount", () => decide(L6.lease, j2, "partial", 400, { min_score: 70, pay_bps: 5000 }), "I10");
await allowed("partial at 5000 bps pays 250", () => decide(L6.lease, j2, "partial", 250, { min_score: 70, pay_bps: 5000 }));
const j3 = await mkJob(L6.lease, SELLER, 500, JSON.stringify([{ min_score: 50, pay_bps: 5000 }])); await reserve(L6.lease, j3, 500);
await verdict(j3, "openai", "pass", 0); await verdict(j3, "anthropic", "pass", 0);
await blocked("M1 release when both scores are 0", () => decide(L6.lease, j3, "release", 500, { min_score: 0, pay_bps: 0 }), "I10");
await allowed("M1 zero-paying rubric result is a void", () => decide(L6.lease, j3, "void", 0));
const j4 = await mkJob(L6.lease, SELLER, 500); await reserve(L6.lease, j4, 500);
await verdict(j4, "openai", "pass", 95); await verdict(j4, "anthropic", "unsure", 50);
await blocked("F10 one unsure cannot release", () => decide(L6.lease, j4, "release", 500, { min_score: 95, pay_bps: 10000 }), "I11");
await blocked("F10 one unsure cannot void a good seller", () => decide(L6.lease, j4, "void", 0), "I11");
await blocked("N1 one unsure cannot void with precheck_failed false", () => decide(L6.lease, j4, "void", 0, { precheck_failed: false }), "I11");
await blocked("N1 one unsure cannot void with precheck_failed true", () => decide(L6.lease, j4, "void", 0, { precheck_failed: true }), "I11");
await allowed("F10 one unsure holds", () => decide(L6.lease, j4, "hold", 0));
const j5 = await mkJob(L6.lease, SELLER, 500); await verdict(j5, "openai", "pass", 95); await verdict(j5, "anthropic", "fail", 10);
await blocked("disagreement cannot release", () => decide(L6.lease, j5, "release", 500, { min_score: 95, pay_bps: 10000 }), "I11");
await blocked("disagreement cannot void", () => decide(L6.lease, j5, "void", 0), "I11");
await blocked("N1 one fail cannot void with precheck_failed false", () => decide(L6.lease, j5, "void", 0, { precheck_failed: false }), "I11");
await allowed("disagreement holds", () => decide(L6.lease, j5, "hold", 0));
await allowed("F5 a new round after a hold lets fresh judges settle it", async () => {
  await verdict(j5, "xai", "pass", 95, 2); await verdict(j5, "google", "pass", 95, 2);
  await decide(L6.lease, j5, "release", 500, { min_score: 95, pay_bps: 10000 });
});
await blocked("a new round before any hold", async () => { const j = await mkJob(L6.lease, SELLER, 500); await verdict(j, "openai", "pass", 95); await verdict(j, "anthropic", "pass", 95, 2); }, "round");
const j6 = await mkJob(L6.lease, SELLER, 500); await verdict(j6, "openai", "fail", 5); await verdict(j6, "anthropic", "fail", 10);
await blocked("two fails cannot hold forever", () => decide(L6.lease, j6, "hold", 0), "I11");
await allowed("two fails void", () => decide(L6.lease, j6, "void", 0));
const j7 = await mkJob(L6.lease, SELLER, 500);
await blocked("N1 void with precheck_failed false and zero judges", () => decide(L6.lease, j7, "void", 0, { precheck_failed: false }), "I11");
await blocked("N1 void with no precheck_failed key and zero judges", () => decide(L6.lease, j7, "void", 0, {}), "I11");
await allowed("failed pre-check voids with zero judges", () => decide(L6.lease, j7, "void", 0, { precheck_failed: true }));
await blocked("fake pre-check cannot override passes", async () => {
  const j = await mkJob(L6.lease, SELLER, 500); await verdict(j, "openai", "pass", 95); await verdict(j, "anthropic", "pass", 95);
  await decide(L6.lease, j, "void", 0, { precheck_failed: true });
}, "I10");
await blocked("verdict update", () => db.query("update verdicts set verdict='fail'"), "permission denied");
await blocked("decision update", () => db.query("update decisions set amount_minor = 900000"), "permission denied");
await blocked("verdict update even as owner", () => asOwner(() => db.query("update verdicts set verdict='fail'")), "append-only");
await blocked("decision delete even as owner", () => asOwner(() => db.query("delete from decisions")), "append-only");
await blocked("capture beyond a decision (I9)", async () => { await completeCapture(L6.lease, L6.auth, 500, 52, dec1); await startCapture(L6.lease, L6.auth, 1, dec1); }, "I9");
await blocked("C4 capture tied to a decision of another lease", async () => {
  const j = await mkJob(L6.lease, SELLER, 100); await verdict(j, "openai", "pass", 95); await verdict(j, "anthropic", "pass", 95);
  const d = (await decide(L6.lease, j, "release", 100, { min_score: 95, pay_bps: 10000 })).rows[0].id;
  const x = await mkLease(100); await meter(x.lease, SELLER, 50); await startCapture(x.lease, x.auth, 50, d);
}, "foreign key");

// ================= Close, void, return =================
await blocked("E1 close with the hold still open", async () => { const L = await mkLease(1000); await db.query("update leases set state='closed' where id=$1", [L.lease]); }, "I14");
await blocked("E1b close with an unresolved PayPal call", async () => {
  const L = await mkLease(1000); await succeedCall(L.lease, "void"); await db.query("update authorizations set status='voided' where id=$1", [L.auth]); await P.voidRem(L.lease, 1000);
  await db.query("insert into paypal_calls (lease_id, op, request_id, state, sent_at) values ($1,'capture',$2,'unknown', now())", [L.lease, uuid()]);
  await db.query("update leases set state='closed' where id=$1", [L.lease]);
}, "I14");
await blocked("F10 void posting without a succeeded void call", async () => { const L = await mkLease(1000); await P.voidRem(L.lease, 1000); }, "I17");
await blocked("F10 close while the authorization is still live", async () => {
  const L = await mkLease(1000); await succeedCall(L.lease, "void"); await P.voidRem(L.lease, 1000); await db.query("update leases set state='closed' where id=$1", [L.lease]);
}, "I14");
const closeOk = async () => { const L = await mkLease(1000); const m=await meter(L.lease, SELLER, 300); await completeCapture(L.lease, L.auth, 300, 52); await P.accrue(L.lease,SELLER,248,m.callId);
  await voidAuth(L.lease, L.auth); await P.voidRem(L.lease, 700); await db.query("update leases set state='closed' where id=$1", [L.lease]); return L; };
await allowed("close after meter, capture, void call, void remainder", closeOk);
await blocked("E2 commit on a closed lease", async () => { const L = await closeOk(); await meter(L.lease, SELLER, 5); }, "");
await blocked("capture on a closed lease", async () => { const L = await closeOk(); await startCapture(L.lease, L.auth, 10); }, "");
await blocked("closed lease cannot reopen", async () => { const L = await closeOk(); await db.query("update leases set state='active' where id=$1", [L.lease]); }, "not allowed");

// ================= Tool calls =================
const T = await mkLease(1000);
await db.query("insert into tools (id, seller_id, name, price_minor) values ('t1',$1,'t1',25)", [SELLER]);
await blocked("E3 tool call price differs from tool price", () => db.query("insert into tool_calls (lease_id, tool_id, idempotency_key, price_minor, status) values ($1,'t1','k0',1,'refused_cap')", [T.lease]), "price");
await blocked("E3b served call without a ledger group", () => db.query("insert into tool_calls (lease_id, tool_id, idempotency_key, price_minor, status) values ($1,'t1','k1',25,'served')", [T.lease]), "commit posting");
await blocked("E3c served call pointing at a group that does not exist", () => db.query("insert into tool_calls (lease_id, tool_id, idempotency_key, price_minor, status, ledger_group_id) values ($1,'t1','k2',25,'served',$2)", [T.lease, uuid()]), "commit posting");
await allowed("refused call needs no ledger group", () => db.query("insert into tool_calls (lease_id, tool_id, idempotency_key, price_minor, status) values ($1,'t1','k4',25,'refused_cap')", [T.lease]));
await blocked("F11 tool price changed by the application role", () => db.query("update tools set price_minor = 999999 where id='t1'"), "permission denied");

// ================= Webhooks =================
await allowed("webhook stored unverified", () => db.query("insert into webhook_events (id, event_type, resource, signature_verified) values ('WH-U','X','{}',false)"));
await blocked("B4 unverified event cannot be processed", () => db.query("update webhook_events set processed_at=now() where id='WH-U'"), "I12");
await blocked("B4 unverified event rewritten to verified", () => db.query("update webhook_events set signature_verified=true where id='WH-U'"), "permission denied");
await allowed("V05.1 verified delivery of a poisoned id is stored beside the unverified row", () => db.query("insert into webhook_events (id, event_type, resource, signature_verified) values ('WH-U','X','{\"real\":1}',true) on conflict (id, signature_verified) do update set deliveries = webhook_events.deliveries + 1"));
await allowed("V05.1 verified poisoned id can be processed", () => db.query("update webhook_events set processed_at=now() where id='WH-U' and signature_verified"));
await blocked("V05.1 unverified twin still cannot be processed", () => db.query("update webhook_events set processed_at=now() where id='WH-U' and not signature_verified"), "I12");
await allowed("V05.1 exactly one verified and one unverified row for the id", async () => { const r = await db.query("select count(*) filter (where signature_verified) v, count(*) filter (where not signature_verified) u from webhook_events where id='WH-U'"); if (r.rows[0].v != 1 || r.rows[0].u != 1) throw new Error(JSON.stringify(r.rows[0])); });
await allowed("verified webhook stored", () => db.query("insert into webhook_events (id, event_type, resource, signature_verified) values ('WH-1','PAYMENT.CAPTURE.COMPLETED','{}',true)"));
await allowed("repeat delivery increments the counter", () => db.query("insert into webhook_events (id, event_type, resource, signature_verified) values ('WH-1','PAYMENT.CAPTURE.COMPLETED','{}',true) on conflict (id, signature_verified) do update set deliveries = webhook_events.deliveries + 1"));
await blocked("F11 deliveries jumped by a million", () => db.query("update webhook_events set deliveries = 1000000 where id='WH-1'"), "deliveries");
await allowed("verified event processed once", () => db.query("update webhook_events set processed_at=now() where id='WH-1'"));
await blocked("processed_at cannot be cleared", () => db.query("update webhook_events set processed_at=null where id='WH-1'"), "frozen");
await blocked("deliveries cannot decrease", () => db.query("update webhook_events set deliveries=0 where id='WH-1'"), "deliveries");

// ================= Payouts =================
const L7 = await mkLease(5000);
const pj = await paidJob(L7, SELLER, 500, 52); // accrued 448 against the decision
const payoutRow = (lease, seller, source, dec, amt, release = "now() + interval '30 seconds'") =>
  db.query(`insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at) values ($1,$2,$3,$4,$5,'queued', ${release}) returning id`, [lease, seller, source, dec, amt]);
await blocked("B3 metered payout with no accrual", async () => { const L = await mkLease(1000); await payoutRow(L.lease, SELLER, "metered", null, 100000000); }, "I13");
await blocked("payout above the seller accrual", () => payoutRow(L7.lease, SELLER, "job", pj.dec, 449), "I13");
await blocked("payout release before the hold window", () => payoutRow(L7.lease, SELLER, "job", pj.dec, 448, "now()"), "I13");
await blocked("payout to a seller who did not do the job", async () => {
  const L = await mkLease(5000); const S2 = await mkSeller(30, "other@x.com");
  const pjx = await paidJob(L, SELLER, 500, 52);
  const m = await meter(L.lease, S2, 500); await completeCapture(L.lease, L.auth, 500, 52); await P.accrue(L.lease, S2, 448, m.callId);
  await payoutRow(L.lease, S2, "job", pjx.dec, 10);
}, "I13");
await blocked("payout without a completed capture", async () => {
  const L = await mkLease(2000); const job = await mkJob(L.lease, SELLER, 100); await reserve(L.lease, job, 100);
  await verdict(job, "openai", "pass", 95); await verdict(job, "anthropic", "pass", 95);
  const d = (await decide(L.lease, job, "release", 100, { min_score: 95, pay_bps: 10000 })).rows[0].id;
  await payoutRow(L.lease, SELLER, "job", d, 10);
}, "I13");
const pid = (await payoutRow(L7.lease, SELLER, "job", pj.dec, 448)).rows[0].id;
await blocked("C5b second payout row for one decision", async () => {
  const L = await mkLease(5000); const px = await paidJob(L, SELLER, 500, 52);
  await payoutRow(L.lease, SELLER, "job", px.dec, 100); await payoutRow(L.lease, SELLER, "job", px.dec, 100);
}, "one_payout_per_decision");
await blocked("F5 payout amount rewritten", () => db.query("update payouts set amount_minor = 999999 where id=$1", [pid]), "permission denied");
await blocked("F5 payout seller rewritten", async () => { const S3 = await mkSeller(30, "s3@x.com"); await db.query("update payouts set seller_id=$1 where id=$2", [S3, pid]); }, "permission denied");
await blocked("F5 payout state skipped to success", () => db.query("update payouts set state='success' where id=$1", [pid]), "not allowed");
await blocked("F5 payout sent before release_at", () => db.query("update payouts set state='sent' where id=$1", [pid]), "I13");
await blocked("F5 seller payout address changed", () => asOwner(() => db.query("update sellers set paypal_email='thief@x.com' where id=$1", [SELLER])), "immutable");
await blocked("F5 seller hold shortened", () => db.query("update sellers set payout_hold_seconds=29 where id=$1", [SELLER]), "");
await blocked("seller hold below 30 seconds", () => mkSeller(0), "payout_hold_seconds");
await blocked("N5 payout failed with a PayPal batch id and no evidence", async () => {
  const L = await mkLease(5000); const px = await paidJob(L, SELLER, 500, 52); const p = (await payoutRow(L.lease, SELLER, "job", px.dec, 448)).rows[0].id;
  await db.query("update payouts set paypal_batch_id='BATCH-REAL' where id=$1", [p]);
}, "I13");
await blocked("N5 queued payout failed, then the same accrual reissued as metered", async () => {
  const L = await mkLease(5000); const px = await paidJob(L, SELLER, 500, 52); const p = (await payoutRow(L.lease, SELLER, "job", px.dec, 448)).rows[0].id;
  await db.query("update payouts set state='failed' where id=$1", [p]); await payoutRow(L.lease, SELLER, "metered", null, 448);
}, "I13");
await allowed("a cancelled (never sent) job payout is a clean failure", async () => {
  const L = await mkLease(5000); const px = await paidJob(L, SELLER, 500, 52); const p = (await payoutRow(L.lease, SELLER, "job", px.dec, 448)).rows[0].id;
  await db.query("update payouts set state='failed' where id=$1", [p]);
});
await allowed("N5 appeal (job held) holds the queued payout", async () => {
  const L = await mkLease(5000); const px = await paidJob(L, SELLER, 500, 52); const p = (await payoutRow(L.lease, SELLER, "job", px.dec, 448)).rows[0].id;
  for (const st of ["delivered", "judging", "decided", "held"]) await db.query("update jobs set state=$2 where id=$1", [px.job, st]);
  const r = await one("select held_at is not null as held from payouts where id=$1", [p]);
  if (!r.held) throw new Error("appeal did not hold the payout");
});
await blocked("job state machine: settled cannot go back to open", async () => {
  const L = await mkLease(5000); const job = await mkJob(L.lease, SELLER, 100);
  for (const st of ["delivered", "judging", "decided", "settled"]) await db.query("update jobs set state=$2 where id=$1", [job, st]);
  await db.query("update jobs set state='open' where id=$1", [job]);
}, "not allowed");
const Lrev = await mkLease(5000); const pjr = await paidJob(Lrev, SELLER, 500, 52);
const pidRev = (await payoutRow(Lrev.lease, SELLER, "job", pjr.dec, 448)).rows[0].id;
{ const m=await meter(Lrev.lease, SELLER, 100); const c = await completeCapture(Lrev.lease, Lrev.auth, 100, 52); await P.accrue(Lrev.lease,SELLER,48,m.callId);
  await db.transaction(async (tx) => { await tx.query("update captures set status='reversed' where id=$1", [c]);
    await tx.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,'CHARGEBACK_LOSS','D',100,'reversal',$3), ($1,$2,'CAPTURED_GROSS','C',100,'reversal',$3)", [uuid(), Lrev.lease, c]); }); }
const L9 = await mkLease(5000); const pj9 = await paidJob(L9, SELLER, 500, 52);
const pidFree = (await payoutRow(L9.lease, SELLER, "job", pj9.dec, 448)).rows[0].id;
await allowed("appeal holds the payout through the job trigger", async()=>{ for(const st of ["delivered","judging","decided","held"]) await db.query("update jobs set state=$2 where id=$1",[pj.job,st]); });
await blocked("held_at cannot be cleared or moved", () => db.query("update payouts set held_at=null where id=$1", [pid]).then(() => db.query("update payouts set held_at=now() + interval '1 day' where id=$1", [pid])), "frozen");

// ================= Application role limits =================
await allowed("app role can insert a lease", () => db.query("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('x',100,100)"));
await blocked("app role cannot disable triggers", () => db.exec("alter table captures disable trigger captures_insert"), "owner");
await blocked("app role cannot rewrite verdicts", () => db.exec("update verdicts set score = 100"), "permission denied");
await blocked("app role cannot edit the posting shapes", () => db.exec("insert into posting_shapes values ('x','RELEASED','D')"), "permission denied");
await blocked("app role cannot change the kernel settings", () => db.exec("update kernel_settings set value='400 days'"), "permission denied");
await blocked("app role cannot replace lock_lease", () => db.exec("create or replace function lock_lease(uuid) returns lease_state language sql as 'select state from leases limit 1'"), "");
await blocked("app role still hits the state machine", async () => {
  const L = await mkLease(1000); await meter(L.lease, SELLER, 100); const c = await completeCapture(L.lease, L.auth, 100, 52);
  await db.exec(`update captures set status='declined' where id='${c}'`);
}, "not allowed");

// ================= v0.5 allocation and lifecycle coverage =================
await blocked('V05 review partial single accrual cannot strand net',async()=>{
  const L=await mkLease(); const m=await meter(L.lease,SELLER,600); await completeCapture(L.lease,L.auth,600,52); await P.accrue(L.lease,SELLER,200,m.callId);
});
await blocked('V05 review accrual waits for all allocated captures',async()=>{
  const L=await mkLease(); const m=await meter(L.lease,SELLER,600); await completeCapture(L.lease,L.auth,300,52); await startCapture(L.lease,L.auth,300); await P.accrue(L.lease,SELLER,248,m.callId);
});
await blocked('V05 review job and served tool cannot share commit identity',async()=>{
  const L=await mkLease(); const j=await mkJob(L.lease,SELLER,300); const g=await reserve(L.lease,j,300); const other=await mkSeller(); const tool='collision-'+uuid();
  await db.query("insert into tools(id,seller_id,name,price_minor) values($1,$2,'test',300)",[tool,other]);
  await db.query("insert into tool_calls(id,lease_id,tool_id,idempotency_key,price_minor,status,ledger_group_id) values($1,$2,$3,$4,300,'served',$5)",[j,L.lease,tool,uuid(),g]);
});
for(const kind of ['missing','over-ref','cross-lease','uncommitted']) await blocked(`V05 allocation ${kind}`,async()=>{
  const L=await mkLease(); const m=await meter(L.lease,SELLER,300); await meter(L.lease,SELLER,300);
  let ref=m.callId,amount=300;
  if(kind==='missing') amount=299;
  if(kind==='over-ref') amount=400;
  if(kind==='cross-lease') {const O=await mkLease(); ref=(await meter(O.lease,SELLER,300)).callId;}
  if(kind==='uncommitted') {ref=await mkJob(L.lease,SELLER,300); await verdict(ref,'openai','pass',95); await verdict(ref,'anthropic','pass',95); await decide(L.lease,ref,'release',300,{min_score:95,pay_bps:10000});}
  await startCapture(L.lease,L.auth,kind==='missing'?300:amount,null,[[ref,amount]]);
});
await blocked('V05 decision capture allocates only its own job',async()=>{
  const L=await mkLease(2000); const j=await mkJob(L.lease,SELLER,500); await reserve(L.lease,j,500);
  await verdict(j,'openai','pass',95); await verdict(j,'anthropic','pass',95); const d=(await decide(L.lease,j,'release',500,{min_score:95,pay_bps:10000})).rows[0].id;
  const m=await meter(L.lease,SELLER,300); await startCapture(L.lease,L.auth,100,d,[[m.callId,100]]);
});
await allowed('V05 batch across two sellers and a job accounts for every net cent',async()=>{
  const L=await mkLease(2000); const s=await mkSeller(); const m=await meter(L.lease,SELLER,301),n=await meter(L.lease,s,199);
  const j=await mkJob(L.lease,s,500); await reserve(L.lease,j,500); await verdict(j,'openai','pass',95); await verdict(j,'anthropic','pass',95);
  const d=(await decide(L.lease,j,'release',500,{min_score:95,pay_bps:10000})).rows[0].id;
  const c=await completeCapture(L.lease,L.auth,1000,53,null,[[m.callId,301],[n.callId,199],[j,500]]);
  const rows=(await db.query('select ref_id,amount_minor,net_minor from allocation_nets where capture_id=$1 order by ref_id',[c])).rows;
  if(rows.reduce((sum,r)=>sum+BigInt(r.net_minor),0n)!==947n) throw Error('net cents lost');
  let cumulative=0n,prior=0n; for(const r of rows) {cumulative+=BigInt(r.amount_minor); const next=947n*cumulative/1000n;
    if(BigInt(r.net_minor)!==next-prior) throw Error('wrong individual net share'); prior=next;}
  for(const r of rows) await P.accrue(L.lease,r.ref_id===m.callId?SELLER:s,Number(r.net_minor),r.ref_id===j?d:r.ref_id);
  await voidAuth(L.lease,L.auth); await P.voidRem(L.lease,1000); await db.query("update leases set state='closed' where id=$1",[L.lease]);
});
await blocked('V05 close refuses completed but unaccrued net',async()=>{
  const L=await mkLease(); await meter(L.lease,SELLER,300); await completeCapture(L.lease,L.auth,300,52); await voidAuth(L.lease,L.auth); await P.voidRem(L.lease,700);
  await db.query("update leases set state='closed' where id=$1",[L.lease]);
},'unaccrued');
await allowed('V05 multiple captures of one ref before accrual',async()=>{
  const L=await mkLease(); const m=await meter(L.lease,SELLER,600); const a=await completeCapture(L.lease,L.auth,300,52),b=await completeCapture(L.lease,L.auth,300,52);
  await P.accrue(L.lease,SELLER,496,m.callId);
  await db.transaction(async tx=>{await tx.query("update captures set status='reversed' where id=$1",[a]);
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CHARGEBACK_LOSS','D',300,'reversal',$3),($1,$2,'CAPTURED_GROSS','C',300,'reversal',$3)",[uuid(),L.lease,a]);});
  await posting(L.lease,'clawback',a,[['SELLER_PAYABLE','D',248,SELLER],['SELLER_COST','C',248,SELLER]]);
  if((await one('select public.uncovered_clawbacks($1) as frozen',[L.lease])).frozen) throw Error('covered clawback stays frozen');
});
await allowed('V05 fully captured authorization can become captured',async()=>{
  const L=await mkLease(); await meter(L.lease,SELLER,1000); await completeCapture(L.lease,L.auth,1000,52);
  await db.query("update authorizations set status='captured' where id=$1",[L.auth]);
});
await allowed('V05 held payout can cancel and be replaced',async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id;
  for(const st of ['delivered','judging','decided','held']) await db.query('update jobs set state=$2 where id=$1',[a.job,st]);
  await db.query("update payouts set state='failed' where id=$1",[p]); await payoutRow(L.lease,SELLER,'job',a.dec,448);
});
await allowed('V05 attached unsent intent payout can cancel',async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id;
  const c=(await one("insert into paypal_calls(lease_id,op,request_id,amount_minor,state) values($1,'payout',$2,448,'intent') returning id",[L.lease,uuid()])).id;
  await db.query('update payouts set call_id=$2 where id=$1',[p,c]); await db.query("update payouts set state='failed' where id=$1",[p]);
});
await blocked('V05 clawback is capped at attributable accrual',async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER);
  await db.transaction(async tx=>{await tx.query("update captures set status='reversed' where id=$1",[a.cap]);
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CHARGEBACK_LOSS','D',500,'reversal',$3),($1,$2,'CAPTURED_GROSS','C',500,'reversal',$3)",[uuid(),L.lease,a.cap]);});
  await posting(L.lease,'clawback',a.cap,[['SELLER_PAYABLE','D',449,SELLER],['SELLER_COST','C',449,SELLER]]);
});
await allowed('V05 seeded legitimate flow walk, seed 503, 24 leases',async()=>{
  let seed=503; const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<24;i++) {
    const L=await mkLease(); const price=100+random()%200, fee=random()%30;
    const m=await meter(L.lease,SELLER,price); const j=await mkJob(L.lease,SELLER,100); await reserve(L.lease,j,100); await P.ret(L.lease,100,j);
    if(random()%3===0) {
      const c=await startCapture(L.lease,L.auth,price); await finishCall(c.callId,'{"status":"DENIED"}');
      await db.transaction(async tx=>{await tx.query("update captures set status='denied' where id=$1",[c.capId]);
        await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'WRITTEN_OFF','D',$3,'writeoff',$4),($1,$2,'COMMITTED_UNSETTLED','C',$3,'writeoff',$4)",[uuid(),L.lease,price,c.capId]);});
    } else {
      const c=await completeCapture(L.lease,L.auth,price,fee); await P.accrue(L.lease,SELLER,price-fee,m.callId);
      if(random()%2===0) {
        await db.transaction(async tx=>{await tx.query("update captures set status='reversed' where id=$1",[c]);
          await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CHARGEBACK_LOSS','D',$3,'reversal',$4),($1,$2,'CAPTURED_GROSS','C',$3,'reversal',$4)",[uuid(),L.lease,price,c]);});
        await posting(L.lease,'clawback',c,[['SELLER_PAYABLE','D',price-fee,SELLER],['SELLER_COST','C',price-fee,SELLER]]);
      }
    }
    await voidAuth(L.lease,L.auth); await P.voidRem(L.lease,1000-price); await db.query("update leases set state='closed' where id=$1",[L.lease]);
    const r=await one(`select sum(case when account='BUYER_COMMITMENT' then amount_minor else 0 end)::text buyer,
      sum(case when account in ('HOLD_AVAILABLE','COMMITTED_UNSETTLED','RELEASED','WRITTEN_OFF') then case direction when 'D' then amount_minor else -amount_minor end
        when account='CAPTURED_GROSS' and ref_type='capture' and direction='D' then amount_minor else 0 end)::text accounted
      from ledger_entries where lease_id=$1`,[L.lease]);
    if(BigInt(r.buyer)!==1000n || r.buyer!==r.accounted) throw Error('conservation failed at step '+i);
    const unpaid=await one(`select count(*)::int n from allocation_nets a join captures c on c.id=a.capture_id where a.lease_id=$1 and c.status='completed'
      and not exists(select 1 from ledger_entries e where e.lease_id=$1 and e.ref_type='accrue' and e.ref_id=a.ref_id and e.amount_minor=a.net_minor)`,[L.lease]);
    if(unpaid.n) throw Error('closable lease has unpaid capture at step '+i);
  }
});
const payoutCases={};
for(const name of ['amountMismatch','responseMismatch','batchReuse','successNoPosting','sentRetry']) {
  const L=await mkLease(); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id; payoutCases[name]={L,a,p};
}
await allowed('V05 mixed job and metered clawback preserves unaffected source',async()=>{
  const L=await mkLease(5000); const m=await meter(L.lease,SELLER,500),j=await mkJob(L.lease,SELLER,500); await reserve(L.lease,j,500);
  await verdict(j,'openai','pass',95); await verdict(j,'anthropic','pass',95); const d=(await decide(L.lease,j,'release',500,{min_score:95,pay_bps:10000})).rows[0].id;
  const c=await completeCapture(L.lease,L.auth,1000,53,null,[[m.callId,500],[j,500]]);
  const shares=(await db.query('select ref_id,net_minor from allocation_nets where capture_id=$1 order by ref_id',[c])).rows;
  if(BigInt(shares[0].net_minor)!==473n || BigInt(shares[1].net_minor)!==474n) throw Error('wrong batch share');
  for(const r of shares) await P.accrue(L.lease,SELLER,Number(r.net_minor),r.ref_id===j?d:r.ref_id);
  const n=await meter(L.lease,SELLER,1000); await completeCapture(L.lease,L.auth,1000,52); await P.accrue(L.lease,SELLER,948,n.callId);
  await db.transaction(async tx=>{await tx.query("update captures set status='reversed' where id=$1",[c]);
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CHARGEBACK_LOSS','D',1000,'reversal',$3),($1,$2,'CAPTURED_GROSS','C',1000,'reversal',$3)",[uuid(),L.lease,c]);});
  await posting(L.lease,'clawback',c,[['SELLER_PAYABLE','D',947,SELLER],['SELLER_COST','C',947,SELLER]]);
  const recoveries=(await db.query('select ref_id,recovered_minor,net_minor from allocation_recoveries where capture_id=$1',[c])).rows;
  if(recoveries.some(r=>r.recovered_minor!==r.net_minor)) throw Error('wrong source recovery');
  const p=(await payoutRow(L.lease,SELLER,'metered',null,800)).rows[0].id; payoutCases.mixedRecovered={L,p};
});

// ================= v0.5 regressions, written before schema fixes =================
await blocked("V05 review direct success insert bypasses call and hold",async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER);
  await db.transaction(async tx=>{
    const p=(await tx.query("insert into payouts(lease_id,seller_id,source,decision_id,amount_minor,state,release_at) values($1,$2,'job',$3,448,'success',now()+interval '30 seconds') returning id",[L.lease,SELLER,a.dec])).rows[0].id;
    await tx.query("insert into ledger_entries(group_id,lease_id,seller_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,$3,'SELLER_PAYABLE','D',448,'payout',$4),($1,$2,null,'CAPTURED_GROSS','C',448,'payout',$4)",[uuid(),L.lease,SELLER,p]);
  });
});
const recovered=await (async()=>{
  const L=await mkLease(5000); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id;
  const m=await meter(L.lease,SELLER,1000); await completeCapture(L.lease,L.auth,1000,52); await P.accrue(L.lease,SELLER,948,m.callId);
  await db.transaction(async tx=>{await tx.query("update captures set status='reversed' where id=$1",[a.cap]);
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CHARGEBACK_LOSS','D',500,'reversal',$3),($1,$2,'CAPTURED_GROSS','C',500,'reversal',$3)",[uuid(),L.lease,a.cap]);});
  await posting(L.lease,'clawback',a.cap,[['SELLER_PAYABLE','D',448,SELLER],['SELLER_COST','C',448,SELLER]]);return {L,a,p};
})();
await blocked("V05 F1 decoy job cannot return served usage", async () => {
  const L = await mkLease(); await meter(L.lease, SELLER, 300);
  const j = await mkJob(L.lease, SELLER, 300); await P.ret(L.lease, 300, j);
});
await blocked("V05 F1 commit and return cannot share a group", async () => {
  const L = await mkLease(); const j = await mkJob(L.lease, SELLER, 300); const g = uuid();
  await db.transaction(async tx => {
    for (const [type, account, dir] of [["commit","COMMITTED_UNSETTLED","D"],["commit","HOLD_AVAILABLE","C"],["return","HOLD_AVAILABLE","D"],["return","COMMITTED_UNSETTLED","C"]])
      await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,$3,$4,300,$5,$6)", [g,L.lease,account,dir,type,j]);
  });
});
await blocked("V05 F2 capture without allocations", async () => {
  const L = await mkLease(); await meter(L.lease, SELLER, 300);
  await db.transaction(async tx => {
    const call = uuid(); await tx.query("insert into paypal_calls(id,lease_id,op,request_id,amount_minor,state) values($1,$2,'capture',$3,300,'intent')",[call,L.lease,uuid()]);
    await tx.query("insert into captures(lease_id,authorization_id,call_id,amount_minor,status) values($1,$2,$3,300,'intent')",[L.lease,L.auth,call]);
  });
});
await blocked("V05 F2 another seller cannot accrue uncaptured usage", async () => {
  const L = await mkLease(); const j=await mkJob(L.lease,SELLER,500); await reserve(L.lease,j,500);
  await verdict(j,'openai','pass',95); await verdict(j,'anthropic','pass',95);
  const d=(await decide(L.lease,j,'release',500,{min_score:95,pay_bps:10000})).rows[0].id;
  await completeCapture(L.lease,L.auth,500,52,d);
  const other = await mkSeller(); const m = await meter(L.lease,other,448); await P.accrue(L.lease,other,448,m.callId);
});
await allowed("V05 F2 partial capture and unpaid return finish", async () => {
  const L = await mkLease(); const j = await mkJob(L.lease,SELLER,500); await reserve(L.lease,j,500);
  await verdict(j,'openai','pass',70); await verdict(j,'anthropic','pass',80);
  const d = (await decide(L.lease,j,'partial',250,{min_score:70,pay_bps:5000})).rows[0].id;
  await P.ret(L.lease,250,j); await completeCapture(L.lease,L.auth,250,52,d); await P.accrue(L.lease,SELLER,198,d);
  await voidAuth(L.lease,L.auth); await P.voidRem(L.lease,750); await db.query("update leases set state='closed' where id=$1",[L.lease]);
});
await blocked("V05 F3 early hold cannot advance incomplete round", async () => {
  const L=await mkLease(); const j=await mkJob(L.lease,SELLER); await verdict(j,'openai','pass',95); await decide(L.lease,j,'hold',0); await verdict(j,'anthropic','fail',10,2);
});
await blocked("V05 F3 early hold cannot override unanimous passes", async () => {
  const L=await mkLease(); const j=await mkJob(L.lease,SELLER); await verdict(j,'openai','pass',95); await decide(L.lease,j,'hold',0); await verdict(j,'anthropic','pass',96); await verdict(j,'openai','fail',10,2);
});
await blocked("V05 F4 decline requires PayPal evidence", async () => {
  const L=await mkLease(); await meter(L.lease,SELLER,300); const c=await startCapture(L.lease,L.auth,300);
  await db.query("update captures set status='declined' where id=$1",[c.capId]); await P.writeoff(L.lease,300,c.capId);
});
await blocked("V05 F4 decline requires atomic full writeoff", async () => {
  const L=await mkLease(); await meter(L.lease,SELLER,300); const c=await startCapture(L.lease,L.auth,300); await finishCall(c.callId,'{"status":"DECLINED"}');
  await db.query("update captures set status='declined' where id=$1",[c.capId]);
});
for (const status of ['expired','denied','captured']) await blocked(`V05 F4 authorization ${status} needs evidence`,async()=>{
  const L=await mkLease(); await db.query("update authorizations set status=$2 where id=$1",[L.auth,status]);
});
await blocked("V05 child requires succeeded reauthorize",async()=>{
  const L=await mkLease(1000,{ageDays:4});
  const a=await one('select paypal_authorization_id from authorizations where id=$1',[L.auth]);
  await succeedCall(L.lease,'get',JSON.stringify({id:a.paypal_authorization_id,status:'EXPIRED'}));
  await db.query("update authorizations set status='expired' where id=$1",[L.auth]); await kid(L.lease,L.auth,1000,'no-reauth-'+uuid());
});
await blocked("V05 F5 payout call cannot be shared",async()=>{
  const L=await mkLease(5000); const a=await paidJob(L,SELLER), b=await paidJob(L,SELLER);
  const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id, q=(await payoutRow(L.lease,SELLER,'job',b.dec,448)).rows[0].id;
  const c=(await one("insert into paypal_calls(lease_id,op,request_id,amount_minor,state) values($1,'payout',$2,448,'intent') returning id",[L.lease,uuid()])).id;
  await db.query('update payouts set call_id=$2 where id=$1',[p,c]); await db.query('update payouts set call_id=$2 where id=$1',[q,c]);
});
await allowed("V05 F6 cancelled payout can be replaced",async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id;
  await db.query("update payouts set state='failed' where id=$1",[p]); await payoutRow(L.lease,SELLER,'job',a.dec,448);
});
await allowed("V05 F6 attached failed intent can be cancelled and replaced",async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id;
  const c=(await one("insert into paypal_calls(lease_id,op,request_id,amount_minor,state) values($1,'payout',$2,448,'intent') returning id",[L.lease,uuid()])).id;
  await db.query('update payouts set call_id=$2 where id=$1',[p,c]); await db.query("update paypal_calls set state='failed' where id=$1",[c]); await db.query("update payouts set state='failed' where id=$1",[p]); await payoutRow(L.lease,SELLER,'job',a.dec,448);
});
const appealed = await (async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER); const p=(await payoutRow(L.lease,SELLER,'job',a.dec,448)).rows[0].id;
  for(const st of ['delivered','judging','decided','held']) await db.query('update jobs set state=$2 where id=$1',[a.job,st]); return {L,a,p};
})();
await allowed("V05 F6 upheld appeal clears held_at",async()=>{
  await db.query("update jobs set state='decided' where id=$1",[appealed.a.job]);
  if((await one('select held_at from payouts where id=$1',[appealed.p])).held_at!==null) throw Error('hold not cleared');
});
for(const st of ['expired','failed']) await allowed(`V05 F7 ${st} then accrue`,async()=>{
  const L=await mkLease(); const m=await meter(L.lease,SELLER,300); await completeCapture(L.lease,L.auth,300,52); await db.query('update leases set state=$2 where id=$1',[L.lease,st]); await P.accrue(L.lease,SELLER,248,m.callId);
});
await allowed("V05 F7 reverse then clawback",async()=>{
  const L=await mkLease(); const a=await paidJob(L,SELLER);
  await db.transaction(async tx=>{ await tx.query("update captures set status='reversed' where id=$1",[a.cap]);
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CHARGEBACK_LOSS','D',500,'reversal',$3),($1,$2,'CAPTURED_GROSS','C',500,'reversal',$3)",[uuid(),L.lease,a.cap]); });
  await posting(L.lease,'clawback',a.cap, [['SELLER_PAYABLE','D',448,SELLER],['SELLER_COST','C',448,SELLER]]);
});
await allowed("V05 F8 safe login role exists",async()=>{
  const r=await one("select rolcanlogin and not rolsuper and not rolinherit as safe from pg_roles where rolname='kernel_login'"); if(!r?.safe) throw Error('safe login absent');
});
for(const field of ['amount','fee']) await blocked(`V05 F9 ${field} third decimal rejected`,async()=>{
  const L=await mkLease(); await meter(L.lease,SELLER,300); const c=await startCapture(L.lease,L.auth,300); const pp='PP-'+c.capId;
  const body=JSON.parse(captureResponse(pp,300,0)); if(field==='amount') body.amount.value='3.001'; else body.seller_receivable_breakdown.paypal_fee.value='0.001';
  await finishCall(c.callId,JSON.stringify(body));
  await db.transaction(async tx=>{ await tx.query("update captures set status='completed',fee_minor=0,paypal_capture_id=$2 where id=$1",[c.capId,pp]);
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'CAPTURED_GROSS','D',300,'capture',$3),($1,$2,'COMMITTED_UNSETTLED','C',300,'capture',$3)",[uuid(),L.lease,c.capId]); });
});
await blocked("V05 F10 negative committed reports I4 before in-flight",async()=>{
  const L=await mkLease(); const j=await mkJob(L.lease,SELLER,300); await reserve(L.lease,j,300);
  // Owner-only diagnostic: bypass the shape guard so this tests the consistency function's error order.
  await asOwner(()=>db.transaction(async tx=>{
    await tx.exec('alter table ledger_entries disable trigger ledger_shape');
    await tx.query("insert into ledger_entries(group_id,lease_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,'HOLD_AVAILABLE','D',400,'return',$3),($1,$2,'COMMITTED_UNSETTLED','C',400,'return',$3)",[uuid(),L.lease,j]);
    await tx.query('select public.check_lease_consistency($1)',[L.lease]);
    throw Error('negative balance accepted');
  }));
},'I4');

// ================= Time-dependent: payout release after the hold =================
console.log("waiting for the payout hold window...");
await sleep(31000);
async function sendPayout(F,amount=448) {
  const c=(await one("insert into paypal_calls(lease_id,op,request_id,amount_minor,state) values($1,'payout',$2,$3,'intent') returning id",[F.L.lease,uuid(),amount])).id;
  await db.query("update paypal_calls set state='sent',sent_at=now() where id=$1",[c]); await db.query("update payouts set call_id=$2,state='sent' where id=$1",[F.p,c]); return c;
}
async function payoutResponse(F,batch,amount='4.48') {
  const c=await sendPayout(F); await db.query("update paypal_calls set state='succeeded',response=$2::jsonb where id=$1",[c,JSON.stringify({batch_header:{payout_batch_id:batch,batch_status:'SUCCESS',amount:{value:amount}}})]); return c;
}
await blocked('V05 F5 sent payout call amount must match',()=>sendPayout(payoutCases.amountMismatch,1),'I13');
await allowed('V05 covered mixed reversal allows unaffected metered payout',()=>sendPayout(payoutCases.mixedRecovered,800));
await blocked('V05 F5 success response amount must match',async()=>{
  const F=payoutCases.responseMismatch; await payoutResponse(F,'BAD-AMOUNT','0.01');
  await db.query("update payouts set state='success',paypal_batch_id='BAD-AMOUNT' where id=$1",[F.p]);
},'I13');
await blocked('V05 F5 success requires atomic full posting',async()=>{
  const F=payoutCases.successNoPosting; await payoutResponse(F,'NO-POST'); await db.query("update payouts set state='success',paypal_batch_id='NO-POST' where id=$1",[F.p]);
},'full posting');
await allowed('V05 F6 sent then failed payout can be replaced',async()=>{
  const F=payoutCases.sentRetry,c=await sendPayout(F); await db.query("update paypal_calls set state='failed',response='{\"message\":\"rejected\"}' where id=$1",[c]);
  await db.query("update payouts set state='failed' where id=$1",[F.p]); await payoutRow(F.L.lease,SELLER,'job',F.a.dec,448);
});
await blocked("V05 review clawed-back queued job cannot spend metered accrual",async()=>{
  const c=(await one("insert into paypal_calls(lease_id,op,request_id,amount_minor,state) values($1,'payout',$2,448,'intent') returning id",[recovered.L.lease,uuid()])).id;
  await db.query("update paypal_calls set state='sent',sent_at=now() where id=$1",[c]); await db.query("update payouts set call_id=$2,state='sent' where id=$1",[recovered.p,c]);
});
await allowed("V05 F6 appeal then uphold then send",async()=>{
  const c=(await one("insert into paypal_calls(lease_id,op,request_id,amount_minor,state) values($1,'payout',$2,448,'intent') returning id",[appealed.L.lease,uuid()])).id;
  await db.query("update paypal_calls set state='sent',sent_at=now() where id=$1",[c]); await db.query("update payouts set call_id=$2,state='sent' where id=$1",[appealed.p,c]);
});
await blocked("F3 payouts cannot be sent on a lease that has a reversed capture", async () => {
  const callId = (await one("insert into paypal_calls (lease_id, op, request_id, amount_minor, state) values ($1,'payout',$2,448,'intent') returning id", [Lrev.lease, uuid()])).id;
  await db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
  await db.query("update payouts set call_id=$2 where id=$1", [pidRev, callId]);
  await db.query("update payouts set state='sent' where id=$1", [pidRev]);
}, "reversed capture");
await blocked("held payout cannot be sent even after release_at", () => db.query("update payouts set state='sent' where id=$1", [pid]), "I13");
await blocked("N5 payout cannot be sent without its PayPal call", () => db.query("update payouts set state='sent' where id=$1", [pidFree]), "I13");
await allowed("unheld payout is sent with its payout call", async () => {
  const callId = (await one("insert into paypal_calls (lease_id, op, request_id, amount_minor, state) values ($1,'payout',$2,448,'intent') returning id", [L9.lease, uuid()])).id;
  await db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
  await db.query("update payouts set call_id=$2 where id=$1", [pidFree, callId]);
  await db.query("update payouts set state='sent' where id=$1", [pidFree]);
  globalThis.__payCall = callId;
});
await blocked("N5 sent payout cannot be failed with a batch id and no response", () => db.query("update payouts set paypal_batch_id='BATCH-X', state='failed' where id=$1", [pidFree]), "I13");
await blocked("payout success without a batch id", () => db.query("update payouts set state='success' where id=$1", [pidFree]), "I13");
await allowed("payout call succeeds with the batch response", () => db.query("update paypal_calls set state='succeeded', http_status=201, response='{\"batch_header\":{\"payout_batch_id\":\"BATCH-1\",\"batch_status\":\"SUCCESS\",\"amount\":{\"value\":\"4.48\"}}}'::jsonb where id=$1", [globalThis.__payCall]));
await blocked("payout success with a batch id the response does not show", () => db.query("update payouts set state='success', paypal_batch_id='BATCH-FAKE' where id=$1", [pidFree]), "I13");
await allowed("sent payout succeeds with its posting atomically", () => db.transaction(async tx=>{
  await tx.query("update payouts set state='success', paypal_batch_id='BATCH-1' where id=$1",[pidFree]);
  await tx.query("insert into ledger_entries(group_id,lease_id,seller_id,account,direction,amount_minor,ref_type,ref_id) values($1,$2,$3,'SELLER_PAYABLE','D',448,'payout',$4),($1,$2,null,'CAPTURED_GROSS','C',448,'payout',$4)",[uuid(),L9.lease,SELLER,pidFree]);
}));
await blocked("payout posting with the wrong amount", () => P.payout(L9.lease, SELLER, 100, pidFree), "I13");
await allowed("payout posting from settled cash", async()=>{if((await one("select count(*)::int n from ledger_entries where ref_type='payout' and ref_id=$1",[pidFree])).n!==2) throw Error("posting missing");});
await blocked('V05 F5 a second payout cannot reuse the batch id',async()=>{
  const F=payoutCases.batchReuse; await payoutResponse(F,'BATCH-1');
  await db.query("update payouts set state='success',paypal_batch_id='BATCH-1' where id=$1",[F.p]);
},'one_payout_per_batch');
await blocked("payout cannot be posted twice", () => P.payout(L9.lease, SELLER, 448, pidFree), "ledger_one_posting_per_ref");
await blocked("terminal payout state cannot change", () => db.query("update payouts set state='failed' where id=$1", [pidFree]), "not allowed");

console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
