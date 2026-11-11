import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import type { Database, Tx } from '../../../packages/kernel/src/db.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { commitUsageInTransaction, previewUsage } from '../../../packages/kernel/src/usage.ts';
import { isUuid } from './auth.ts';
import { Busy, ToolFailure, WindowClosed, lockedTransaction, meterReasons, runBeforeDeadline, windowStillOpen, type Deadlines } from './meter.ts';
import type { ToolDef } from './mcp.ts';
import { readHandlers } from './read-handlers.ts';

const DAILY = 12;
const PER_IP = 2;
const PREFIX = 'showcase:';
const TEXT = 'A PayPal sandbox authorization backs an AI agent spending limit. The gateway charges for tools and refuses calls above the remaining budget.';

export function showcaseRoutes(db: Database, lease: string, secret: string, tool: ToolDef, lifetime: number, deadlines?: Deadlines) {
  const app = new Hono();
  const reads = readHandlers(db);
  const headers = { 'Cache-Control': 'no-store' };
  const ipPrefix = (request: Request) => {
    const ip = process.env.VERCEL ? request.headers.get('x-vercel-forwarded-for') ?? '' : '127.0.0.1';
    return isIP(ip) ? PREFIX + createHmac('sha256', secret).update('showcase-ip:' + ip).digest('hex') + ':' : null;
  };
  async function remaining(tx: Tx, prefix: string | null) {
    const { rows: [row] } = await tx.query<{ total: number; daily: number; ip: number }>(`
      select count(*)::int as total,
        count(*) filter (where created_at>=date_trunc('day',now()))::int as daily,
        count(*) filter (where left(idempotency_key,length($1))=$1 and created_at>=date_trunc('day',now()))::int as ip
      from public.tool_calls where status='served' and left(idempotency_key,9)='showcase:'`, [prefix]);
    return Math.max(0, Math.min(lifetime - row!.total, DAILY - row!.daily, prefix ? PER_IP - row!.ip : 0));
  }
  app.use('/showcase/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.get('/showcase', async c => {
    if (!isUuid(lease)) return c.json({ error: 'showcase_unavailable' }, 503, headers);
    const input = { params: { leaseId: lease }, query: {}, body: undefined, request: c.req.raw, principal: null };
    const result = await reads.getLease!(input);
    if (result.status !== 200) return c.json({ error: 'showcase_unavailable' }, 503, headers);
    const journal = await reads.getJournal!(input);
    const proof = await db.transaction(null, async tx => {
      const calls = await tx.query(`select t.id,t.tool_id,t.price_minor,t.status,t.created_at,t.ledger_group_id,
        exists(select 1 from public.capture_allocations a join public.captures c on c.id=a.capture_id
          where a.lease_id=t.lease_id and a.ref_id=t.id::text and c.status='completed') as captured
        from public.tool_calls t where t.lease_id=$1 order by t.created_at,t.id`, [lease]);
      const captures = await tx.query(`select id,paypal_capture_id,amount_minor,fee_minor,status,created_at
        from public.captures where lease_id=$1 order by created_at,id`, [lease]);
      return { calls: calls.rows, captures: captures.rows, remaining_calls: await remaining(tx, ipPrefix(c.req.raw)) };
    });
    return c.json({ provenance: 'computed', mode: 'live', lease: result.body, journal: journal.body, ...proof }, 200, headers);
  });
  app.post('/showcase/run', async c => {
    const entered = Date.now();
    if (c.req.header('content-type') !== 'application/json') return c.json({ error: 'Expected application/json' }, 415);
    const prefix = ipPrefix(c.req.raw);
    if (!prefix || !isUuid(lease)) return c.json({ error: 'showcase_unavailable' }, 503);
    const admission = tool.admit(TEXT);
    if (!admission) return c.json({ error: 'agent_unavailable' }, 503);
    try {
      // The model runs inside the charging transaction, under the same bounded lock wait and overall deadline as an MCP call.
      // If it fails, or the honor window closed meanwhile, the commit and the served row roll back together and the
      // visitor allowance is not used up.
      let output: Promise<Record<string, unknown>> | undefined;
      let price = 0n;
      try {
        const payment = await lockedTransaction(db, lease, { ...deadlines, entered }, async (tx, signal, endWait, arm) => {
          await arm(); // what is left of the one budget, not a fresh wait
          await tx.query('select pg_advisory_xact_lock(234171,4)');
          const available = await remaining(tx, prefix);
          if (!available) return { status: 429 as const, body: { error: 'demo_limit', remaining_calls: 0 } };
          const call = await commitUsageInTransaction(tx, lease, { kind: 'tool', tool_id: tool.name, idempotency_key: prefix + randomUUID() });
          price = call.amount_minor;
          const { hold } = await balances(tx, lease);
          const amounts = { price_minor: Number(call.amount_minor), remaining_minor: Number(hold), provenance: 'computed' };
          if (call.status !== 'served') return { status: 402 as const, body: { ...amounts, reason: meterReasons[call.status] } };
          await endWait();
          output ??= runBeforeDeadline(signal2 => admission.run(TEXT, signal2), signal); // a serialization retry must not call the model twice
          await output;
          if (!await windowStillOpen(tx, lease)) throw new WindowClosed();
          return { status: 200 as const, body: { ...amounts, remaining_calls: available - 1 } };
        });
        if (payment.status !== 200) return c.json(payment.body, payment.status);
        return c.json({ ...payment.body, result: await output });
      } catch (error) {
        if (error instanceof Busy) return c.json({ error: 'busy', charged: false }, 503);
        if (error instanceof ToolFailure) return c.json({ error: 'tool_failed', charged: false }, 502);
        if (error instanceof WindowClosed) {
          const { hold } = await db.transaction(null, tx => balances(tx, lease));
          return c.json({ price_minor: Number(price), remaining_minor: Number(hold), provenance: 'computed', reason: meterReasons.refused_window }, 402);
        }
        throw error;
      }
    } finally {
      admission.cancel();
    }
  });
  app.post('/showcase/try', async c => {
    const raw = c.req.query('price_minor') ?? '';
    if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
      return c.json({ error: 'Enter a positive price in cents.' }, 400);
    }
    if (!isUuid(lease)) return c.json({ error: 'showcase_unavailable' }, 503);
    const price = BigInt(raw);
    const result = await previewUsage(db, lease, price);
    return c.json({
      provenance: 'computed', price_minor: Number(price), remaining_minor: Number(result.hold),
      reason: result.status === 'served' ? null : meterReasons[result.status],
    }, result.status === 'served' ? 200 : 402);
  });
  return app;
}
