import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMcp, unavailableKernelMeter, type Meter } from '../src/mcp.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };
const available = async () => ['text_stats', 'sha256_digest'] as const;
const key = (tool: string, text: string, nonce = '11111111-1111-4111-8111-111111111111') => `${nonce}:${createHash('sha256').update(tool).update('\0').update(text).digest('hex')}`;
async function rpc(app: ReturnType<typeof createMcp>, method: string, params: unknown = {}) {
  const response = await app.request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal(response.status, 200);
  return await response.json() as any;
}

test('MCP lists two real tools without charging', async () => {
  let count = 0;
  const meter: Meter = async (_l, _t, _k, work) => { count++; return { ok: true, result: await work(new AbortController().signal) }; };
  const message = await rpc(createMcp(meter, async () => null, available), 'tools/list');
  assert.deepEqual(message.result.tools.map((x: any) => x.name), ['text_stats', 'sha256_digest']);
  assert.equal(count, 0);
});

test('MCP commits before computing a deterministic tool result', async () => {
  const calls: string[] = [];
  const app = createMcp(async (_lease, tool, key, work) => { calls.push(`${tool}:${key}`); return { ok: true, result: await work(new AbortController().signal) }; }, async () => 'fixture-lease', available);
  const args = { text: 'hello world', idempotency_key: key('text_stats', 'hello world') };
  const first = await rpc(app, 'tools/call', { name: 'text_stats', arguments: args });
  const second = await rpc(app, 'tools/call', { name: 'text_stats', arguments: args });
  assert.deepEqual(first.result.structuredContent, { words: 2, lines: 1, bytes: 11 });
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
  assert.deepEqual(first.result.structuredContent, second.result.structuredContent);
  const hash = await rpc(app, 'tools/call', { name: 'sha256_digest', arguments: { text: 'abc', idempotency_key: key('sha256_digest', 'abc') } });
  assert.equal(hash.result.structuredContent.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('MCP refusal returns a structured payment error and no result', async () => {
  const app = createMcp(async () => ({ ok: false, reason: 'cap_reached', price_minor: 3, remaining_minor: 0, lease_id: 'fixture' }), async () => 'fixture', available);
  const message = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'fixture', idempotency_key: key('text_stats', 'fixture') } });
  assert.equal(message.result.isError, true);
  assert.equal(message.result.structuredContent.reason, 'cap_reached');
  assert.equal(message.result.structuredContent.words, undefined);
});

test('MCP refuses an unauthenticated tool call before metering', async () => {
  let called = false;
  const app = createMcp(async (_l, _t, _k, work) => { called = true; return { ok: true, result: await work(new AbortController().signal) }; }, async () => null, async () => {
    throw new Error('Tool registry must not be read on an unauthenticated call');
  });
  const message = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'fixture', idempotency_key: key('text_stats', 'fixture') } });
  assert.equal(message.result.isError, true); assert.equal(called, false);
});

test('MCP rejects a key bound to different input before metering', async () => {
  let called = false;
  const app = createMcp(async (_l, _t, _k, work) => { called = true; return { ok: true, result: await work(new AbortController().signal) }; }, async () => 'fixture', available);
  const message = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'changed', idempotency_key: key('text_stats', 'original') } });
  assert.equal(message.result.isError, true); assert.equal(called, false);
});

test('MCP lists only registered tools', async () => {
  const app = createMcp(async (_l, _t, _k, work) => ({ ok: true, result: await work(new AbortController().signal) }), async () => null, async () => ['sha256_digest']);
  const message = await rpc(app, 'tools/list');
  assert.deepEqual(message.result.tools.map((x: any) => x.name), ['sha256_digest']);
});

test('browser origins must match configured site origin before authentication or tool execution', async () => {
  let resolutions = 0;
  const app = createMcp(unavailableKernelMeter, async () => { resolutions++; return null; }, available, undefined, { allowedOrigins: ['https://site.example'] });
  const send = (origin?: string) => app.request('http://localhost/mcp', {
    method: 'POST', headers: { ...headers, ...(origin === undefined ? {} : { origin }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  for (const origin of ['https://evil.example', 'https://site.example.evil.example', 'null', 'https://site.example/']) {
    assert.equal((await send(origin)).status, 403);
  }
  assert.equal(resolutions, 0);
  assert.equal((await send('https://site.example')).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(resolutions, 2);
  const closed = createMcp(unavailableKernelMeter, async () => null, available);
  assert.equal((await closed.request('http://localhost/mcp', { method: 'POST', headers: { ...headers, origin: 'https://site.example' }, body: '{}' })).status, 403);
});

test('official MCP client discovers registry prices and calls a tool over Streamable HTTP', async () => {
  const app = createMcp(async (_l, _t, _k, work) => ({ ok: true, result: await work(new AbortController().signal) }),
    async () => 'fixture', async () => [{ id: 'text_stats', price_minor: 2 }]);
  const client = new Client({ name: 'compatibility-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools[0]?._meta?.['pashadhara/price_minor'], 2);
    const result = await client.callTool({ name: 'text_stats', arguments: { text: 'hello world', idempotency_key: key('text_stats', 'hello world') } });
    assert.deepEqual(result.structuredContent, { words: 2, lines: 1, bytes: 11 });
  } finally { await client.close(); }
});

test('production meter fails closed until nonce binding is atomic', async () => {
  const app = createMcp(unavailableKernelMeter, async () => 'fixture', available);
  const result = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'fixture', idempotency_key: key('text_stats', 'fixture') } });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error, 'metering_unavailable');
});

test('a meter that returns ok without a result does not typecheck', () => {
  // The type enforces only that an ok result carries `result`, and that `work` is a parameter. It cannot stop a fake from
  // returning some result while ignoring `work`. The behaviour is covered by the integration tests, which run the real meter.
  // @ts-expect-error an ok result must carry the tool result
  const withoutResult: Meter = async () => ({ ok: true });
  assert.equal(typeof withoutResult, 'function');
});
