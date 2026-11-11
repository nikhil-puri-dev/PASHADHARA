import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Database } from '../../../packages/kernel/src/db.ts';
import { LOCK_WAIT_MS } from './meter.ts';

type MeterResult = { ok: true; result: Record<string, unknown> } | { ok: false; reason: string; price_minor: number; remaining_minor: number; lease_id: string }
  | { ok: false; error: 'tool_unavailable' | 'idempotency_conflict' | 'metering_unavailable' }
  | { ok: false; error: 'tool_failed' | 'busy'; charged: false };
/**
 * `work` is required: the meter runs the tool inside the charge and hands back its result. If `work` throws, times
 * out (the signal aborts at the call's overall deadline) or the honor window closed meanwhile, nothing is charged.
 */
export type Meter = (lease: string, tool: string, key: string, work: (signal: AbortSignal) => Promise<Record<string, unknown>>, entered?: number) => Promise<MeterResult>;

/** A tool may only run after `admit` agreed it can (provider ready, spend left) and the meter charged. */
export type Admission = { run(text: string, signal?: AbortSignal): Promise<Record<string, unknown>>; cancel(): void };
export type ToolDef = { name: string; description: string; admit(text: string): Admission | null };

const toy = (name: string, description: string, compute: (text: string) => Record<string, unknown>): ToolDef => ({
  name, description, admit: () => ({ run: async text => compute(text), cancel() {} }),
});
/** Deterministic tools used by the sandbox runner and unit tests. The gateway does not register them. */
export const toyTools: readonly ToolDef[] = [
  toy('text_stats', 'Count words, lines and UTF-8 bytes in text.', text => ({
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    lines: text ? text.split(/\r\n|\r|\n/u).length : 0,
    bytes: Buffer.byteLength(text, 'utf8'),
  })),
  toy('sha256_digest', 'Compute the SHA-256 digest of UTF-8 text.', text => ({ sha256: createHash('sha256').update(text, 'utf8').digest('hex') })),
];

/** Fail closed until a real kernel meter is wired in. */
export const unavailableKernelMeter: Meter = async () => ({ ok: false, error: 'metering_unavailable' });

/** The lease resolver must verify a scoped bearer token, not merely parse one. */
export function createMcp(
  meter: Meter, resolveLease: (request: Request) => Promise<string | null>,
  available: () => Promise<readonly (string | { id: string; price_minor: number })[]>, tools: readonly ToolDef[] = toyTools,
  budget: { lockWaitMs?: number; allowedOrigins?: readonly string[] } = {},
) {
  const app = new Hono();
  app.all('/mcp', async c => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !budget.allowedOrigins?.includes(origin)) return c.json({ error: 'origin_not_allowed' }, 403);
    // One budget from request entry: authentication (which uses a pool slot) counts against the same lock wait as the meter.
    const entered = Date.now();
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const busy = Symbol('busy');
    const resolving = resolveLease(c.req.raw);
    resolving.catch(() => {});
    const lease = await Promise.race([
      resolving, new Promise<typeof busy>(resolve => { waitTimer = setTimeout(() => resolve(busy), budget.lockWaitMs ?? LOCK_WAIT_MS); }),
    ]).finally(() => clearTimeout(waitTimer));
    const server = new McpServer({ name: 'pashadhara', version: '0.1.0' });
    for (const tool of tools) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: {
          text: z.string().max(16000),
          idempotency_key: z.string().regex(/^[0-9a-f-]{36}:[0-9a-f]{64}$/).describe('A new UUID, colon, and SHA-256 of tool name, NUL, then UTF-8 text. Reuse only to retry the same invocation.'),
        },
      }, async ({ text, idempotency_key }) => {
        if (lease === busy) {
          const refusal = { ok: false, error: 'busy', charged: false };
          return { isError: true, structuredContent: refusal, content: [{ type: 'text', text: JSON.stringify(refusal) }] };
        }
        if (!lease) return { isError: true, content: [{ type: 'text', text: 'A valid lease token is required.' }] };
        const digest = createHash('sha256').update(tool.name).update('\0').update(text).digest('hex');
        if (!idempotency_key.endsWith(`:${digest}`)) return { isError: true, content: [{ type: 'text', text: 'Idempotency key does not match the tool and input.' }] };
        // Admission runs first so a refused or unavailable provider is never charged.
        const admission = tool.admit(text);
        if (!admission) {
          const refusal = { ok: false, error: 'tool_unavailable' };
          return { isError: true, structuredContent: refusal, content: [{ type: 'text', text: JSON.stringify(refusal) }] };
        }
        let payment: Awaited<ReturnType<Meter>>;
        try { payment = await meter(lease, tool.name, idempotency_key, signal => admission.run(text, signal), entered); }
        catch { payment = { ok: false, error: 'metering_unavailable' }; }
        if (!payment.ok) {
          admission.cancel();
          return { isError: true, structuredContent: payment, content: [{ type: 'text', text: JSON.stringify(payment) }] };
        }
        return { structuredContent: payment.result, content: [{ type: 'text', text: JSON.stringify(payment.result) }] };
      });
    }
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const enabled = await available();
      return { tools: tools.filter(tool => enabled.some(item => (typeof item === 'string' ? item : item.id) === tool.name)).map(tool => {
        const entry = enabled.find(item => typeof item !== 'string' && item.id === tool.name);
        const price = typeof entry === 'object' ? entry.price_minor : undefined;
        return {
        name: tool.name,
        description: price === undefined ? tool.description : `${tool.description} Price: ${price} USD cents per call (computed from server registry).`,
        ...(price === undefined ? {} : { _meta: { 'pashadhara/price_minor': price, 'pashadhara/currency': 'USD' } }),
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', maxLength: 16000 },
            idempotency_key: { type: 'string', description: 'A new UUID, colon, and SHA-256 of tool name, NUL, then UTF-8 text. Reuse only to retry the same invocation.' },
          },
          required: ['text', 'idempotency_key'],
        },
      }; }) };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}

export function registeredTools(db: Database, names: readonly string[] = toyTools.map(tool => tool.name)) {
  return () => db.transaction(null, async tx => {
    const rows = await tx.query<{ id: string; price_minor: string }>('select id,price_minor from public.tools where active and id=any($1::text[])', [names]);
    return names.flatMap(name => {
      const row = rows.rows.find(item => item.id === name);
      if (!row) return [];
      const price = Number(row.price_minor);
      if (!Number.isSafeInteger(price) || price <= 0) throw new Error('Tool price is outside the safe integer range');
      return [{ id: row.id, price_minor: price }];
    });
  });
}
