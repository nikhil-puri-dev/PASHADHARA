import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createMcp, registeredTools, type ToolDef } from '../src/mcp.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';
import { seedFinance } from '../scripts/finance-seed.ts';

// Throwaway Postgres 15434 only (create the database with scripts/live-db.sh). No network, no spend.
const database = process.env.REPLAY_TEST_DATABASE ?? 'live_replay';
if (!/^live_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
const key = (text: string) => `${randomUUID()}:${createHash('sha256').update('finance_payment_lookup').update('\0').update(text).digest('hex')}`;
after(() => db.end());
test('seed', async () => { await seedFinance(db, 'replay-fixture@example.test'); });

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
  let runs = 0, cancels = 0;
  const tool: ToolDef = { name: 'finance_payment_lookup', description: 'counting stub', admit: () => ({ cancel() { cancels++; }, async run() { runs++; return { provenance: 'fixture', evidence: { id: 'PAY-A', pair: 'A', n: runs } }; } }) };
  const app = createMcp(kernelMeter(db, undefined, withStore ? resultStore(db) : undefined), async () => lease, registeredTools(db, ['finance_payment_lookup']), [tool]);
  const call = async (text: string, idempotency: string) => {
    const response = await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'finance_payment_lookup', arguments: { text, idempotency_key: idempotency } } }) });
    return (await response.json() as { result: { isError?: boolean; structuredContent: any } }).result;
  };
  return { call, runs: () => runs, cancels: () => cancels };
}
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
  assert.equal(g.cancels(), 0, 'a replay asks for no admission, so nothing is left to release');
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
