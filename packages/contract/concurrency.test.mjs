// Real two-connection race tests on Postgres. Needs: npm i pg, and a Postgres 15+ reachable at DATABASE_URL (trust auth is fine for a throwaway container):
//   docker run -d --rm --name pashadhara-contract-v05 -e POSTGRES_HOST_AUTH_METHOD=trust -p 15435:5432 postgres:15
//   DATABASE_URL=postgres://postgres@127.0.0.1:15435/postgres node concurrency.test.mjs
// Loads schema.sql and roles.sql into a fresh schema, then races two sessions at READ COMMITTED and REPEATABLE READ.
import pg from "pg";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:15435/postgres";
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "15435" || target.pathname !== "/postgres") throw Error("Throwaway localhost:15435/postgres only");
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const roles = readFileSync(new URL("./roles.sql", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const connect = async (login = false) => { const u=new URL(url); if(login){u.username="kernel_login";u.password="";} const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return c; };

const admin = await connect();
await admin.query("drop schema public cascade; create schema public;");
await admin.query("drop role if exists kernel_login");
await admin.query(schema);
await admin.query(roles);
await admin.query("insert into sellers (name, paypal_email, payout_hold_seconds) values ('s','s@x.com',30)");
const version = (await admin.query("show server_version")).rows[0].server_version;
console.log("Postgres", version);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("ok  ", name, detail); } else { fail++; console.log("FAIL", name, detail); } };
try {
  const loginUrl=new URL(url); loginUrl.username='kernel_login'; loginUrl.password='';
  const c=new pg.Client({connectionString:loginUrl.toString()}); await c.connect();
  try {
    await c.query('set role pashadhara_app'); await c.query('reset role');
    const r=(await c.query('select current_user, session_user')).rows[0];
    ok('V05 F8 RESET ROLE returns to unprivileged login',r.current_user==='kernel_login' && r.session_user==='kernel_login');
    for(const sql of ['alter table public.captures disable trigger captures_insert',"create or replace function public.lock_lease(uuid) returns public.lease_state language sql as 'select state from public.leases limit 1'"]) {
      try { await c.query(sql); ok('V05 F8 login cannot change enforcement',false); } catch(e) {ok('V05 F8 login cannot change enforcement',e.code==='42501');}
    }
  } finally {await c.end();}
} catch(e) {ok('V05 F8 actual login works',false,e.code+' '+e.message);}

async function mkLease(cap = 1000) {
  const l = (await admin.query("insert into leases (buyer_ref, cap_minor, unsettled_limit_minor) values ('b',$1,$1) returning id", [cap])).rows[0].id;
  const a = (await admin.query(`insert into authorizations (lease_id, paypal_authorization_id, amount_minor, status, created_at, honor_until, expires_at)
    values ($1,$2,$3,'created', now(), now() + interval '3 days', now() + interval '29 days') returning id`, [l, "AUTH-" + uuid(), cap])).rows[0].id;
  await postAtomic(admin, l, "authorize", "auth-" + uuid(), [["HOLD_AVAILABLE", "D", cap], ["BUYER_COMMITMENT", "C", cap]]);
  await admin.query("update leases set state='active' where id=$1", [l]);
  return { lease: l, auth: a };
}
async function postAtomic(c, lease, refType, refId, lines) {
  await c.query("begin"); try { await postGroup(c, lease, refType, refId, lines); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; }
}
async function postGroup(c, lease, refType, refId, lines) {
  const g = uuid();
  for (const [account, dir, amt] of lines)
    await c.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,$3,$4,$5,$6,$7)", [g, lease, account, dir, amt, refType, refId]);
}
const commitLines = (p) => [["COMMITTED_UNSETTLED", "D", p], ["HOLD_AVAILABLE", "C", p]];
// A commit must reference a job reserve of exactly that amount. The job insert also takes the lease lock first.
async function reserveJob(c, lease, amount) {
  const seller = (await admin.query("select id from sellers limit 1")).rows[0].id;
  const jobId = (await c.query("insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,$3,'[{\"min_score\":50,\"pay_bps\":10000}]') returning id", [lease, seller, amount])).rows[0].id;
  await postGroup(c, lease, "commit", jobId, commitLines(amount));
  return jobId;
}

async function payJob(c,lease,job,amt){
  for(const provider of ['openai','anthropic']) await c.query("insert into verdicts(job_id,judge_provider,model,verdict,score) values($1,$2,'test','pass',95)",[job,provider]);
  await c.query("insert into decisions(lease_id,job_id,outcome,amount_minor,derived_from) values($1,$2,'release',$3,'{\"min_score\":95,\"pay_bps\":10000}')",[lease,job,amt]);
}
async function allocate(c,l,cap,amt){
  const j=(await c.query('select id from jobs where lease_id=$1',[l])).rows[0].id;
  await c.query('insert into capture_allocations(capture_id,lease_id,ref_id,amount_minor) values($1,$2,$3,$4)',[cap,l,j,amt]);
}

// Run two sessions: A takes the lock first, B queues behind it, A commits, then B resumes.
async function race(iso, bodyA, bodyB) {
  const a = await connect(true), b = await connect(true);
  const out = {};
  try {
    await a.query("set role pashadhara_app"); await b.query("set role pashadhara_app");
    await a.query(`begin isolation level ${iso}`); await b.query(`begin isolation level ${iso}`);
    // Take a snapshot in B before A commits, which is what exposes repeatable read.
    await b.query("select 1");
    await bodyA.pre(a);
    const pB = (async () => { try { await bodyB.pre(b); await b.query("commit"); out.b = "committed"; } catch (e) { out.b = e.code + " " + e.message.slice(0, 80); await b.query("rollback").catch(() => {}); } })();
    await sleep(300);
    try { await a.query("commit"); out.a = "committed"; } catch (e) { out.a = e.code + " " + e.message.slice(0, 80); await a.query("rollback").catch(() => {}); }
    await pB;
  } finally { await a.end(); await b.end(); }
  return out;
}

for (const iso of ["read committed", "repeatable read"]) {
  {
    const L=await mkLease(); await admin.query('begin');
    const job=await reserveJob(admin,L.lease,500); await admin.query('commit');
    const v=(c,p,result,round)=>c.query("insert into verdicts(job_id,judge_provider,model,verdict,score,round) values($1,$2,'test',$3,95,$4)",[job,p,result,round]);
    await v(admin,'openai','pass',1);
    await admin.query("insert into decisions(lease_id,job_id,outcome,amount_minor,derived_from) values($1,$2,'hold',0,'{}')",[L.lease,job]);
    await v(admin,'anthropic','pass',1);
    const r=await race(iso,{pre:c=>c.query("insert into decisions(lease_id,job_id,outcome,amount_minor,derived_from) values($1,$2,'release',500,'{\"min_score\":95,\"pay_bps\":10000}')",[L.lease,job])},{pre:async c=>{await v(c,'openai','fail',2);await v(c,'anthropic','fail',2);}});
    const later=Number((await admin.query('select count(*) n from verdicts where job_id=$1 and round>1',[job])).rows[0].n);
    ok(`V05 F3 [${iso}] release cannot coexist with later verdicts`,r.a==='committed' && r.b!=='committed' && later===0,JSON.stringify(r));
  }
  // Race 1: two ledger commitments of 800 against a hold of 1000.
  {
    const L = await mkLease(1000);
    const mk = () => ({ pre: (c) => reserveJob(c, L.lease, 800) });
    const r = await race(iso, mk(), mk());
    const committed = Number((await admin.query("select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0) as c from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'", [L.lease])).rows[0].c);
    const deadlock = JSON.stringify(r).includes("40P01");
    ok(`[${iso}] ledger 800+800 on hold 1000: never overspends`, committed === 800, `a=${r.a} | b=${r.b} | committed=${committed}`);
    ok(`[${iso}] ledger race has no deadlock`, !deadlock);
  }
  // Race 2: two sessions each start a capture of 600 on a cap of 1000 (committed usage 1000).
  {
    const L = await mkLease(1000);
    { const sid = (await admin.query("select id from sellers limit 1")).rows[0].id; const jid = (await admin.query("insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,1000,'[{\"min_score\":50,\"pay_bps\":10000}]') returning id", [L.lease, sid])).rows[0].id; await postAtomic(admin, L.lease, "commit", jid, commitLines(1000)); await payJob(admin,L.lease,jid,1000); }
    const mk = () => ({ pre: async (c) => {
      const callId = uuid();
      await c.query("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,600,'intent')", [callId, L.lease, uuid()]);
      const capId=(await c.query("insert into captures (lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,600,'intent') returning id", [L.lease, L.auth, callId])).rows[0].id; await allocate(c,L.lease,capId,600);
    } });
    const r = await race(iso, mk(), mk());
    const n = Number((await admin.query("select count(*) as n from captures where lease_id=$1", [L.lease])).rows[0].n);
    const sum = Number((await admin.query("select coalesce(sum(amount_minor),0) as s from captures where lease_id=$1", [L.lease])).rows[0].s);
    ok(`[${iso}] two captures of 600 on cap 1000: only one lands`, n === 1 && sum === 600, `a=${r.a} | b=${r.b} | rows=${n} sum=${sum}`);
  }
  // Race 2b: two sessions each COMPLETE a capture of 600 (the F8 case: completed inside the race transaction) on a cap of 1000.
  {
    const L = await mkLease(1000);
    { const sid = (await admin.query("select id from sellers limit 1")).rows[0].id; const jid = (await admin.query("insert into jobs (lease_id, seller_id, amount_minor, rubric) values ($1,$2,1000,'[{\"min_score\":50,\"pay_bps\":10000}]') returning id", [L.lease, sid])).rows[0].id; await postAtomic(admin, L.lease, "commit", jid, commitLines(1000)); await payJob(admin,L.lease,jid,1000); }
    const mk = () => ({ pre: async (c) => {
      const callId = uuid(), capId = uuid(), pp = "PP-" + capId;
      await c.query("insert into paypal_calls (id, lease_id, op, request_id, amount_minor, state) values ($1,$2,'capture',$3,600,'intent')", [callId, L.lease, uuid()]);
      await c.query("insert into captures (id, lease_id, authorization_id, call_id, amount_minor, status) values ($1,$2,$3,$4,600,'intent')", [capId, L.lease, L.auth, callId]);
      await allocate(c,L.lease,capId,600);
      await c.query("update paypal_calls set state='sent', sent_at=now() where id=$1", [callId]);
      await c.query("update paypal_calls set state='succeeded', http_status=201, response=$2::jsonb where id=$1", [callId, JSON.stringify({ id: pp, amount: { value: "6.00" }, seller_receivable_breakdown: { paypal_fee: { value: "0.52" } } })]);
      await c.query("update captures set status='completed', fee_minor=52, paypal_capture_id=$2 where id=$1", [capId, pp]);
      const g = uuid();
      for (const [account, dir, amt] of [["CAPTURED_GROSS", "D", 600], ["COMMITTED_UNSETTLED", "C", 600], ["PAYPAL_FEES", "D", 52], ["CAPTURED_GROSS", "C", 52]])
        await c.query("insert into ledger_entries (group_id, lease_id, account, direction, amount_minor, ref_type, ref_id) values ($1,$2,$3,$4,$5,'capture',$6)", [g, L.lease, account, dir, amt, capId]);
    } });
    const r = await race(iso, mk(), mk());
    const sum = Number((await admin.query("select coalesce(sum(amount_minor),0) as s from captures where lease_id=$1 and status='completed'", [L.lease])).rows[0].s);
    const comm = Number((await admin.query("select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0) as c from ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED'", [L.lease])).rows[0].c);
    ok(`[${iso}] two COMPLETED captures of 600 on cap 1000: only one lands, committed never negative`, sum === 600 && comm === 400, `a=${r.a} | b=${r.b} | completed=${sum} committed=${comm}`);
  }
  // Race 3: opposite lock orders, repeated, must never deadlock.
  {
    let deadlocks = 0, bothFine = 0;
    for (let i = 0; i < 15; i++) {
      const L = await mkLease(1000);
      const a = { pre: async (c) => { await c.query("insert into paypal_calls (lease_id, op, request_id, state, sent_at) values ($1,'get',$2,'sent',now())", [L.lease, uuid()]); await reserveJob(c, L.lease, 100); } };
      const b = { pre: async (c) => { await reserveJob(c, L.lease, 100); await c.query("insert into paypal_calls (lease_id, op, request_id, state, sent_at) values ($1,'get',$2,'sent',now())", [L.lease, uuid()]); } };
      const r = await race(iso, a, b);
      if (JSON.stringify(r).includes("40P01")) deadlocks++;
      if (r.a === "committed" && (r.b === "committed" || iso === "repeatable read")) bothFine++;
    }
    ok(`[${iso}] opposite insert orders: no deadlock in 15 runs`, deadlocks === 0, `deadlocks=${deadlocks}`);
  }
}

console.log(`\n${pass} checks passed, ${fail} failed`);
await admin.end();
process.exit(fail ? 1 : 0);
