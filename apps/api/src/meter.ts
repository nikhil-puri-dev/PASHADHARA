import type { Database, Tx } from '../../../packages/kernel/src/db.ts';
import { commitUsageInTransaction } from '../../../packages/kernel/src/usage.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { logError } from './request-log.ts';
import type { Meter } from './mcp.ts';

export const meterReasons = {
  refused_cap: 'cap_reached', refused_exposure: 'exposure_limit',
  refused_window: 'window_ended', refused_inactive: 'lease_not_active',
} as const;
const nextActions = {
  refused_cap: 'Choose a cheaper tool or ask the buyer to approve a new lease.',
  refused_exposure: 'Wait for settlement before retrying or choose a cheaper tool.',
  refused_window: 'Ask the buyer to approve a new lease.',
  refused_inactive: 'Choose an active tool.',
} as const;

/** One overall deadline per call, counted from the moment the call arrives: wait for a pool slot and the lease lock, then the model. */
export const PROVIDER_MS = 15_000;
/** Longest a call waits for a pool slot plus the lease lock before it answers busy. */
export const LOCK_WAIT_MS = 5_000;
export type Deadlines = { providerMs?: number; lockWaitMs?: number };

export class Busy extends Error {}
export class ToolFailure extends Error {}
export class WindowClosed extends Error {}

/** `entered` is when the request arrived (before authentication and pool checkout). Both deadlines count from it. */
export type Budget = Deadlines & { entered?: number };

/**
 * Run `body` inside one transaction that holds the lease lock. One budget counts from request entry: pool checkout and
 * every lock acquisition use what is left of the lock wait (never a fresh wait per lock), and `signal` aborts at the overall
 * deadline. `body` calls `arm()` before each further lock it takes, and `endWait()` before it runs the tool.
 */
export async function lockedTransaction<T>(
  db: Database, lease: string, budget: Budget | undefined,
  body: (tx: Tx, signal: AbortSignal, endWait: () => Promise<void>, arm: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const providerMs = budget?.providerMs ?? PROVIDER_MS;
  const lockWaitMs = budget?.lockWaitMs ?? LOCK_WAIT_MS;
  const entered = budget?.entered ?? Date.now();
  const waitEnds = entered + lockWaitMs;
  const signal = AbortSignal.timeout(Math.max(1, providerMs - (Date.now() - entered)));
  let started = false, abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { if (!started) { abandoned = true; reject(new Busy()); } }, Math.max(0, waitEnds - Date.now()));
  });
  const transaction = db.transaction(null, async tx => {
    if (abandoned) throw new Busy(); // the caller gave up while waiting for a pool slot
    started = true;
    const arm = async () => {
      const left = waitEnds - Date.now();
      if (left <= 0) throw new Busy();
      await tx.query(`set local lock_timeout = ${Math.max(1, Math.floor(left))}`);
    };
    await arm();
    await tx.query('select public.lock_lease($1)', [lease]);
    return body(tx, signal, async () => { await tx.query('set local lock_timeout = 0'); }, arm);
  }).catch(error => {
    if ((error as { code?: unknown })?.code === '55P03') throw new Busy();
    throw error;
  });
  try { return await Promise.race([transaction, gate]); }
  finally { clearTimeout(timer); transaction.catch(() => {}); }
}

/** Run the tool against the deadline. A provider that ignores the signal still cannot hold the lock past it. */
export async function runBeforeDeadline<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ToolFailure();
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => { onAbort = () => reject(new ToolFailure()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([work(signal), expired]); }
  catch { throw new ToolFailure(); }
  finally { signal.removeEventListener('abort', onAbort!); }
}

/** The honor window as it is now. Checked after the tool ran, because the model call can outlast it. */
export async function windowStillOpen(tx: Tx, lease: string) {
  const { rows: [row] } = await tx.query<{ open: boolean }>(`select
    exists(select 1 from public.authorizations a where a.lease_id=l.id and a.status in ('created','partially_captured')
      and a.honor_until>clock_timestamp()) and l.state='active'
    and not exists(select 1 from public.paypal_calls p where p.lease_id=l.id and p.op='void' and p.state in ('intent','sent','unknown')) as open
    from public.leases l where l.id=$1`, [lease]);
  return row?.open === true;
}

/**
 * The real meter. The kernel prices the call from public.tools, checks the lease and
 * writes the journal rows. Every error path fails closed with `metering_unavailable`.
 * A key that was already used is refused, because the tool result is not stored and a
 * free replay would let a caller spend the provider budget without paying.
 *
 * The tool runs inside the charging transaction, under the lease lock. If it throws, times out, or the honor
 * window closed while it ran, the charge and the served row roll back together. A retry with the same key after
 * such a rollback can repeat provider work: the buyer is charged at most once, the repeat is bounded by the
 * caller limits and the AI spend cap.
 */
export function kernelMeter(db: Database, deadlines?: Deadlines, results?: ResultStore): Meter {
  return async (lease, tool, key, work, entered) => {
    let price = 0n;
    try {
      const store = results && await results.usable() ? results : undefined;
      let output: Promise<Record<string, unknown>> | undefined;
      const result = await lockedTransaction(db, lease, { ...deadlines, entered }, async (tx, signal, endWait) => {
        const usage = await commitUsageInTransaction(tx, lease, { kind: 'tool', tool_id: tool, idempotency_key: key });
        price = usage.amount_minor;
        if (usage.replayed) {
          // Replay: same key, same lease. Return the stored product, charge nothing, call no provider.
          const stored = usage.status === 'served' && store ? await store.get(tx, lease, key) : null;
          const { hold } = await balances(tx, lease);
          return { usage, output, hold, stored };
        }
        if (usage.status !== 'served') return { usage, output };
        await endWait();
        output ??= runBeforeDeadline(work, signal); // a serialization retry must not call the provider twice
        const product = await output;
        if (!await windowStillOpen(tx, lease)) throw new WindowClosed();
        if (store) await store.put(tx, lease, key, usage.id!, product);
        const { hold } = await balances(tx, lease);
        return { usage, output, hold };
      });
      const { usage } = result;
      if (usage.replayed) {
        const { stored, hold } = result as { stored?: { tool_call_id: string; result: Record<string, unknown> } | null; hold: bigint };
        if (stored) return { ok: true, result: { ...stored.result, receipt: {
          provenance: 'computed', replayed: true, lease_id: lease, tool_call_id: stored.tool_call_id, ledger_group_id: usage.ledger_group_id,
          charged_minor: 0, original_charged_minor: Number(usage.amount_minor), remaining_minor: Number(hold) } } };
        if (store && usage.status !== 'served') return { ok: false, reason: meterReasons[usage.status], price_minor: Number(usage.amount_minor), remaining_minor: Number(hold), lease_id: lease, next_action: nextActions[usage.status] };
        return { ok: false, error: 'idempotency_conflict' };
      }
      if (usage.status === 'served') return { ok: true, result: {
        ...await result.output!,
        receipt: { provenance: 'computed', lease_id: lease, tool_call_id: usage.id, ledger_group_id: usage.ledger_group_id,
          charged_minor: Number(usage.amount_minor), remaining_minor: Number(result.hold) },
      } };
      const { hold } = await db.transaction(null, tx => balances(tx, lease));
      return { ok: false, reason: meterReasons[usage.status], price_minor: Number(usage.amount_minor), remaining_minor: Number(hold), lease_id: lease, next_action: nextActions[usage.status] };
    } catch (error) {
      if (error instanceof Busy) return { ok: false, error: 'busy', charged: false };
      if (error instanceof ToolFailure) return { ok: false, error: 'tool_failed', charged: false };
      if (error instanceof WindowClosed) {
        const { hold } = await db.transaction(null, tx => balances(tx, lease));
        return { ok: false, reason: meterReasons.refused_window, price_minor: Number(price), remaining_minor: Number(hold), lease_id: lease, next_action: nextActions.refused_window };
      }
      try { logError(new Request('http://localhost/mcp'), 'meter', error); } catch { /* logging must not open the gate */ }
      return { ok: false, error: 'metering_unavailable' };
    }
  };
}

/** Durable store of served results, written inside the charging transaction (see sql/tool_results.sql). */
export type ResultStore = {
  usable(): Promise<boolean>;
  put(tx: Tx, lease: string, key: string, toolCallId: string, result: Record<string, unknown>): Promise<void>;
  get(tx: Tx, lease: string, key: string): Promise<{ tool_call_id: string; result: Record<string, unknown> } | null>;
};
export function resultStore(db: Database): ResultStore {
  let usable: Promise<boolean> | undefined;
  return {
    // A missing table means replay is off and a reused key is refused, as before.
    usable: async () => {
      if (usable) return usable;
      // Only a positive answer is cached, so a transient probe failure is retried on the next call.
      const ok = await db.transaction(null, tx => tx.query("select to_regclass('public.tool_results') is not null as ok")).then(r => (r.rows[0] as { ok: boolean }).ok, () => false);
      if (ok) usable = Promise.resolve(true);
      return ok;
    },
    async put(tx, lease, key, id, result) {
      await tx.query('insert into public.tool_results(lease_id,idempotency_key,tool_call_id,result) values ($1,$2,$3,$4::jsonb)', [lease, key, id, JSON.stringify(result)]);
    },
    async get(tx, lease, key) {
      const { rows } = await tx.query<{ tool_call_id: string; result: Record<string, unknown> }>('select tool_call_id,result from public.tool_results where lease_id=$1 and idempotency_key=$2', [lease, key]);
      return rows[0] ?? null;
    },
  };
}
