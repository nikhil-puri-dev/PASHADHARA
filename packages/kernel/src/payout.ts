import { randomUUID } from 'node:crypto';
import { type Database, one, type Tx } from './db.ts';
import { finish, intent, isSuccess, loadCall, objectField, paypalMinor, sent, stringField, type Call, type ReadEvidence } from './calls.ts';
import { post } from './journal.ts';

type PayoutSource = { source: 'job'; decision_id: string } | { source: 'metered' };
type Payout = { id: string; state: string; amount_minor: string; seller_id: string; receiver_email: string; call_id: string | null };

export function accrueSeller(db: Database, lease: string, accrualRef: string) {
  return db.transaction(lease, async tx => {
    const ref = await one<{ usage_ref: string; seller_id: string; collectible: string }>(tx, `select d.job_id::text as usage_ref,j.seller_id,d.amount_minor as collectible
      from public.decisions d join public.jobs j on j.id=d.job_id
      where d.id=$2 and d.lease_id=$1 and d.outcome in ('release','partial')
      union all
      select t.id::text,u.seller_id,t.price_minor from public.tool_calls t join public.tools u on u.id=t.tool_id
      where t.id=$2 and t.lease_id=$1 and t.status='served'`, [lease, accrualRef]);
    const row = await one<{ amount: string; allocated: string; accrued: boolean }>(tx, `select
      coalesce((select sum(net_minor) from public.allocation_nets where lease_id=$1 and ref_id=$2),0) as amount,
      coalesce((select sum(amount_minor) from public.capture_allocations where lease_id=$1 and ref_id=$2),0) as allocated,
      exists(select 1 from public.ledger_entries where lease_id=$1 and ref_id=$3 and ref_type='accrue') as accrued`,
    [lease, ref.usage_ref, accrualRef]);
    const amount = BigInt(row.amount);
    if (BigInt(row.allocated) !== BigInt(ref.collectible)) throw new Error('Settle the remaining amount before accruing this source');
    await tx.query('select public.validate_accrual($1,$2,$3)', [lease, accrualRef, amount]);
    if (amount > 0n && !row.accrued) await post(tx, lease, 'accrue', accrualRef, amount, ref.seller_id);
    return { seller_id: ref.seller_id, amount_minor: amount };
  });
}

export function queuePayout(db: Database, lease: string, input: PayoutSource & {
  seller_id: string; amount_minor: bigint; release_at?: Date;
}) {
  return db.transaction(lease, tx => one<{ id: string; release_at: Date }>(tx, `insert into public.payouts
    (lease_id,seller_id,source,decision_id,amount_minor,state,release_at)
    select $1,s.id,$3,$4,$5,'queued',greatest($6::timestamptz,clock_timestamp()+make_interval(secs=>s.payout_hold_seconds))
    from public.sellers s where s.id=$2 returning id,release_at`,
  [lease, input.seller_id, input.source, input.source === 'job' ? input.decision_id : null, input.amount_minor, input.release_at ?? null]));
}

export function beginPayout(db: Database, lease: string, payout: string, request: string = randomUUID()) {
  return db.transaction(lease, async tx => {
    const row = await one<Payout>(tx, "select * from public.payouts where lease_id=$1 and id=$2 and state='queued' and call_id is null", [lease, payout]);
    const call = await intent(tx, lease, 'payout', request, BigInt(row.amount_minor));
    await tx.query('update public.payouts set call_id=$2 where id=$1', [payout, call.call_id]);
    return call;
  });
}

export function sendPayout(db: Database, lease: string, payout: string) {
  return db.transaction(lease, async tx => sendPayoutInTransaction(
    tx, lease, await one<Payout>(tx, 'select * from public.payouts where lease_id=$1 and id=$2', [lease, payout]),
  ));
}

/** Create and claim a due payout intent in the same lease transaction. */
export function claimDuePayout(db: Database, lease: string, payout: string) {
  return db.transaction(lease, async tx => {
    const row = (await tx.query<Payout>(`select * from public.payouts where lease_id=$1 and id=$2
      and state='queued' and held_at is null and release_at<=now()`, [lease, payout])).rows[0];
    if (!row) return null;
    if (!row.call_id) {
      const call = await intent(tx, lease, 'payout', randomUUID(), BigInt(row.amount_minor));
      await tx.query('update public.payouts set call_id=$2 where id=$1', [payout, call.call_id]);
      row.call_id = call.call_id;
    }
    return sendPayoutInTransaction(tx, lease, row);
  });
}

async function sendPayoutInTransaction(tx: Tx, lease: string, row: Payout) {
  if (row.state !== 'queued' || !row.call_id || !await sent(tx, lease, row.call_id)) return null;
  await tx.query("update public.payouts set state='sent' where id=$1", [row.id]);
  const call = await loadCall(tx, lease, row.call_id);
  return { receiver_email: row.receiver_email, amount_minor: BigInt(row.amount_minor), call_id: row.call_id, request_id: call.request_id };
}

export async function finishPayout(tx: Tx, lease: string, call: Call, evidence: ReadEvidence) {
  if (call.op !== 'payout' || evidence.source !== 'get' || !isSuccess(evidence)) throw new Error('Expected PayPal payout batch GET evidence');
  const row = await one<Payout>(tx, 'select * from public.payouts where lease_id=$1 and call_id=$2', [lease, call.id]);
  const header = objectField(evidence.body.batch_header);
  const status = header.batch_status;
  const batch = stringField(header.payout_batch_id);
  const amount = objectField(header.amount);
  if (objectField(header.sender_batch_header).sender_batch_id !== call.request_id ||
    amount.currency !== 'USD' || paypalMinor(amount.value) !== BigInt(row.amount_minor)) {
    throw new Error('GET evidence names a different payout');
  }
  if (status !== 'SUCCESS' && status !== 'DENIED' && status !== 'CANCELED') {
    throw new Error('PayPal payout batch has no terminal result');
  }
  let paid = false;
  if (status === 'SUCCESS') {
    const items = evidence.body.items;
    if (!Array.isArray(items) || items.length !== 1) throw new Error('Expected exactly one PayPal payout item');
    const item = objectField(items[0]);
    const request = objectField(item.payout_item);
    const money = objectField(request.amount);
    if (item.payout_batch_id !== batch || request.sender_item_id !== call.request_id ||
      request.receiver !== row.receiver_email || money.currency !== 'USD' || paypalMinor(money.value) !== BigInt(row.amount_minor)) {
      throw new Error('GET evidence names a different payout item');
    }
    if (!['SUCCESS', 'FAILED', 'RETURNED'].includes(String(item.transaction_status))) throw new Error('PayPal payout item has no terminal result');
    paid = item.transaction_status === 'SUCCESS';
  }
  await finish(tx, call, paid ? 'succeeded' : 'failed', evidence);
  if (paid) {
    await tx.query("update public.payouts set state='success',paypal_batch_id=$2 where id=$1", [row.id, batch]);
    await post(tx, lease, 'payout', row.id, BigInt(row.amount_minor), row.seller_id);
  } else {
    await tx.query("update public.payouts set state='failed' where id=$1", [row.id]);
  }
}

export function completePayout(db: Database, lease: string, callId: string, evidence: ReadEvidence) {
  return db.transaction(lease, async tx => finishPayout(tx, lease, await loadCall(tx, lease, callId), evidence));
}

/** Several readers can reconcile a known batch, but only one posts its terminal result. */
export function reconcileSentPayout(db: Database, lease: string, callId: string, evidence: ReadEvidence) {
  return db.transaction(lease, async tx => {
    const call = await loadCall(tx, lease, callId);
    if (call.state === 'sent' || call.state === 'unknown') await finishPayout(tx, lease, call, evidence);
  });
}
