import { type Database, one } from './db.ts';
import { deliverableHash, deriveDecision, type Judgment, type ProviderVerdict, type RubricBand } from '../judge/index.ts';
import { returnUnpaid } from './usage.ts';

export function recordDelivery(db: Database, lease: string, job: string, text: string) {
  const hash = deliverableHash(text);
  return db.transaction(lease, async tx => {
    const row = await one<{ state: string; deliverable_hash: string | null }>(tx,
      'select state,deliverable_hash from public.jobs where lease_id=$1 and id=$2 for update', [lease, job]);
    if (row.state === 'delivered' && row.deliverable_hash === hash) return hash;
    if (row.state !== 'open') throw new Error('Job is not open for delivery');
    await tx.query("update public.jobs set state='delivered',deliverable_hash=$2 where id=$1", [job, hash]);
    return hash;
  });
}

export async function recordJudgment(db: Database, lease: string, job: string, round: number, judgment: Judgment) {
  if (!Number.isInteger(round) || round < 1 || round > 3) throw new Error('Invalid judgment round');
  if (judgment.job_id !== job) throw new Error('Judgment is for a different job');
  if (judgment.status !== 'evaluated' && judgment.verdicts.length > 0) throw new Error('Prechecks or budget stopped provider evaluation');
  return db.transaction(lease, async tx => {
    const row = await one<{ state: string; deliverable_hash: string; amount_minor: string; rubric: RubricBand[]; same_acceptance: boolean }>(tx,
      `select state,deliverable_hash,amount_minor,rubric,acceptance=$3::jsonb as same_acceptance
        from public.jobs where lease_id=$1 and id=$2 for update`, [lease, job, JSON.stringify(judgment.acceptance)]);
    if (!row.same_acceptance) throw new Error('Judgment acceptance differs from the buyer terms');
    if (row.deliverable_hash !== judgment.deliverable_hash || !['delivered', 'held', 'judging'].includes(row.state)) {
      throw new Error('Job is not judging this deliverable');
    }
    const previous = await tx.query<ProviderVerdict & { round: number }>(
      'select round,judge_provider,model,verdict,score,reasons from public.verdicts where job_id=$1 order by round desc',
      [job],
    );
    const latestRound = previous.rows[0]?.round ?? 0;
    if (round < latestRound || round > latestRound + 1) throw new Error('Judgment round does not follow stored verdicts');

    await tx.query("update public.jobs set state='judging' where id=$1", [job]);
    for (const verdict of judgment.verdicts) {
      const stored = previous.rows.find(v => v.round === round && v.judge_provider === verdict.judge_provider);
      if (stored) {
        if (stored.verdict !== verdict.verdict || stored.score !== verdict.score || stored.model !== verdict.model ||
          JSON.stringify(stored.reasons) !== JSON.stringify(verdict.reasons)) {
          throw new Error('A provider already judged this round');
        }
        continue;
      }
      await tx.query(`insert into public.verdicts (job_id,round,judge_provider,model,verdict,score,reasons)
        values ($1,$2,$3,$4,$5,$6,$7)`,
      [job, round, verdict.judge_provider, verdict.model, verdict.verdict, verdict.score, JSON.stringify(verdict.reasons)]);
    }
    const decisionRound = judgment.verdicts.length ? round : latestRound;
    const verdicts = await tx.query<ProviderVerdict>(`select judge_provider,model,verdict,score,reasons
      from public.verdicts where job_id=$1 and round=$2`, [job, decisionRound]);
    const decision = deriveDecision(BigInt(row.amount_minor), row.rubric, verdicts.rows,
      judgment.status === 'precheck_failed' && latestRound === 0);
    const saved = await one<{ id: string; round: number }>(tx, `insert into public.decisions
      (lease_id,job_id,outcome,amount_minor,derived_from) values ($1,$2,$3,$4,$5) returning id,round`,
    [lease, job, decision.outcome, decision.amount_minor, JSON.stringify(decision.derived_from)]);
    const state = decision.outcome === 'hold' ? 'held' : decision.outcome === 'void' ? 'voided' : 'decided';
    await tx.query('update public.jobs set state=$2 where id=$1', [job, state]);
    if (decision.outcome !== 'hold') await returnUnpaid(tx, lease, job);
    return { ...saved, ...decision };
  });
}
