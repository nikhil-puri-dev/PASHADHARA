import type { PoolClient } from 'pg';
import { type Database, type JsonObject, one } from './db.ts';
import { finish, isSuccess, loadCall, objectField, sent, type Evidence, type ReadEvidence } from './calls.ts';
import { resolveCaptureRead } from './capture.ts';
import { finishVoid } from './lease.ts';
import { finishPayout } from './payout.ts';

export function markCallSent(db: Database, lease: string, callId: string) {
  return db.transaction(lease, async tx => {
    const call = await loadCall(tx, lease, callId);
    if (call.op === 'payout') throw new Error('Use sendPayout to validate and send a queued payout');
    return sent(tx, lease, callId);
  });
}

export function markUnknown(db: Database, lease: string, callId: string) {
  return db.transaction(lease, async tx => {
    const call = await loadCall(tx, lease, callId);
    if (call.state === 'unknown') return false;
    if (call.state !== 'sent') throw new Error('Only a sent PayPal call can time out');
    await tx.query("update public.paypal_calls set state='unknown' where id=$1", [callId]);
    if (call.op === 'capture') await tx.query("update public.captures set status='unknown' where call_id=$1", [callId]);
    if (call.op === 'payout') await tx.query("update public.payouts set state='unknown' where call_id=$1", [callId]);
    return true;
  });
}

/** Record definitive direct rejections only. Transport failures must be marked unknown. */
export function recordRejectedCall(db: Database, lease: string, callId: string, evidence: Evidence) {
  return db.transaction(lease, async tx => {
    const call = await loadCall(tx, lease, callId);
    const details = evidence.body.details;
    const issue = Array.isArray(details) && details.length === 1 ? objectField(details[0]).issue : undefined;
    const validation = evidence.http_status === 400 && evidence.body.name === 'INVALID_REQUEST';
    const rejection = evidence.http_status === 422 && (
      (call.op === 'reauthorize' && issue === 'REAUTHORIZATION_TOO_SOON') ||
      (call.op === 'authorize' && issue === 'ORDER_NOT_APPROVED') ||
      (call.op === 'void' && (issue === 'AUTHORIZATION_ALREADY_CAPTURED' || issue === 'AUTHORIZATION_EXPIRED'))
    );
    const failedRead = call.op === 'get' && [400, 401, 403, 404].includes(evidence.http_status);
    if (call.state !== 'sent' || 'source' in evidence ||
      (!failedRead && (['capture', 'payout', 'get'].includes(call.op) || (!validation && !rejection)))) {
      throw new Error('Response does not establish a definitive direct rejection');
    }
    await finish(tx, call, 'failed', evidence);
  });
}

/** Rails supplies a fresh GET tied to the original operation. A resource id learned from a webhook alone is insufficient. */
export function resolveUnknown(db: Database, lease: string, callId: string, evidence: ReadEvidence) {
  return db.transaction(lease, tx => resolveRead(tx, lease, callId, evidence));
}

/** The caller holds the lease lock and owns commit and rollback. Only terminal evidence can finish a webhook. */
export async function resolveUnknownInTransaction(
  tx: PoolClient, leaseId: string, callId: string, evidence: ReadEvidence,
): Promise<void> {
  await resolveRead(tx, leaseId, callId, evidence, true);
}

async function resolveRead(tx: PoolClient, lease: string, callId: string, evidence: ReadEvidence, terminalOnly = false) {
  if (evidence.source !== 'get') throw new Error('Resolution requires a PayPal GET');
  const call = await loadCall(tx, lease, callId);
  if (call.state !== 'unknown' && call.state !== 'sent') throw new Error('Call is not awaiting reconciliation');
  switch (call.op) {
    case 'capture':
      if (terminalOnly && evidence.body.status === 'PENDING') throw new Error('PayPal read has no terminal capture result');
      return resolveCaptureRead(tx, lease, callId, evidence);
    case 'reauthorize': throw new Error('Cannot correlate a replacement authorization GET to this intent');
    case 'void': return finishVoid(tx, lease, call, evidence);
    case 'payout': return finishPayout(tx, lease, call, evidence);
    default: throw new Error('Use the order or authorization recorder for approval evidence');
  }
}

export function recordAuthorizationRead(db: Database, lease: string, callId: string, evidence: ReadEvidence) {
  return db.transaction(lease, tx => recordAuthorizationReadInTransaction(tx, lease, callId, evidence));
}

/** Use the same lease-first transaction as the webhook claim. */
export async function recordAuthorizationReadInTransaction(
  tx: PoolClient, leaseId: string, callId: string, evidence: ReadEvidence,
): Promise<void> {
  const call = await loadCall(tx, leaseId, callId);
  if (call.op !== 'get' || evidence.source !== 'get' || !isSuccess(evidence)) throw new Error('Expected successful authorization GET evidence');
  const status = evidence.body.status;
  if (status !== 'EXPIRED' && status !== 'DENIED') throw new Error('Use the corresponding money operation to record other authorization states');
  const auth = await one<{ id: string }>(tx, 'select id from public.authorizations where lease_id=$1 and paypal_authorization_id=$2',
    [leaseId, evidence.body.id]);
  const open = await tx.query(`select 1 from public.paypal_calls
    where lease_id=$1 and op in ('capture','reauthorize','void') and state in ('intent','sent','unknown')`, [leaseId]);
  if (open.rowCount) throw new Error('Resolve the outstanding money operation before applying the authorization read');
  await finish(tx, call, 'succeeded', evidence);
  await tx.query('update public.authorizations set status=$2 where id=$1', [auth.id, status.toLowerCase()]);
  await tx.query("update public.leases set state=$2 where id=$1 and state in ('active','pending_approval')",
    [leaseId, status === 'EXPIRED' ? 'expired' : 'failed']);
}

export function recordWebhookEvent(db: Database, input: {
  id: string; event_type: string; resource: JsonObject; signature_verified: boolean; source?: 'webhook' | 'poll';
}) {
  // Deliveries can reference objects that have no local lease.
  return db.transaction(null, tx => one<{ deliveries: number; eligible: boolean; processed: boolean }>(tx, `insert into public.webhook_events as event
    (id,event_type,resource,signature_verified,source) values ($1,$2,$3,$4,$5)
    on conflict (id,signature_verified) do update set deliveries=event.deliveries+1
    returning deliveries,
      signature_verified and event_type=$2 and resource=$3::jsonb as eligible,
      processed_at is not null as processed`,
  [input.id, input.event_type, JSON.stringify(input.resource), input.signature_verified, input.source ?? 'webhook']));
}
