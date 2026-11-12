"use client";
import { useEffect, useSyncExternalStore } from "react";

/* Live read of /api/showcase. Every field after `read_at` is optional and feature-detected by callers.
   Rule: after one good read the UI keeps the last good read (with its age). It never falls back to a saved fixture. */
export type Call = { id: string; tool_id: string; price_minor: string | number; status: string; created_at: string; ledger_group_id?: string | null; captured?: boolean };
export type Capture = { id?: string; paypal_capture_id?: string; amount_minor: number | string; fee_minor?: number | string | null; status?: string; created_at?: string };
export type Showcase = {
  mode?: string; state?: string; ended?: boolean; read_at?: string; honor_until?: string | null; remaining_calls?: number;
  last_read_at?: string; refused_calls?: Call[];
  lease?: { id?: string; state?: string; cap_minor?: number; guaranteed_now?: boolean;
    authorizations?: { honor_until?: string; expires_at?: string; paypal_authorization_id?: string; status?: string }[];
    balances?: Record<string, number> };
  journal?: { entries?: unknown[] }; calls?: Call[]; captures?: Capture[];
};
type Store = { data: Showcase | null; goodAt: number | null; failedAt: number | null; loading: boolean };

let store: Store = { data: null, goodAt: null, failedAt: null, loading: true };
const subs = new Set<() => void>();
const set = (next: Partial<Store>) => { store = { ...store, ...next }; subs.forEach(f => f()); };
let timer: ReturnType<typeof setInterval> | undefined;
let inflight = false;

export async function refreshShowcase() {
  if (inflight) return;
  inflight = true;
  try {
    let r = await fetch("/api/showcase", { cache: "no-store" });
    if (!r.ok) { await new Promise(x => setTimeout(x, 1200)); r = await fetch("/api/showcase", { cache: "no-store" }); }
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as Showcase;
    set({ data, goodAt: Date.now(), failedAt: null, loading: false });
  } catch {
    set({ failedAt: Date.now(), loading: false });
  } finally { inflight = false; }
}

export function useShowcase(enabled = true) {
  useEffect(() => {
    if (enabled && !timer) {
      void refreshShowcase();
      const tick = () => { if (document.visibilityState === "visible") void refreshShowcase(); };
      timer = setInterval(tick, 20_000);
      document.addEventListener("visibilitychange", tick);
    }
  }, [enabled]);
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => store, () => store);
}

/* ---- derived values (all from real fields, never invented) ---- */
export const cents = (v: unknown) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
export const usd = (c: number | null | undefined) => (c === null || c === undefined ? "" : `$${(c / 100).toFixed(2)}`);
export const utc = (iso?: string | number | null) => {
  if (iso === undefined || iso === null) return "";
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${d.toISOString().slice(11, 16)} UTC`;
};
export const age = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; };

export function hold(d: Showcase | null, now = Date.now()) {
  if (!d) return null;
  const b = d.lease?.balances ?? {};
  const auths = d.lease?.authorizations ?? [];
  const auth = auths.find(a => a.status === "created" || a.status === "partially_captured") ?? auths[0];
  const honor = d.honor_until ?? auth?.honor_until ?? null;
  const cap = cents(d.lease?.cap_minor ?? b.buyer_commitment);
  const available = cents(b.hold_available);
  const spent = cents(b.committed_unsettled);
  const collected = cents(b.captured_gross);
  const honorMs = honor ? Date.parse(honor) : NaN;
  let state: "active" | "expiring" | "ended" | "unknown" = "unknown";
  if (d.state === "ended" || d.state === "expiring" || d.state === "active") state = d.state;
  else if (d.ended === true) state = "ended";
  // The reader's clock is the safer check when the stored state is older than the honor time.
  if (!Number.isNaN(honorMs)) {
    if (honorMs <= now) state = "ended";
    else if (state !== "ended") state = honorMs - now <= 86_400_000 ? "expiring" : state === "unknown" ? "active" : state;
  }
  return { cap, available, spent, collected, honor, honorMs, state, paypalId: auth?.paypal_authorization_id ?? null, expires: auth?.expires_at ?? null };
}

export const shortId = (id?: string | null) => (id && id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id ?? "");

export const REASON: Record<string, string> = {
  cap_reached: "Above what is available on the hold",
  exposure_limit: "Above the unsettled limit",
  window_ended: "The hold is not taking a new charge",
  lease_not_active: "The hold or the tool is not active",
  refused_cap: "Above what is available on the hold",
  refused_exposure: "Above the unsettled limit",
  refused_window: "The hold is not taking a new charge",
  refused_inactive: "The tool is not active",
};
export const callKind = (c: Call): "served" | "refused" | "other" => (c.status === "served" ? "served" : c.status.startsWith("refused") ? "refused" : "other");

/* fee model: 0.49 + 3.49% per capture. Computed, matches 12 recorded captures (0.52 on 1.00, 0.59 on 3.00, 0.66 on 5.00). */
export const feeFor = (amountCents: number) => 49 + Math.round(amountCents * 0.0349);
