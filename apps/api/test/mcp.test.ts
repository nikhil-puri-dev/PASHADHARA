import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMcp, unavailableKernelMeter, type Meter } from '../src/mcp.ts';

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
  const meter: Meter = async () => { count++; return { ok: true }; };
  const message = await rpc(createMcp(meter, async () => null, available), 'tools/list');
  assert.deepEqual(message.result.tools.map((x: any) => x.name), ['text_stats', 'sha256_digest']);
  assert.equal(count, 0);
});

test('MCP commits before computing a deterministic tool result', async () => {
  const calls: string[] = [];
  const app = createMcp(async (_lease, tool, key) => { calls.push(`${tool}:${key}`); return { ok: true }; }, async () => 'fixture-lease', available);
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
  const app = createMcp(async () => { called = true; return { ok: true }; }, async () => null, async () => {
    throw new Error('Tool registry must not be read on an unauthenticated call');
  });
  const message = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'fixture', idempotency_key: key('text_stats', 'fixture') } });
  assert.equal(message.result.isError, true); assert.equal(called, false);
});

test('MCP rejects a key bound to different input before metering', async () => {
  let called = false;
  const app = createMcp(async () => { called = true; return { ok: true }; }, async () => 'fixture', available);
  const message = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'changed', idempotency_key: key('text_stats', 'original') } });
  assert.equal(message.result.isError, true); assert.equal(called, false);
});

test('MCP lists only registered tools', async () => {
  const app = createMcp(async () => ({ ok: true }), async () => null, async () => ['sha256_digest']);
  const message = await rpc(app, 'tools/list');
  assert.deepEqual(message.result.tools.map((x: any) => x.name), ['sha256_digest']);
});

test('production meter fails closed until nonce binding is atomic', async () => {
  const app = createMcp(unavailableKernelMeter, async () => 'fixture', available);
  const result = await rpc(app, 'tools/call', { name: 'text_stats', arguments: { text: 'fixture', idempotency_key: key('text_stats', 'fixture') } });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error, 'metering_unavailable');
});
