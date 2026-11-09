import { randomUUID } from 'node:crypto';
import { one, type Tx } from './db.ts';

const pairs = {
  authorize: ['HOLD_AVAILABLE', 'BUYER_COMMITMENT'],
  commit: ['COMMITTED_UNSETTLED', 'HOLD_AVAILABLE'],
  capture: ['CAPTURED_GROSS', 'COMMITTED_UNSETTLED'],
  accrue: ['SELLER_COST', 'SELLER_PAYABLE'],
  payout: ['SELLER_PAYABLE', 'CAPTURED_GROSS'],
  return: ['HOLD_AVAILABLE', 'COMMITTED_UNSETTLED'],
  void: ['RELEASED', 'HOLD_AVAILABLE'],
  writeoff: ['WRITTEN_OFF', 'COMMITTED_UNSETTLED'],
  reversal: ['CHARGEBACK_LOSS', 'CAPTURED_GROSS'],
  clawback: ['SELLER_PAYABLE', 'SELLER_COST'],
} as const;
type Posting = keyof typeof pairs;

export async function post(db: Tx, lease: string, kind: Posting, ref: string, amount: bigint,
  seller: string | null = null, fee: bigint = 0n) {
  const id = randomUUID();
  const [debit, credit] = pairs[kind];
  const lines: { account: string; direction: 'D' | 'C'; amount: string; seller: string | null }[] = [
    { account: debit, direction: 'D', amount: amount.toString(), seller: debit.startsWith('SELLER_') ? seller : null },
    { account: credit, direction: 'C', amount: amount.toString(), seller: credit.startsWith('SELLER_') ? seller : null },
  ];
  if (fee > 0n) lines.push(
    { account: 'PAYPAL_FEES', direction: 'D', amount: fee.toString(), seller: null },
    { account: 'CAPTURED_GROSS', direction: 'C', amount: fee.toString(), seller: null },
  );
  await db.query(`insert into public.ledger_entries
    (group_id, lease_id, account, direction, amount_minor, seller_id, ref_type, ref_id)
    select $1,$2,account,direction,amount,seller,$3,$4
    from jsonb_to_recordset($5::jsonb) as x(account public.ledger_account, direction char(1), amount bigint, seller uuid)`,
  [id, lease, kind, ref, JSON.stringify(lines)]);
  return id;
}

export async function balances(db: Tx, lease: string) {
  const row = await one<{ hold: string; committed: string }>(db, `select
    coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end)
      filter (where account='HOLD_AVAILABLE'), 0) as hold,
    coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end)
      filter (where account='COMMITTED_UNSETTLED'), 0) as committed
    from public.ledger_entries where lease_id=$1`, [lease]);
  return { hold: BigInt(row.hold), committed: BigInt(row.committed) };
}
