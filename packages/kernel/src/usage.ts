import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { type Database, type JsonObject, one, type Tx } from './db.ts';
import { balances, post } from './journal.ts';
import type { RubricBand } from '../judge/decision.ts';

export type JobUsage = { kind: 'job'; job_id?: string; seller_id: string; amount_minor: bigint; rubric: readonly RubricBand[]; acceptance?: JsonObject };
export type ToolUsage = { kind: 'tool'; tool_id: string; idempotency_key: string };
type UsageStatus = 'served' | 'refused_cap' | 'refused_exposure' | 'refused_window' | 'refused_inactive';
export type UsageResult = { id: string | null; status: UsageStatus; amount_minor: bigint; ledger_group_id: string | null; replayed: boolean };

export function commitUsage(db: Database, lease: string, usage: ToolUsage | JobUsage): Promise<UsageResult> {
  return db.transaction(lease, tx => commitUsageInTransaction(tx, lease, usage));
}

/** The caller holds the lease lock and owns any nonce validation, commit and rollback. */
export async function commitUsageInTransaction(
  tx: PoolClient, leaseId: string, usage: ToolUsage | JobUsage,
): Promise<UsageResult> {
  const id = usage.kind === 'job' ? usage.job_id ?? randomUUID() : randomUUID();
  let amount: bigint;
  let active = true;
  if (usage.kind === 'tool') {
    const prior = (await tx.query<{ id: string; tool_id: string; price_minor: string; status: UsageStatus; ledger_group_id: string | null }>(
      'select * from public.tool_calls where lease_id=$1 and idempotency_key=$2', [leaseId, usage.idempotency_key],
    )).rows[0];
    if (prior) {
      if (prior.tool_id !== usage.tool_id) throw new Error('Idempotency key belongs to a different tool');
      return { id: prior.id, status: prior.status, amount_minor: BigInt(prior.price_minor), ledger_group_id: prior.ledger_group_id, replayed: true };
    }
    const tool = await one<{ active: boolean; price_minor: string }>(
      tx, 'select active,price_minor from public.tools where id=$1', [usage.tool_id],
    );
    active = tool.active;
    amount = BigInt(tool.price_minor);
  } else {
    amount = usage.amount_minor;
  }
  const { status } = await checkUsage(tx, leaseId, amount, active);

  if (usage.kind === 'job' && status !== 'served') {
    return { id: null, status, amount_minor: amount, ledger_group_id: null, replayed: false };
  }
  if (usage.kind === 'job') {
    await tx.query(`insert into public.jobs (id,lease_id,seller_id,amount_minor,rubric,acceptance)
      values ($1,$2,$3,$4,$5,$6)`, [id, leaseId, usage.seller_id, amount, JSON.stringify(usage.rubric), JSON.stringify(usage.acceptance ?? {})]);
  }
  const group = status === 'served' ? await post(tx, leaseId, 'commit', id, amount) : null;
  if (usage.kind === 'tool') {
    await tx.query(`insert into public.tool_calls (id,lease_id,tool_id,idempotency_key,price_minor,status,ledger_group_id)
      values ($1,$2,$3,$4,$5,$6,$7)`, [id, leaseId, usage.tool_id, usage.idempotency_key, amount, status, group]);
  }
  return { id, status, amount_minor: amount, ledger_group_id: group, replayed: false };
}

export function previewUsage(db: Database, leaseId: string, amount: bigint) {
  return db.transaction(leaseId, tx => checkUsage(tx, leaseId, amount, true));
}

async function checkUsage(tx: Tx, leaseId: string, amount: bigint, active: boolean) {
  if (amount <= 0n) throw new Error('Usage amount must be positive');

  const limits = await one<{ state: string; unsettled_limit_minor: string; within_window: boolean; voiding: boolean }>(tx, `select
    l.state, l.unsettled_limit_minor,
    exists(select 1 from public.authorizations a where a.lease_id=l.id and a.status in ('created','partially_captured')
      and a.honor_until>clock_timestamp()) as within_window,
    exists(select 1 from public.paypal_calls p where p.lease_id=l.id and p.op='void'
      and p.state in ('intent','sent','unknown')) as voiding
    from public.leases l where l.id=$1`, [leaseId]);
  const { hold, committed } = await balances(tx, leaseId);
  const status: UsageStatus = !active ? 'refused_inactive'
    : limits.state !== 'active' || !limits.within_window || limits.voiding ? 'refused_window'
    : amount > hold ? 'refused_cap'
    : amount + committed > BigInt(limits.unsettled_limit_minor) ? 'refused_exposure' : 'served';
  return { status, hold };

}

export async function returnUnpaid(tx: Tx, lease: string, job: string) {
  const row = await one<{ amount: string }>(tx, `select j.amount_minor - coalesce(
    (select d.amount_minor from public.decisions d where d.job_id=j.id and d.outcome in ('release','partial')),0) as amount
    from public.jobs j where j.id=$1 and j.lease_id=$2`, [job, lease]);
  const amount = BigInt(row.amount);
  if (amount > 0n) await post(tx, lease, 'return', job, amount);
  return amount;
}

export function cancelJob(db: Database, lease: string, job: string) {
  return db.transaction(lease, async tx => {
    const row = await one<{ state: string; paying: boolean }>(tx, `select j.state,
      exists(select 1 from public.decisions d where d.job_id=j.id and d.outcome in ('release','partial')) as paying
      from public.jobs j where j.lease_id=$1 and j.id=$2 for update`, [lease, job]);
    if (row.state === 'voided') return 0n;
    if (row.paying) throw new Error('A paying job cannot be cancelled as an unpaid reserve');
    await tx.query("update public.jobs set state='voided' where id=$1", [job]);
    return returnUnpaid(tx, lease, job);
  });
}
