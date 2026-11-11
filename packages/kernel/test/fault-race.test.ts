import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as k from '../src/index.ts';
import { active, admin, commit, completed, db, kernelTestUrl, declined, ledger, seed, toolId, usd } from './fixtures.ts';

const other = new k.Database(kernelTestUrl);
beforeAll(seed);
afterAll(async () => { await other.end(); await db.end(); await admin.end(); });

test('fixture crash recovery blocks a second dispatch and posts exactly one matched GET', async () => {
  const { lease, auth } = await active();
  const usage = await commit(lease, 700n);
  const input = { authorization_id: auth, allocations: [{ ref_id: usage.id!, amount_minor: 700n }] };
  const capture = await k.beginCapture(db, lease, input);
  expect((await admin.query('select state from public.paypal_calls where id=$1', [capture.call_id])).rows[0]?.state).toBe('intent');
  const dispatch = await Promise.all([k.markCallSent(db, lease, capture.call_id), k.markCallSent(other, lease, capture.call_id)]);
  expect(dispatch.filter(Boolean)).toHaveLength(1);

  // The first worker lost the response. The replacement worker only reads.
  await k.markUnknown(other, lease, capture.call_id);
  const remoteId = randomUUID();
  await expect(k.completeCapture(db, lease, capture.capture_id, completed(remoteId, 700n))).rejects.toThrow('fresh PayPal GET');
  await expect(k.resolveUnknown(other, lease, capture.call_id, { source: 'get', http_status: 404, body: {} })).rejects.toThrow('terminal');
  await expect(k.beginCapture(other, lease, input)).rejects.toMatchObject({ code: '23505' });
  await expect(k.resolveUnknown(other, lease, capture.call_id, { ...completed(randomUUID(), 700n), source: 'get' }))
    .rejects.toThrow('invoice');
  const final = completed(remoteId, 700n, 73n);
  const evidence = { ...final, body: { ...final.body, invoice_id: capture.capture_id }, source: 'get' as const };
  const resolutions = await Promise.allSettled([
    k.resolveUnknown(db, lease, capture.call_id, evidence), k.resolveUnknown(other, lease, capture.call_id, evidence),
  ]);
  expect(resolutions.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await ledger(lease)).toMatchObject({ CAPTURED_GROSS: 627n, PAYPAL_FEES: 73n, COMMITTED_UNSETTLED: 0n });
  expect((await admin.query(`select count(*)::int n from public.ledger_entries
    where lease_id=$1 and ref_type='capture' and account='CAPTURED_GROSS' and direction='D'`, [lease])).rows[0]?.n).toBe(1);
});

test('fixture pending capture pins the remote id and final fee parsing is atomic', async () => {
  const { lease, auth } = await active();
  const usage = await commit(lease, 300n);
  const capture = await k.beginCapture(db, lease, { authorization_id: auth, allocations: [{ ref_id: usage.id!, amount_minor: 300n }] });
  await k.markCallSent(db, lease, capture.call_id);
  const id = randomUUID();
  expect(await k.recordPendingCapture(db, lease, capture.capture_id,
    { http_status: 202, body: { id, status: 'PENDING', amount: usd(300n) } })).toBe('pending');
  await k.markUnknown(other, lease, capture.call_id);
  await expect(k.resolveUnknown(other, lease, capture.call_id, { ...declined(randomUUID(), 300n), source: 'get' })).rejects.toThrow('different capture');
  await expect(k.resolveUnknown(other, lease, capture.call_id, { source: 'get', http_status: 200, body: {
    ...completed(id, 300n).body, seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '0.123' } },
  } })).rejects.toThrow('two-decimal');
  const persisted = await admin.query(`select p.state,p.response,c.status from public.paypal_calls p
    join public.captures c on c.call_id=p.id where p.id=$1`, [capture.call_id]);
  expect(persisted.rows[0]).toEqual({ state: 'unknown', status: 'unknown', response: null });
  expect(await k.resolveUnknown(other, lease, capture.call_id, { ...declined(id, 300n), source: 'get' })).toBe('declined');
  expect(await ledger(lease)).toMatchObject({ COMMITTED_UNSETTLED: 0n, WRITTEN_OFF: 300n });
});

test('fixture concurrent commits and capture intents conserve the cap through separate connections', async () => {
  const { lease, auth } = await active();
  const sameLeaseCommit = (client: k.Database, key: string) => k.commitUsage(client, lease, {
    kind: 'tool', tool_id: toolId(700n), idempotency_key: key,
  });
  await commit(lease, 100n);
  const commits = await Promise.all([sameLeaseCommit(db, 'a'), sameLeaseCommit(other, 'b')]);
  expect(commits.map(x => x.status).sort()).toEqual(['refused_cap', 'served']);
  const winner = commits.find(x => x.status === 'served')!;
  const intents = await Promise.allSettled([db, other].map(client => k.beginCapture(client, lease, {
    authorization_id: auth, allocations: [{ ref_id: winner.id!, amount_minor: 700n }],
  })));
  expect(intents.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const loser = intents.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(loser.reason).toMatchObject({ code: '23505' });
  expect(await ledger(lease)).toMatchObject({ BUYER_COMMITMENT: 1000n, HOLD_AVAILABLE: 200n, COMMITTED_UNSETTLED: 800n });
  const counts = await admin.query(`select count(distinct p.id)::int calls, count(distinct c.id)::int captures
    from public.paypal_calls p join public.captures c on c.call_id=p.id where p.lease_id=$1`, [lease]);
  expect(counts.rows[0]).toEqual({ calls: 1, captures: 1 });
});

test('fixture SQLSTATE 40001 retries the whole transaction after rollback', async () => {
  const { lease } = await active();
  const marker = randomUUID();
  let attempts = 0;
  await db.transaction(lease, async tx => {
    const identity = await tx.query("select session_user,current_user,current_setting('transaction_isolation') as isolation");
    expect(identity.rows[0]).toEqual({ session_user: 'kernel_login', current_user: 'pashadhara_app', isolation: 'read committed' });
    await tx.query("insert into public.paypal_calls(lease_id,op,request_id,state) values ($1,'get',$2,'intent')", [lease, marker]);
    if (++attempts === 1) await tx.query("do $$ begin raise exception 'fixture retry' using errcode='40001'; end $$");
  });
  expect(attempts).toBe(2);
  expect((await admin.query('select count(*)::int n from public.paypal_calls where request_id=$1', [marker])).rows[0]?.n).toBe(1);
});

test('fixture refund GET atomically reverses gross and recovers attributable payable', async () => {
  const { lease, auth } = await active();
  const usage = await commit(lease, 300n);
  const capture = await k.beginCapture(db, lease, { authorization_id: auth, allocations: [{ ref_id: usage.id!, amount_minor: 300n }] });
  const id = randomUUID();
  await k.markCallSent(db, lease, capture.call_id);
  await k.completeCapture(db, lease, capture.capture_id, completed(id, 300n, 59n));
  await k.accrueSeller(db, lease, usage.id!);
  const read = await k.beginPayPalCall(db, lease, 'get');
  await k.markCallSent(db, lease, read.call_id);
  await k.reverseCapture(db, lease, capture.capture_id, read.call_id, {
    source: 'get', http_status: 200, body: { id, status: 'REFUNDED', amount: usd(300n) },
  });
  expect(await ledger(lease)).toMatchObject({
    CAPTURED_GROSS: -59n, PAYPAL_FEES: 59n, CHARGEBACK_LOSS: 300n, SELLER_COST: 0n, SELLER_PAYABLE: 0n,
  });
});

test('fixture early accrual cannot strand the remaining amount of a split capture', async () => {
  const { lease, auth } = await active();
  const usage = await commit(lease, 300n);
  for (const amount of [100n, 200n]) {
    const capture = await k.beginCapture(db, lease, { authorization_id: auth, allocations: [{ ref_id: usage.id!, amount_minor: amount }] });
    await k.markCallSent(db, lease, capture.call_id);
    await k.completeCapture(db, lease, capture.capture_id, completed(randomUUID(), amount));
    if (amount === 100n) await expect(k.accrueSeller(db, lease, usage.id!)).rejects.toThrow('remaining');
  }
  expect((await k.accrueSeller(db, lease, usage.id!)).amount_minor).toBe(300n);
});

test('fixture definitive void rejection unlocks commits while ambiguous transport failure stays open', async () => {
  const { lease } = await active();
  const attempt = await k.beginVoid(db, lease);
  await k.markCallSent(db, lease, attempt.call_id);
  await expect(k.recordRejectedCall(db, lease, attempt.call_id, { http_status: 503, body: {} })).rejects.toThrow('definitive');
  expect((await commit(lease, 100n)).status).toBe('refused_window');
  await k.recordRejectedCall(db, lease, attempt.call_id, { http_status: 400, body: { name: 'INVALID_REQUEST' } });
  expect((await commit(lease, 100n)).status).toBe('served');
});
