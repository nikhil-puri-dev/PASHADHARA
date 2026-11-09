import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as k from '../src/index.ts';
import { active, admin, authorization, commit, completed, db, declined, ledger, seed, seller, usd, voided } from './fixtures.ts';

beforeAll(seed);
afterAll(async () => { await db.end(); await admin.end(); });

test('fixture money flow posts gross, actual fee, allocated accrual, payout and release', async () => {
  const { lease, auth } = await active();
  const first = await commit(lease, 300n);
  const second = await commit(lease, 100n);
  const capture = await k.beginCapture(db, lease, { authorization_id: auth,
    allocations: [first, second].map(item => ({ ref_id: item.id!, amount_minor: item.amount_minor })) });
  expect(capture.amount_minor).toBe(400n);
  await expect(k.closeLease(db, lease)).rejects.toThrow('I14');
  expect(await k.markCallSent(db, lease, capture.call_id)).toBe(true);
  await k.completeCapture(db, lease, capture.capture_id, completed(randomUUID(), 400n, 63n));
  await expect(k.closeLease(db, lease)).rejects.toThrow('unaccrued');
  const a = await k.accrueSeller(db, lease, first.id!);
  const b = await k.accrueSeller(db, lease, second.id!);
  expect(a.amount_minor + b.amount_minor).toBe(337n);
  const payout = await k.queuePayout(db, lease, { source: 'metered', seller_id: seller, amount_minor: 337n });
  const payoutCall = await k.beginPayout(db, lease, payout.id);
  await expect(k.sendPayout(db, lease, payout.id)).rejects.toThrow('release time');
  // Exercise the database's real payout hold clock.
  const waitForDue = await admin.query<{ seconds: number }>(
    'select greatest(0,extract(epoch from release_at-clock_timestamp()))::float8 as seconds from public.payouts where id=$1', [payout.id]);
  await admin.query('select pg_sleep($1)', [waitForDue.rows[0]!.seconds]);
  expect(await k.sendPayout(db, lease, payout.id)).toMatchObject({ amount_minor: 337n });
  const batchId = randomUUID();
  const payoutAmount = { currency: 'USD', value: usd(337n).value };
  const item = { payout_batch_id: batchId, transaction_status: 'UNCLAIMED', payout_item: {
    amount: payoutAmount, receiver: 'fixture@example.test', sender_item_id: payoutCall.request_id,
  } };
  const payoutEvidence = { source: 'get' as const, http_status: 200, body: {
    batch_header: { batch_status: 'SUCCESS', payout_batch_id: batchId, amount: payoutAmount,
      sender_batch_header: { sender_batch_id: payoutCall.request_id } }, items: [item],
  } };
  await expect(k.completePayout(db, lease, payoutCall.call_id, payoutEvidence)).rejects.toThrow('no terminal result');
  await expect(k.completePayout(db, lease, payoutCall.call_id, { ...payoutEvidence, body: {
    batch_header: { ...payoutEvidence.body.batch_header, batch_status: 'DENIED', sender_batch_header: { sender_batch_id: randomUUID() } },
  } })).rejects.toThrow('different payout');
  item.transaction_status = 'SUCCESS';
  await k.completePayout(db, lease, payoutCall.call_id, payoutEvidence);
  const close = await k.beginVoid(db, lease);
  expect((await commit(lease, 100n)).status).toBe('refused_window');
  await k.markCallSent(db, lease, close.call_id);
  await k.completeVoid(db, lease, close.call_id, voided);
  await k.closeLease(db, lease);
  expect(await ledger(lease)).toEqual({
    BUYER_COMMITMENT: 1000n, HOLD_AVAILABLE: 0n, COMMITTED_UNSETTLED: 0n, CAPTURED_GROSS: 0n,
    PAYPAL_FEES: 63n, SELLER_COST: 337n, SELLER_PAYABLE: 0n, RELEASED: 600n,
  });
}, 45_000);

test('fixture decline needs evidence and consumes only its own allocations', async () => {
  const { lease, auth } = await active(1000n, 300n);
  const call = await commit(lease, 300n, 'original');
  expect((await commit(lease, 300n, 'original')).replayed).toBe(true);
  await expect(commit(lease, 100n, 'original')).rejects.toThrow('different tool');
  expect((await commit(lease, 100n)).status).toBe('refused_exposure');
  const capture = await k.beginCapture(db, lease, { authorization_id: auth, allocations: [{ ref_id: call.id!, amount_minor: 300n }] });
  await expect(k.failCapture(db, lease, capture.capture_id, declined(randomUUID(), 300n))).rejects.toThrow('awaiting');
  expect((await ledger(lease)).WRITTEN_OFF).toBeUndefined();
  await k.markCallSent(db, lease, capture.call_id);
  await k.failCapture(db, lease, capture.capture_id, declined(randomUUID(), 300n));
  expect(await ledger(lease)).toMatchObject({ HOLD_AVAILABLE: 700n, COMMITTED_UNSETTLED: 0n, WRITTEN_OFF: 300n });
  await expect(k.beginCapture(db, lease, { authorization_id: auth, allocations: [{ ref_id: call.id!, amount_minor: 100n }] })).rejects.toThrow();
});

test('fixture fresh window and reauthorization lineage are enforced before dispatch', async () => {
  const fresh = await active();
  await expect(k.beginReauthorize(db, fresh.lease)).rejects.toThrow();
  const old = await active(1000n, 1000n, 4);
  expect((await commit(old.lease, 100n)).status).toBe('refused_window');
  const call = await k.beginReauthorize(db, old.lease);
  expect(call.amount_minor).toBe(1000n);
  await k.markCallSent(db, old.lease, call.call_id);
  const child = await k.completeReauthorize(db, old.lease, call.call_id, { http_status: 201, body: authorization(1000n) });
  expect((await admin.query('select parent_id,status from public.authorizations where id=$1', [child.id])).rows[0])
    .toEqual({ parent_id: old.auth, status: 'created' });
  expect((await commit(old.lease, 100n)).status).toBe('served');
});

test('fixture webhook dedupe separates signature domains and preserves the canonical payload', async () => {
  const id = randomUUID();
  const base = { id, event_type: 'PAYMENT.CAPTURE.COMPLETED' };
  expect(await k.recordWebhookEvent(db, { ...base, resource: { id: 'poison' }, signature_verified: false }))
    .toEqual({ deliveries: 1, eligible: false, processed: false });
  expect(await k.recordWebhookEvent(db, { ...base, resource: { id: 'real' }, signature_verified: true }))
    .toEqual({ deliveries: 1, eligible: true, processed: false });
  expect(await k.recordWebhookEvent(db, { ...base, resource: { id: 'changed' }, signature_verified: true }))
    .toMatchObject({ deliveries: 2, eligible: false });
  expect(await k.recordWebhookEvent(db, { ...base, resource: { id: 'real' }, signature_verified: true }))
    .toMatchObject({ deliveries: 3, eligible: true });
});

test('fixture judgment uses the stored rubric and returns the unpaid reserve atomically', async () => {
  const { lease } = await active();
  const rubric = [{ min_score: 50, pay_bps: 2500 }, { min_score: 95, pay_bps: 10000 }];
  const job = await k.commitUsage(db, lease, { kind: 'job', seller_id: seller, amount_minor: 300n, rubric });
  const hash = await k.recordDelivery(db, lease, job.id!, 'fixture job');
  const passes = (id: 'openai' | 'anthropic', score: number) => ({ id, model: 'fixture', max_cost_minor: 1n,
    evaluate: async () => JSON.stringify({ verdict: 'pass', score, reasons: [] }) });
  const judgment = await k.runJudges({ job_id: job.id!, deliverable: { text: 'fixture job', content_type: 'text/plain' },
    acceptance: {}, providers: [passes('openai', 90), passes('anthropic', 100)], guard: new k.SpendGuard(2n) });
  expect(judgment.deliverable_hash).toBe(hash);
  const other = await k.commitUsage(db, lease, { kind: 'job', seller_id: seller, amount_minor: 100n, rubric });
  await k.recordDelivery(db, lease, other.id!, 'fixture job');
  await expect(k.recordJudgment(db, lease, other.id!, 1, judgment)).rejects.toThrow('different job');
  await k.cancelJob(db, lease, other.id!);
  const decision = await k.recordJudgment(db, lease, job.id!, 1, judgment);
  expect(decision).toMatchObject({ round: 1, outcome: 'partial', amount_minor: 75n, derived_from: { min_score: 90, pay_bps: 2500 } });
  expect(await ledger(lease)).toMatchObject({ HOLD_AVAILABLE: 925n, COMMITTED_UNSETTLED: 75n });
});
