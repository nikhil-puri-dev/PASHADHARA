export type RubricBand = { min_score: number; pay_bps: number };

export const providers = ['openai', 'anthropic', 'xai', 'google'] as const;
export type ProviderName = typeof providers[number];
export const verdictValues = ['pass', 'fail', 'unsure'] as const;
export type Verdict = { verdict: typeof verdictValues[number]; score: number; reasons: string[] };
export type ProviderVerdict = Verdict & { judge_provider: ProviderName; model: string };
export type Decision = {
  outcome: 'release' | 'partial' | 'void' | 'hold';
  amount_minor: bigint;
  derived_from: Record<string, number | boolean>;
};

export function deriveDecision(amount: bigint, rubric: readonly RubricBand[],
  verdicts: readonly ProviderVerdict[], precheckFailed = false): Decision {
  if (amount <= 0n) throw new Error('Job amount must be positive');
  const bands = [...rubric].sort((a, b) => a.min_score - b.min_score);
  if (!bands.length || bands.some((band, i) =>
    !Number.isInteger(band.min_score) || band.min_score < 0 || band.min_score > 100 ||
    !Number.isInteger(band.pay_bps) || band.pay_bps < 0 || band.pay_bps > 10000 ||
    (i > 0 && (band.min_score === bands[i - 1]!.min_score || band.pay_bps < bands[i - 1]!.pay_bps)))) {
    throw new Error('Invalid buyer rubric');
  }
  if (precheckFailed && verdicts.length === 0) return { outcome: 'void', amount_minor: 0n, derived_from: { precheck_failed: true } };
  const [first, second] = verdicts;
  if (verdicts.length !== 2 || !first || !second || first.judge_provider === second.judge_provider ||
    verdicts.some(v => !providers.includes(v.judge_provider) || !verdictValues.includes(v.verdict)
      || !Number.isInteger(v.score) || v.score < 0 || v.score > 100) ||
    first.verdict !== second.verdict || first.verdict === 'unsure') {
    return { outcome: 'hold', amount_minor: 0n, derived_from: {} };
  }
  if (first.verdict === 'fail') return { outcome: 'void', amount_minor: 0n, derived_from: {} };
  const minScore = Math.min(first.score, second.score);
  const payBps = bands.reverse().find(band => band.min_score <= minScore)?.pay_bps ?? 0;
  const paid = amount * BigInt(payBps) / 10000n;
  return {
    outcome: paid === 0n ? 'void' : paid === amount ? 'release' : 'partial',
    amount_minor: paid,
    derived_from: { min_score: minScore, pay_bps: payBps },
  };
}
