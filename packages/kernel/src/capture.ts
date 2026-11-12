import { randomUUID } from 'node:crypto';
import { type Database, one, type Tx } from './db.ts';
import { finish, intent, isSuccess, loadCall, objectField, paypalMinor, stringField, type Evidence, type ReadEvidence } from './calls.ts';
import { post } from './journal.ts';

type Capture = {
  id: string; call_id: string; authorization_id: string; amount_minor: string;
  paypal_capture_id: string | null; status: 'intent' | 'pending' | 'unknown' | 'completed' | 'declined' | 'denied' | 'reversed';
};
type BeginCapture = {
  authorization_id: string;
  decision_id?: string;
  request_id?: string;
  allocations: readonly { ref_id: string; amount_minor: bigint }[];
};

export function beginCapture(db: Database, lease: string, input: BeginCapture) {
  return db.transaction(lease, tx => beginCaptureInTransaction(tx, lease, input));
}

/** The caller already holds the lease lock. */
export async function beginCaptureInTransaction(tx: Tx, lease: string, input: BeginCapture) {
  const request = input.request_id ?? randomUUID();
  const amount = input.allocations.reduce((total, line) => total + line.amount_minor, 0n);
    await one(tx, `select id from public.authorizations where lease_id=$1 and id=$2
      and status in ('created','partially_captured') and expires_at>clock_timestamp()`, [lease, input.authorization_id]);
    const call = await intent(tx, lease, 'capture', request, amount);
    const capture = await one<{ id: string }>(tx, `insert into public.captures
      (lease_id, authorization_id, call_id, decision_id, amount_minor, status)
      values ($1,$2,$3,$4,$5,'intent') returning id`,
    [lease, input.authorization_id, call.call_id, input.decision_id ?? null, amount]);
    await tx.query(`insert into public.capture_allocations (capture_id, lease_id, ref_id, amount_minor)
      select $1,$2,ref_id,amount_minor from jsonb_to_recordset($3::jsonb) as x(ref_id text, amount_minor bigint)`,
    [capture.id, lease, JSON.stringify(input.allocations.map(line => ({ ...line, amount_minor: line.amount_minor.toString() })))]);
    return { ...call, capture_id: capture.id, invoice_id: capture.id, amount_minor: amount };
}

function findCapture(tx: Tx, lease: string, id: string) {
  return one<Capture>(tx, 'select * from public.captures where lease_id=$1 and id=$2', [lease, id]);
}

function checkId(capture: Capture, evidence: Evidence) {
  const id = stringField(evidence.body.id);
  if (capture.paypal_capture_id !== null && capture.paypal_capture_id !== id) {
    throw new Error('PayPal capture evidence names a different capture');
  }
  return id;
}

export async function settleCapture(tx: Tx, lease: string, capture: Capture, evidence: Evidence) {
  const call = await loadCall(tx, lease, capture.call_id);
  if (call.state === 'unknown' && (!('source' in evidence) || evidence.source !== 'get')) {
    throw new Error('An unknown capture needs a fresh PayPal GET');
  }
  const status = evidence.body.status;
  const amount = BigInt(capture.amount_minor);
  if (isSuccess(evidence) && (status === 'PENDING' || status === 'COMPLETED' || status === 'DECLINED' || status === 'DENIED')) {
    const id = checkId(capture, evidence);
    if ((('source' in evidence && capture.paypal_capture_id === null) || evidence.body.invoice_id !== undefined)
      && evidence.body.invoice_id !== capture.id) {
      throw new Error('PayPal capture invoice does not match its intent');
    }
    const reported = objectField(evidence.body.amount);
    if (reported.currency_code !== 'USD' || paypalMinor(reported.value) !== amount) {
      throw new Error('PayPal capture amount does not match its intent');
    }
    if (status === 'PENDING') {
      if (capture.status === 'unknown') {
        await tx.query('update public.captures set paypal_capture_id=$2 where id=$1', [capture.id, id]);
        return 'unknown';
      }
      if (call.state !== 'sent') throw new Error('Capture is not sent');
      await tx.query("update public.captures set status='pending',paypal_capture_id=$2 where id=$1", [capture.id, id]);
      return 'pending';
    }
    await finish(tx, call, 'succeeded', evidence);
    if (status === 'COMPLETED') {
      const feeData = objectField(objectField(evidence.body.seller_receivable_breakdown).paypal_fee);
      const fee = paypalMinor(feeData.value);
      if (feeData.currency_code !== 'USD' || fee > amount) throw new Error('Invalid PayPal capture fee');
      await tx.query(`update public.captures set status='completed',paypal_capture_id=$2,fee_minor=$3,
        settled_at=clock_timestamp() where id=$1`, [capture.id, id, fee]);
      await post(tx, lease, 'capture', capture.id, amount, null, fee);
      await tx.query(`update public.authorizations a set status=case when a.amount_minor =
        (select sum(c.amount_minor) from public.captures c where c.authorization_id=a.id and c.status in ('completed','reversed'))
        then 'captured' else 'partially_captured' end where a.id=$1`, [capture.authorization_id]);
      return 'completed';
    }
    const failed = status === 'DECLINED' ? 'declined' : 'denied';
    await writeoff(tx, lease, capture, failed, id);
    return failed;
  }
  const details = evidence.body.details;
  const decline = evidence.http_status === 422 && Array.isArray(details) && details.length === 1
    && ['INSTRUMENT_DECLINED', 'PAYMENT_DENIED', 'AUTHORIZATION_VOIDED', 'AUTHORIZATION_EXPIRED']
      .includes(String(objectField(details[0]).issue));
  if (!decline || 'source' in evidence || capture.paypal_capture_id !== null) {
    throw new Error('PayPal evidence does not establish a terminal capture result');
  }
  await finish(tx, call, 'failed', evidence);
  await writeoff(tx, lease, capture, 'declined', null);
  return 'declined';
}

async function writeoff(tx: Tx, lease: string, capture: Capture, status: 'declined' | 'denied', id: string | null) {
  await tx.query(`update public.captures set status=$2,paypal_capture_id=coalesce($3,paypal_capture_id),
    settled_at=clock_timestamp() where id=$1`, [capture.id, status, id]);
  await post(tx, lease, 'writeoff', capture.id, BigInt(capture.amount_minor));
}

export function completeCapture(db: Database, lease: string, id: string, evidence: Evidence) {
  if (!isSuccess(evidence) || evidence.body.status !== 'COMPLETED') throw new Error('Expected a completed PayPal capture');
  return db.transaction(lease, async tx => settleCapture(tx, lease, await findCapture(tx, lease, id), evidence));
}

export function failCapture(db: Database, lease: string, id: string, evidence: Evidence) {
  if (isSuccess(evidence) && evidence.body.status !== 'DECLINED' && evidence.body.status !== 'DENIED') {
    throw new Error('Expected a declined or denied PayPal capture');
  }
  return db.transaction(lease, async tx => settleCapture(tx, lease, await findCapture(tx, lease, id), evidence));
}

export function recordPendingCapture(db: Database, lease: string, id: string, evidence: Evidence) {
  if (evidence.body.status !== 'PENDING') throw new Error('Expected a pending PayPal capture');
  return db.transaction(lease, async tx => settleCapture(tx, lease, await findCapture(tx, lease, id), evidence));
}

export async function resolveCaptureRead(tx: Tx, lease: string, callId: string, evidence: ReadEvidence) {
  const capture = await one<Capture>(tx, 'select * from public.captures where lease_id=$1 and call_id=$2', [lease, callId]);
  return settleCapture(tx, lease, capture, evidence);
}

export function reverseCapture(db: Database, lease: string, id: string, readCallId: string, evidence: ReadEvidence) {
  return db.transaction(lease, async tx => {
    const capture = await findCapture(tx, lease, id);
    const audit = await loadCall(tx, lease, readCallId);
    if (audit.op !== 'get' || evidence.source !== 'get' || capture.status !== 'completed'
      || !isSuccess(evidence) || evidence.body.status !== 'REFUNDED') {
      throw new Error('A reversal needs a completed capture and a fresh full-refund GET');
    }
    checkId(capture, evidence);
    const reported = objectField(evidence.body.amount);
    if (reported.currency_code !== 'USD' || paypalMinor(reported.value) !== BigInt(capture.amount_minor)) {
      throw new Error('Reversal evidence does not match capture amount');
    }
    await finish(tx, audit, 'succeeded', evidence);
    await tx.query("update public.captures set status='reversed' where id=$1", [id]);
    await post(tx, lease, 'reversal', id, BigInt(capture.amount_minor));
    // One immutable clawback per seller/capture. Defer when payment attribution is uncertain.
    const sellers = await tx.query<{ seller_id: string; amount: string }>(`select a.seller_id,sum(a.earned_minor) as amount
      from public.allocation_earnings a where a.lease_id=$1 and a.capture_id=$2
      group by a.seller_id having not bool_or(exists (
        select 1 from public.payouts p where p.lease_id=$1 and p.seller_id=a.seller_id
          and p.state in ('sent','unknown','success')
          and (p.decision_id::text=a.accrual_ref or (p.source='metered' and a.accrual_ref=a.ref_id))
      )) and sum(a.earned_minor) <= coalesce((
        select sum(case l.direction when 'C' then l.amount_minor else -l.amount_minor end)
        from public.ledger_entries l where l.lease_id=$1 and l.account='SELLER_PAYABLE' and l.seller_id=a.seller_id
      ),0) - coalesce((select sum(p.amount_minor) from public.payouts p
        where p.lease_id=$1 and p.seller_id=a.seller_id and p.state in ('sent','unknown')),0)`, [lease, id]);
    for (const seller of sellers.rows) {
      const amount = BigInt(seller.amount);
      if (amount > 0n) await post(tx, lease, 'clawback', id, amount, seller.seller_id);
    }
  });
}
