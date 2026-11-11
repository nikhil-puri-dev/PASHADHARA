import { invoices, paymentEvidence, pairIds } from './finance-fixtures.ts';
import { labels, split, type Label } from './finance-labels.ts';

export const referencedPaymentIds = (rationale: string) => [...new Set(rationale.match(/\bPAY-[A-Za-z0-9_-]+\b/g) ?? [])];
export type Finding = { pair: string; classification: 'potential_duplicate' | 'not_duplicate' | 'abstain'; citations: string[]; rationale: string };
export const CLASSES = ['potential_duplicate', 'not_duplicate', 'abstain'] as const;

/** Why a finding is not acceptable. Empty means structurally valid and every cited payment ID was actually purchased. */
export function findingProblems(f: Finding, purchased: readonly string[]): string[] {
  const out: string[] = [];
  if (!f || !pairIds.includes(f.pair)) return [`unknown pair ${f?.pair}`];
  if (!CLASSES.includes(f.classification)) out.push('invalid classification');
  if (!Array.isArray(f.citations) || f.citations.some(c => typeof c !== 'string')) return [...out, 'citations must be strings'];
  if (typeof f.rationale !== 'string') return [...out, 'rationale must be a string'];
  if (f.rationale.length > 400) out.push(`pair ${f.pair}: rationale is longer than 400 characters`);
  const allowed = [`INV-${f.pair}1`, `INV-${f.pair}2`, `PAY-${f.pair}`];
  for (const id of [`INV-${f.pair}1`, `INV-${f.pair}2`]) if (!f.citations.includes(id)) out.push(`pair ${f.pair}: citations must include ${id}`);
  for (const c of f.citations) if (!allowed.includes(c)) out.push(`pair ${f.pair}: citation ${c} does not belong to this pair`);
  if (f.citations.includes(`PAY-${f.pair}`) && !purchased.includes(f.pair)) out.push(`pair ${f.pair}: PAY-${f.pair} was not purchased`);
  for (const id of referencedPaymentIds(f.rationale)) {
    if (id !== `PAY-${f.pair}` || !purchased.includes(f.pair)) out.push(`pair ${f.pair}: rationale mentions ${id}, which is not purchased evidence for this pair`);
    else if (!f.citations.includes(id)) out.push(`pair ${f.pair}: rationale mentions ${id} but the citations array omits it`);
  }
  return out;
}
/** All problems for a whole artifact: exactly one finding per known pair. */
export function artifactProblems(findings: unknown, purchased: readonly string[]): string[] {
  if (!Array.isArray(findings)) return ['findings must be an array'];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of findings as Finding[]) {
    if (!f || typeof f !== 'object') { out.push('finding is not an object'); continue; }
    if (seen.has(f.pair)) out.push(`duplicate finding for pair ${f.pair}`);
    seen.add(f.pair);
    out.push(...findingProblems(f, purchased));
  }
  for (const p of pairIds) if (!seen.has(p)) out.push(`missing finding for pair ${p}`);
  return out;
}

const expected = (l: Label): Finding['classification'] => l === 'duplicate' ? 'potential_duplicate' : l === 'not_duplicate' ? 'not_duplicate' : 'abstain';
export function score(findings: Finding[], purchased: string[], spentCents: number, latencyMs: number) {
  const byPair = new Map(findings.map(f => [f.pair, f]));
  const tally = (pairs: string[]) => {
    let correct = 0, tp = 0, fp = 0, fn = 0, abstentions = 0, unsupported = 0;
    for (const pair of pairs) {
      const f = byPair.get(pair), truth = labels[pair]!;
      const bad = !f || findingProblems(f, purchased).length > 0;
      if (f && bad) unsupported++;
      const got = bad ? 'invalid' : f.classification; // an invalid finding is never credited, not even as a correct abstention
      if (got === 'abstain' || got === 'invalid') abstentions++;
      if (got === expected(truth)) correct++;
      if (got === 'potential_duplicate' && truth === 'duplicate') tp++;
      else if (got === 'potential_duplicate') fp++;
      else if (truth === 'duplicate') fn++;
    }
    return { correct, total: pairs.length, true_positives: tp, false_positives: fp, missed_findings: fn, abstentions, unsupported_or_incomplete_citations: unsupported };
  };
  const bySplit = (kind: 'dev' | 'heldout') => tally(pairIds.filter(p => split[p] === kind));
  return { provenance: 'computed', ...tally(pairIds), spent_cents: spentCents, latency_ms: latencyMs, dev: bySplit('dev'), heldout: bySplit('heldout') };
}

function similarity(a: string, b: string) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, ''); b = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length, 1);
}
type Rec = { supplier: string; invoice: string; amount_cents: number };
const exactMatch = (a: Rec, b: Rec) => a.amount_cents === b.amount_cents && a.supplier === b.supplier && a.invoice === b.invoice;
const fuzzyMatch = (a: Rec, b: Rec) => a.amount_cents === b.amount_cents && similarity(a.supplier, b.supplier) >= 0.7 && similarity(a.invoice, b.invoice) >= 0.7;
const verdictFromEvidence = (pair: string) => {
  const [p, q] = paymentEvidence[pair]!.payments;
  if (p!.status === 'pending' || q!.status === 'pending') return 'abstain' as const;
  return p!.status === 'settled' && q!.status === 'settled' && p!.reference === q!.reference ? 'potential_duplicate' as const : 'not_duplicate' as const;
};
export const LOOKUP_CENTS = 2;

/**
 * Deterministic baselines on the same records, evidence prices and budget. All four are plain programs.
 * - exact_invoice, fuzzy_invoice: free fields only.
 * - fixed_purchase_in_input_order: buy lookups in input order until the budget ends, abstain on the rest.
 * - triage_then_buy: free heuristics first; buy evidence where exact and fuzzy disagree or fuzzy flags a duplicate
 *   (confirmation), most uncertain first; where the budget ends, a flagged pair abstains and the rest are called not duplicate.
 */
export function baselines(budgetCents = 6) {
  if (!Number.isSafeInteger(budgetCents) || budgetCents < 0) throw new Error('Invalid baseline budget');
  const run = (kind: 'exact' | 'fuzzy' | 'fixed' | 'triage') => {
    const start = performance.now();
    const purchased: string[] = [];
    let spent = 0;
    const flagged = (r: (typeof invoices)[number]) => exactMatch(...r.records) !== fuzzyMatch(...r.records) || fuzzyMatch(...r.records);
    const disagree = (r: (typeof invoices)[number]) => exactMatch(...r.records) !== fuzzyMatch(...r.records);
    const order = kind === 'triage' ? [...invoices].sort((x, y) => Number(disagree(y)) - Number(disagree(x))) : [...invoices];
    const findings = new Map<string, Finding>();
    for (const row of order) {
      const { pair, records: [a, b] } = row;
      const citations: string[] = [a.id, b.id];
      const wantsEvidence = kind === 'fixed' || (kind === 'triage' && flagged(row));
      let classification: Finding['classification'];
      if (wantsEvidence && spent + LOOKUP_CENTS <= budgetCents) { spent += LOOKUP_CENTS; purchased.push(pair); citations.push(`PAY-${pair}`); classification = verdictFromEvidence(pair); }
      else if (kind === 'fixed') classification = 'abstain';
      else if (kind === 'triage') classification = flagged(row) ? 'abstain' : 'not_duplicate';
      else classification = (kind === 'exact' ? exactMatch(a, b) : fuzzyMatch(a, b)) ? 'potential_duplicate' : 'not_duplicate';
      findings.set(pair, { pair, classification, citations, rationale: `deterministic ${kind} baseline` });
    }
    return score(invoices.map(i => findings.get(i.pair)!), purchased, spent, performance.now() - start);
  };
  return { exact_invoice: run('exact'), fuzzy_invoice: run('fuzzy'), fixed_purchase_in_input_order: run('fixed'), triage_then_buy: run('triage') };
}
