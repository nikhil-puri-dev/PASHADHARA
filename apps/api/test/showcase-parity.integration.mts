import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import { createMcp, registeredTools } from '../src/mcp.ts';
import { kernelMeter } from '../src/meter.ts';
import { summariseTool } from '../src/summarise.ts';
import { showcaseRoutes } from '../src/showcase.ts';
import { seedSummarise } from '../scripts/live-seed.ts';

// Throwaway Postgres 15434 only. Model provider is a counting stub: no network, no spend.
const database = process.env.GATEWAY_TEST_DATABASE ?? 'live_c2';
if (!/^live_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
const secret = 'fixture-secret-fixture-secret-fixture-secret';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
const key = (text: string) => `${randomUUID()}:${createHash('sha256').update('summarise').update('\0').update(text).digest('hex')}`;
after(() => db.end());

async function activeLease(cap: bigint) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'parity-test', cap_minor: cap, unsettled_limit_minor: cap })).id;
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

function rig(lease: string) {
  let providerCalls = 0;
  const tool = summariseTool({
    apiKey: 'fixture-not-a-key', limitUsd: 2, log: () => {},
    fetcher: async () => { providerCalls++; return Response.json({ content: [{ type: 'text', text: 'A short summary.' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 6 } }); },
  });
  // The real production wiring: signed lease token, leaseIsOpen check, kernel meter.
  const auth = createAuth(db, secret, '');
  const mcp = createMcp(kernelMeter(db), auth.resolveMcpLease, registeredTools(db, ['summarise']), [tool]);
  const token = issueToken(secret, 'lease', lease);
  const callMcp = async (text: string, bearer: string | null = token) => {
    const response = await mcp.request('http://localhost/mcp', {
      method: 'POST', headers: { ...headers, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text, idempotency_key: key(text) } } }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } }).result;
  };
  const showcase = showcaseRoutes(db, lease, randomUUID(), tool, 100);
  const run = () => showcase.request('http://localhost/showcase/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
  return { callMcp, run, token, mcp, providerCalls: () => providerCalls };
}

const state = (lease: string) => db.transaction(null, async tx => ({
  served: (await tx.query<{ n: number }>("select count(*)::int as n from public.tool_calls where lease_id=$1 and status='served'", [lease])).rows[0]!.n,
  commits: (await tx.query<{ n: number }>("select count(distinct group_id)::int as n from public.ledger_entries where lease_id=$1 and ref_type='commit'", [lease])).rows[0]!.n,
  entries: (await tx.query<{ n: number }>('select count(*)::int as n from public.ledger_entries where lease_id=$1', [lease])).rows[0]!.n,
}));

/** Served calls reduced to what must be equal across paths, tagged by the path that wrote them (key prefix), never by row order. */
const shape = (lease: string) => db.transaction(null, async tx => {
  const calls = (await tx.query<{ tool_id: string; price_minor: string; status: string; group: string | null; key: string }>(
    "select tool_id,price_minor,status,ledger_group_id as group,idempotency_key as key from public.tool_calls where lease_id=$1 and status='served' order by created_at,id", [lease])).rows;
  const out: { mcp: Shape[]; showcase: Shape[] } = { mcp: [], showcase: [] };
  for (const call of calls) {
    const postings = (await tx.query<{ account: string; direction: string; amount_minor: string; ref_type: string }>(
      'select account,direction,amount_minor,ref_type from public.ledger_entries where group_id=$1 order by account,direction', [call.group])).rows;
    out[call.key.startsWith('showcase:') ? 'showcase' : 'mcp'].push({ tool_id: call.tool_id, price_minor: call.price_minor, status: call.status, grouped: call.group !== null, postings });
  }
  return out;
});
type Shape = { tool_id: string; price_minor: string; status: string; grouped: boolean; postings: { account: string; direction: string; amount_minor: string; ref_type: string }[] };

test('seed the tool', async () => { await seedSummarise(db, 'seller-fixture@example.test'); });

test('one showcase Run and one MCP call on a lease write equivalent tool_calls and journal rows', async () => {
  const lease = await activeLease(1000n);
  const g = rig(lease);
  const viaMcp = await g.callMcp('parity text');
  assert.equal(viaMcp.isError, undefined);
  const viaShowcase = await g.run();
  assert.equal(viaShowcase.status, 200);
  const rows = await shape(lease);
  assert.equal(rows.mcp.length, 1, 'exactly one MCP row');
  assert.equal(rows.showcase.length, 1, 'exactly one showcase row');
  assert.deepEqual(rows.showcase[0], rows.mcp[0], 'showcase row and postings equal the MCP row and postings');
  assert.ok(rows.mcp[0]!.grouped && rows.mcp[0]!.postings.length >= 2 && rows.mcp[0]!.price_minor === '3');
  assert.equal(g.providerCalls(), 2);
});

test('an over-cap call is refused on both paths with no new commit and no new served row', async () => {
  const lease = await activeLease(5n);
  const g = rig(lease);
  assert.equal((await g.callMcp('first')).isError, undefined); // 3 of 5 cents
  const before = await state(lease);
  const calls = g.providerCalls();
  const mcp = await g.callMcp('second');
  assert.equal(mcp.isError, true);
  assert.equal(mcp.structuredContent?.reason, 'cap_reached');
  assert.deepEqual(await state(lease), before);
  const showcase = await g.run();
  assert.equal(showcase.status, 402);
  assert.equal((await showcase.json() as { reason: string }).reason, 'cap_reached');
  assert.deepEqual(await state(lease), before);
  assert.equal(g.providerCalls(), calls, 'no provider call after either refusal');
});

test('refusal after void: MCP revokes that lease token and nothing is charged', async () => {
  const lease = await activeLease(100n);
  const g = rig(lease);
  const voidCall = await kernel.beginVoid(db, lease);
  await kernel.markCallSent(db, lease, voidCall.call_id);
  await kernel.completeVoid(db, lease, voidCall.call_id, { http_status: 204, body: {} });
  const before = await state(lease);
  const response = await g.mcp.request('http://localhost/mcp', {
    method: 'POST', headers: { ...headers, authorization: `Bearer ${g.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text: 'after void', idempotency_key: key('after void') } } }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await state(lease), before);
  assert.equal(g.providerCalls(), 0);
});

test('showcase Run on a voided lease is refused, nothing charged', async () => {
  const lease = await activeLease(100n);
  const g = rig(lease);
  const voidCall = await kernel.beginVoid(db, lease);
  await kernel.markCallSent(db, lease, voidCall.call_id);
  await kernel.completeVoid(db, lease, voidCall.call_id, { http_status: 204, body: {} });
  const before = await state(lease);
  const response = await g.run();
  assert.equal(response.status, 402);
  assert.equal((await response.json() as { reason: string }).reason, 'window_ended');
  assert.deepEqual(await state(lease), before);
  assert.equal(g.providerCalls(), 0);
});

test('a 777-cent showcase hold admits 777 cents and refuses 778 before a provider call', async () => {
  const lease = await activeLease(777n, 777n);
  const g = rig(lease);
  const showcase = showcaseRoutes(db, lease, randomUUID(), { name: 'summarise', description: 'fixture', admit: () => null }, 100);
  const within = await showcase.request('http://localhost/showcase/try?price_minor=777', { method: 'POST' });
  const over = await showcase.request('http://localhost/showcase/try?price_minor=778', { method: 'POST' });
  assert.equal(within.status, 200);
  assert.equal(over.status, 402);
  assert.equal((await over.json()).reason, 'cap_reached');
  assert.equal(g.providerCalls(), 0);
  assert.equal((await state(lease)).served, 0);
});
