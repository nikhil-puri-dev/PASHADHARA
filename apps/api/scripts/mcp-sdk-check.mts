/** Interop check with the official TypeScript SDK against a fixture server. Spends the fixture lease only. Never prints the token. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const url = process.env.MCP_URL, tokenFile = process.env.MCP_TOKEN_FILE;
if (!url || !tokenFile) throw new Error('Set MCP_URL and MCP_TOKEN_FILE.');
const client = new Client({ name: 'pashadhara-sdk-check', version: '1.0.0' });
const show = (label: string, r: any) => console.log(JSON.stringify({ step: label, isError: r.isError ?? false, result: r.structuredContent ?? r.content?.[0]?.text }));
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}` } } }));
  const list = await client.listTools();
  console.log(JSON.stringify({ step: 'list', tools: list.tools.map(t => ({ name: t.name, readOnly: t.annotations?.readOnlyHint, price: t._meta?.['pashadhara/price_minor'] })) }));
  show('preflight', await client.callTool({ name: 'check_budget', arguments: { tool: 'text_stats' } }));
  const id = randomUUID();
  show('first call, bare UUID', await client.callTool({ name: 'text_stats', arguments: { text: 'hello world', idempotency_key: id } }));
  show('retry, same UUID and text', await client.callTool({ name: 'text_stats', arguments: { text: 'hello world', idempotency_key: id } }));
  show('same UUID, other text', await client.callTool({ name: 'text_stats', arguments: { text: 'other text', idempotency_key: id } }));
  show('no key', await client.callTool({ name: 'text_stats', arguments: { text: 'hello world' } }));
  show('preflight after one charge', await client.callTool({ name: 'check_budget', arguments: { tool: 'text_stats' } }));
} finally { await client.close(); }
