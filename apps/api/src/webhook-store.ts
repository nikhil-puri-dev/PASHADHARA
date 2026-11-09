import { randomUUID } from 'node:crypto';
import { recordAuthorizationReadInTransaction, resolveUnknownInTransaction, type Database, type ReadEvidence } from '../../../packages/kernel/src/index.ts';
import { finish, intent, isSuccess, loadCall, objectField, paypalMinor, sent } from '../../../packages/kernel/src/calls.ts';
import { one, type Json, type Tx } from '../../../packages/kernel/src/db.ts';
import { isUuid } from './auth.ts';
import type { KernelPort } from './kernel-port.ts';
import { ApiError } from './request-log.ts';

const findCapture = (tx: Tx, id: string, invoice: string | null) => tx.query<{
  id: string; lease_id: string; call_id: string; paypal_capture_id: string | null;
  status: string; amount_minor: string; fee_minor: string | null;
}>(`select id,lease_id,call_id,paypal_capture_id,status,amount_minor,fee_minor from public.captures
    where paypal_capture_id=$1 or (id=$2 and paypal_capture_id is null)`, [id, invoice]);
const findAuthorization = (tx: Tx, id: string) => tx.query<{ lease_id: string; status: string; amount_minor: string }>(
  'select lease_id,status,amount_minor from public.authorizations where paypal_authorization_id=$1', [id],
);

function matchesUsd(value: unknown, expected: string) {
  const money = objectField(value);
  return money.currency_code === 'USD' && paypalMinor(money.value) === BigInt(expected);
}

async function auditRead(tx: Tx, lease: string) {
  const { call_id } = await intent(tx, lease, 'get', randomUUID(), null);
  await sent(tx, lease, call_id);
  return loadCall(tx, lease, call_id);
}

export function webhookStore(db: Database): KernelPort {
  const reading = new Set<string>();
  return {
    async recordWebhook(id, event, verified) {
      const payload = event as { event_type: string; resource?: Json };
      const stored = await db.transaction(null, tx => one<{ event_type: string; resource: Json }>(tx, `insert into public.webhook_events as event
        (id,event_type,resource,signature_verified) values ($1,$2,$3::jsonb,$4)
        on conflict (id,signature_verified) do update set deliveries=event.deliveries+1
        returning event_type,resource`, [id, payload.event_type, JSON.stringify(verified ? payload.resource ?? null : null), verified]));
      return { id, ...stored };
    },
    async claimWebhook(id) {
      if (reading.has(id)) return 'busy';
      reading.add(id);
      try {
        const row = await db.transaction(null, tx => one<{ processed_at: Date | null }>(tx,
          'select processed_at from public.webhook_events where id=$1 and signature_verified', [id]));
        if (!row.processed_at) return 'claimed';
        reading.delete(id);
        return 'processed';
      } catch (error) { reading.delete(id); throw error; }
    },
    async releaseWebhook(id) { reading.delete(id); },
    async reconcileWebhook(eventId, resource, response, http_status = 200) {
      const evidence: ReadEvidence = { source: 'get', http_status, body: objectField(response) };
      if (!isSuccess(evidence) || evidence.body.id !== resource.id || typeof evidence.body.status !== 'string') {
        throw new ApiError('PayPal read does not match the verified resource');
      }
      const status = evidence.body.status.toLowerCase();
      const invoice = isUuid(evidence.body.invoice_id) ? evidence.body.invoice_id : null;
      const find = resource.kind === 'capture'
        ? (tx: Tx) => findCapture(tx, resource.id, invoice)
        : (tx: Tx) => findAuthorization(tx, resource.id);
      const matches = await db.transaction(null, find);
      if (matches.rows.length !== 1) throw new ApiError('PayPal resource has no unique local match');
      const lease = matches.rows[0]!.lease_id;

      // Every instance takes the lease lock first, then locks the same verified event row.
      // The PayPal GET already finished, so neither lock is held across network I/O.
      await db.transaction(lease, async tx => {
        const event = await one<{ processed_at: Date | null }>(tx,
          'select processed_at from public.webhook_events where id=$1 and signature_verified for update', [eventId]);
        if (event.processed_at) return;
        if (resource.kind === 'capture') {
          const { rows } = await findCapture(tx, resource.id, invoice);
          const capture = rows[0];
          if (rows.length !== 1 || capture?.lease_id !== lease) throw new ApiError('Capture no longer matches the lease');
          if (capture.status === status && capture.paypal_capture_id === resource.id && status !== 'pending') {
            if (!matchesUsd(evidence.body.amount, capture.amount_minor)
              || (evidence.body.invoice_id !== undefined && evidence.body.invoice_id !== capture.id)
              || (capture.fee_minor !== null && !matchesUsd(objectField(evidence.body.seller_receivable_breakdown).paypal_fee, capture.fee_minor))) {
              throw new ApiError('PayPal capture read differs from the journal');
            }
            await finish(tx, await auditRead(tx, lease), 'succeeded', evidence);
          } else {
            await resolveUnknownInTransaction(tx, lease, capture.call_id, evidence);
          }
        } else {
          const authorization = (await findAuthorization(tx, resource.id)).rows[0];
          if (authorization?.lease_id !== lease) throw new ApiError('Authorization no longer matches the lease');
          if (!matchesUsd(evidence.body.amount, authorization.amount_minor)) throw new ApiError('PayPal authorization read differs from the journal');
          if (authorization.status === status) {
            await finish(tx, await auditRead(tx, lease), 'succeeded', evidence);
          } else if (status === 'voided') {
            const call = await one<{ id: string }>(tx, `select id from public.paypal_calls
              where lease_id=$1 and op='void' and state in ('sent','unknown')`, [lease]);
            await resolveUnknownInTransaction(tx, lease, call.id, evidence);
          } else {
            const call = await auditRead(tx, lease);
            await recordAuthorizationReadInTransaction(tx, lease, call.id, evidence);
          }
        }
        await tx.query('update public.webhook_events set processed_at=clock_timestamp() where id=$1 and signature_verified', [eventId]);
      });
    },
  };
}
