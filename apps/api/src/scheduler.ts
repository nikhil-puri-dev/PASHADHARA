import { planSettlement, type SettlementPlan, type SettlementState } from '../../../packages/kernel/src/settlement.ts';

type Candidate = { leaseId: string; state: SettlementState };
type Result = { leaseId: string; planned: boolean; dispatched: boolean; error?: string };

/** The executor must re-read and lock the lease before writing any capture intent. */
export async function runSettlementSchedule(
  candidates: readonly Candidate[],
  execute: (leaseId: string, plan: SettlementPlan) => Promise<void>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const candidate of candidates) {
    let planned = false;
    try {
      const plan = planSettlement(candidate.state);
      if (!plan) { results.push({ leaseId: candidate.leaseId, planned: false, dispatched: false }); continue; }
      planned = true;
      await execute(candidate.leaseId, plan);
      results.push({ leaseId: candidate.leaseId, planned: true, dispatched: true });
    } catch {
      results.push({ leaseId: candidate.leaseId, planned, dispatched: false, error: 'Settlement failed' });
    }
  }
  return results;
}
