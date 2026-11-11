export const CAP = 500_000n;
export const PER_REQUEST = 150_000n;
export const EXPOSURE = 400_000n;

export type Quote = { id: string; name: string; purpose: string; amount: bigint; category: string };
export const quotes: Quote[] = [
  { id: "audit", name: "Audit source documents", purpose: "Cross-check the quarter-close evidence pack", amount: 42_000n, category: "Assurance" },
  { id: "screen", name: "Screen another supplier", purpose: "Run a second diligence pass before onboarding", amount: 98_000n, category: "Diligence" },
  { id: "research", name: "Commission market research", purpose: "Extend the category analysis for procurement", amount: 140_000n, category: "Research" },
  { id: "analysis", name: "Expand category analysis", purpose: "Request a larger research package", amount: 180_000n, category: "Research" },
  { id: "dataset", name: "Acquire market dataset", purpose: "Add a larger external dataset", amount: 250_000n, category: "Research" },
];
export type Commitment = { id: string; name: string; amount: bigint; category: string; sequence: number };
export type Decision = { id: string; name: string; amount: bigint; outcome: "admitted" | "refused"; reason: string; sequence: number };
export type Delegation = { commitments: Commitment[]; decisions: Decision[]; sequence: number };

export const initial: Delegation = {
  commitments: [
    { id: "index", name: "Index the data room", amount: 125_000n, category: "Documents", sequence: 1 },
    { id: "diligence", name: "Vendor diligence", amount: 87_500n, category: "Diligence", sequence: 2 },
    { id: "invoices", name: "Extract invoice exceptions", amount: 64_000n, category: "Finance operations", sequence: 3 },
  ],
  decisions: [], sequence: 3,
};

export const total = (s: Delegation) => s.commitments.reduce((sum, row) => sum + row.amount, 0n);
export const remaining = (s: Delegation) => CAP - total(s);
export const money = (cents: bigint) => {
  const whole = cents / 100n;
  const fraction = String(cents % 100n).padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
};

// This fixture mirrors the kernel's cap-then-exposure order. Only the kernel governs real leases.
export function decide(s: Delegation, quote: Quote): { next: Delegation; decision: Decision } {
  const committed = total(s);
  const free = CAP - committed;
  const reason = quote.amount <= 0n ? "Invalid quote"
    : quote.amount > free ? `Exceeds remaining authority by ${money(quote.amount - free)}`
    : quote.amount > PER_REQUEST ? `Exceeds the ${money(PER_REQUEST)} per-request ceiling`
    : quote.amount + committed > EXPOSURE ? `Exceeds the ${money(EXPOSURE)} outstanding exposure limit`
    : "Within all three rules";
  const admitted = reason === "Within all three rules";
  const sequence = s.sequence + 1;
  const decision: Decision = { id: quote.id, name: quote.name, amount: quote.amount, outcome: admitted ? "admitted" : "refused", reason, sequence };
  return {
    decision,
    next: {
      commitments: admitted ? [...s.commitments, { id: quote.id, name: quote.name, amount: quote.amount, category: quote.category, sequence }] : s.commitments,
      decisions: [decision, ...s.decisions], sequence,
    },
  };
}
