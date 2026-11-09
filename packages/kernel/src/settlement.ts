export type SettlementState = {
  // Only eligible, unallocated committed usage belongs in this batch.
  capturable_minor: bigint;
  committed_unsettled_minor: bigint;
  unsettled_limit_minor: bigint;
  fee_target_bps: bigint;
  exposure_trigger_bps: bigint;
  honor_until: Date;
  now: Date;
  closing: boolean;
};

export type SettlementPlan = {
  amount_minor: bigint;
  reason: 'fee_target' | 'exposure_limit' | 'honor_window' | 'closing';
};

const basis = 10000n;
export const estimatedPayPalFee = (amount: bigint) => 49n + (amount * 349n + basis / 2n) / basis;

export function planSettlement(state: SettlementState): SettlementPlan | null {
  const amount = state.capturable_minor;
  const timeLeft = state.honor_until.getTime() - state.now.getTime();
  if (amount < 0n || amount > state.committed_unsettled_minor || state.committed_unsettled_minor < 0n ||
    state.unsettled_limit_minor < 0n || state.fee_target_bps < 0n || state.fee_target_bps > basis ||
    state.exposure_trigger_bps <= 0n || state.exposure_trigger_bps > basis || !Number.isFinite(timeLeft)) {
    throw new Error('Invalid settlement state');
  }
  if (amount === 0n) return null;
  if (state.closing) return { amount_minor: amount, reason: 'closing' };
  if (state.committed_unsettled_minor * basis >= state.unsettled_limit_minor * state.exposure_trigger_bps) {
    return { amount_minor: amount, reason: 'exposure_limit' };
  }
  if (timeLeft <= 4 * 60 * 60 * 1000) return { amount_minor: amount, reason: 'honor_window' };
  if (estimatedPayPalFee(amount) * basis <= amount * state.fee_target_bps) {
    return { amount_minor: amount, reason: 'fee_target' };
  }
  return null;
}
