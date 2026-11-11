import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselines, score } from '../src/finance-evaluation.ts';
import { financeTools } from '../src/finance-fixtures.ts';

test('fixture tools expose evidence only for a valid pair', async () => {
  const tool = financeTools.find(t => t.name === 'finance_payment_lookup')!;
  assert.deepEqual((await tool.admit('C')!.run('C')).evidence, { id: 'PAY-C', pair: 'C', provenance: 'fixture', payments: [{ id: 'P-C1', status: 'settled', reference: 'PO-431' }, { id: 'P-C2', status: 'settled', reference: 'PO-431' }], detail: 'Both payments settled to the same bank account; each remittance cites PO-431 and delivery note DN-431.' });
  await assert.rejects(() => tool.admit('X')!.run('X'));
});

test('evaluation flags fabricated and unpurchased citations and computes baseline outcomes', () => {
  const result = score([{ pair: 'A', classification: 'potential_duplicate', citations: ['INV-A1', 'INV-A2', 'PAY-B'], rationale: 'wrong pair' }], [], 0, 1);
  assert.equal(result.unsupported_or_incomplete_citations, 1);
  assert.equal(result.correct, 0);
  assert.equal(result.abstentions, 4);
  const omitted = score([{ pair: 'A', classification: 'potential_duplicate', citations: ['INV-A1', 'INV-A2'], rationale: 'PAY-A shows two settled payments.' }], ['A'], 2, 1);
  assert.equal(omitted.unsupported_or_incomplete_citations, 1);
  const crossPair = score([{ pair: 'A', classification: 'potential_duplicate', citations: ['INV-A1', 'INV-A2', 'PAY-A'], rationale: 'PAY-B is the evidence.' }], ['A', 'B'], 2, 1);
  assert.equal(crossPair.unsupported_or_incomplete_citations, 1);
  const unpurchased = score([{ pair: 'A', classification: 'potential_duplicate', citations: ['INV-A1', 'INV-A2', 'PAY-A'], rationale: 'PAY-A.' }], [], 0, 1);
  assert.equal(unpurchased.unsupported_or_incomplete_citations, 1);
  const valid = score([{ pair: 'A', classification: 'potential_duplicate', citations: ['INV-A1', 'INV-A2', 'PAY-A'], rationale: 'PAY-A.' }], ['A'], 2, 1);
  assert.equal(valid.unsupported_or_incomplete_citations, 0);
  const base = baselines();
  assert.equal(base.exact_invoice.false_positives, 1);
  assert.equal(base.fixed_purchase_in_input_order.spent_cents, 6);
  assert.equal(base.fixed_purchase_in_input_order.true_positives, 2);
  assert.equal(base.fixed_purchase_in_input_order.abstentions, 1);
  const limited = baselines(2).fixed_purchase_in_input_order;
  assert.equal(limited.spent_cents, 2);
  assert.equal(limited.abstentions, 3);
  assert.throws(() => baselines(-1));
});

