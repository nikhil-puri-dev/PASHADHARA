import { invoices, paymentEvidence } from './finance-fixtures.ts';

/** Independent fixture labels for evaluation only; never included in the agent prompt. */
const truth = new Set(['A', 'C']);
const pairs = invoices.map(row => row.pair);
export const referencedPaymentIds = (rationale: string) => [...new Set(rationale.match(/\bPAY-[A-Za-z0-9_-]+\b/g) ?? [])];
export type Finding = { pair: string; classification: 'potential_duplicate' | 'not_duplicate' | 'abstain'; citations: string[]; rationale: string };
export function score(findings: Finding[], purchased: string[], spentCents: number, latencyMs: number) {
  const byPair = new Map(findings.map(f => [f.pair, f]));
  const missingOrUnsupported = findings.filter(f => !pairs.includes(f.pair as typeof pairs[number]) || !f.citations.includes(`INV-${f.pair}1`) || !f.citations.includes(`INV-${f.pair}2`) || f.citations.some(c => c.startsWith('PAY-') && (c !== `PAY-${f.pair}` || !purchased.includes(f.pair))) || f.citations.some(c => ![`INV-${f.pair}1`, `INV-${f.pair}2`, `PAY-${f.pair}`].includes(c)) || referencedPaymentIds(f.rationale).some(id => id !== `PAY-${f.pair}` || !purchased.includes(f.pair) || !f.citations.includes(id)));
  let tp = 0, fp = 0, fn = 0, abstentions = 0, correct = 0;
  for (const pair of pairs) {
    const f = byPair.get(pair);
    if (!f || missingOrUnsupported.includes(f) || f.classification === 'abstain') { abstentions++; if (truth.has(pair)) fn++; continue; }
    const predicted = f.classification === 'potential_duplicate';
    if (predicted && truth.has(pair)) tp++;
    else if (predicted) fp++;
    else if (truth.has(pair)) fn++;
    if (predicted === truth.has(pair)) correct++;
  }
  return { provenance: 'computed', correct, total: pairs.length, true_positives: tp, false_positives: fp, missed_findings: fn, abstentions, spent_cents: spentCents, latency_ms: latencyMs, unsupported_or_incomplete_citations: missingOrUnsupported.length };
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

/** Same free records and budget; fixed strategy buys lookups in input order. */
export function baselines(budgetCents = 6) {
  if (!Number.isSafeInteger(budgetCents) || budgetCents < 0) throw new Error('Invalid baseline budget');
  const run = (kind: 'exact' | 'fuzzy' | 'fixed') => {
    const start = performance.now();
    const purchased: string[] = [];
    let spent = 0;
    const findings: Finding[] = invoices.map(({ pair, records: [a, b] }) => {
      let classification: Finding['classification'];
      const citations = [a.id as string, b.id as string];
      if (kind === 'fixed') {
        if (spent + 2 > budgetCents) classification = 'abstain';
        else {
          spent += 2; purchased.push(pair);
          const evidence = paymentEvidence[pair]; citations.push(evidence.id);
          const [p, q] = evidence.payments;
          classification = p.status === 'settled' && q.status === 'settled' && p.reference === q.reference ? 'potential_duplicate' : 'not_duplicate';
        }
      } else {
        const match = kind === 'exact' ? a.supplier === b.supplier && a.invoice === b.invoice : similarity(a.supplier, b.supplier) >= 0.7 && similarity(a.invoice, b.invoice) >= 0.7;
        classification = a.amount_cents === b.amount_cents && match ? 'potential_duplicate' : 'not_duplicate';
      }
      return { pair, classification, citations, rationale: `deterministic ${kind} baseline` };
    });
    return score(findings, purchased, spent, performance.now() - start);
  };
  return { exact_invoice: run('exact'), fuzzy_invoice: run('fuzzy'), fixed_purchase_in_input_order: run('fixed') };
}

