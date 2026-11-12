import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { createMcp,registeredTools } from '../src/mcp.ts';
import { kernelMeter } from '../src/meter.ts';
import { summariseTool } from '../src/summarise.ts';
import { showcaseRoutes } from '../src/showcase.ts';
import { escrowFlow } from '../src/escrow.ts';
import { seedSummarise } from '../scripts/live-seed.ts';
import { settlementFlow } from '../src/settlement.ts';
import { readHandlers } from '../src/read-handlers.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import type { RouteInput } from '../src/routes.ts';

// Throwaway Postgres 15434 only. The model provider is a counting stub: no network, no spend.
const database = process.env.GATEWAY_TEST_DATABASE ?? 'postgres';
if (!/^(postgres|live_[a-z0-9_]+)$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
const key = (text: string) => `${randomUUID()}:${createHash('sha256').update('summarise').update('\0').update(text).digest('hex')}`;

async function activeLease(cap: bigint, limit = cap) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'live-gateway-test', cap_minor: cap, unsettled_limit_minor: limit })).id;
  const order = await kernel.beginPayPalCall(db, lease, 'create_order');
  await kernel.markCallSent(db, lease, order.call_id);
  const orderId = await kernel.recordOrder(db, lease, order.call_id, { http_status: 201, body: { id: randomUUID() } });
  const call = await kernel.beginPayPalCall(db, lease, 'authorize');
  await kernel.markCallSent(db, lease, call.call_id);
  const now = Date.now();
  const resource = { id: randomUUID(), status: 'CREATED', amount: { currency_code: 'USD', value: `${cap / 100n}.${String(cap % 100n).padStart(2, '0')}` },
    create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86_400_000).toISOString() };
  await kernel.recordAuthorization(db, lease, call.call_id, { http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [resource] } }] } });
  return lease;
}

function gateway(lease: string, providerKey: string | null = 'fixture-not-a-key') {
  let providerCalls = 0;
  const tool = summariseTool({
    apiKey: providerKey ?? undefined, limitUsd: 2, log: () => {},
    fetcher: async () => { providerCalls++; return Response.json({ content: [{ type: 'text', text: 'A short summary.' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 6 } }); },
  });
  const app = createMcp(kernelMeter(db), async () => lease, registeredTools(db, ['summarise']), [tool]);
  const call = async (text: string, idempotency = key(text)) => {
    const response = await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text, idempotency_key: idempotency } } }) });
    assert.equal(response.status, 200);
    const rpc = await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
    return { ...rpc.result, idempotency };
  };
  return { call, providerCalls: () => providerCalls, tool };
}

const rows = (lease: string) => db.transaction(null, tx => tx.query<{ status: string; price_minor: string; ledger_group_id: string | null }>(
  'select status,price_minor,ledger_group_id from public.tool_calls where lease_id=$1 order by id', [lease])).then(r => r.rows);

test('seed the tool', async () => { await seedSummarise(db, 'seller-fixture@example.test'); });

test('showcase reads the published lease anew and keeps an ended journal free of fixture numbers', async () => {
  const app = showcaseRoutes(db, null, 'fixture-secret', gateway('').tool, 100);
  const read = async () => {
    const response = await app.request('http://localhost/showcase');
    assert.equal(response.status, 200);
    return response.json() as Promise<{ lease?: { id: string }; state: string; ended: boolean; read_at: string; provenance: string }>;
  };
  const empty = await read();
  assert.equal(empty.state, 'ended');
  assert.equal(empty.lease, undefined);
  assert.ok(Date.parse(empty.read_at));
  const old = await activeLease(100n);
  // Fixture only: database owner has backdated the honor clock for this test through the helper below.
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:15434/${database}` });
  await owner.connect();
  try {
    await owner.query('begin');
    await owner.query('alter table public.authorizations disable trigger authorizations_immutable');
    await owner.query("update public.authorizations set created_at=now()-interval '4 days',honor_until=now()-interval '1 day' where lease_id=$1", [old]);
    await owner.query('alter table public.authorizations enable trigger authorizations_immutable');
    await owner.query('commit');
  } finally { await owner.end(); }
  const register = (lease: string, published: boolean) => db.transaction(null, tx => tx.query(
    'insert into public.showcase_leases(lease_id,published_at) values ($1,case when $2 then now() end)', [lease, published],
  ));
  await register(old, true);
  const ended = await read();
  assert.equal(ended.state, 'ended');
  assert.equal(ended.lease?.id, old);
  assert.equal(ended.provenance, 'computed');
  const replacement = await activeLease(100n);
  await db.transaction(replacement, async tx => {
    await tx.query(`insert into public.tools(id,seller_id,name,price_minor)
      select 'rotation-refusal-fixture',seller_id,'Refusal fixture',101 from public.tools where id='summarise'
      on conflict (id) do nothing`);
  });
  const refusal = await kernel.commitUsage(db, replacement, { kind: 'tool', tool_id: 'rotation-refusal-fixture', idempotency_key: randomUUID() });
  assert.equal(refusal.status, 'refused_cap');
  await register(replacement, false);
  assert.equal((await read()).lease?.id, old);
  await db.transaction(null, tx => tx.query('update public.showcase_leases set published_at=now() where lease_id=$1', [replacement]));
  const active = await read();
  assert.equal(active.lease?.id, replacement);
  assert.equal(active.state, 'active');
  assert.equal(active.ended, false);
  const publicRows = await (await app.request('http://localhost/showcase')).json() as { calls: Record<string, unknown>[] };
  assert.deepEqual(publicRows.calls.map(call => [call.id, call.status, call.ledger_group_id]), [[refusal.id, 'refused_cap', null]]);
  assert.ok(!Object.hasOwn(publicRows.calls[0]!, 'idempotency_key'));
});

test('lost capture response and concurrent void preserve exactly one batch and one release', async () => {
  const lease = await activeLease(1000n, 350n);
  const secret = 'fixture-only-lease-signing-secret';
  const request = new Request('http://localhost', { headers: { authorization: `Bearer ${issueToken(secret, 'lease', lease)}` } });
  const input: RouteInput = { params: { leaseId: lease }, request, principal: null, body: undefined, query: {} };
  const auth = (await db.transaction(null, tx => tx.query<{ paypal_authorization_id: string }>(
    'select paypal_authorization_id from public.authorizations where lease_id=$1', [lease],
  ))).rows[0]!.paypal_authorization_id;
  const order = (await db.transaction(null, tx => tx.query<{ paypal_order_id: string }>(
    'select paypal_order_id from public.leases where id=$1', [lease],
  ))).rows[0]!.paypal_order_id;
  const seller = await seedSummarise(db, 'seller-fixture@example.test');
  const tool = randomUUID();
  await db.transaction(null, tx => tx.query("insert into public.tools(id,seller_id,name,price_minor) values ($1,$2,'Fixture',100)", [tool, seller]));
  const use = () => kernel.commitUsage(db, lease, { kind: 'tool', tool_id: tool, idempotency_key: randomUUID() });
  for (let i = 0; i < 2; i++) assert.equal((await use()).status, 'served');
  let capturePosts = 0, voidPosts = 0, voided = false, failVoidRead = true;
  let capture: Record<string, unknown>;
  let reachedVoid!: () => void, finishVoid!: () => void;
  const atVoid = new Promise<void>(resolve => { reachedVoid = resolve; });
  const allowVoid = new Promise<void>(resolve => { finishVoid = resolve; });
  const money = (value: string) => ({ currency_code: 'USD', value });
  const flow = settlementFlow(db, {
    async capture(_auth, amount, invoice_id) {
      capturePosts++;
      capture = { id: randomUUID(), invoice_id, status: 'COMPLETED', amount, seller_receivable_breakdown: { paypal_fee: money('0.59') } };
      throw new Error('Fixture response lost after capture');
    },
    async getOrder() { return { status: 200, body: { id: order, purchase_units: [{ payments: { captures: [capture] } }] } }; },
    async getCapture() { return { status: 200, body: capture }; },
    async void() { voidPosts++; reachedVoid(); await allowVoid; voided = true; throw new Error('Fixture response lost after void'); },
    async getAuthorization() {
      if (voided && failVoidRead) { failVoidRead = false; throw new Error('Fixture void GET failed'); }
      return { status: 200, body: { id: auth, status: voided ? 'VOIDED' : 'PARTIALLY_CAPTURED', amount: money('10.00') } };
    },
    async reauthorize() { throw new Error('Unexpected reauthorization'); },
  }, readHandlers(db).getLease!);
  assert.deepEqual((await flow.sweep()).find(r => r.leaseId === lease),
    { leaseId: lease, planned: false, dispatched: false });
  assert.equal((await use()).status, 'served');
  assert.deepEqual((await flow.sweep()).find(r => r.leaseId === lease),
    { leaseId: lease, planned: true, dispatched: true });
  assert.equal((await flow.handlers.settleLease(input)).status, 409);
  assert.equal(capturePosts, 1);
  const proof = await flow.handlers.reconcileLease(input);
  assert.equal(proof.status, 200);
  assert.equal((proof.body as { all_match: boolean }).all_match, true);
  const close = flow.handlers.closeLease(input);
  await atVoid;
  try {
    assert.equal((await use()).status, 'refused_window');
    assert.equal((await flow.handlers.closeLease(input)).status, 409);
  } finally { finishVoid(); }
  assert.equal((await close).status, 409);
  assert.equal((await flow.handlers.closeLease(input)).status, 409);
  assert.equal((await flow.handlers.reconcileLease(input)).status, 200);
  assert.equal(voidPosts, 1);
  assert.equal((await db.transaction(null, tx => tx.query('select state from public.leases where id=$1', [lease]))).rows[0]?.state, 'closed');
  assert.equal(await createAuth(db, secret, '').resolveMcpLease(request), null);
  const { rows: journal } = await db.transaction(null, tx => tx.query(
    "select ref_type,account,amount_minor from public.ledger_entries where lease_id=$1 and ref_type in ('capture','void') and direction='D' order by account", [lease],
  ));
  assert.deepEqual(journal.map(row => [row.ref_type, row.account, row.amount_minor]), [
    ['capture', 'CAPTURED_GROSS', '300'], ['capture', 'PAYPAL_FEES', '59'], ['void', 'RELEASED', '700'],
  ]);
});

after(() => db.end());

test('served call debits the lease, the next call that would pass the cap is refused before the provider', async () => {
  const lease = await activeLease(5n);
  const g = gateway(lease);
  const first = await g.call('First document to summarise.');
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.summary, 'A short summary.');
  assert.deepEqual(first.structuredContent.receipt, {
    provenance: 'computed', lease_id: lease,
    tool_call_id: (first.structuredContent.receipt as any).tool_call_id,
    ledger_group_id: (first.structuredContent.receipt as any).ledger_group_id,
    charged_minor: 3, remaining_minor: 2,
  });
  assert.equal(g.providerCalls(), 1);
  const second = await g.call('Second document to summarise.');
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.reason, 'cap_reached');
  assert.equal(second.structuredContent.remaining_minor, 2);
  assert.match(String(second.structuredContent.next_action), /cheaper tool/);
  assert.equal(g.providerCalls(), 1, 'refused call must not reach the provider');
  const journal = await rows(lease);
  const served = journal.find(row => row.status === 'served')!;
  const refused = journal.find(row => row.status === 'refused_cap')!;
  assert.equal(journal.length, 2);
  assert.equal(served.price_minor, '3');
  assert.notEqual(served.ledger_group_id, null);
  assert.equal((first.structuredContent.receipt as any).ledger_group_id, served.ledger_group_id);
  assert.equal(refused.ledger_group_id, null);

  // Replayed key: no new charge, no provider call.
  const replay = await g.call('First document to summarise.', first.idempotency);
  assert.equal(replay.structuredContent.error, 'idempotency_conflict');
  assert.equal(g.providerCalls(), 1);
  assert.equal((await rows(lease)).length, 2);

});

test('call after the authorization is voided is refused before the provider', async () => {
  const lease = await activeLease(5n);
  const g = gateway(lease);
  const voidCall = await kernel.beginVoid(db, lease);
  await kernel.markCallSent(db, lease, voidCall.call_id);
  await kernel.completeVoid(db, lease, voidCall.call_id, { http_status: 204, body: {} });
  const secret = 'fixture-only-lease-signing-secret';
  const request = new Request('http://localhost', { headers: { authorization: `Bearer ${issueToken(secret, 'lease', lease)}` } });
  assert.equal(await createAuth(db, secret, '').authenticate([{ leaseToken: [] }], request, 'getLease', { leaseId: lease }, undefined), null);
  const result = await g.call('after void');
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, 'window_ended');
  assert.equal(g.providerCalls(), 0);
});

test('exact cap spends to zero and one more cent of demand is refused', async () => {
  const lease = await activeLease(6n);
  const g = gateway(lease);
  assert.equal((await g.call('a')).isError, undefined);
  assert.equal((await g.call('b')).isError, undefined);
  const third = await g.call('c');
  assert.equal(third.structuredContent.reason, 'cap_reached');
  assert.equal(third.structuredContent.remaining_minor, 0);
  assert.equal(g.providerCalls(), 2);
});

test('two parallel calls on a lease with room for one: exactly one is served', async () => {
  const lease = await activeLease(5n);
  const g = gateway(lease);
  const results = await Promise.all([g.call('parallel one'), g.call('parallel two')]);
  assert.equal(results.filter(result => !result.isError).length, 1);
  assert.equal(results.filter(result => result.structuredContent.reason === 'cap_reached').length, 1);
  assert.equal(g.providerCalls(), 1);
});

test('no model key: unavailable, nothing charged', async () => {
  const lease = await activeLease(5n);
  const g = gateway(lease, null);
  const result = await g.call('no key');
  assert.equal(result.structuredContent.error, 'tool_unavailable');
  assert.equal((await rows(lease)).length, 0);
});

const balance = (lease: string) => db.transaction(null, tx => balances(tx, lease)).then(b => b.hold);
const ledgerRows = (lease: string) => db.transaction(null, tx => tx.query<{ n: number }>(
  'select count(*)::int as n from public.ledger_entries where lease_id=$1', [lease])).then(r => r.rows[0]!.n);

test('a provider failure after admission leaves no charge and no served row', async () => {
  const lease = await activeLease(5n);
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: async () => new Response('no', { status: 500 }) });
  const app = createMcp(kernelMeter(db), async () => lease, registeredTools(db, ['summarise']), [tool]);
  const idempotency = key('x');
  const send = async () => (await (await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text: 'x', idempotency_key: idempotency } } }) })).json() as any).result;
  const before = { hold: await balance(lease), ledger: await ledgerRows(lease) };
  const first = await send();
  assert.deepEqual(first.structuredContent, { ok: false, error: 'tool_failed', charged: false });
  assert.deepEqual(await rows(lease), [], 'no tool_calls row, so nothing is marked served');
  assert.equal(await balance(lease), before.hold);
  assert.equal(await ledgerRows(lease), before.ledger);
});

test('showcase run: a model failure after admission returns 502, charges nothing, marks nothing served', async () => {
  const lease = await activeLease(1000n);
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: async () => { throw new Error('upstream down'); } });
  const app = showcaseRoutes(db, lease, 'fixture-secret', tool, 100);
  const before = { hold: await balance(lease), ledger: await ledgerRows(lease) };
  const response = await app.request('http://localhost/showcase/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'tool_failed', charged: false });
  assert.deepEqual(await rows(lease), []);
  assert.equal(await balance(lease), before.hold);
  assert.equal(await ledgerRows(lease), before.ledger);
  const proof = await (await app.request('http://localhost/showcase')).json() as { remaining_calls: number; calls: unknown[] };
  assert.equal(proof.calls.length, 0);
  assert.equal(proof.remaining_calls, 2, 'a failed run must not use up the visitor allowance');
});

test('exhausted AI budget refuses before the kernel charges', async () => {
  const lease = await activeLease(5n);
  let calls = 0;
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 0.001, log: () => {}, fetcher: async () => { calls++; return Response.json({}); } });
  const app = createMcp(kernelMeter(db), async () => lease, registeredTools(db, ['summarise']), [tool]);
  const response = await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text: 'x', idempotency_key: key('x') } } }) });
  const rpc = await response.json() as any;
  assert.equal(rpc.result.structuredContent.error, 'tool_unavailable');
  assert.equal(calls, 0);
  assert.equal((await rows(lease)).length, 0);
});


test('public showcase refuses 48 of 50 requests from one IP and previews a cap breach without a charge', async () => {
  const lease = await activeLease(1000n);
  const g = gateway(lease);
  const first = showcaseRoutes(db, lease, 'fixture-secret', g.tool, 100);
  const second = showcaseRoutes(db, lease, 'fixture-secret', g.tool, 100);
  const headers = { 'content-type': 'application/json' };
  const attempts = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    (i % 2 ? first : second).request('http://localhost/showcase/run', { method: 'POST', headers })));
  assert.equal(attempts.filter(r => r.status === 200).length, 2);
  assert.equal(attempts.filter(r => r.status === 429).length, 48);
  assert.equal(g.providerCalls(), 2);
  assert.equal((await rows(lease)).length, 2);
  const proof = await (await second.request('http://localhost/showcase')).json() as {
    lease: { balances: { hold_available: number } }; calls: Record<string, unknown>[];
  };
  assert.equal(proof.lease.balances.hold_available, 994);
  assert.equal(proof.calls.length, 2);
  assert.ok(proof.calls.every(row => !Object.hasOwn(row, 'idempotency_key')));
  const refused = await second.request('http://localhost/showcase/try?price_minor=995', { method: 'POST' });
  assert.equal(refused.status, 402);
  assert.equal((await refused.json() as { reason: string }).reason, 'cap_reached');
  assert.equal((await rows(lease)).length, 2);
  assert.equal(g.providerCalls(), 2);
});

test('judge admission survives two API instances and a failed provider', async () => {
  const lease = await activeLease(1000n);
  const seller = await seedSummarise(db, 'seller-fixture@example.test');
  const makeJob = () => kernel.commitUsage(db, lease, {
    kind: 'job', seller_id: seller, amount_minor: 100n, rubric: [{ min_score: 0, pay_bps: 0 }],
  });
  const [a,b] = await Promise.all([makeJob(),makeJob()]);
  let providerCalls = 0;
  const evaluate = async () => { providerCalls++; throw new Error('fixture provider failure'); };
  const unexpected = async () => { throw new Error('unexpected PayPal call'); };
  const options = {
    db, budgetCents: 10n,
    judges: [
      { id: 'openai', model: 'fixture', max_cost_minor: 5n, evaluate },
      { id: 'anthropic', model: 'fixture', max_cost_minor: 5n, evaluate },
    ] as const,
    paypal: { capture: unexpected, payout: unexpected, getPayout: unexpected },
  };
  const delivery = (job: string) => ({
    params: { jobId: job }, query: {}, body: { deliverable: 'fixture' }, request: new Request('http://localhost'), principal: null,
  });
  const disabled = escrowFlow({ ...options, judges: undefined });
  assert.equal((await disabled.deliverJob(delivery(a.id!))).status, 409);
  const first = escrowFlow(options);
  const second = escrowFlow(options);
  const responses = await Promise.all([first.deliverJob(delivery(a.id!)), second.deliverJob(delivery(b.id!))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202,409]);
  await Promise.all([first.drain(),second.drain()]);
  assert.equal(providerCalls, 2);
  const fresh = escrowFlow(options);
  assert.equal((await fresh.deliverJob(delivery(responses[0]!.status === 409 ? a.id! : b.id!))).status, 409);
  assert.equal(providerCalls, 2);
});

test('parallel read sweeps send exactly one due payout and reconcile one posting', { timeout: 45000 }, async () => {
  const lease = await activeLease(1000n);
  const usage = await kernel.commitUsage(db, lease, { kind: 'tool', tool_id: 'summarise', idempotency_key: randomUUID() });
  const auth = await db.transaction(null, async tx => (await tx.query<{ id: string }>(
    'select id from public.authorizations where lease_id=$1', [lease])).rows[0]!);
  const capture = await kernel.beginCapture(db, lease, {
    authorization_id: auth.id, allocations: [{ ref_id: usage.id!, amount_minor: 3n }],
  });
  await kernel.markCallSent(db, lease, capture.call_id);
  await kernel.completeCapture(db, lease, capture.capture_id, {
    http_status: 201, body: { id: randomUUID(), invoice_id: capture.capture_id, status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '0.03' },
      seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '0.01' } } },
  });
  const earned = await kernel.accrueSeller(db, lease, usage.id!);
  const queued = await kernel.queuePayout(db, lease, { ...earned, source: 'metered' });
  let sends = 0, requestId = '', receiver = '';
  const batchId = randomUUID();
  const money = { value: '0.02', currency: 'USD' };
  const unexpected = async () => { throw new Error('unexpected capture'); };
  const options = { db, budgetCents: 0n, judges: undefined, paypal: {
    capture: unexpected,
    payout: async (email: string, _amount: unknown, key: string) => {
      sends++; requestId = key; receiver = email;
      return { status: 201, body: { batch_header: { payout_batch_id: batchId } }, headers: new Headers() };
    },
    getPayout: async () => ({
      status: 200, headers: new Headers(),
      body: { batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS', amount: money,
        sender_batch_header: { sender_batch_id: requestId } },
        items: [{ payout_batch_id: batchId, transaction_status: 'SUCCESS',
          payout_item: { sender_item_id: requestId, receiver, amount: money } }] },
    }),
  } };
  const a = escrowFlow(options), b = escrowFlow(options);
  a.sweep(lease);
  await a.drain();
  assert.equal(sends, 0, 'hold still active');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, queued.release_at.getTime() - Date.now()) + 200));
  a.sweep(lease); b.sweep(lease);
  await Promise.all([a.drain(), b.drain()]);
  assert.equal(sends, 1);
  const saved = await db.transaction(null, async tx => (await tx.query<{ state: string; calls: number; postings: number }>(`
    select p.state,
      (select count(*)::int from public.paypal_calls where lease_id=$1 and op='payout') as calls,
      (select count(*)::int from public.ledger_entries where lease_id=$1 and ref_type='payout' and account='SELLER_PAYABLE') as postings
    from public.payouts p where p.id=$2`, [lease, queued.id])).rows[0]!);
  assert.deepEqual(saved, { state: 'success', calls: 1, postings: 1 });
});
