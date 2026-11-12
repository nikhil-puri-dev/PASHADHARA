/** External MCP smoke test. Tool calls may spend from the supplied lease. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';

const url = process.env.MCP_URL;
const token = process.env.LEASE_TOKEN;
const tool = process.env.MCP_TOOL;
const input = process.env.MCP_TEXT;
if (!url || !token) throw new Error('Set MCP_URL and LEASE_TOKEN in the environment.');
if ((tool === undefined) !== (input === undefined)) throw new Error('Set both MCP_TOOL and MCP_TEXT to make a paid call.');
const client = new Client({ name: 'pashadhara-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const list = await client.listTools();
  console.log(JSON.stringify({ event: 'tools', tools: list.tools.map(({ name, description }) => ({ name, description })) }));
  if (tool !== undefined && input !== undefined) {
    const result = await client.callTool({ name: tool, arguments: { text: input, idempotency_key: randomUUID() } });
    console.log(JSON.stringify({ event: 'call', result }));
  }
} finally { await client.close(); }
