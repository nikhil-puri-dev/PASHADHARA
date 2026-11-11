import { commitUsage, type Database } from '../../../packages/kernel/src/index.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { logError } from './request-log.ts';
import type { Meter } from './mcp.ts';

export const meterReasons = {
  refused_cap: 'cap_reached', refused_exposure: 'exposure_limit',
  refused_window: 'window_ended', refused_inactive: 'lease_not_active',
} as const;

/**
 * The real meter. The kernel prices the call from public.tools, checks the lease and
 * writes the journal rows. Every error path fails closed with `metering_unavailable`.
 * A key that was already used is refused, because the tool result is not stored and a
 * free replay would let a caller spend the provider budget without paying.
 */
export function kernelMeter(db: Database): Meter {
  return async (lease, tool, key) => {
    try {
      const result = await commitUsage(db, lease, { kind: 'tool', tool_id: tool, idempotency_key: key });
      if (result.replayed) return { ok: false, error: 'idempotency_conflict' };
      if (result.status === 'served') return { ok: true };
      const { hold } = await db.transaction(null, tx => balances(tx, lease));
      return { ok: false, reason: meterReasons[result.status], price_minor: Number(result.amount_minor), remaining_minor: Number(hold), lease_id: lease };
    } catch (error) {
      try { logError(new Request('http://localhost/mcp'), 'meter', error); } catch { /* logging must not open the gate */ }
      return { ok: false, error: 'metering_unavailable' };
    }
  };
}
