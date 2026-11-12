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
export type Meter = (lease: string, tool: string, key: string, work: (signal: AbortSignal) => Promise<Record<string, unknown>>, entered?: number, admit?: () => boolean) => Promise<MeterResult>;

/** A meter may also answer a free, non-posting affordability preview for one lease (kernel previewUsage). */
export type PreviewMeter = Meter & { preview?: (lease: string, priceMinor: bigint) => Promise<{ status: string; hold: bigint }> };
export const PREFLIGHT_TOOL = 'check_budget';

/** A tool may only run after `admit` agreed it can (provider ready, spend left) and the meter charged. */
export type Admission = { run(text: string, signal?: AbortSignal): Promise<Record<string, unknown>>; cancel(): void };
export type ToolDef = { name: string; description: string; admit(text: string): Admission | null };

/** A client sends a bare UUID and the server binds it to the tool and input by appending the digest itself. The digest form UUID:sha256(tool NUL text) is still accepted. */
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{64}$/i;
export const KEY_HELP = 'idempotency_key must be a new random UUID, in the form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx with random hex digits. Never reuse an old UUID or copy an example. Send a fresh UUID for each new request. Resend the same UUID with the same text only to retry a request whose answer was lost.';
const KEY_DESCRIPTION = 'A new random UUID for each new request, in the form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx with random hex digits. Never reuse an old UUID or copy an example. To retry a request whose answer was lost, resend the same UUID with the same text: the retry is free. A UUID reused with different text is refused.';

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
/* Standard Implementation metadata (MCP 2025-11-25: title, websiteUrl, icons). Clients that do not read it ignore it. */
const WEB_ORIGIN = 'https://pashadhara.vercel.app';
export const SERVER_INFO = {
  name: 'pashadhara', title: 'Pashadhara', version: '0.1.0', websiteUrl: WEB_ORIGIN,
  icons: [{ src: `${WEB_ORIGIN}/mark.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }],
};

export function createMcp(
  meter: PreviewMeter, resolveLease: (request: Request) => Promise<string | null>,
  available: () => Promise<readonly (string | { id: string; price_minor: number })[]>, tools: readonly ToolDef[] = toyTools,
  budget: { lockWaitMs?: number; allowedOrigins?: readonly string[]; preflightPerMinute?: number } = {},
) {
  const app = new Hono();
  // Per lease, per process: at most preflightPerMinute free previews in any 60 s. Paid calls are never throttled by it.
  const previews = new Map<string, number[]>();
  const allowPreview = (lease: string) => {
    const now = Date.now(), recent = (previews.get(lease) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= (budget.preflightPerMinute ?? 20)) { previews.set(lease, recent); return Math.ceil((60_000 - (now - recent[0]!)) / 1000); }
    recent.push(now); previews.set(lease, recent);
    if (previews.size > 1000) for (const [id, times] of previews) if (times.every(at => now - at >= 60_000)) previews.delete(id);
    return 0;
  };
  app.all('/mcp', async c => {
    // Stateless server: there is no session to resume (GET) or end (DELETE). The spec allows 405 for both.
    if (c.req.method === 'GET' || c.req.method === 'DELETE') return c.body(null, 405, { allow: 'POST' });
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
    if (lease === null && c.req.method === 'POST') {
      // A tool call without a valid lease token is an authentication failure at the HTTP layer, so clients can react to it.
      const rpc = await c.req.raw.clone().json().catch(() => null) as { method?: unknown } | { method?: unknown }[] | null;
      if ((Array.isArray(rpc) ? rpc : [rpc]).some(m => m?.method === 'tools/call')) return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="pashadhara-lease"' });
    }
    const server = new McpServer(SERVER_INFO);
    for (const tool of tools) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: {
          text: z.string().max(16000),
          // Optional here only so a call without it gets a refusal that says what to send (the listed schema marks it required).
          idempotency_key: z.string().max(200).optional().describe(KEY_DESCRIPTION),
        },
      }, async ({ text, idempotency_key }) => {
        if (lease === busy) {
          const refusal = { ok: false, error: 'busy', charged: false };
          return { isError: true, structuredContent: refusal, content: [{ type: 'text', text: JSON.stringify(refusal) }] };
        }
        if (!lease) return { isError: true, content: [{ type: 'text', text: 'A valid lease token is required.' }] };
        if (idempotency_key === undefined) return { isError: true, content: [{ type: 'text', text: `idempotency_key is required. ${KEY_HELP}` }] };
        const digest = createHash('sha256').update(tool.name).update('\0').update(text).digest('hex');
        let key: string;
        if (UUID_KEY.test(idempotency_key)) key = `${idempotency_key.toLowerCase()}:${digest}`;
        else if (DIGEST_KEY.test(idempotency_key)) {
          if (!idempotency_key.endsWith(`:${digest}`)) return { isError: true, content: [{ type: 'text', text: 'Idempotency key does not match the tool and input.' }] };
          key = idempotency_key.slice(0, 36).toLowerCase() + idempotency_key.slice(36);
        } else return { isError: true, content: [{ type: 'text', text: `idempotency_key is not a UUID. ${KEY_HELP}` }] };
        // Admission (provider ready, spend reserved) is requested by the meter only when the call can really run: after the
        // key checks, never for a stored replay, and always before the kernel charges.
        let admission: Admission | null | undefined;
        const admit = () => { admission ??= tool.admit(text); return admission !== null; };
        const work = async (signal: AbortSignal) => { if (!admit()) throw new Error('tool unavailable'); return admission!.run(text, signal); };
        let payment: Awaited<ReturnType<Meter>>;
        try { payment = await meter(lease, tool.name, key, work, entered, admit); }
        catch { payment = { ok: false, error: 'metering_unavailable' }; }
        if (!payment.ok) {
          admission?.cancel();
          const body = 'error' in payment && payment.error === 'idempotency_conflict'
            ? { ...payment, message: 'This UUID was already used for different input. Nothing was charged. Send a new random UUID for this request.' } : payment;
          return { isError: true, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
        }
        if ((payment.result.receipt as { replayed?: boolean } | undefined)?.replayed) admission?.cancel(); // a replay never ran the tool: free any reservation
        return { structuredContent: payment.result, content: [{ type: 'text', text: JSON.stringify(payment.result) }] };
      });
    }
    const preview = meter.preview;
    if (preview) {
      server.registerTool(PREFLIGHT_TOOL, {
        description: 'Free. Check whether this lease can afford one call to a paid tool right now, without spending anything. Returns the price, whether it is affordable and the remaining balance in USD cents.',
        inputSchema: { tool: z.string().max(100).describe('Plain name of a paid tool from the tool list, for example text_stats. Not a client-prefixed name.') },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async ({ tool }) => {
        const fail = (body: Record<string, unknown>) => ({ isError: true, structuredContent: { ok: false, ...body }, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...body }) }] });
        if (lease === busy) return fail({ error: 'busy', charged: false });
        if (!lease) return { isError: true, content: [{ type: 'text' as const, text: 'A valid lease token is required.' }] };
        const wait = allowPreview(lease);
        if (wait > 0) return fail({ error: 'rate_limited', retry_after_seconds: wait });
        const enabled = await available();
        const names = tools.map(item => item.name).filter(name => enabled.some(item => (typeof item === 'string' ? item : item.id) === name));
        const entry = enabled.find(item => typeof item !== 'string' && item.id === tool && names.includes(tool));
        if (typeof entry !== 'object') return fail({ error: 'unknown_tool', available: names });
        let answer: { status: string; hold: bigint };
        try { answer = await preview(lease, BigInt(entry.price_minor)); } catch { return fail({ error: 'metering_unavailable' }); }
        const body = { provenance: 'computed', tool, price_minor: entry.price_minor, affordable: answer.status === 'served', status: answer.status, remaining_minor: Number(answer.hold) };
        return { structuredContent: body, content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      });
    }
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const enabled = await available();
      const check = preview ? [{
        name: PREFLIGHT_TOOL,
        description: 'Free. Check whether this lease can afford one call to a paid tool right now, without spending anything. Returns the price, whether it is affordable and the remaining balance in USD cents.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { type: 'object' as const, properties: { tool: { type: 'string', maxLength: 100, description: 'Plain name of a paid tool from the tool list, for example text_stats. Not a client-prefixed name.' } }, required: ['tool'] },
      }] : [];
      return { tools: [...tools.filter(tool => enabled.some(item => (typeof item === 'string' ? item : item.id) === tool.name)).map(tool => {
        const entry = enabled.find(item => typeof item !== 'string' && item.id === tool.name);
        const price = typeof entry === 'object' ? entry.price_minor : undefined;
        return {
        name: tool.name,
        description: price === undefined ? tool.description : `${tool.description} Price: ${price} USD cents per call (computed from server registry).`,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        outputSchema: { type: 'object' as const, additionalProperties: true },
        ...(price === undefined ? {} : { _meta: { 'pashadhara/price_minor': price, 'pashadhara/currency': 'USD' } }),
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', maxLength: 16000 },
            idempotency_key: { type: 'string', description: KEY_DESCRIPTION },
          },
          required: ['text', 'idempotency_key'],
        },
      }; }), ...check] };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}

export function registeredTools(db: Database, names: readonly string[] = toyTools.map(tool => tool.name)) {
  return () => db.transaction(null, async tx => {
    const rows = await tx.query<{ id: string; name: string; description: string; seller_id: string; price_minor: string }>('select id,name,description,seller_id,price_minor from public.tools where active and id=any($1::text[])', [names]);
    return names.flatMap(name => {
      const row = rows.rows.find(item => item.id === name);
      if (!row) return [];
      const price = Number(row.price_minor);
      if (!Number.isSafeInteger(price) || price <= 0) throw new Error('Tool price is outside the safe integer range');
      return [{ ...row, price_minor: price }];
    });
  });
}
