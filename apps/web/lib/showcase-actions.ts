"use client";
import { refreshShowcase } from "./showcase-store";

export type TryResult =
  | { kind: "served"; price: number; remaining: number }
  | { kind: "refused"; price: number; remaining: number; reason: string }
  | { kind: "error"; message: string };

/* POST /api/showcase/try runs the real kernel check against the live hold and posts nothing. */
export async function tryAmount(priceMinor: number): Promise<TryResult> {
  try {
    const r = await fetch(`/api/showcase/try?price_minor=${encodeURIComponent(priceMinor)}`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 200) return { kind: "served", price: j.price_minor, remaining: j.remaining_minor };
    if (r.status === 402) return { kind: "refused", price: j.price_minor, remaining: j.remaining_minor, reason: j.reason ?? "cap_reached" };
    if (r.status === 429) return { kind: "error", message: "Too many checks in a minute. Try again shortly." };
    return { kind: "error", message: j.error ?? "The gateway did not answer." };
  } catch { return { kind: "error", message: "The gateway did not answer." }; }
}

export type RunResult =
  | { kind: "served"; price: number; remaining: number; summary?: string }
  | { kind: "refused"; price: number; remaining: number; reason: string }
  | { kind: "error"; message: string };

/* POST /api/showcase/run makes one paid sandbox call (a model runs, the price is committed against the hold). */
export async function runAgent(): Promise<RunResult> {
  try {
    const r = await fetch("/api/showcase/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json().catch(() => ({}));
    void refreshShowcase();
    if (r.status === 200) {
      const res = j.result as Record<string, unknown> | undefined;
      const text = res && typeof res === "object" ? Object.values(res).find(v => typeof v === "string") as string | undefined : undefined;
      return { kind: "served", price: j.price_minor, remaining: j.remaining_minor, ...(text ? { summary: text } : {}) };
    }
    if (r.status === 402) return { kind: "refused", price: j.price_minor, remaining: j.remaining_minor, reason: j.reason ?? "cap_reached" };
    if (r.status === 429) return { kind: "error", message: "The demo limit for today is used up. Nothing was charged." };
    return { kind: "error", message: "The call did not complete. Nothing was charged." };
  } catch { return { kind: "error", message: "The gateway did not answer. Nothing was charged." }; }
}

export const parseDollars = (raw: string): number | null => {
  const m = raw.trim().replace(/^\$/, "").match(/^(\d{0,6})(?:\.(\d{1,2}))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const c = Number(m[1] || 0) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return c >= 1 ? c : null;
};
