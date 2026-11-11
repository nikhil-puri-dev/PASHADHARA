import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import { createMcp, registeredTools } from '../src/mcp.ts';
import { kernelMeter } from '../src/meter.ts';
import { summariseTool } from '../src/summarise.ts';
import { showcaseRoutes } from '../src/showcase.ts';
import { seedSummarise } from '../scripts/live-seed.ts';

// Throwaway Postgres 15434 only. Provider is a stub: no network, no spend.
const database = process.env.GATEWAY_TEST_DATABASE ?? 'live_c2';
if (!/^live_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
const key = (text: string) => `${randomUUID()}:${createHash('sha256').update('summarise').update('\0').update(text).digest('hex')}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const complete = { content: [{ type: 'text', text: 'A short summary.' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 6 } };
after(() => db.end());

async function activeLease(cap: bigint) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'deadline-test', cap_minor: cap, unsettled_limit_minor: cap })).id;
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

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** A provider that waits `ms` (or until its signal aborts), like a real fetch. */
const slow = (ms: number, counter: { n: number }): Fetch => async (_url, init) => {
  counter.n++;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  });
  return Response.json(complete);
};

function mcpRig(lease: string, fetcher: Fetch, options: { providerMs?: number; lockWaitMs?: number } = {}) {
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher });
  const app = createMcp(kernelMeter(db, options), async () => lease, registeredTools(db, ['summarise']), [tool]);
  const call = async (text: string) => {
    const response = await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text, idempotency_key: key(text) } } }) });
    assert.equal(response.status, 200);
    return (await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
  };
  return { call, tool };
}

const state = (lease: string) => db.transaction(null, async tx => ({
  served: (await tx.query<{ n: number }>("select count(*)::int as n from public.tool_calls where lease_id=$1 and status='served'", [lease])).rows[0]!.n,
  entries: (await tx.query<{ n: number }>('select count(*)::int as n from public.ledger_entries where lease_id=$1', [lease])).rows[0]!.n,
}));

test('seed the tool', async () => { await seedSummarise(db, 'seller-fixture@example.test'); });

test('25 parallel calls (more than the pool of 10) end in served or busy, within the lock wait, and busy calls never reach the provider', { timeout: 20_000 }, async () => {
  const lease = await activeLease(1000n);
  const provider = { n: 0 };
  const g = mcpRig(lease, slow(200, provider), { providerMs: 8000, lockWaitMs: 400 });
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => g.call(`parallel ${i}`)));
  const elapsed = Date.now() - started;
  const served = results.filter(r => !r.isError);
  const busy = results.filter(r => r.structuredContent?.error === 'busy');
  assert.equal(served.length + busy.length, 25, 'every call is served or busy');
  assert.ok(busy.length >= 1 && served.length >= 1, `served ${served.length}, busy ${busy.length}`);
  for (const refusal of busy) assert.deepEqual(refusal.structuredContent, { ok: false, error: 'busy', charged: false });
  assert.ok(elapsed < 4000, `finished in ${elapsed} ms, not queued for 25 x 200 ms`);
  await sleep(1500); // calls that were still waiting for a pool slot get theirs and must do nothing
  assert.equal(provider.n, served.length, 'only served calls reached the provider');
  assert.equal((await state(lease)).served, served.length);
  const probe = await g.call('after the storm');
  assert.equal(probe.isError, undefined, 'the pool is free again');
});

test('showcase Run waits at most the lock wait behind a held lease lock: 503 busy, charged false, nothing written', { timeout: 20_000 }, async () => {
  const lease = await activeLease(1000n);
  const provider = { n: 0 };
  const stuck = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: slow(1500, provider) });
  const fast = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: slow(0, { n: 0 }) });
  const first = showcaseRoutes(db, lease, randomUUID(), stuck, 100, { providerMs: 8000, lockWaitMs: 300 });
  const second = showcaseRoutes(db, lease, randomUUID(), fast, 100, { providerMs: 8000, lockWaitMs: 300 });
  const post = (app: typeof first) => app.request('http://localhost/showcase/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
  const holding = post(first);
  await sleep(150);
  const started = Date.now();
  const blocked = await post(second);
  assert.equal(blocked.status, 503);
  assert.deepEqual(await blocked.json(), { error: 'busy', charged: false });
  assert.ok(Date.now() - started < 1000, 'gave up at the lock wait, not at the end of the held call');
  assert.equal((await holding).status, 200);
  assert.equal((await state(lease)).served, 1);
});

test('a stuck provider is cut at the overall deadline, which includes the wait; a void queued behind it is not starved', { timeout: 20_000 }, async () => {
  const lease = await activeLease(100n);
  const provider = { n: 0 };
  const g = mcpRig(lease, slow(60_000, provider), { providerMs: 800, lockWaitMs: 300 });
  const started = Date.now();
  const stuck = g.call('stuck');
  await sleep(150);
  const voidStarted = Date.now();
  const voidCall = await kernel.beginVoid(db, lease);
  const waited = Date.now() - voidStarted;
  const result = await stuck;
  const total = Date.now() - started;
  assert.deepEqual(result.structuredContent, { ok: false, error: 'tool_failed', charged: false });
  assert.ok(total < 2500, `call ended at ${total} ms, not the old 30 s`);
  assert.ok(waited < 2500, `void waited ${waited} ms`);
  await kernel.markCallSent(db, lease, voidCall.call_id);
  await kernel.completeVoid(db, lease, voidCall.call_id, { http_status: 204, body: {} });
  assert.equal((await state(lease)).served, 0);
});

test('abort at the deadline with an unknown outcome keeps the AI reservation counted as spent', { timeout: 20_000 }, async () => {
  const lease = await activeLease(100n);
  const g = mcpRig(lease, slow(60_000, { n: 0 }), { providerMs: 400, lockWaitMs: 300 });
  const result = await g.call('x');
  assert.equal(result.structuredContent?.error, 'tool_failed');
  assert.ok(g.tool.spend.spent_micro > 1000, `spent ${g.tool.spend.spent_micro} micro-USD counted at worst case`);
  assert.equal(g.tool.spend.reserved_micro, 0);
});

// Moves the authorization to end at now + ms. Throwaway database only: container pashadhara-rails-15434, as postgres,
// triggers off for this one statement, because the kernel refuses to create an authorization this close to its end.
function honorEndsIn(lease: string, ms: number) {
  const sql = `set session_replication_role=replica; update public.authorizations set created_at=now()-interval '3 days'+interval '${ms} milliseconds', honor_until=now()+interval '${ms} milliseconds' where lease_id='${lease}'`;
  execFileSync('docker', ['exec', 'pashadhara-rails-15434', 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
}

test('honor period ends while the provider call runs: MCP call is refused at commit time and nothing is charged', { timeout: 20_000 }, async () => {
  const lease = await activeLease(100n);
  honorEndsIn(lease, 1200);
  const provider = { n: 0 };
  const g = mcpRig(lease, slow(2000, provider), { providerMs: 8000, lockWaitMs: 300 });
  const before = await state(lease);
  const result = await g.call('boundary');
  assert.equal(provider.n, 1, 'the call started inside the window');
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.reason, 'window_ended');
  assert.deepEqual(await state(lease), before);
});

test('honor period ends while the provider call runs: showcase Run is refused 402 window_ended and nothing is charged', { timeout: 20_000 }, async () => {
  const lease = await activeLease(100n);
  honorEndsIn(lease, 1200);
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: slow(2000, { n: 0 }) });
  const app = showcaseRoutes(db, lease, randomUUID(), tool, 100, { providerMs: 8000, lockWaitMs: 300 });
  const before = await state(lease);
  const response = await app.request('http://localhost/showcase/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 402);
  assert.equal((await response.json() as { reason: string }).reason, 'window_ended');
  assert.deepEqual(await state(lease), before);
});

// One budget counted from request entry: pool checkout and every lock use what is left of the lock wait.
const url = `postgres://kernel_login@127.0.0.1:15434/${database}`;

test('showcase with both locks held answers 503 busy within the budget (no fresh wait per lock), then 200 once both clear', { timeout: 20_000 }, async () => {
  const lease = await activeLease(1000n);
  const holder = new kernel.Database(url);
  const provider = { n: 0 };
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: slow(0, provider) });
  const app = showcaseRoutes(db, lease, randomUUID(), tool, 100, { providerMs: 8000, lockWaitMs: 400 });
  const post = () => app.request('http://localhost/showcase/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
  let freeAdvisory!: () => void, freeLease!: () => void;
  const advisory = holder.transaction(null, async tx => { await tx.query('select pg_advisory_xact_lock(234171,4)'); await new Promise<void>(r => { freeAdvisory = r; }); });
  const leaseLock = holder.transaction(lease, async () => { await new Promise<void>(r => { freeLease = r; }); });
  await sleep(300);
  setTimeout(() => freeLease(), 250); // the lease lock clears early, the advisory lock stays held
  const reserved = tool.spend.reserved_micro;
  const started = Date.now();
  const response = await Promise.race([post(), sleep(4000).then(() => null)]);
  const elapsed = Date.now() - started;
  freeLease(); freeAdvisory(); // never leave a lock held, even when an assertion below fails
  await Promise.all([advisory, leaseLock]);
  assert.ok(response, 'the call stayed pending past its deadline');
  assert.equal(response.status, 503, `got ${response.status} after ${elapsed} ms`);
  assert.deepEqual(await response.json(), { error: 'busy', charged: false });
  assert.ok(elapsed <= 550, `busy after ${elapsed} ms on a 400 ms budget`);
  assert.equal(provider.n, 0);
  assert.equal(tool.spend.reserved_micro, reserved, 'reservation released');
  assert.equal(tool.spend.spent_micro, 0);
  assert.equal((await state(lease)).served, 0);
  const ok = await post();
  assert.equal(ok.status, 200);
  await holder.end();
});

test('MCP with every pool slot held answers busy within the budget, authentication included', { timeout: 20_000 }, async () => {
  const lease = await activeLease(100n);
  const poolDb = new kernel.Database(url);
  const options = { providerMs: 8000, lockWaitMs: 400 };
  const provider = { n: 0 };
  const tool = summariseTool({ apiKey: 'fixture', limitUsd: 2, log: () => {}, fetcher: slow(0, provider) });
  const auth = createAuth(poolDb, 'fixture-secret-fixture-secret-fixture-secret', '');
  const app = createMcp(kernelMeter(poolDb, options), auth.resolveMcpLease, registeredTools(db, ['summarise']), [tool], options);
  const token = issueToken('fixture-secret-fixture-secret-fixture-secret', 'lease', lease);
  const frees: (() => void)[] = [];
  const held = Array.from({ length: 10 }, () => poolDb.transaction(null, () => new Promise<void>(r => { frees.push(r); })));
  await sleep(400);
  assert.equal(frees.length, 10, 'all pool slots are held');
  const text = 'pool held';
  const started = Date.now();
  const outcome = await Promise.race([
    app.request('http://localhost/mcp', { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summarise', arguments: { text, idempotency_key: key(text) } } }) })
      .then(async r => (await r.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result),
    sleep(3000).then(() => 'still pending' as const),
  ]);
  const elapsed = Date.now() - started;
  for (const free of frees) free();
  await Promise.all(held);
  assert.notEqual(outcome, 'still pending', 'the call stayed pending past its deadline');
  assert.deepEqual((outcome as { structuredContent: unknown }).structuredContent, { ok: false, error: 'busy', charged: false });
  assert.ok(elapsed <= 550, `busy after ${elapsed} ms on a 400 ms budget`);
  assert.equal(provider.n, 0);
  assert.equal(tool.spend.reserved_micro, 0, 'reservation released');
  await sleep(300);
  assert.equal((await state(lease)).served, 0);
  await poolDb.end();
});
