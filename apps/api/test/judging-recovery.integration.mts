import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { escrowFlow } from '../src/escrow.ts';
import { seedFinance } from '../scripts/finance-seed.ts';

// Throwaway Postgres 15434 only. Judges are stubs: no network, no spend, no PayPal call.
const database = process.env.REPLAY_TEST_DATABASE ?? 'live_replay';
if (!/^live_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
after(() => db.end());

async function activeLease(cap: bigint) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'recovery-test', cap_minor: cap, unsettled_limit_minor: cap })).id;
  const order = await kernel.beginPayPalCall(db, lease, 'create_order');
  await kernel.markCallSent(db, lease, order.call_id);
  const orderId = await kernel.recordOrder(db, lease, order.call_id, { http_status: 201, body: { id: randomUUID() } });
  const call = await kernel.beginPayPalCall(db, lease, 'authorize');
  await kernel.markCallSent(db, lease, call.call_id);
  const now = Date.now();
  const resource = { id: randomUUID(), status: 'CREATED', amount: { currency_code: 'USD', value: `${cap / 100n}.${String(cap % 100n).padStart(2, '0')}` }, create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86_400_000).toISOString() };
  await kernel.recordAuthorization(db, lease, call.call_id, { http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [resource] } }] } });
  return lease;
}
const delivery = (job: string, text: string) => ({ params: { jobId: job }, query: {}, body: { deliverable: text }, request: new Request('http://localhost'), principal: null });
const verdictRows = (job: string) => db.transaction(null, tx => tx.query<{ n: string }>('select count(*) n from public.verdicts where job_id=$1', [job])).then(r => Number(r.rows[0]!.n));
const decisions = (job: string) => db.transaction(null, tx => tx.query<{ outcome: string }>('select outcome from public.decisions where job_id=$1', [job])).then(r => r.rows);

test('a delivered job that was never decided resumes when the seller resubmits the same text', async () => {
  const lease = await activeLease(1000n);
  const seller = await seedFinance(db, 'recovery-fixture@example.test');
  const job = await kernel.commitUsage(db, lease, { kind: 'job', seller_id: seller, amount_minor: 100n, rubric: [{ min_score: 0, pay_bps: 0 }] });
  // The crash: the delivery hash was committed, the process died before any verdict or decision.
  await kernel.recordDelivery(db, lease, job.id!, 'the deliverable');
  assert.equal((await decisions(job.id!)).length, 0);
  let providerCalls = 0;
  const evaluate = async () => { providerCalls++; return JSON.stringify({ verdict: 'pass', score: 100, reasons: ['ok'] }); };
  const unexpected = async () => { throw new Error('unexpected PayPal call'); };
  const flow = escrowFlow({ db, budgetCents: 100n, paypal: { capture: unexpected, payout: unexpected, getPayout: unexpected }, judges: [
    { id: 'openai', model: 'fixture', max_cost_minor: 1n, evaluate }, { id: 'anthropic', model: 'fixture', max_cost_minor: 1n, evaluate },
  ] as const });
  assert.equal((await flow.deliverJob(delivery(job.id!, 'a different text'))).status, 409, 'other text must not resume');
  assert.equal(providerCalls, 0);
  assert.equal((await flow.deliverJob(delivery(job.id!, 'the deliverable'))).status, 202);
  await flow.drain();
  assert.equal(providerCalls, 2);
  assert.equal(await verdictRows(job.id!), 2);
  assert.equal((await decisions(job.id!)).length, 1);
  assert.equal((await flow.deliverJob(delivery(job.id!, 'the deliverable'))).status, 409, 'a decided job cannot be judged again');
  await flow.drain();
  assert.equal(providerCalls, 2);
});
