import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Database } from '../../../packages/kernel/src/db.ts';

type MeterResult = { ok: true } | { ok: false; reason: string; price_minor: number; remaining_minor: number; lease_id: string } | { ok: false; error: 'tool_unavailable' | 'idempotency_conflict' | 'metering_unavailable' };
export type Meter = (lease: string, tool: string, key: string) => Promise<MeterResult>;
const toolNames = ['text_stats', 'sha256_digest'] as const;
type ToolName = typeof toolNames[number];

/** Fail closed until nonce binding and the kernel commit share one transaction. */
export const unavailableKernelMeter: Meter = async () => ({ ok: false, error: 'metering_unavailable' });

/** The lease resolver must verify a scoped bearer token, not merely parse one. */
export function createMcp(meter: Meter, resolveLease: (request: Request) => Promise<string | null>, available: () => Promise<readonly ToolName[]>) {
  const app = new Hono();
  app.all('/mcp', async c => {
    const lease = await resolveLease(c.req.raw);
    const server = new McpServer({ name: 'pashadhara', version: '0.1.0' });
    for (const tool of toolNames) {
      server.registerTool(tool, {
        description: tool === 'text_stats' ? 'Count words, lines and UTF-8 bytes in text.' : 'Compute the SHA-256 digest of UTF-8 text.',
        inputSchema: {
          text: z.string().max(16000),
          idempotency_key: z.string().regex(/^[0-9a-f-]{36}:[0-9a-f]{64}$/).describe('A new UUID, colon, and SHA-256 of tool name, NUL, then UTF-8 text. Reuse only to retry the same invocation.'),
        },
      }, async ({ text, idempotency_key }) => {
        if (!lease) return { isError: true, content: [{ type: 'text', text: 'A valid lease token is required.' }] };
        const digest = createHash('sha256').update(tool).update('\0').update(text).digest('hex');
        if (!idempotency_key.endsWith(`:${digest}`)) return { isError: true, content: [{ type: 'text', text: 'Idempotency key does not match the tool and input.' }] };
        const payment = await meter(lease, tool, idempotency_key);
        if (!payment.ok) return { isError: true, structuredContent: payment, content: [{ type: 'text', text: JSON.stringify(payment) }] };
        const result = tool === 'text_stats'
          ? { words: text.trim() ? text.trim().split(/\s+/u).length : 0, lines: text ? text.split(/\r\n|\r|\n/u).length : 0, bytes: Buffer.byteLength(text, 'utf8') }
          : { sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      });
    }
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const enabled = await available();
      return { tools: toolNames.filter(name => enabled.includes(name)).map(name => ({
        name,
        description: name === 'text_stats' ? 'Count words, lines and UTF-8 bytes in text.' : 'Compute the SHA-256 digest of UTF-8 text.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', maxLength: 16000 },
            idempotency_key: { type: 'string', description: 'A new UUID, colon, and SHA-256 of tool name, NUL, then UTF-8 text. Reuse only to retry the same invocation.' },
          },
          required: ['text', 'idempotency_key'],
        },
      })) };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}

export function registeredTools(db: Database) {
  return () => db.transaction(null, async tx => {
    const rows = await tx.query<{ id: string }>('select id from public.tools where active and id=any($1::text[])', [toolNames]);
    return toolNames.filter(name => rows.rows.some(row => row.id === name));
  });
}
