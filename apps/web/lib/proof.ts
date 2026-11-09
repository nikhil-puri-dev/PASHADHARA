import type { Schema } from "./client";
import { recorded } from "./recorded.ts";
import { replayLeaseId, replayPostings } from "./replay-postings.ts";

export function replayProof(faultAt?: number) {
  const focus = faultAt === undefined ? undefined : recorded[faultAt];
  const postings = replayPostings.map(group => {
    const fault = focus?.id === group.ref && group.kind === (focus.kind === "capture" ? "capture" : "authorize");
    return { ...group, legs: group.legs.map(([account, direction, amount], index) => ({
      account, direction, amount: BigInt(amount) - (fault && index === 0 ? 1n : 0n),
    })) };
  });
  const lines = recorded.map(record => {
    const kind = record.kind === "capture" ? "capture" : "authorize";
    const group = postings.find(candidate => candidate.kind === kind && candidate.ref === record.id);
    if (!group) throw new Error(`Missing replay posting for ${record.id}`);
    const auth = kind === "authorize";
    const debit = (account: string) => group.legs.find(leg => leg.account === account && leg.direction === "D")?.amount ?? 0n;
    const ours = {
      id: group.ref,
      status: auth ? (postings.some(posting => posting.kind === "void" && posting.ref === group.ref) ? "VOIDED" : "CREATED") : "COMPLETED",
      amount_minor: Number(debit(auth ? "HOLD_AVAILABLE" : "CAPTURED_GROSS")),
      fee_minor: auth ? null : Number(debit("PAYPAL_FEES")),
    };
    const paypal = { ...record, amount_minor: Number(record.amount.replace(".", "")),
      fee_minor: record.fee === null ? null : Number(record.fee.replace(".", "")) };
    return { subject: `${record.kind} ${record.id}`, ours, paypal, read_at: record.at, legs: group.legs,
      match: ours.id === paypal.id && ours.status === paypal.status && ours.amount_minor === paypal.amount_minor &&
        ours.fee_minor === paypal.fee_minor,
    };
  });
  const balanced = postings.every(group => group.legs.reduce((sum, leg) =>
    sum + (leg.direction === "D" ? leg.amount : -leg.amount), 0n) === 0n);
  return { lease_id: replayLeaseId, lines, all_match: lines.every(line => line.match), invariants: [], balanced,
  } satisfies Schema<"Proof"> & { balanced: boolean };
}
