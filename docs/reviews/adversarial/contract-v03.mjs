// Contract v0.3 attacks. Port of contract-v02.mjs plus the cases schema.test.mjs does not run.
// PGlite is one backend: concurrency is adversarial/contract-concurrency-v03.mjs on Postgres 15.
// Run: node adversarial/contract-v03.mjs
// Requires @electric-sql/pglite. Set PGLITE_MODULE to its dist/index.js if Node cannot resolve it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const spec = process.env.PGLITE_MODULE
  ? pathToFileURL(process.env.PGLITE_MODULE).href
  : "@electric-sql/pglite";
const { PGlite } = await import(spec);
const schema = readFileSync(new URL("../packages/contract/schema.sql", import.meta.url), "utf8");
const roles = readFileSync(new URL("../packages/contract/roles.sql", import.meta.url), "utf8");

const uuid = () => crypto.randomUUID();
const errText = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 280);

function line(kind, name, detail) {
  console.log(`${kind}\t${name}\t${detail}`);
}

async function load() {
  const db = new PGlite();
  await db.exec(schema);
  await db.exec(roles);
  const one = async (q, p) => (await db.query(q, p)).rows[0];
  async function works(name, fn) {
    try { line("WORKS", name, await fn()); }
    catch (e) { try { await db.exec("rollback"); } catch { /* autocommit */ } line("MISSED", name, errText(e)); }
  }
  async function holds(name, fn) {
    try { await fn(); line("BROKEN-CONTROL", name, "was allowed"); }
    catch (e) { try { await db.exec("rollback"); } catch { /* autocommit */ } line("HOLDS", name, errText(e)); }
  }
  async function posting(lease, refType, refId, legs) {
    // The unique index is global. A shared literal like 'c' would collide across leases and hide the real error.
    if (refType !== "reversal" && refType !== "capture" && refType !== "payout") refId = `${refId}-${uuid()}`;
    const g = uuid();
    await db.transaction(async (tx) => {
      for (const [account, dir, amt, seller] of legs) {
        await tx.query(
          `insert into ledger_entries (group_id, lease_id, seller_id, account, direction, amount_minor, ref_type, ref_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [g, lease, seller ?? null, account, dir, amt, refType, refId],
        );
      }
    });
    return g;
  }
  async function fund(cap = 1000, limit = null, hold = 30) {
    const seller = (await one(
      "insert into sellers (name, paypal_email, payout_hold_seconds) values ('s','seller@x.com',$1) returning id",
      [hold],
    )).id;
    const lease = (await one(
      "insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',$1,$2) returning id",
      [cap, limit ?? cap],
    )).id;
    const auth = (await one(
      `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
       values ($1,$2,$3,'created', now() + interval '3 days', now() + interval '29 days') returning id`,
      [lease, "AUTH-" + uuid(), cap],
    )).id;
    await posting(lease, "authorize", "auth-" + uuid(), [
      ["HOLD_AVAILABLE", "D", cap],
      ["BUYER_COMMITMENT", "C", cap],
    ]);
    await db.query("update leases set state='active' where id=$1", [lease]);
    return { seller, lease, auth };
  }
  async function callRow(lease, amt, state = "intent") {
    return (await one(
      `insert into paypal_calls (lease_id, op, request_id, amount_minor, state)
       values ($1,'capture',$2,$3,$4) returning id`,
      [lease, uuid(), amt, state],
    )).id;
  }
  async function captureIntent(lease, auth, amt, decision = null, call = null) {
    const callId = call ?? await callRow(lease, amt);
    const id = (await one(
      `insert into captures (lease_id, authorization_id, call_id, decision_id, amount_minor, status)
       values ($1,$2,$3,$4,$5,'intent') returning id`,
      [lease, auth, callId, decision, amt],
    )).id;
    return { id, callId };
  }
  // Status, fee and the capture posting have to commit together. I17 rejects a completed row with no posting.
  async function finish(tx, lease, capId, callId, amt, fee, pp, opts = {}) {
    if (!opts.leaveCall) {
      await tx.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
      await tx.query(
        "update paypal_calls set state='succeeded', http_status=201, response='{\"id\":\"measured\"}'::jsonb, resolved_at=now() where id=$1",
        [callId],
      );
    }
    await tx.query(
      "update captures set status='completed', fee_minor=$2, paypal_capture_id=$3, settled_at=now() where id=$1",
      [capId, fee, pp],
    );
    const g = uuid();
    const legs = [["CAPTURED_GROSS", "D", amt], ["COMMITTED_UNSETTLED", "C", amt]];
    if (opts.feePosted != null) {
      if (opts.feePosted > 0) legs.push(["PAYPAL_FEES", "D", opts.feePosted], ["CAPTURED_GROSS", "C", opts.feePosted]);
    } else if (fee > 0) {
      legs.push(["PAYPAL_FEES", "D", fee], ["CAPTURED_GROSS", "C", fee]);
    }
    for (const [account, dir, a] of legs) {
      await tx.query(
        `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id)
         values ($1,$2,$3,$4,$5,'capture',$6)`,
        [g, lease, account, dir, a, capId],
      );
    }
  }
  async function settle(lease, auth, amt, fee, decision = null, pp = null) {
    const started = await captureIntent(lease, auth, amt, decision);
    const paypalId = pp ?? "PP-" + started.id;
    await db.transaction(async (tx) => {
      await finish(tx, lease, started.id, started.callId, amt, fee, paypalId);
    });
    return started;
  }
  async function balances(lease) {
    const rows = (await db.query(
      `select account,
              sum(case when account in ('BUYER_COMMITMENT','SELLER_PAYABLE')
                       then case direction when 'C' then amount_minor else -amount_minor end
                       else case direction when 'D' then amount_minor else -amount_minor end end)::text as bal
         from ledger_entries where lease_id=$1 group by account order by account`,
      [lease],
    )).rows;
    return rows.map((r) => `${r.account}=${r.bal}`).join(" ");
  }
  async function counted(lease) {
    const r = await one(
      `select coalesce(sum(amount_minor),0)::text as s, count(*)::int as n
         from captures where lease_id=$1 and status in ('intent','pending','completed','unknown','reversed')`,
      [lease],
    );
    return `counted=${r.s} rows=${r.n}`;
  }
  const RUBRIC = JSON.stringify([{ min_score: 90, pay_bps: 10000 }, { min_score: 60, pay_bps: 5000 }]);
  async function jobWith(lease, seller, amount, rubric, verdicts) {
    const job = (await one(
      "insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,$3,$4::jsonb) returning id",
      [lease, seller, amount, rubric],
    )).id;
    for (const [provider, verdict, score] of verdicts) {
      await db.query(
        "insert into verdicts (job_id, judge_provider, model, verdict, score) values ($1,$2,'m',$3,$4)",
        [job, provider, verdict, score],
      );
    }
    return job;
  }
  return { db, one, works, holds, posting, fund, callRow, captureIntent, finish, settle, balances, counted, RUBRIC, jobWith };
}

const base = await load();
const ver = await base.one("select version() as v");
console.log(`RUNTIME\t${ver.v}`);
const procs = (await base.db.query(
  `select p.proname, p.prosecdef as definer, p.proconfig
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
      ('lock_lease','enforce_capture_insert','enforce_decision','enforce_payout_insert','check_lease_consistency','ledger_deferred_check','captures_deferred_check')
    order by 1`,
)).rows;
console.log(`RUNTIME\tfunctions ${procs.map((p) => `${p.proname} definer=${p.definer} search_path=${p.proconfig ?? "unset"}`).join(" | ")}`);
const grants = (await base.db.query(
  `select table_name, string_agg(column_name, ',' order by column_name) as cols
     from information_schema.column_privileges
    where grantee='pashadhara_app' and privilege_type='UPDATE'
    group by table_name order by table_name`,
)).rows;
console.log(`RUNTIME\tapp_update ${grants.map((g) => `${g.table_name}(${g.cols})`).join(" ")}`);

// --- v0.2 attacks, replayed with a legal v0.3 setup. HOLDS means v0.3 blocks it. ---
{
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
  await base.holds("V02 control over cap", () => base.captureIntent(L.lease, L.auth, 1001));
}

await base.holds("V02 B1 reversed then declined frees the cap", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
  const c = await base.settle(L.lease, L.auth, 1000, 0);
  await base.db.query("update captures set status='reversed' where id=$1", [c.id]);
  await base.db.query("update captures set status='declined' where id=$1", [c.id]);
});

await base.holds("V02 B1 three in-flight captures", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const a = await base.captureIntent(L.lease, L.auth, 100);
  await base.db.query("update captures set status='pending' where id=$1", [a.id]);
  await base.captureIntent(L.lease, L.auth, 100);
});

await base.holds("V02 B2 void the books then complete the capture and close", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
  const c = await base.captureIntent(L.lease, L.auth, 1000);
  await base.posting(L.lease, "return", "r", [["HOLD_AVAILABLE", "D", 1000], ["COMMITTED_UNSETTLED", "C", 1000]]);
  await base.posting(L.lease, "void", "v", [["RELEASED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
  await base.db.transaction(async (tx) => {
    await base.finish(tx, L.lease, c.id, c.callId, 1000, 0, "PP-" + c.id);
  });
});

await base.holds("V02 B2 capture posting with no capture row", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 600], ["HOLD_AVAILABLE", "C", 600]]);
  await base.posting(L.lease, "capture", "not-a-capture", [["CAPTURED_GROSS", "D", 600], ["COMMITTED_UNSETTLED", "C", 600]]);
});

await base.works("N2 authorize of 1 cent stays, and the lease can still be marked active", async () => {
  const lease = (await base.one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  await base.one(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
     values ($1,$2,1000,'created', now() + interval '3 days', now() + interval '29 days') returning id`,
    [lease, "AUTH-" + uuid()],
  );
  await base.posting(lease, "authorize", "short", [["HOLD_AVAILABLE", "D", 1], ["BUYER_COMMITMENT", "C", 1]]);
  await base.db.query("update leases set state='active' where id=$1", [lease]);
  let commit = "allowed";
  try {
    await base.posting(lease, "commit", "tiny", [["COMMITTED_UNSETTLED", "D", 1], ["HOLD_AVAILABLE", "C", 1]]);
  } catch (e) { commit = "blocked:" + errText(e).slice(0, 70); }
  const st = await base.one("select state from leases where id=$1", [lease]);
  return `state=${st.state} later_commit=${commit}; ${await base.balances(lease)}`;
});

await base.holds("V02 B2 served tool call with a missing ledger group", async () => {
  const L = await base.fund();
  await base.db.query("insert into tools (id, seller_id, name, price_minor) values ($1,$2,'t',25)", ["tool-" + uuid(), L.seller]);
  const tool = (await base.one("select id from tools where seller_id=$1", [L.seller])).id;
  await base.db.query(
    `insert into tool_calls (lease_id, tool_id, idempotency_key, price_minor, status, ledger_group_id)
     values ($1,$2,'k',25,'served',$3)`,
    [L.lease, tool, uuid()],
  );
});

await base.holds("V02 B3 metered payout with no accrual", async () => {
  const L = await base.fund();
  await base.db.query(
    `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
     values ($1,$2,'metered',100000000,'queued', now() + interval '30 seconds')`,
    [L.lease, L.seller],
  );
});

await base.holds("V02 B3 rewrite payout amount seller and state", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const c = await base.settle(L.lease, L.auth, 300, 0);
  await base.posting(L.lease, "accrue", "a", [["SELLER_COST", "D", 300, L.seller], ["SELLER_PAYABLE", "C", 300, L.seller]]);
  const pid = (await base.one(
    `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
     values ($1,$2,'metered',300,'queued', now() + interval '30 seconds') returning id`,
    [L.lease, L.seller],
  )).id;
  const thief = (await base.one("insert into sellers (name, paypal_email) values ('thief','thief@x.com') returning id")).id;
  await base.db.query("update payouts set amount_minor=999999, seller_id=$2, state='success' where id=$1", [pid, thief]);
});

await base.holds("V02 B4 webhook resource and signature rewritten", async () => {
  const id = "WH-" + uuid();
  await base.db.query(
    "insert into webhook_events (id, event_type, resource, signature_verified) values ($1,'PAYMENT.CAPTURE.COMPLETED',$2::jsonb,false)",
    [id, JSON.stringify({ id: "real" })],
  );
  await base.db.query(
    `insert into webhook_events (id, event_type, resource, signature_verified)
     values ($1,'PAYMENT.CAPTURE.COMPLETED',$2::jsonb,true)
     on conflict (id) do update set resource=excluded.resource, signature_verified=excluded.signature_verified, processed_at=null`,
    [id, JSON.stringify({ id: "injected" })],
  );
});

await base.holds("V02 M1 release 500 when the rubric pays 0", async () => {
  const L = await base.fund();
  const job = await base.jobWith(L.lease, L.seller, 500, JSON.stringify([{ min_score: 0, pay_bps: 0 }]), [["openai", "pass", 0], ["anthropic", "pass", 0]]);
  await base.db.query(
    `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
     values ($1,$2,'release',500,'{"min_score":"0","pay_bps":"0"}'::jsonb)`,
    [L.lease, job],
  );
});

await base.holds("V02 M1 delete a fail verdict and rewrite the rest", async () => {
  const L = await base.fund();
  const job = await base.jobWith(L.lease, L.seller, 400, base.RUBRIC, [["openai", "pass", 99], ["anthropic", "fail", 10]]);
  await base.db.query("delete from verdicts where job_id=$1 and verdict='fail'", [job]);
});

await base.holds("V02 M2 move honor_until", async () => {
  const L = await base.fund();
  await base.db.query("update authorizations set honor_until=now() + interval '400 days' where id=$1", [L.auth]);
});

await base.holds("V02 M2 commit through a zero exposure limit", async () => {
  const L = await base.fund(1000, 0);
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
});

await base.holds("V02 M2 day-0 child using now() and voided auth resurrected", async () => {
  const L = await base.fund();
  await base.db.query("update authorizations set status='voided' where id=$1", [L.auth]);
  await base.db.query("update authorizations set status='created' where id=$1", [L.auth]);
  await base.db.query("update authorizations set status='superseded' where id=$1", [L.auth]);
  await base.db.query(
    `insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, honor_until, expires_at)
     values ($1,$2,$3,1000,'created', now() + interval '3 days', now() + interval '29 days')`,
    [L.lease, L.auth, "AUTH-" + uuid()],
  );
});

await base.holds("V02 M2 sent call failed with a null response", async () => {
  const L = await base.fund();
  const id = await base.callRow(L.lease, 10);
  await base.db.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [id]);
  await base.db.query("update paypal_calls set state='failed' where id=$1", [id]);
});

await base.holds("V02 M6 capture posting omits a fee the capture row recorded", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const started = await base.captureIntent(L.lease, L.auth, 300);
  await base.db.transaction(async (tx) => {
    await base.finish(tx, L.lease, started.id, started.callId, 300, 59, "PP-" + started.id, { feePosted: 0 });
  });
});

await base.holds("V02 M7 replace the payout email", async () => {
  const L = await base.fund(1000, 1000, 86400);
  await base.db.query("update sellers set paypal_email='thief@x.com' where id=$1", [L.seller]);
});
await base.holds("V02 M7 shorten the hold", async () => {
  const L = await base.fund(1000, 1000, 86400);
  await base.db.query("update sellers set payout_hold_seconds=30 where id=$1", [L.seller]);
});

await base.holds("V02 M7 rewrite fee and paypal_capture_id after they are set", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 20], ["HOLD_AVAILABLE", "C", 20]]);
  const c = await base.settle(L.lease, L.auth, 20, 5);
  await base.db.query("update captures set fee_minor=0, paypal_capture_id='OTHER' where id=$1", [c.id]);
});

await base.holds("V02 app role regresses a completed capture and raises a payout", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 100], ["HOLD_AVAILABLE", "C", 100]]);
  const c = await base.settle(L.lease, L.auth, 100, 0);
  await base.db.transaction(async (tx) => {
    await tx.query("set local role pashadhara_app");
    await tx.query("update captures set status='declined' where id=$1", [c.id]);
  });
});

// --- New: decision derivation ---
await base.works("N1 one unsure voids when derived_from merely contains precheck_failed", async () => {
  const L = await base.fund();
  const cases = [
    ["unsure-false", [["openai", "unsure", 50]], { precheck_failed: false }],
    ["one-fail-false", [["openai", "fail", 10]], { precheck_failed: false }],
    ["unsure-true", [["anthropic", "unsure", 90]], { precheck_failed: true }],
    ["no-judges-false", [], { precheck_failed: false }],
  ];
  const out = [];
  for (const [name, verdicts, derived] of cases) {
    const job = await base.jobWith(L.lease, L.seller, 500, base.RUBRIC, verdicts);
    try {
      await base.db.query(
        `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
         values ($1,$2,'void',0,$3::jsonb)`,
        [L.lease, job, JSON.stringify(derived)],
      );
      out.push(`${name}=VOIDED`);
    } catch (e) {
      out.push(`${name}=blocked:${errText(e).slice(0, 60)}`);
    }
  }
  const job = await base.jobWith(L.lease, L.seller, 500, base.RUBRIC, [["openai", "pass", 95]]);
  let onePass = "voided";
  try {
    await base.db.query(
      `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
       values ($1,$2,'void',0,'{"precheck_failed":false}'::jsonb)`,
      [L.lease, job],
    );
  } catch (e) {
    onePass = "blocked";
  }
  return `${out.join(" ")}; one-pass-with-key=${onePass}`;
});

await base.works("N1 rubric pays a worse score more, and a 95 forces void", async () => {
  const L = await base.fund();
  const rubric = JSON.stringify([{ min_score: 0, pay_bps: 10000 }, { min_score: 90, pay_bps: 0 }]);
  const low = await base.jobWith(L.lease, L.seller, 500, rubric, [["openai", "pass", 60], ["anthropic", "pass", 70]]);
  const high = await base.jobWith(L.lease, L.seller, 500, rubric, [["openai", "pass", 95], ["anthropic", "pass", 96]]);
  let lowResult = "not-inserted";
  try {
    await base.db.query(
      `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
       values ($1,$2,'release',500,'{"min_score":"60","pay_bps":"10000"}'::jsonb)`,
      [L.lease, low],
    );
    lowResult = "release-500";
  } catch (e) { lowResult = errText(e).slice(0, 80); }
  let highResult = "not-inserted";
  try {
    await base.db.query(
      `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
       values ($1,$2,'void',0,'{}'::jsonb)`,
      [L.lease, high],
    );
    highResult = "void-required";
  } catch (e) { highResult = errText(e).slice(0, 80); }
  return `score-60 ${lowResult}; score-95 ${highResult}`;
});

await base.works("N1 disagreement stays undecidable after a third pass", async () => {
  const L = await base.fund();
  const job = await base.jobWith(L.lease, L.seller, 500, base.RUBRIC, [["openai", "pass", 95], ["anthropic", "fail", 10]]);
  await base.db.query(
    `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from) values ($1,$2,'hold',0,'{}'::jsonb)`,
    [L.lease, job],
  );
  await base.db.query("insert into verdicts (job_id, judge_provider, model, verdict, score) values ($1,'xai','m','pass',99)", [job]);
  await base.db.query("insert into verdicts (job_id, judge_provider, model, verdict, score) values ($1,'google','m','pass',99)", [job]);
  let release = "allowed", voids = "allowed";
  try {
    await base.db.query(
      `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
       values ($1,$2,'release',500,'{"min_score":"95","pay_bps":"10000"}'::jsonb)`,
      [L.lease, job],
    );
  } catch (e) { release = "blocked"; }
  try {
    await base.db.query(
      `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
       values ($1,$2,'void',0,'{}'::jsonb)`,
      [L.lease, job],
    );
  } catch (e) { voids = "blocked"; }
  const n = await base.one("select count(*)::int as n from verdicts where job_id=$1 and verdict='pass'", [job]);
  return `passes=${n.n} release=${release} void=${voids}`;
});

// --- New: timestamps, capture linkage, payouts, role ---
await base.works("N2 root honor_until of 400 days is accepted and commits", async () => {
  const seller = (await base.one("insert into sellers (name, paypal_email) values ('s','s@x.com') returning id")).id;
  const lease = (await base.one("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',1000,1000) returning id")).id;
  const auth = await base.one(
    `insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     values ($1,$2,1000,'created', now() - interval '10 days', now() + interval '400 days', now() + interval '400 days')
     returning id, honor_until > now() + interval '300 days' as long_honor, created_at < now() - interval '9 days' as backdated`,
    [lease, "AUTH-" + uuid()],
  );
  await base.posting(lease, "authorize", "a", [["HOLD_AVAILABLE", "D", 1000], ["BUYER_COMMITMENT", "C", 1000]]);
  await base.db.query("update leases set state='active' where id=$1", [lease]);
  await base.posting(lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
  return `seller=${seller} backdated=${auth.backdated} long_honor=${auth.long_honor} commit=ok auth=${auth.id}`;
});

await base.works("N2 day-0 child by setting created_at, then a grandchild", async () => {
  const L = await base.fund();
  await base.db.query("update authorizations set status='superseded' where id=$1", [L.auth]);
  const child = await base.one(
    `insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     select lease_id, id, $2, amount_minor, 'created', created_at + interval '3 days', now() + interval '400 days', now() + interval '400 days'
       from authorizations where id=$1
     returning id, created_at > now() + interval '2 days' as created_in_the_future`,
    [L.auth, "AUTH-" + uuid()],
  );
  await base.db.query("update authorizations set status='superseded' where id=$1", [child.id]);
  const grand = await base.one(
    `insert into authorizations (lease_id, parent_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
     select lease_id, id, $2, amount_minor, 'created', created_at + interval '3 days', now() + interval '400 days', now() + interval '400 days'
       from authorizations where id=$1
     returning id, created_at > now() + interval '5 days' as created_in_the_future`,
    [child.id, "AUTH-" + uuid()],
  );
  const wall = await base.one(
    `select extract(epoch from (c.created_at - p.created_at))::int as claimed_gap,
            extract(epoch from (now() - p.created_at))::int as wall_gap
       from authorizations c join authorizations p on p.id=c.parent_id where c.id=$1`,
    [child.id],
  );
  return `child_future=${child.created_in_the_future} claimed_gap_s=${wall.claimed_gap} wall_clock_gap_s=${wall.wall_gap} grandchild_future=${grand.created_in_the_future}`;
});

await base.works("N3 accrue and pay a seller who has no job and no tool call", async () => {
  const L = await base.fund();
  const stranger = (await base.one("insert into sellers (name, paypal_email, payout_hold_seconds) values ('stranger','stranger@x.com',30) returning id")).id;
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const c = await base.settle(L.lease, L.auth, 300, 0);
  await base.posting(L.lease, "accrue", "steal", [["SELLER_COST", "D", 300, stranger], ["SELLER_PAYABLE", "C", 300, stranger]]);
  const jobs = await base.one("select count(*)::int as n from jobs where lease_id=$1", [L.lease]);
  const tools = await base.one("select count(*)::int as n from tool_calls where lease_id=$1", [L.lease]);
  const pid = (await base.one(
    `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
     values ($1,$2,'metered',300,'queued', now() + interval '30 seconds') returning id, receiver_email`,
    [L.lease, stranger],
  ));
  return `jobs=${jobs.n} tool_calls=${tools.n} payout=${pid.id} receiver=${pid.receiver_email}; ${await base.balances(L.lease)}`;
});

await base.works("N3 fee recorded as 0 and the seller is accrued the gross", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const c = await base.settle(L.lease, L.auth, 300, 0);
  await base.posting(L.lease, "accrue", "a", [["SELLER_COST", "D", 300, L.seller], ["SELLER_PAYABLE", "C", 300, L.seller]]);
  const fee = await base.one("select fee_minor::text as f from captures where id=$1", [c.id]);
  return `fee_minor=${fee.f} (measured fee on 300 cents is 59); ${await base.balances(L.lease)}`;
});

await base.works("N3 reversed capture is still accrued and a 1-cent reversal is enough", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const full = await base.settle(L.lease, L.auth, 200, 0, null, "PP-FULL");
  await base.db.query("update captures set status='reversed' where id=$1", [full.id]);
  await base.posting(L.lease, "accrue", "a", [["SELLER_COST", "D", 200, L.seller], ["SELLER_PAYABLE", "C", 200, L.seller]]);
  const pid = (await base.one(
    `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
     values ($1,$2,'metered',200,'queued', now() + interval '30 seconds') returning id`,
    [L.lease, L.seller],
  )).id;
  const partial = await base.settle(L.lease, L.auth, 100, 0, null, "PP-PART");
  await base.db.query("update captures set status='reversed' where id=$1", [partial.id]);
  await base.posting(L.lease, "reversal", partial.id, [["CHARGEBACK_LOSS", "D", 1], ["CAPTURED_GROSS", "C", 1]]);
  const rev = await base.one(
    `select coalesce(sum(amount_minor),0)::text as s from ledger_entries
      where lease_id=$1 and ref_type='reversal' and account='CHARGEBACK_LOSS'`,
    [L.lease],
  );
  return `payout_on_reversed=${pid} chargeback_booked=${rev.s} against_reversed_captures=300; ${await base.balances(L.lease)}; ${await base.counted(L.lease)}`;
});

await base.works("N4 capture completes while its call is still intent, and a second capture reuses the call", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const call = await base.callRow(L.lease, 200);
  const a = await base.captureIntent(L.lease, L.auth, 200, null, call);
  await base.db.transaction(async (tx) => {
    await base.finish(tx, L.lease, a.id, call, 200, 0, "PP-A", { leaveCall: true });
  });
  const callState = await base.one("select state from paypal_calls where id=$1", [call]);
  const b = await base.captureIntent(L.lease, L.auth, 100, null, call);
  await base.db.transaction(async (tx) => {
    await base.finish(tx, L.lease, b.id, call, 100, 0, "PP-B", { leaveCall: true });
  });
  const n = await base.one("select count(*)::int as n from captures where call_id=$1", [call]);
  return `call_state_after_two_completions=${callState.state} captures_on_that_call=${n.n}; ${await base.counted(L.lease)}`;
});

await base.works("N4 app role rewrites a succeeded call's response and http status", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 50], ["HOLD_AVAILABLE", "C", 50]]);
  const c = await base.settle(L.lease, L.auth, 50, 0);
  await base.db.query("set role pashadhara_app");
  await base.db.query(
    "update paypal_calls set response='{\"id\":\"EVIL\",\"status\":\"REFUNDED\"}'::jsonb, http_status=500 where id=$1",
    [c.callId],
  );
  await base.db.query("reset role");
  const row = await base.one("select http_status, response::text as r, state from paypal_calls where id=$1", [c.callId]);
  return `state=${row.state} http=${row.http_status} response=${row.r}`;
});

await base.works("N5 payout with a PayPal batch id is failed and the accrual is paid again as metered", async () => {
  const L = await base.fund();
  const job = await base.jobWith(L.lease, L.seller, 300, base.RUBRIC, [["openai", "pass", 95], ["anthropic", "pass", 95]]);
  await base.posting(L.lease, "commit", "job", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  const dec = (await base.one(
    `insert into decisions (lease_id, job_id, outcome, amount_minor, derived_from)
     values ($1,$2,'release',300,'{"min_score":"95","pay_bps":"10000"}'::jsonb) returning id`,
    [L.lease, job],
  )).id;
  await base.settle(L.lease, L.auth, 300, 0, dec);
  await base.posting(L.lease, "accrue", "a", [["SELLER_COST", "D", 300, L.seller], ["SELLER_PAYABLE", "C", 300, L.seller]]);
  const first = (await base.one(
    `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
     values ($1,$2,'job',$3,300,'queued', now() + interval '30 seconds') returning id`,
    [L.lease, L.seller, dec],
  )).id;
  await base.db.query("update jobs set state='held' where id=$1", [job]);
  await base.db.query("update payouts set held_at=now(), paypal_batch_id='BATCH-REAL' where id=$1", [first]);
  await base.db.query("update payouts set state='failed' where id=$1", [first]);
  let secondJob = "inserted";
  try {
    await base.db.query(
      `insert into payouts (lease_id, seller_id, source, decision_id, amount_minor, state, release_at)
       values ($1,$2,'job',$3,300,'queued', now() + interval '30 seconds')`,
      [L.lease, L.seller, dec],
    );
  } catch (e) { secondJob = "blocked:" + errText(e).slice(0, 50); }
  const second = (await base.one(
    `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
     values ($1,$2,'metered',300,'queued', now() + interval '30 seconds') returning id`,
    [L.lease, L.seller],
  )).id;
  const rows = (await base.db.query(
    "select source, state, paypal_batch_id, held_at is not null as held from payouts where lease_id=$1 order by created_at",
    [L.lease],
  )).rows.map((r) => `${r.source}:${r.state}:batch=${r.paypal_batch_id}:held=${r.held}`).join(" ");
  const jstate = await base.one("select state from jobs where id=$1", [job]);
  return `job_state=${jstate.state} second_job_payout=${secondJob} metered=${second} rows=${rows}`;
});

await base.works("N5 supplied receiver email is overwritten, then a queued payout is marked failed with no call row", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 40], ["HOLD_AVAILABLE", "C", 40]]);
  await base.settle(L.lease, L.auth, 40, 0);
  await base.posting(L.lease, "accrue", "a", [["SELLER_COST", "D", 40, L.seller], ["SELLER_PAYABLE", "C", 40, L.seller]]);
  const pid = await base.one(
    `insert into payouts (lease_id, seller_id, source, amount_minor, receiver_email, state, release_at)
     values ($1,$2,'metered',40,'thief@x.com','queued', now() + interval '30 seconds') returning id, receiver_email`,
    [L.lease, L.seller],
  );
  const calls = await base.one("select count(*)::int as n from paypal_calls where op='payout' and lease_id=$1", [L.lease]);
  await base.db.query("update payouts set state='failed' where id=$1", [pid.id]);
  const again = (await base.one(
    `insert into payouts (lease_id, seller_id, source, amount_minor, state, release_at)
     values ($1,$2,'metered',40,'queued', now() + interval '30 seconds') returning id`,
    [L.lease, L.seller],
  )).id;
  return `inserted_email_became=${pid.receiver_email} payout_calls=${calls.n} replacement=${again}`;
});

await base.works("N6 void posting and close while the authorization is still created", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "void", "v", [["RELEASED", "D", 1000], ["HOLD_AVAILABLE", "C", 1000]]);
  await base.db.query("update leases set state='closed' where id=$1", [L.lease]);
  const row = await base.one(
    `select l.state, a.status,
            (select count(*) from paypal_calls p where p.lease_id=l.id and p.op='void')::int as void_calls
       from leases l join authorizations a on a.lease_id=l.id where l.id=$1`,
    [L.lease],
  );
  return `lease=${row.state} auth=${row.status} void_calls=${row.void_calls}; ${await base.balances(L.lease)}`;
});

await base.works("N6 served tool call, then the commit is returned", async () => {
  const L = await base.fund();
  const tool = "tool-" + uuid();
  await base.db.query("insert into tools (id, seller_id, name, price_minor) values ($1,$2,'t',25)", [tool, L.seller]);
  const g = await base.posting(L.lease, "commit", "tc", [["COMMITTED_UNSETTLED", "D", 25], ["HOLD_AVAILABLE", "C", 25]]);
  await base.db.query(
    `insert into tool_calls (lease_id, tool_id, idempotency_key, price_minor, status, ledger_group_id)
     values ($1,$2,'k',25,'served',$3)`,
    [L.lease, tool, g],
  );
  await base.posting(L.lease, "return", "undo", [["HOLD_AVAILABLE", "D", 25], ["COMMITTED_UNSETTLED", "C", 25]]);
  const tc = await base.one("select status from tool_calls where ledger_group_id=$1", [g]);
  return `tool_call=${tc.status}; ${await base.balances(L.lease)}`;
});

await base.works("N6 writeoff with no declined capture, then close", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "c", [["COMMITTED_UNSETTLED", "D", 300], ["HOLD_AVAILABLE", "C", 300]]);
  await base.posting(L.lease, "writeoff", "w", [["WRITTEN_OFF", "D", 300], ["COMMITTED_UNSETTLED", "C", 300]]);
  await base.posting(L.lease, "void", "v", [["RELEASED", "D", 700], ["HOLD_AVAILABLE", "C", 700]]);
  await base.db.query("update leases set state='closed' where id=$1", [L.lease]);
  const caps = await base.one("select count(*)::int as n from captures where lease_id=$1", [L.lease]);
  const st = await base.one("select state from leases where id=$1", [L.lease]);
  return `captures=${caps.n} lease=${st.state}; ${await base.balances(L.lease)}`;
});

await base.works("N7 app role column rights: price, job state, settled_at, deliveries; deletes denied", async () => {
  const L = await base.fund();
  const tool = "tool-" + uuid();
  await base.db.query("insert into tools (id, seller_id, name, price_minor) values ($1,$2,'t',25)", [tool, L.seller]);
  const job = await base.jobWith(L.lease, L.seller, 100, base.RUBRIC, []);
  await base.db.query(
    "insert into webhook_events (id, event_type, resource, signature_verified) values ('WH-N7','X','{}',true)",
  );
  const denied = [];
  async function asApp(sql, params) {
    await base.db.query("set role pashadhara_app");
    try { await base.db.query(sql, params); return "ok"; }
    catch (e) { return errText(e).slice(0, 70); }
    finally { await base.db.query("reset role"); }
  }
  const price = await asApp("update tools set price_minor=999999 where id=$1", [tool]);
  const state = await asApp("update jobs set state='settled' where id=$1", [job]);
  const del = await asApp("delete from ledger_entries where lease_id=$1", [L.lease]);
  const cap = await asApp("update leases set cap_minor=1 where id=$1", [L.lease]);
  const deliveries = await asApp("update webhook_events set deliveries=1000000 where id='WH-N7'");
  const disable = await asApp("alter table captures disable trigger captures_insert");
  const priceNow = await base.one("select price_minor::text as p from tools where id=$1", [tool]);
  const jobNow = await base.one("select state from jobs where id=$1", [job]);
  const dnow = await base.one("select deliveries from webhook_events where id='WH-N7'");
  denied.push(`price_update=${price} price_now=${priceNow.p}`, `job_state=${state} now=${jobNow.state}`, `delete=${del}`, `cap=${cap}`, `deliveries=${deliveries} now=${dnow.deliveries}`, `disable=${disable}`);
  return denied.join(" | ");
});

await base.works("N9 app role cannot commit a capture or a ledger row", async () => {
  const L = await base.fund();
  await base.posting(L.lease, "commit", "setup", [["COMMITTED_UNSETTLED", "D", 40], ["HOLD_AVAILABLE", "C", 40]]);
  const out = [];
  await base.db.query("set role pashadhara_app");
  try {
    try {
      const g = uuid();
      const ref = "app-" + uuid();
      await base.db.transaction(async (tx) => {
        await tx.query(
          `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values
           ($1,$2,'COMMITTED_UNSETTLED','D',1,'commit',$3),
           ($1,$2,'HOLD_AVAILABLE','C',1,'commit',$3)`,
          [g, L.lease, ref],
        );
      });
      out.push("balanced-ledger=inserted");
    } catch (e) { out.push("balanced-ledger=" + errText(e).slice(0, 100)); }
    try {
      const c = await base.captureIntent(L.lease, L.auth, 40);
      out.push("capture=" + c.id);
    } catch (e) { out.push("capture=" + errText(e).slice(0, 90)); }
  } finally {
    await base.db.query("reset role");
  }
  const n = await base.one("select count(*)::int as n from captures where lease_id=$1", [L.lease]);
  return `${out.join(" | ")} captures_left=${n.n}`;
});

// search_path: fresh database so the capture trigger has not been planned yet.
{
  const s = await load();
  await s.works("N8 search_path shadow inserts a capture past the cap", async () => {
    const L = await s.fund();
    await s.db.query("create temp table leases (like public.leases)");
    await s.db.query("insert into pg_temp.leases select * from public.leases where id=$1", [L.lease]);
    await s.db.query("update pg_temp.leases set cap_minor=5000000 where id=$1", [L.lease]);
    await s.db.query("create temp table authorizations (like public.authorizations)");
    await s.db.query("insert into pg_temp.authorizations select * from public.authorizations where id=$1", [L.auth]);
    await s.db.query("update pg_temp.authorizations set amount_minor=5000000 where id=$1", [L.auth]);
    await s.db.query(
      `create temp table captures (id uuid, lease_id uuid, authorization_id uuid, decision_id uuid, status text, amount_minor bigint, fee_minor bigint)`,
    );
    await s.db.query("set search_path = pg_temp, public");
    await s.db.query("discard plans");
    let cap = "";
    await s.db.transaction(async (tx) => {
      const call = (await tx.query(
        "insert into public.paypal_calls (lease_id, op, request_id, amount_minor, state) values ($1,'capture',$2,5000,'intent') returning id",
        [L.lease, uuid()],
      )).rows[0].id;
      cap = (await tx.query(
        `insert into public.captures (lease_id, authorization_id, call_id, amount_minor, status)
         values ($1,$2,$3,5000,'intent') returning id`,
        [L.lease, L.auth, call],
      )).rows[0].id;
      // The insert trigger already saw the inflated temp cap. The deferred check runs at commit
      // and reads the same temp tables, so put the real cap back and leave temp captures empty.
      await tx.query("update pg_temp.leases set cap_minor = 1000 where id=$1", [L.lease]);
    });
    await s.db.query("reset search_path");
    const sum = await s.one(
      `select current_setting('search_path') as sp,
              (select coalesce(sum(amount_minor),0)::text from public.captures where lease_id=$1) as public_sum,
              (select cap_minor::text from public.leases where id=$1) as public_cap`,
      [L.lease],
    );
    return `capture=${cap} search_path=${sum.sp} public_sum=${sum.public_sum} public_cap=${sum.public_cap}`;
  });
}

{
  const g = await load();
  await g.works("N8b app role, after the missing EXECUTE grant, search_path still beats the cap", async () => {
    await g.db.exec("grant execute on all functions in schema public to pashadhara_app");
    const L = await g.fund();
    await g.db.query("set role pashadhara_app");
    await g.db.query("create temp table leases (like public.leases)");
    await g.db.query("insert into pg_temp.leases select * from public.leases where id=$1", [L.lease]);
    await g.db.query("update pg_temp.leases set cap_minor=5000000 where id=$1", [L.lease]);
    await g.db.query("create temp table authorizations (like public.authorizations)");
    await g.db.query("insert into pg_temp.authorizations select * from public.authorizations where id=$1", [L.auth]);
    await g.db.query("update pg_temp.authorizations set amount_minor=5000000 where id=$1", [L.auth]);
    await g.db.query("create temp table captures (id uuid, lease_id uuid, authorization_id uuid, decision_id uuid, status text, amount_minor bigint, fee_minor bigint)");
    await g.db.query("set search_path = pg_temp, public");
    await g.db.query("discard plans");
    let cap = "";
    await g.db.transaction(async (tx) => {
      const call = (await tx.query(
        "insert into public.paypal_calls (lease_id, op, request_id, amount_minor, state) values ($1,'capture',$2,5000,'intent') returning id",
        [L.lease, uuid()],
      )).rows[0].id;
      cap = (await tx.query(
        `insert into public.captures (lease_id, authorization_id, call_id, amount_minor, status)
         values ($1,$2,$3,5000,'intent') returning id`,
        [L.lease, L.auth, call],
      )).rows[0].id;
      await tx.query("update pg_temp.leases set cap_minor = 1000 where id=$1", [L.lease]);
    });
    await g.db.query("reset role");
    await g.db.query("reset search_path");
    const sum = await g.one(
      "select coalesce(sum(amount_minor),0)::text as s from public.captures where lease_id=$1",
      [L.lease],
    );
    return `capture=${cap} public_sum=${sum.s} cap=1000`;
  });
}

{
  const owned = await load();
  await owned.works("V02 M5 owner disables the cap trigger and truncates", async () => {
    const L = await owned.fund(100);
    await owned.db.exec("alter table captures disable trigger captures_insert");
    await owned.db.exec("alter table captures disable trigger captures_commit_checks");
    const call = await owned.callRow(L.lease, 100);
    const over = await owned.one(
      `insert into captures (lease_id, authorization_id, call_id, amount_minor, status)
       values ($1,$2,$3,100000,'intent') returning amount_minor::text as a`,
      [L.lease, L.auth, call],
    );
    await owned.db.exec("alter table ledger_entries disable trigger user");
    await owned.db.query(
      `insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id)
       values ($1,$2,'HOLD_AVAILABLE','D',5,'return','orphan')`,
      [uuid(), L.lease],
    );
    await owned.db.exec("truncate ledger_entries");
    const n = await owned.one("select count(*)::int as n from ledger_entries");
    return `over_cap_capture=${over.a} truncate_left=${n.n}`;
  });
}

console.log("DONE");
