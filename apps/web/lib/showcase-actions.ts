"use client";
import { refreshShowcase } from "./showcase-store";

export type TryResult =
  | { kind: "served"; price: number; remaining: number }
  | { kind: "refused"; price: number | null; remaining: number | null; reason: string }
  | { kind: "error"; message: string };

const minor = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

function refusal(j: Record<string, unknown>) {
  return { kind: "refused" as const, price: minor(j.price_minor), remaining: minor(j.remaining_minor), reason: typeof j.reason === "string" ? j.reason : "Reason unavailable" };
}

/* POST /api/showcase/try runs the real kernel check against the live hold and posts nothing. */
export async function tryAmount(priceMinor: number): Promise<TryResult> {
  try {
    const r = await fetch(`/api/showcase/try?price_minor=${encodeURIComponent(priceMinor)}`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    const price = minor(j.price_minor), remaining = minor(j.remaining_minor);
    if (r.status === 200 && price != null && remaining != null) return { kind: "served", price, remaining };
    if (r.status === 402) return refusal(j);
    if (r.status === 429) return { kind: "error", message: "Too many checks in a minute. Try again shortly." };
    return { kind: "error", message: j.error ?? "The gateway did not answer." };
  } catch { return { kind: "error", message: "The gateway did not answer." }; }
}

export type RunResult =
  | { kind: "served"; price: number; remaining: number; summary?: string }
  | { kind: "refused"; price: number | null; remaining: number | null; reason: string }
  | { kind: "error"; message: string; unknown?: boolean };

/* POST /api/showcase/run makes one paid sandbox call (a model runs, the price is committed against the hold). */
export async function runAgent(): Promise<RunResult> {
  try {
    const r = await fetch("/api/showcase/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json().catch(() => ({}));
    void refreshShowcase();
    const price = minor(j.price_minor ?? j.charged_minor), remaining = minor(j.remaining_minor);
    if (r.status === 200 && price != null && remaining != null) {
      const summary = typeof j.result?.summary === "string" ? j.result.summary : undefined;
      return { kind: "served", price, remaining, ...(summary ? { summary } : {}) };
    }
    if (r.status === 402) return refusal(j);
    if (r.status === 429) return { kind: "error", message: "The public run allowance is used up. No charge was committed." };
    if (j.charged === false) return { kind: "error", message: "The tool call did not complete. No charge was committed." };
    if (r.status === 503 && (j.error === "showcase_unavailable" || j.error === "agent_unavailable")) return { kind: "error", message: "The tool call did not start. No charge was committed." };
    return { kind: "error", unknown: true, message: "Outcome unknown. The call may have committed." };
  } catch {
    void refreshShowcase();
    return { kind: "error", unknown: true, message: "Outcome unknown. The gateway response was lost." };
  }
}

export const parseDollars = (raw: string): number | null => {
  const m = raw.trim().replace(/^\$/, "").match(/^(\d{0,6})(?:\.(\d{1,2}))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const c = Number(m[1] || 0) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return c >= 1 ? c : null;
};
