import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createMcp, registeredTools, type ToolDef } from '../src/mcp.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';
import { seedFinance } from '../scripts/finance-seed.ts';

// Isolated Postgres 15433 only (scripts/mcp-db.sh). Fixture authorizations, no PayPal or model calls.
const database = process.env.MCP_TEST_DATABASE ?? 'mcp_test_20261112';
if (!/^mcp_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15433/${database}`);
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
after(() => db.end());
test('seed', async () => { await seedFinance(db, 'preflight-fixture@example.test'); });

async function activeLease(cap: bigint) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'preflight-test', cap_minor: cap, unsettled_limit_minor: cap })).id;
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
const snapshot = (lease: string) => db.transaction(null, tx => tx.query<{ c: string; l: string }>('select (select count(*) from public.tool_calls where lease_id=$1) c,(select count(*) from public.ledger_entries where lease_id=$1) l', [lease])).then(r => r.rows[0]!);

function rig(perMinute?: number) {
  let admits = 0;
  const tool: ToolDef = { name: 'finance_payment_lookup', description: 'stub', admit: () => { admits++; return { cancel() {}, async run() { return { provenance: 'fixture' }; } }; } };
  const leases = new Map<string, string>();
  const app = createMcp(kernelMeter(db, undefined, resultStore(db)), async request => leases.get(request.headers.get('authorization') ?? '') ?? null,
    registeredTools(db, [tool.name]), [tool], perMinute === undefined ? {} : { preflightPerMinute: perMinute });
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const response = await app.request('http://localhost/mcp', { method: 'POST', headers: { ...headers, authorization: token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: response.status, body: await response.json() as any };
  };
  const list = async (token: string) => (await (await app.request('http://localhost/mcp', { method: 'POST', headers: { ...headers, authorization: token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json() as any).result.tools as { name: string; annotations: any }[];
  return { call, list, leases, admits: () => admits };
}

test('the preflight tool is listed as read-only and free, next to the paid tool', async () => {
  const r = rig(), lease = await activeLease(10n);
  r.leases.set('t', lease);
  const tools = await r.list('t');
  assert.deepEqual(tools.map(t => t.name).sort(), ['check_budget', 'finance_payment_lookup']);
  assert.equal(tools.find(t => t.name === 'check_budget')!.annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'finance_payment_lookup')!.annotations.readOnlyHint, false);
});

test('preflight posts nothing and asks the provider for nothing', async () => {
  const r = rig(), lease = await activeLease(10n);
  r.leases.set('t', lease);
  const before = await snapshot(lease);
  const answer = await r.call('t', 'check_budget', { tool: 'finance_payment_lookup' });
  assert.equal(answer.body.result.isError, undefined);
  assert.deepEqual(answer.body.result.structuredContent, { provenance: 'computed', tool: 'finance_payment_lookup', price_minor: 2, affordable: true, status: 'served', remaining_minor: 10 });
  assert.deepEqual(await snapshot(lease), before);
  assert.equal(r.admits(), 0);
});

test('preflight reports a refusal without charging or recording it', async () => {
  const r = rig(), lease = await activeLease(1n);
  r.leases.set('t', lease);
  const before = await snapshot(lease);
  const answer = (await r.call('t', 'check_budget', { tool: 'finance_payment_lookup' })).body.result.structuredContent;
  assert.equal(answer.affordable, false);
  assert.equal(answer.status, 'refused_cap');
  assert.equal(answer.remaining_minor, 1);
  assert.deepEqual(await snapshot(lease), before);
});

test('cross-lease isolation: each token sees only its own lease, and a named lease_id is ignored', async () => {
  const r = rig(), rich = await activeLease(10n), poor = await activeLease(1n);
  r.leases.set('rich', rich); r.leases.set('poor', poor);
  const own = (await r.call('poor', 'check_budget', { tool: 'finance_payment_lookup' })).body.result.structuredContent;
  assert.equal(own.remaining_minor, 1);
  const forged = (await r.call('poor', 'check_budget', { tool: 'finance_payment_lookup', lease_id: rich })).body.result.structuredContent;
  assert.equal(forged.remaining_minor, 1, 'an argument naming another lease must not change whose balance is read');
  assert.equal((await r.call('rich', 'check_budget', { tool: 'finance_payment_lookup' })).body.result.structuredContent.remaining_minor, 10);
  // spend on rich: poor's answer is unchanged, rich's drops
  assert.equal((await r.call('rich', 'finance_payment_lookup', { text: 'A', idempotency_key: randomUUID() })).body.result.isError, undefined);
  assert.equal((await r.call('rich', 'check_budget', { tool: 'finance_payment_lookup' })).body.result.structuredContent.remaining_minor, 8);
  assert.equal((await r.call('poor', 'check_budget', { tool: 'finance_payment_lookup' })).body.result.structuredContent.remaining_minor, 1);
});

test('a bad token gets 401 and reads nothing', async () => {
  const r = rig();
  assert.equal((await r.call('nope', 'check_budget', { tool: 'finance_payment_lookup' })).status, 401);
});

test('an unknown tool is refused with the names that exist, and the tool itself cannot be priced', async () => {
  const r = rig(), lease = await activeLease(10n);
  r.leases.set('t', lease);
  const unknown = (await r.call('t', 'check_budget', { tool: 'nope' })).body.result;
  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent.available, ['finance_payment_lookup']);
  assert.equal((await r.call('t', 'check_budget', { tool: 'check_budget' })).body.result.isError, true);
});

test('preflight is rate limited per lease and the limit does not leak across leases', async () => {
  const r = rig(3), a = await activeLease(10n), b = await activeLease(10n);
  r.leases.set('a', a); r.leases.set('b', b);
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await r.call('a', 'check_budget', { tool: 'finance_payment_lookup' })).body.result);
  assert.deepEqual(results.map(x => x.isError === true), [false, false, false, true, true]);
  assert.equal(results[3].structuredContent.error, 'rate_limited');
  assert.equal((await r.call('b', 'check_budget', { tool: 'finance_payment_lookup' })).body.result.isError, undefined);
  // paid calls are not throttled by the free tool's limit
  assert.equal((await r.call('a', 'finance_payment_lookup', { text: 'A', idempotency_key: randomUUID() })).body.result.isError, undefined);
});
