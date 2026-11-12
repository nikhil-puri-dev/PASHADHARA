import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createMcp, registeredTools, type ToolDef } from '../src/mcp.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';
import { seedFinance } from '../scripts/finance-seed.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createApp } from '../src/app.ts';

// Isolated Postgres 15433 only. Fixture authorizations, no PayPal or model calls.
const database = process.env.MCP_TEST_DATABASE ?? 'mcp_test_20261112';
if (!/^mcp_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15433/${database}`);
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
const key = (text: string) => `${randomUUID()}:${createHash('sha256').update('finance_payment_lookup').update('\0').update(text).digest('hex')}`;
after(() => db.end());
test('seed', async () => { await seedFinance(db, 'replay-fixture@example.test'); });

test('REST and MCP expose only active implemented registry entries', async () => {
  const tool: ToolDef = { name: 'finance_payment_lookup', description: 'Fixture evidence.', admit: () => null };
  const contract = parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8'));
  const app = createApp({ db, contract, authenticate: async () => ({}), resolveMcpLease: async () => null, tools: [tool] });
  const rest = await app.request('http://localhost/api/v1/tools');
  assert.equal(rest.status, 200);
  const listed = await rest.json() as { tools: { id: string; price_minor: number }[] };
  assert.deepEqual(listed.tools.map(row => [row.id, row.price_minor]), [['finance_payment_lookup', 2]]);
  const response = await app.request('http://localhost/api/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const mcp = await response.json() as { result: { tools: { name: string; _meta: Record<string, unknown> }[] } };
  assert.deepEqual(mcp.result.tools.map(row => [row.name, row._meta['pashadhara/price_minor']]), [['finance_payment_lookup', 2]]);
});

async function activeLease(cap: bigint) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'replay-test', cap_minor: cap, unsettled_limit_minor: cap })).id;
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
function gateway(lease: string, withStore: boolean) {
  let runs = 0, cancels = 0, admits = 0, available = true;
  const tool: ToolDef = { name: 'finance_payment_lookup', description: 'counting stub', admit: () => { admits++; return available ? ({ cancel() { cancels++; }, async run() { runs++; return { provenance: 'fixture', evidence: { id: 'PAY-A', pair: 'A', n: runs } }; } }) : null; } };
  const app = createMcp(kernelMeter(db, undefined, withStore ? resultStore(db) : undefined), async () => lease, registeredTools(db, ['finance_payment_lookup']), [tool]);
  const call = async (text: string, idempotency?: string) => {
    const response = await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'finance_payment_lookup', arguments: { text, ...(idempotency === undefined ? {} : { idempotency_key: idempotency }) } } }) });
    return (await response.json() as { result: { isError?: boolean; structuredContent: any; content: { text: string }[] } }).result;
  };
  return { call, runs: () => runs, cancels: () => cancels, admits: () => admits, setAvailable: (value: boolean) => { available = value; } };
}
const served = (lease: string) => db.transaction(null, tx => tx.query<{ s: string }>("select coalesce(sum(amount_minor),0) s from public.ledger_entries where lease_id=$1 and account='COMMITTED_UNSETTLED' and direction='D'", [lease])).then(r => BigInt(r.rows[0]!.s));
const digest = (text: string) => createHash('sha256').update('finance_payment_lookup').update('\0').update(text).digest('hex');
const counts = (lease: string) => db.transaction(null, tx => tx.query<{ c: string; l: string }>('select (select count(*) from public.tool_calls where lease_id=$1) c,(select count(*) from public.ledger_entries where lease_id=$1) l', [lease])).then(r => r.rows[0]!);

test('same key replays the stored product with no second charge, no second provider run', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), k = key('A');
  const first = await g.call('A', k);
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.receipt.charged_minor, 2);
  const before = await counts(lease);
  const replay = await g.call('A', k);
  assert.equal(replay.isError, undefined);
  assert.deepEqual(replay.structuredContent.evidence, first.structuredContent.evidence);
  assert.equal(replay.structuredContent.receipt.replayed, true);
  assert.equal(replay.structuredContent.receipt.charged_minor, 0);
  assert.equal(replay.structuredContent.receipt.tool_call_id, first.structuredContent.receipt.tool_call_id);
  assert.equal(replay.structuredContent.receipt.remaining_minor, 8);
  assert.equal(g.runs(), 1);
  assert.deepEqual(await counts(lease), before);
  assert.equal(g.admits(), 1, 'a replay must not ask for admission at all, so nothing is left to release');
  assert.equal(g.cancels(), 0);
});

test('a replayed refusal stays a refusal and charges nothing', async () => {
  const lease = await activeLease(3n);
  const g = gateway(lease, true), k = key('A');
  assert.equal((await g.call('A', key('A'))).isError, undefined);
  const refused = await g.call('A', k);
  assert.equal(refused.structuredContent.reason, 'cap_reached');
  const before = await counts(lease);
  const again = await g.call('A', k);
  assert.equal(again.structuredContent.reason, 'cap_reached');
  assert.deepEqual(await counts(lease), before);
  assert.equal(g.runs(), 1);
});

test('without the store a reused key is still refused as before', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, false), k = key('A');
  await g.call('A', k);
  assert.equal((await g.call('A', k)).structuredContent.error, 'idempotency_conflict');
  assert.equal(g.runs(), 1);
});


test('official SDK over HTTP sees price, serves and receives refusal', async () => {
  const lease = await activeLease(3n);
  let runs = 0;
  const tool: ToolDef = { name: 'finance_payment_lookup', description: 'Fixture evidence.', admit: () => ({ cancel() {}, async run() { runs++; return { provenance: 'fixture', evidence: 'fixture' }; } }) };
  const app = createMcp(kernelMeter(db, undefined, resultStore(db)), async request => request.headers.get('authorization') === 'Bearer fixture-token' ? lease : null, registeredTools(db, [tool.name]), [tool]);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  const client = new Client({ name: 'fixture-sdk-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: 'Bearer fixture-token' } } }));
    const list = await client.listTools();
    assert.match(list.tools[0]!.description!, /Price: 2 USD cents/);
    const first = await client.callTool({ name: tool.name, arguments: { text: 'A', idempotency_key: key('A') } });
    assert.equal((first.structuredContent as any).receipt.charged_minor, 2);
    const refusal = await client.callTool({ name: tool.name, arguments: { text: 'A', idempotency_key: key('A') } });
    assert.equal(refusal.isError, true);
    assert.equal((refusal.structuredContent as any).reason, 'cap_reached');
    assert.equal(runs, 1);
  } finally { await client.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('same UUID with a different digest is a conflict: no admission, no charge, no provider run', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), id = randomUUID();
  assert.equal((await g.call('A', `${id}:${digest('A')}`)).isError, undefined);
  const before = await counts(lease), admitsBefore = g.admits();
  const other = await g.call('B', `${id}:${digest('B')}`);
  assert.equal(other.isError, true);
  assert.equal(other.structuredContent.error, 'idempotency_conflict');
  assert.match(other.structuredContent.message, /Nothing was charged.*new random UUID/);
  assert.deepEqual(await counts(lease), before);
  assert.equal(g.admits(), admitsBefore, 'a conflict must do no admission work');
  assert.equal(g.runs(), 1);
});

test('bare UUID: same text retried replays free, different text conflicts, key form never changes the charge', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), id = randomUUID();
  const first = await g.call('A', id);
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.receipt.charged_minor, 2);
  const before = await counts(lease);
  const replay = await g.call('A', id);
  assert.equal(replay.isError, undefined);
  assert.equal(replay.structuredContent.receipt.replayed, true);
  assert.equal(replay.structuredContent.receipt.charged_minor, 0);
  const upper = await g.call('A', id.toUpperCase());
  assert.equal(upper.structuredContent.receipt.replayed, true, 'UUID case must not make a new key');
  const legacy = await g.call('A', `${id}:${digest('A')}`);
  assert.equal(legacy.structuredContent.receipt.replayed, true, 'the digest form still works and is the same invocation');
  assert.equal((await g.call('B', id)).structuredContent.error, 'idempotency_conflict');
  assert.deepEqual(await counts(lease), before);
  assert.equal(g.runs(), 1);
});

test('two parallel calls with the same bare UUID charge once', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), id = randomUUID();
  const results = await Promise.all([g.call('A', id), g.call('A', id)]);
  assert.deepEqual(results.map(r => r.isError), [undefined, undefined]);
  assert.deepEqual(results.map(r => r.structuredContent.receipt.charged_minor).sort(), [0, 2]);
  assert.equal((await counts(lease)).c, '1'); assert.equal(await served(lease), 2n);
  assert.equal(g.runs(), 1);
});

test('parallel calls with the same UUID and different text: one charge, one conflict', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), id = randomUUID();
  const results = await Promise.all([g.call('A', id), g.call('B', id)]);
  assert.equal(results.filter(r => r.isError).length, 1);
  assert.equal(results.find(r => r.isError)!.structuredContent.error, 'idempotency_conflict');
  assert.equal((await counts(lease)).c, '1'); assert.equal(await served(lease), 2n);
});

test('the same UUID on another lease is independent', async () => {
  const a = await activeLease(10n), b = await activeLease(10n), id = randomUUID();
  const ga = gateway(a, true), gb = gateway(b, true);
  assert.equal((await ga.call('A', id)).isError, undefined);
  const other = await gb.call('B', id);
  assert.equal(other.isError, undefined);
  assert.equal(other.structuredContent.receipt.replayed, undefined);
});

test('a call with no idempotency_key is refused with what to send, before admission or charge', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), start = await counts(lease);
  const refused = await g.call('A');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /idempotency_key/);
  assert.match(refused.content[0]!.text, /UUID/);
  assert.equal(g.admits(), 0);
  assert.deepEqual(await counts(lease), start);
  const malformed = await g.call('A', 'not-a-uuid');
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0]!.text, /UUID/);
  assert.equal(g.admits(), 0);
});

test('stored replay still works when the provider is unavailable or the AI budget is exhausted', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), id = randomUUID();
  assert.equal((await g.call('A', id)).isError, undefined);
  g.setAvailable(false);
  const before = await counts(lease), admitsBefore = g.admits();
  const replay = await g.call('A', id);
  assert.equal(replay.isError, undefined);
  assert.equal(replay.structuredContent.receipt.replayed, true);
  assert.equal(g.admits(), admitsBefore, 'a replay must not ask the provider for admission');
  assert.deepEqual(await counts(lease), before);
  const fresh = await g.call('A', randomUUID());
  assert.equal(fresh.isError, true);
  assert.equal(fresh.structuredContent.error, 'tool_unavailable');
  assert.deepEqual(await counts(lease), before);
});

test('a call that really runs reserves admission before the kernel charge, and a refusal releases it', async () => {
  const lease = await activeLease(3n);
  const g = gateway(lease, true);
  assert.equal((await g.call('A', randomUUID())).isError, undefined);
  const refused = await g.call('A', randomUUID());
  assert.equal(refused.structuredContent.reason, 'cap_reached');
  assert.equal(g.admits(), 2);
  assert.equal(g.cancels(), 1, 'the refused call must release its reservation');
});

test('a legacy key must carry a UUID prefix, so reshaping the prefix cannot make a second charge', async () => {
  const lease = await activeLease(10n);
  const g = gateway(lease, true), start = await counts(lease);
  for (const prefix of ['-'.repeat(36), 'a'.repeat(36), randomUUID().replaceAll('-', '').padEnd(36, '0')]) {
    const refused = await g.call('A', `${prefix}:${digest('A')}`);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /UUID/);
  }
  assert.deepEqual(await counts(lease), start);
  assert.equal(g.admits(), 0);
});

test('a failed result-store probe charges nothing, so a retry can still be served and stored', async () => {
  const lease = await activeLease(10n);
  let failures = 1;
  const flaky = new Proxy(db, { get: (target, property, receiver) => property === 'transaction' && failures-- > 0 ? async () => { throw new Error('probe failed'); } : Reflect.get(target, property, receiver) });
  let runs = 0;
  const tool: ToolDef = { name: 'finance_payment_lookup', description: 'stub', admit: () => ({ cancel() {}, async run() { runs++; return { provenance: 'fixture' }; } }) };
  const app = createMcp(kernelMeter(db, undefined, resultStore(flaky)), async () => lease, registeredTools(db, [tool.name]), [tool]);
  const id = randomUUID(), start = await counts(lease);
  const send = async () => (await (await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: { text: 'A', idempotency_key: id } } }) })).json() as any).result;
  const first = await send();
  assert.equal(first.structuredContent.error, 'metering_unavailable');
  assert.deepEqual(await counts(lease), start);
  assert.equal(runs, 0);
  const second = await send();
  assert.equal(second.isError, undefined);
  assert.equal((await send()).structuredContent.receipt.replayed, true, 'the product was stored, so the next retry replays it');
});
