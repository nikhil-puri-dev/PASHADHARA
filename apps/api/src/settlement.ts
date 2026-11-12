import {
  accrueSeller, closeLease, completeCapture, completeReauthorize, completeVoid, estimatedPayPalFee,
  failCapture, markUnknown, planSettlement, recordAuthorizationReadInTransaction, recordPendingCapture, recordRejectedCall, resolveUnknown,
  type Database, type Evidence, type SettlementState,
} from '../../../packages/kernel/src/index.ts';
import { beginCaptureInTransaction } from '../../../packages/kernel/src/capture.ts';
import { beginReauthorizeInTransaction, beginVoidInTransaction } from '../../../packages/kernel/src/lease.ts';
import { randomUUID } from 'node:crypto';
import { intent, objectField, paypalMinor, sent } from '../../../packages/kernel/src/calls.ts';
import type { Tx } from '../../../packages/kernel/src/db.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { PayPalError, type PayPalClient } from '../../../packages/paypal/src/index.ts';
import { readLeases } from './read-handlers.ts';
import type { RouteHandler, RouteInput } from './routes.ts';
import { runSettlementSchedule } from './scheduler.ts';

type Gateway = Pick<PayPalClient, 'capture' | 'void' | 'reauthorize' | 'getAuthorization' | 'getCapture' | 'getOrder'>;
type Authorization = { id: string; paypal_authorization_id: string; honor_until: Date; expires_at: Date; status: string; amount_minor: string };
type Capture = { id: string; authorization_id: string; call_id: string; paypal_capture_id: string | null;
  amount_minor: string; fee_minor: string | null; status: string };
const usd = (amount: bigint) => ({ currency_code: 'USD', value: `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}` });
const problem = (status: number, title: string) => ({ status, body: { type: 'about:blank', status, title } });
const evidence = (result: { status: number; body: unknown }): Evidence => ({
  http_status: result.status, body: objectField(result.body ?? {}),
});
const readEvidence = (result: { status: number; body: unknown }) => ({ ...evidence(result), source: 'get' as const });
const live = (tx: Tx, lease: string) => tx.query<Authorization>(`select * from public.authorizations
  where lease_id=$1 and status in ('created','partially_captured')`, [lease]).then(r => r.rows[0]);
const open = (tx: Tx, lease: string) => tx.query<{ id: string; op: string; state: string }>(
  `select id,op,state from public.paypal_calls where lease_id=$1 and op in ('capture','void','reauthorize')
    and state in ('intent','sent','unknown')`, [lease],
).then(r => r.rows[0]);

async function candidate(tx: Tx, lease: string, auth: Authorization, closing: boolean) {
  const { rows: allocations } = await tx.query<{ ref_id: string; amount_minor: string }>(`
    select t.id::text as ref_id,t.price_minor-coalesce(sum(a.amount_minor),0) as amount_minor
    from public.tool_calls t left join public.capture_allocations a on a.lease_id=t.lease_id and a.ref_id=t.id::text
    where t.lease_id=$1 and t.status='served' group by t.id having t.price_minor>coalesce(sum(a.amount_minor),0)
    order by t.id`, [lease]);
  const { rows: [clock] } = await tx.query<{ now: Date; unsettled_limit_minor: string }>(
    'select clock_timestamp() as now,unsettled_limit_minor from public.leases where id=$1', [lease],
  );
  const lines = allocations.map(a => ({ ref_id: a.ref_id, amount_minor: BigInt(a.amount_minor) }));
  const state: SettlementState = {
    capturable_minor: lines.reduce((sum, a) => sum + a.amount_minor, 0n),
    committed_unsettled_minor: (await balances(tx, lease)).committed,
    unsettled_limit_minor: BigInt(clock!.unsettled_limit_minor),
    fee_target_bps: 1000n, exposure_trigger_bps: 8000n,
    honor_until: auth.honor_until, now: clock!.now, closing,
  };
  return { lines, state };
}

export function settlementFlow(db: Database, paypal: Gateway, getLease: RouteHandler) {
  async function accrue(lease: string) {
    const { rows } = await db.transaction(null, tx => tx.query<{ id: string }>(`
      select t.id from public.tool_calls t
      join public.capture_allocations a on a.lease_id=t.lease_id and a.ref_id=t.id::text
      join public.captures c on c.id=a.capture_id
      where t.lease_id=$1 and t.status='served' and not exists (
        select 1 from public.ledger_entries e where e.lease_id=t.lease_id and e.ref_type='accrue' and e.ref_id=t.id::text)
      group by t.id having sum(a.amount_minor)=t.price_minor
        and bool_and(c.status in ('completed','declined','denied')) and bool_or(c.status='completed')`, [lease]));
    for (const { id } of rows) await accrueSeller(db, lease, id);
  }

  async function settle(lease: string, force: boolean): Promise<{ busy: true } | { id: string } | null> {
    const dispatch = await db.transaction(lease, async (tx, leaseState) => {
      if (await open(tx, lease)) return { busy: true } as const;
      const auth = await live(tx, lease);
      if (!auth || leaseState !== 'active') return null;
      const { lines, state } = await candidate(tx, lease, auth, force);
      // Escrow owns its reserved commitments and capture lifecycle.
      if (state.committed_unsettled_minor !== state.capturable_minor) return { busy: true } as const;
      if (!planSettlement(state)) return null;
      if (state.now >= auth.expires_at) return { busy: true } as const;
      const call = await beginCaptureInTransaction(tx, lease, { authorization_id: auth.id, allocations: lines });
      if (!await sent(tx, lease, call.call_id)) throw new Error('Capture intent not claimed');
      return { auth, call } as const;
    });
    if (!dispatch) return null;
    if (dispatch.busy) return { busy: true };
    const { auth, call } = dispatch;
    let response: Evidence | undefined;
    try {
      response = evidence(await paypal.capture(auth.paypal_authorization_id, usd(call.amount_minor), call.invoice_id, call.request_id));
      if (response.body.status === 'PENDING') await recordPendingCapture(db, lease, call.capture_id, response);
      else if (['DECLINED', 'DENIED'].includes(String(response.body.status))) await failCapture(db, lease, call.capture_id, response);
      else await completeCapture(db, lease, call.capture_id, response);
    } catch (error) {
      const row = await db.transaction(null, tx => tx.query<Capture>('select * from public.captures where id=$1', [call.capture_id])).then(r => r.rows[0]!);
      if (row.status === 'intent') {
        let declined = false;
        if (!response && error instanceof PayPalError && error.status === 422) {
          declined = await failCapture(db, lease, call.capture_id, evidence(error)).then(() => true, () => false);
        }
        if (!declined) await markUnknown(db, lease, call.call_id).catch(async failure => {
          if ((await db.transaction(null, tx => open(tx, lease)))?.id === call.call_id) throw failure;
        });
      }
    }
    await accrue(lease);
    return { id: call.capture_id };
  }

  const snapshot = (lease: string) => db.transaction(null, async tx => ({
    lease: (await readLeases(tx, lease))[0],
    captures: (await tx.query<Capture>('select * from public.captures where lease_id=$1 order by created_at,id', [lease])).rows,
    auths: (await tx.query<Authorization>('select * from public.authorizations where lease_id=$1 order by created_at,id', [lease])).rows,
    order: (await tx.query<{ paypal_order_id: string | null }>('select paypal_order_id from public.leases where id=$1', [lease])).rows[0]?.paypal_order_id,
    open: await open(tx, lease),
  }), 'repeatable read');

  async function voidRemainder(lease: string) {
    const dispatch = await db.transaction(lease, async tx => {
      if (await open(tx, lease) || (await balances(tx, lease)).committed !== 0n) return false;
      if (!await live(tx, lease)) return null;
      const call = await beginVoidInTransaction(tx, lease);
      if (!await sent(tx, lease, call.call_id)) throw new Error('Void intent not claimed');
      return call;
    });
    if (!dispatch) return dispatch !== false;
    try {
      await paypal.void(dispatch.paypal_authorization_id, dispatch.request_id);
      await completeVoid(db, lease, dispatch.call_id, readEvidence(await paypal.getAuthorization(dispatch.paypal_authorization_id)));
      return true;
    } catch (error) {
      // Even a rejected POST can mean the authorization was already voided; GET is authoritative.
      try {
        await completeVoid(db, lease, dispatch.call_id, readEvidence(await paypal.getAuthorization(dispatch.paypal_authorization_id)));
        return true;
      } catch {
        if ((await db.transaction(null, tx => open(tx, lease)))?.id !== dispatch.call_id) return true;
        if (error instanceof PayPalError &&
          await recordRejectedCall(db, lease, dispatch.call_id, evidence(error)).then(() => true, () => false)) return false;
        await markUnknown(db, lease, dispatch.call_id);
        return false;
      }
    }
  }

  async function reconcile(lease: string) {
    const before = await snapshot(lease);
    if (!before.lease) return problem(404, 'Lease not found');
    const lines: { subject: string; ours: object; paypal: object; match: boolean; read_at?: string }[] = [];
    type Read = { result: Awaited<ReturnType<Gateway['getAuthorization']>>; read_at: string };
    const authReads = new Map<string, Read>();
    const captureReads = new Map<string, Read>();
    for (const auth of before.auths) {
      try {
        const result = await paypal.getAuthorization(auth.paypal_authorization_id);
        if (evidence(result).body.id === auth.paypal_authorization_id) authReads.set(auth.id, { result, read_at: new Date().toISOString() });
      } catch { /* no matching evidence */ }
    }
    for (const capture of before.captures) {
      let id = capture.paypal_capture_id;
      try {
        if (!id && before.order && before.open?.id === capture.call_id && before.open.state !== 'intent') {
          const order = evidence(await paypal.getOrder(before.order)).body as { id?: string; purchase_units?: { payments?: { captures?: { id: string; invoice_id?: string }[] } }[] };
          const found = order.id === before.order ? order.purchase_units?.flatMap(u => u.payments?.captures ?? []).filter(c => c.invoice_id === capture.id) : [];
          if (found?.length === 1) id = found[0]!.id;
        }
        if (id) {
          const result = await paypal.getCapture(id);
          if (evidence(result).body.id === id) captureReads.set(capture.id, { result, read_at: new Date().toISOString() });
        }
      } catch { /* no matching evidence */ }
    }
    if (before.open?.state !== 'intent') {
      try {
        if (before.open?.op === 'capture') {
          const capture = before.captures.find(c => c.call_id === before.open?.id);
          const result = capture && captureReads.get(capture.id)?.result;
          if (result) await resolveUnknown(db, lease, before.open.id, readEvidence(result));
        } else if (before.open?.op === 'void') {
          const auth = before.auths.find(a => ['created', 'partially_captured'].includes(a.status));
          const result = auth && authReads.get(auth.id)?.result;
          if (result && evidence(result).body.status === 'VOIDED') await resolveUnknown(db, lease, before.open.id, readEvidence(result));
        }
      } catch { /* the journal below shows unresolved or mismatched evidence */ }
    }
    if (!await db.transaction(null, tx => open(tx, lease))) {
      for (const auth of before.auths.filter(a => ['created', 'partially_captured'].includes(a.status))) {
        const result = authReads.get(auth.id)?.result;
        const status = result && evidence(result).body.status;
        if (result && (status === 'EXPIRED' || (status === 'DENIED' && auth.status === 'created'))) {
          await db.transaction(lease, async tx => {
            if (await open(tx, lease) || (await live(tx, lease))?.id !== auth.id) return;
            const call = await intent(tx, lease, 'get', randomUUID(), null);
            if (!await sent(tx, lease, call.call_id)) throw new Error('Authorization read not claimed');
            await recordAuthorizationReadInTransaction(tx, lease, call.call_id, readEvidence(result));
          }).catch(() => undefined);
        }
      }
    }
    await accrue(lease);
    if (before.open?.op === 'void' && !await db.transaction(null, tx => open(tx, lease))) {
      await closeLease(db, lease).catch(error => {
        if ((error as { code?: string }).code !== '23514') throw error;
      });
    }
    const after = await snapshot(lease);
    const b = after.lease!.balances;
    const conserved = BigInt(b.buyer_commitment!) === [b.hold_available, b.committed_unsettled, b.released, b.written_off, b.total_captured]
      .reduce((sum, n) => sum + BigInt(n!), 0n);
    for (const auth of after.auths) {
      const read = authReads.get(auth.id);
      const body = read ? evidence(read.result).body : {};
      const ours = { id: auth.paypal_authorization_id, status: auth.status, amount_minor: auth.amount_minor };
      const status = auth.status === 'partially_captured' ? 'PARTIALLY_CAPTURED' : auth.status.toUpperCase();
      lines.push({ subject: `authorization ${auth.id}`, ours, paypal: { id: body.id, status: body.status, amount: body.amount }, read_at: read?.read_at,
        match: body.id === ours.id && body.status === status && matchesUsd(body.amount, ours.amount_minor) });
    }
    for (const capture of after.captures) {
      const read = captureReads.get(capture.id);
      const body = read ? evidence(read.result).body : {};
      const fee = (body.seller_receivable_breakdown as { paypal_fee?: unknown } | undefined)?.paypal_fee;
      const ours = { id: capture.paypal_capture_id, status: capture.status, amount_minor: capture.amount_minor, fee_minor: capture.fee_minor };
      lines.push({ subject: `capture ${capture.id}`, ours, paypal: { id: body.id, status: body.status, amount: body.amount, fee }, read_at: read?.read_at,
        match: Boolean(ours.id && ours.id === body.id && body.status === (ours.status === 'reversed' ? 'REFUNDED' : ours.status.toUpperCase())
          && matchesUsd(body.amount, ours.amount_minor) && (ours.fee_minor === null || matchesUsd(fee, ours.fee_minor))) });
    }
    return { status: 200, body: { lease_id: lease, lines, invariants: [{ id: 'I16', holds: conserved }],
      all_match: conserved && !after.open && lines.length > 0 && lines.every(l => l.match) } };
  }

  return {
    async sweep() {
      const recovery = await db.transaction(null, tx => tx.query<{ lease_id: string }>(`
        select lease_id from public.paypal_calls where op in ('capture','void') and state in ('sent','unknown')
        order by sent_at limit 5`));
      for (const { lease_id } of recovery.rows) {
        await reconcile(lease_id).catch(() => undefined);
      }
      const candidates = await db.transaction(null, async tx => {
        const { rows } = await tx.query<{ lease_id: string }>(`select a.lease_id from public.authorizations a
          join public.leases l on l.id=a.lease_id where l.state='active' and a.status in ('created','partially_captured')
          and a.expires_at>clock_timestamp() and not exists (select 1 from public.paypal_calls p
            where p.lease_id=a.lease_id and p.op in ('capture','void','reauthorize') and p.state in ('intent','sent','unknown'))
          and exists (select 1 from public.tool_calls t where t.lease_id=a.lease_id and t.status='served'
            and t.price_minor>coalesce((select sum(c.amount_minor) from public.capture_allocations c
              where c.lease_id=t.lease_id and c.ref_id=t.id::text),0))
          order by a.honor_until limit 20`);
        const found = [];
        for (const { lease_id } of rows) {
          const auth = await live(tx, lease_id);
          if (auth) found.push({ leaseId: lease_id, state: (await candidate(tx, lease_id, auth, false)).state });
        }
        return found;
      }, 'repeatable read');
      return runSettlementSchedule(candidates, async lease => {
        const result = await settle(lease, false);
        if (!result || 'busy' in result) throw new Error('Settlement no longer eligible');
      });
    },
    handlers: {
      async settleLease({ params }: RouteInput) {
        const lease = params.leaseId!;
        const settled = await settle(lease, true);
        if (settled && 'busy' in settled) return problem(409, 'Settlement blocked; reconcile the outstanding call or check the authorization');
        return db.transaction(null, async tx => {
          const { rows } = await tx.query<Capture>('select * from public.captures where id=$1 and lease_id=$2', [settled?.id ?? null, lease]);
          if (rows.some(row => ['intent', 'pending', 'unknown'].includes(row.status))) return problem(409, 'Capture fee is not known; reconcile before retrying');
          const { rows: allocations } = await tx.query<{ capture_id: string; lease_id: string; ref_id: string; amount_minor: string }>(
            'select * from public.capture_allocations where capture_id=$1 order by ref_id', [settled?.id ?? null],
          );
          return { status: 200, body: {
            captures: rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor), fee_minor: row.fee_minor === null ? null : Number(row.fee_minor),
              provenance: row.paypal_capture_id && row.status !== 'unknown' ? 'measured' : 'computed',
              allocations: allocations.map(a => ({ ...a, amount_minor: Number(a.amount_minor) })) })),
            naive_fee_minor: Number(allocations.reduce((total, a) => total + estimatedPayPalFee(BigInt(a.amount_minor)), 0n)),
            actual_fee_minor: Number(rows[0]?.fee_minor ?? 0),
          } };
        });
      },
      async closeLease(input: RouteInput) {
        const lease = input.params.leaseId!;
        const settled = await settle(lease, true);
        if (settled && 'busy' in settled) return problem(409, 'Reconcile the outstanding call before closing');
        await accrue(lease);
        if (!await voidRemainder(lease)) return problem(409, 'Commitments or a PayPal operation still need resolution');
        try { await closeLease(db, lease); }
        catch (error) {
          if ((error as { code?: string }).code !== '23514') throw error;
          return problem(409, 'Lease still has unresolved activity');
        }
        return getLease(input);
      },
      async reauthorizeLease(input: RouteInput) {
        const lease = input.params.leaseId!;
        let call;
        try {
          call = await db.transaction(lease, async (tx, state) => {
            const pending = await beginReauthorizeInTransaction(tx, lease, state);
            if (!await sent(tx, lease, pending.call_id)) throw new Error('Reauthorization intent not claimed');
            return pending;
          });
        }
        catch { return problem(409, 'Authorization is not eligible for reauthorization'); }
        try {
          await completeReauthorize(db, lease, call.call_id, evidence(await paypal.reauthorize(
            call.paypal_authorization_id, usd(call.amount_minor), call.request_id,
          )));
        } catch (error) {
          if (error instanceof PayPalError && await recordRejectedCall(db, lease, call.call_id, evidence(error)).then(() => true, () => false)) {
            return problem(422, 'PayPal rejected reauthorization');
          }
          await markUnknown(db, lease, call.call_id);
          return problem(409, 'Reauthorization outcome unknown; do not retry');
        }
        return getLease(input);
      },
      reconcileLease: async ({ params }: RouteInput) => reconcile(params.leaseId!),
    } satisfies Record<string, RouteHandler>,
  };
}

function matchesUsd(value: unknown, amount: string) {
  try {
    const money = objectField(value);
    return money.currency_code === 'USD' && paypalMinor(money.value) === BigInt(amount);
  } catch { return false; }
}
