import type { LeaseReader, Schema } from "./client";
import { replayProof } from "./proof.ts";

export const stages = ["active", "settled", "reserved", "judged"] as const;
export type Stage = typeof stages[number];
export type Entry = Schema<"LedgerEntry">;
type Account = Entry["account"];

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const leaseId = id(1);
const authId = id(2);
const sellerId = id(3);
export const opened = "2026-11-06T10:00:00.000Z";
export const at = (hour: number) => new Date(Date.parse(opened) + hour * 3_600_000).toISOString();
export const hoursFromOpen = (date: string) => (Date.parse(date) - Date.parse(opened)) / 3_600_000;
const cap = 2000n;
const rubric = [{ min_score: 0, pay_bps: 0 }, { min_score: 70, pay_bps: 7000 }, { min_score: 90, pay_bps: 10000 }];
const verdict = (judge_provider: "openai" | "anthropic", score: number, result: "pass" | "fail", reason: string): Schema<"Verdict"> =>
  ({ judge_provider, round: 1, model: "fixture", verdict: result, score, reasons: [reason] });
const agreement = [
  verdict("anthropic", 84, "pass", "The report covered the requested sources."),
  verdict("openai", 79, "pass", "The citations supported the main findings."),
];
const disagreement = [
  verdict("anthropic", 83, "pass", "The inventory covered the requested vendors."),
  verdict("openai", 46, "fail", "The inventory omitted a required source link."),
];

const gross = 300n * BigInt(rubric.filter(band => band.min_score <= Math.min(...agreement.map(v => v.score))).at(-1)!.pay_bps) / 10000n;
const jobFee = 56n;
export const jobs = {
  decided: {
    id: id(4), lease_id: leaseId, seller_id: sellerId, amount_minor: 300, state: "decided", rubric, verdicts: agreement,
    decision: { id: id(6), round: 1, outcome: "partial", amount_minor: Number(gross), derived_from: { pay_bps: 7000, score: 79 } },
  },
  held: {
    id: id(5), lease_id: leaseId, seller_id: sellerId, amount_minor: 250, state: "held", rubric, verdicts: disagreement,
    decision: { id: id(7), round: 1, outcome: "hold", amount_minor: 0, derived_from: { next_round: 2 } },
  },
} satisfies Record<string, Schema<"Job">>;

export const payout = {
  id: id(8), lease_id: leaseId, source: "job", amount_minor: Number(gross - jobFee),
  state: "queued", release_at: at(10.55), decision_id: jobs.decided.decision.id, provenance: "fixture",
} satisfies Schema<"Payout">;
export const failedPayout = { ...payout, state: "failed" } satisfies Schema<"Payout">;
export const failedResponse = "RECEIVER_UNREGISTERED";

const tools = [
  ["Translate page", 100n], ["Fetch page", 50n], ["Company profile", 200n],
] as const;
const calls = [0, 1, 2, 0, 0, 1, 2, 0, 0, 0, 2, 1, 0].map((tool, index) => {
  const [label, amount] = tools[tool]!;
  return { ref: id(20 + index), label, amount, hour: (index + 1) * 0.55 };
});

type Leg = [Account, "D" | "C", bigint];
type Group = { ref: string; label: string; kind: string; hour: number; legs: Leg[]; batch?: string };
const move = (debit: Account, credit: Account, amount: bigint): Leg[] => [[debit, "D", amount], [credit, "C", amount]];
const groups: Group[] = [
  { ref: authId, label: "Authorization hold", kind: "authorize", hour: 0, legs: move("HOLD_AVAILABLE", "BUYER_COMMITMENT", cap) },
];
const captures: Schema<"Capture">[] = [];
function capture(ref: string, label: string, hour: number, fee: bigint,
  sources: { ref: string; label: string; amount: bigint }[], decisionId: string | null = null) {
  const amount = sources.reduce((sum, source) => sum + source.amount, 0n);
  groups.push({ ref, label, kind: "capture", hour, legs: [
    ...move("CAPTURED_GROSS", "COMMITTED_UNSETTLED", amount),
    ...move("PAYPAL_FEES", "CAPTURED_GROSS", fee),
  ] });
  captures.push({ id: ref, lease_id: leaseId, authorization_id: authId, decision_id: decisionId,
    amount_minor: Number(amount), fee_minor: Number(fee), status: "completed", provenance: "fixture",
    allocations: sources.map(source => ({ capture_id: ref, lease_id: leaseId, ref_id: source.ref, amount_minor: Number(source.amount) })),
  });
  let cumulative = 0n;
  let allocated = 0n;
  for (const source of sources) {
    cumulative += source.amount;
    const next = (amount - fee) * cumulative / amount;
    groups.push({ ref: decisionId ?? source.ref, label: source.label, kind: "accrue", hour,
      legs: move("SELLER_COST", "SELLER_PAYABLE", next - allocated), batch: ref });
    allocated = next;
  }
}
for (const [index, call] of calls.entries()) {
  groups.push({ ...call, kind: "commit", legs: move("COMMITTED_UNSETTLED", "HOLD_AVAILABLE", call.amount) });
  if (index === 7) capture(id(40), "First tool batch", 4.6, 80n, calls.slice(0, 8));
}
capture(id(41), "Second tool batch", 10, 68n, calls.slice(8));
for (const job of Object.values(jobs)) {
  groups.push({ ref: job.id, label: job === jobs.held ? "Vendor inventory" : "Source report", kind: "reserve",
    hour: 10.1, legs: move("COMMITTED_UNSETTLED", "HOLD_AVAILABLE", BigInt(job.amount_minor)) });
}
groups.push({ ref: jobs.decided.id, label: "Unused job reserve", kind: "return", hour: 10.3,
  legs: move("HOLD_AVAILABLE", "COMMITTED_UNSETTLED", BigInt(jobs.decided.amount_minor) - gross) });
capture(id(42), "Judged job capture", 10.4, jobFee, [{ ref: jobs.decided.id, label: "Source report", amount: gross }], jobs.decided.decision.id);

const end: Record<Stage, number> = { active: 9.6, settled: 10, reserved: 10.1, judged: 10.4 };
const creditNormal = new Set<Account>(["BUYER_COMMITMENT", "SELLER_PAYABLE"]);

export function fixtureSnapshot(stage: Stage) {
  const rows = groups.filter(group => group.hour <= end[stage]);
  const net = new Map<Account, bigint>();
  let entryId = 0;
  const journal = rows.map((group, index) => {
    const entries = group.legs.map(([account, direction, amount]): Entry => {
      const sign = creditNormal.has(account) === (direction === "C") ? 1n : -1n;
      net.set(account, (net.get(account) ?? 0n) + sign * amount);
      return { id: ++entryId, group_id: id(100 + index), account, direction, amount_minor: Number(amount),
        ref_type: group.kind === "reserve" ? "commit" : group.kind, ref_id: group.ref, created_at: at(group.hour) };
    });
    return { ...group, entries, available: net.get("HOLD_AVAILABLE") ?? 0n };
  });
  const amount = (account: Account) => Number(net.get(account) ?? 0n);
  const captureRows = captures.filter(item => rows.some(row => row.kind === "capture" && row.ref === item.id));
  const totalCaptured = captureRows.reduce((sum, captureRow) => sum + BigInt(captureRow.amount_minor), 0n);
  const lease: Schema<"Lease"> = {
    id: leaseId, state: "active", cap_minor: Number(cap), unsettled_limit_minor: 1000, guaranteed_now: true,
    authorizations: [{ id: authId, paypal_authorization_id: "FIXTURE-AUTH", parent_id: null, amount_minor: Number(cap),
      status: "partially_captured", honor_until: at(72), expires_at: at(696) }],
    balances: {
      buyer_commitment: amount("BUYER_COMMITMENT"), hold_available: amount("HOLD_AVAILABLE"),
      committed_unsettled: amount("COMMITTED_UNSETTLED"), captured_gross: amount("CAPTURED_GROSS"),
      paypal_fees: amount("PAYPAL_FEES"), seller_cost: amount("SELLER_COST"), seller_payable: amount("SELLER_PAYABLE"),
      released: amount("RELEASED"), written_off: amount("WRITTEN_OFF"), chargeback_loss: amount("CHARGEBACK_LOSS"),
      total_captured: Number(totalCaptured),
    },
  };
  return { lease, journal, captures: captureRows, elapsed: end[stage] };
}

export type Snapshot = ReturnType<typeof fixtureSnapshot>;
export const fixtureRenewedAt = at(96);

export function fixtureRenewal(snapshot: Snapshot): Snapshot {
  const root = snapshot.lease.authorizations[0]!;
  return { ...snapshot, lease: { ...snapshot.lease, guaranteed_now: false, authorizations: [
    { ...root, status: "superseded" },
    {
      id: id(9), paypal_authorization_id: "FIXTURE-REAUTH", parent_id: root.id, status: "created",
      amount_minor: Number(BigInt(snapshot.lease.cap_minor) - BigInt(snapshot.lease.balances.total_captured)),
      honor_until: at(168), expires_at: root.expires_at,
    },
  ] } };
}
export const pendingLease: Schema<"Lease"> = {
  ...fixtureSnapshot("active").lease, state: "pending_approval", authorizations: [], guaranteed_now: false,
  balances: { buyer_commitment: 0, hold_available: 0, committed_unsettled: 0, captured_gross: 0, paypal_fees: 0,
    seller_cost: 0, seller_payable: 0, released: 0, written_off: 0, chargeback_loss: 0, total_captured: 0 },
};

export function fixtureAdapter(stage: Stage): LeaseReader {
  const snapshot = fixtureSnapshot(stage);
  function forLease<T>(requested: string, result: T) {
    if (requested !== leaseId) throw new Error("Fixture lease not found");
    return result;
  }
  return {
    async lease(requested) { return forLease(requested, snapshot.lease); },
    async journal(requested, after = 0) {
      return forLease(requested, { entries: snapshot.journal.flatMap(row => row.entries).filter(entry => entry.id > after) });
    },
    async captures(requested) { return forLease(requested, { captures: snapshot.captures }); },
    async job(requested) {
      const job = Object.values(jobs).find(candidate => candidate.id === requested);
      if (!job) throw new Error("Fixture job not found");
      return job;
    },
    async proof(requested) {
      if (requested !== replayProof().lease_id) throw new Error("Replay lease not found");
      return replayProof();
    },
  };
}


