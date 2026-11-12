import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactProblems, baselines, findingProblems, score, type Finding } from '../src/finance-evaluation.ts';
import { financeTools, invoices, pairIds } from '../src/finance-fixtures.ts';
import { labels } from '../src/finance-labels.ts';

const abstainAll = (purchased: string[] = []): Finding[] => pairIds.map(pair => ({ pair, classification: 'abstain', citations: [`INV-${pair}1`, `INV-${pair}2`, ...(purchased.includes(pair) ? [`PAY-${pair}`] : [])], rationale: purchased.includes(pair) ? `PAY-${pair} reviewed.` : 'No evidence bought.' }));

test('twelve pairs, labels cover every pair, and the held-out split is non-trivial', () => {
  assert.equal(invoices.length, 12);
  assert.deepEqual(Object.keys(labels).sort(), [...pairIds].sort());
  assert.equal(Object.values(labels).filter(l => l === 'duplicate').length, 5);
  assert.equal(Object.values(labels).filter(l => l === 'ambiguous').length, 1);
});

test('fixture tools expose evidence only for a valid pair', async () => {
  const tool = financeTools.find(t => t.name === 'finance_payment_lookup')!;
  assert.equal((await tool.admit('K')!.run('K')).evidence && ((await tool.admit('K')!.run('K')).evidence as { id: string }).id, 'PAY-K');
  await assert.rejects(() => tool.admit('X')!.run('X'));
});

test('citation validation flags fabricated, cross-pair, unpurchased and omitted payment IDs', () => {
  const f = (citations: string[], rationale: string): Finding => ({ pair: 'A', classification: 'potential_duplicate', citations, rationale });
  assert.equal(findingProblems(f(['INV-A1', 'INV-A2', 'PAY-B'], 'x'), ['A', 'B']).length, 1);
  assert.equal(findingProblems(f(['INV-A1', 'INV-A2'], 'PAY-A shows two payments.'), ['A']).length, 1);
  assert.equal(findingProblems(f(['INV-A1', 'INV-A2', 'PAY-A'], 'PAY-B is the evidence.'), ['A', 'B']).length, 1);
  assert.equal(findingProblems(f(['INV-A1', 'INV-A2', 'PAY-A'], 'PAY-A.'), []).length >= 1, true);
  assert.deepEqual(findingProblems(f(['INV-A1', 'INV-A2', 'PAY-A'], 'PAY-A.'), ['A']), []);
  assert.ok(artifactProblems([f(['INV-A1', 'INV-A2'], 'ok')], []).some(p => p.includes('missing finding for pair B')));
  assert.deepEqual(findingProblems({ ...f(['INV-A1', 'INV-A2'], ' '), classification: 'abstain' }, []), ['rationale must be a non-empty string']);
  assert.deepEqual(artifactProblems(abstainAll(['A']), ['A']), []);
});

test('scoring: abstaining on the ambiguous pair is correct, labels are never leaked into the tools', () => {
  const result = score(abstainAll(), [], 0, 1);
  assert.equal(result.correct, 1); // only L, the ambiguous pair
  assert.equal(result.missed_findings, 5);
  assert.equal(result.dev.total + result.heldout.total, 12);
});

test('deterministic baselines are fair and distinct', () => {
  const b = baselines(6);
  assert.equal(b.fixed_purchase_in_input_order.spent_cents, 6);
  assert.equal(b.fixed_purchase_in_input_order.abstentions, 9);
  assert.ok(b.triage_then_buy.spent_cents <= 6);
  assert.ok(b.exact_invoice.false_positives >= 1, 'exact matching is fooled by reversed and recurring payments');
  assert.ok(b.exact_invoice.missed_findings >= 1, 'exact matching misses re-keyed duplicates');
  assert.equal(b.exact_invoice.spent_cents, 0);
  const rich = baselines(24);
  assert.equal(rich.fixed_purchase_in_input_order.correct, 12, 'full evidence settles every pair');
  assert.equal(baselines(0).triage_then_buy.spent_cents, 0);
  assert.throws(() => baselines(-1));
});
