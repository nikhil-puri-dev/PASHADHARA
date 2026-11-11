import type { ToolDef } from './mcp.ts';

/** Synthetic invoice records. None are PayPal records. */
export const invoices = [
  { pair: 'A', records: [{ id: 'INV-A1', supplier: 'Northstar Office', invoice: 'NS-204', date: '2026-10-03', amount_cents: 184500 }, { id: 'INV-A2', supplier: 'Northstar Office', invoice: 'NS-204', date: '2026-10-03', amount_cents: 184500 }] },
  { pair: 'B', records: [{ id: 'INV-B1', supplier: 'Apex Cloud', invoice: 'AC-902', date: '2026-10-10', amount_cents: 72500 }, { id: 'INV-B2', supplier: 'Apex Cloud', invoice: 'AC-902-R', date: '2026-10-11', amount_cents: 72500 }] },
  { pair: 'C', records: [{ id: 'INV-C1', supplier: 'Meridian Labs Ltd', invoice: 'ML-431', date: '2026-10-18', amount_cents: 96000 }, { id: 'INV-C2', supplier: 'Meridian Laboratory', invoice: 'M-431', date: '2026-10-19', amount_cents: 96000 }] },
  { pair: 'D', records: [{ id: 'INV-D1', supplier: 'Harbor Storage', invoice: 'MONTHLY', date: '2026-09-01', amount_cents: 30000 }, { id: 'INV-D2', supplier: 'Harbor Storage', invoice: 'MONTHLY', date: '2026-10-01', amount_cents: 30000 }] },
] as const;

export const paymentEvidence = {
  A: { id: 'PAY-A', pair: 'A', provenance: 'fixture', payments: [{ id: 'P-A1', status: 'settled', reference: 'NS-204' }, { id: 'P-A2', status: 'settled', reference: 'NS-204' }], detail: 'Two payments settled to the same supplier account; neither was reversed.' },
  B: { id: 'PAY-B', pair: 'B', provenance: 'fixture', payments: [{ id: 'P-B1', status: 'reversed', reference: 'AC-902' }, { id: 'P-B2', status: 'settled', reference: 'AC-902' }], detail: 'P-B1 was reversed in full before replacement P-B2 settled.' },
  C: { id: 'PAY-C', pair: 'C', provenance: 'fixture', payments: [{ id: 'P-C1', status: 'settled', reference: 'PO-431' }, { id: 'P-C2', status: 'settled', reference: 'PO-431' }], detail: 'Both payments settled to the same bank account; each remittance cites PO-431 and delivery note DN-431.' },
  D: { id: 'PAY-D', pair: 'D', provenance: 'fixture', payments: [{ id: 'P-D1', status: 'settled', reference: 'September' }, { id: 'P-D2', status: 'settled', reference: 'October' }], detail: 'The payments cover separate service periods under a monthly contract.' },
} as const;

export const financeTools: readonly ToolDef[] = [
  { name: 'finance_payment_lookup', description: 'Fixture payment evidence for one invoice pair. Pass its pair ID (A, B, C, or D) as text.', admit: () => ({ cancel() {}, async run(text) { const row = paymentEvidence[text.trim().toUpperCase() as keyof typeof paymentEvidence]; if (!row) throw new Error('Unknown fixture pair'); return { provenance: 'fixture', evidence: row }; } }) },
  { name: 'finance_payment_bundle', description: 'Fixture payment evidence for all invoice pairs. Pass all as text.', admit: () => ({ cancel() {}, async run(text) { if (text.trim().toLowerCase() !== 'all') throw new Error('Expected all'); return { provenance: 'fixture', evidence: Object.values(paymentEvidence) }; } }) },
];
