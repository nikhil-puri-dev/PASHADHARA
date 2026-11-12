"use client";
/* One budget state for every V3 surface (hero thurible, Budget thurible, tape, Try a call).
   Source: /api/showcase through showcase-store (polled). Local checks come from POST /api/showcase/try and post nothing.
   If no read has ever succeeded the recorded run is used and labelled. Nothing is invented. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { callKind, cents, hold, REASON, useShowcase, type Call, type Showcase } from "../../lib/showcase-store";
import { tryAmount, type TryResult } from "../../lib/showcase-actions";
import record from "../boundary-record.json";

export type Check = { n: number; price: number | null; ok: boolean; reason: string; remaining: number | null; recorded: boolean; error?: string; after?: number; charged?: number };
export type Fx = { n: number; kind: "pour" | "steam"; price: number | null };
type Local = { checks: Check[]; fx: Fx; busy: boolean };

let epoch = 0;
let local: Local = { checks: [], fx: { n: 0, kind: "pour", price: null }, busy: false };
const subs = new Set<() => void>();
const put = (p: Partial<Local>) => { local = { ...local, ...p }; subs.forEach(f => f()); };
export const useLocal = () => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => local, () => local);

export const RECORDED = {
  date: record.date, hold: record.hold, blockedPrice: record.blocked.price, remaining: record.blocked.remaining,
  servedPrice: record.served.price, servedRemaining: record.served.remaining,
};

/* A real check against the live hold. Posts nothing. */
export async function liveCheck(price: number): Promise<TryResult> {
  if (local.busy) return { kind: "error", message: "A check is already running." };
  put({ busy: true });
  const ep = epoch;
  const r = await tryAmount(price);
  if (ep !== epoch) { put({ busy: false }); return r; }
  const n = local.checks.length + 1;
  if (r.kind === "error") {
    put({ busy: false, checks: [...local.checks, { n, price, ok: false, reason: "error", remaining: null, recorded: false, error: r.message }] });
    return r;
  }
  const ok = r.kind === "served";
  const reason = r.kind === "refused" ? r.reason : "allowed";
  const remaining = r.remaining;
  put({
    busy: false,
    checks: [...local.checks, { n, price: r.price ?? price, ok, reason, remaining, recorded: false }],
    fx: { n: local.fx.n + 1, kind: ok ? "pour" : "steam", price: r.price ?? price },
  });
  return r;
}

/* Recorded run, used only when no live read exists. */
export function recordedCheck(which: "blocked" | "served") {
  const n = local.checks.length + 1;
  const blocked = which === "blocked";
  put({
    checks: [...local.checks, { n, price: blocked ? record.blocked.price : record.served.price, ok: !blocked, reason: blocked ? record.blocked.reason : "allowed", remaining: record.blocked.remaining, recorded: true, ...(blocked ? {} : { after: record.served.remaining, charged: record.served.price }) }],
    fx: { n: local.fx.n + 1, kind: blocked ? "steam" : "pour", price: blocked ? record.blocked.price : record.served.price },
  });
}

/* Clears this tab's checks. The hold itself is not changed. */
export function resetChecks() { epoch++; put({ checks: [], fx: { n: local.fx.n, kind: "pour", price: null } }); }

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export type Row = { key: string; n: number; label: string; price: number | null; status: "served" | "refused" | "fits"; why?: string | undefined; check?: boolean };
export type Budget = {
  mode: "loading" | "live" | "ended" | "recorded";
  cap: number; free: number; committed: number; served: number; refused: number;
  stale: boolean; goodAt: number | null; readAt?: string | undefined; honor: string | null; honorMs: number; state: string;
  paypalId: string | null; remainingCalls: number | undefined; lastSummarise: number | null;
  rows: Row[]; checks: Check[]; fx: Fx; busy: boolean; canCheck: boolean; recordedDate: string; sandboxHoldShort: string;
};

/* A read counts only if it carries the hold's limit and available balance. A partial answer never replaces the last good read. */
const valid = (d: Showcase | null | undefined) => { const x = hold(d ?? null); return !!x && x.cap != null && x.available != null; };
let good: { data: Showcase; at: number } | null = null;
const kindOf = (c: Call): "served" | "refused" | "other" => (typeof c.status === "string" ? callKind(c) : "other");

export function useBudget(): Budget {
  const s = useShowcase();
  const now = useNow(1000);
  const lc = useLocal();
  const fresh = valid(s.data);
  if (fresh && s.data && (!good || good.data !== s.data)) good = { data: s.data, at: s.goodAt ?? Date.now() };
  const data = fresh ? s.data : good?.data ?? null;
  const h = hold(data, now);
  const have = !!h && h.cap != null && h.available != null;
  const mode: Budget["mode"] = have ? (h!.state === "ended" ? "ended" : "live") : s.loading && !s.data ? "loading" : "recorded";
  const calls: Call[] = [...(data?.calls ?? []), ...(data?.refused_calls ?? [])].filter((c): c is Call => !!c && typeof c.id === "string" && typeof c.created_at === "string").filter((c, i, a) => a.findIndex(x => x.id === c.id) === i)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const journal: Row[] = have ? calls.filter(c => kindOf(c) !== "other").map((c, i) => ({
    key: `j${c.id}`, n: i + 1, label: c.tool_id, price: cents(c.price_minor), status: kindOf(c) as "served" | "refused",
    ...(kindOf(c) === "refused" ? { why: REASON[c.status] ?? c.status.replace(/_/g, " ") } : {}),
  })) : [];
  const checkRows: Row[] = lc.checks.map(c => ({
    key: `c${c.n}`, n: journal.length + c.n, label: c.recorded ? "recorded check" : "check, nothing posted", price: c.price, check: true,
    status: c.reason === "error" ? "refused" : c.ok ? (c.charged != null ? "served" : "fits") : "refused",
    why: c.reason === "error" ? c.error : c.ok ? (c.charged != null ? "served in the recorded run" : "fits what is free") : (REASON[c.reason] ?? c.reason) + (c.remaining != null ? ` · free $${(c.remaining / 100).toFixed(2)}` : ""),
  }));
  const cap = have ? (h!.cap as number) : RECORDED.hold;
  const free = have ? (h!.available as number) : mode === "loading" ? 0 : RECORDED.remaining;
  const committed = have ? (h!.spent ?? 0) : 0;
  const summ = calls.slice().reverse().find(c => c.tool_id === "summarise" && c.status === "served");
  return {
    mode, cap, free, committed,
    served: journal.filter(r => r.status === "served").length,
    refused: journal.filter(r => r.status === "refused").length,
    stale: (!!s.failedAt || (!!s.data && !fresh)) && !!good, goodAt: good?.at ?? null, readAt: data?.read_at,
    honor: h?.honor ?? null, honorMs: h?.honorMs ?? NaN, state: h?.state ?? "unknown", paypalId: h?.paypalId ?? null,
    remainingCalls: data?.remaining_calls, lastSummarise: summ ? cents(summ.price_minor) : null,
    rows: [...journal, ...checkRows].slice(-6), checks: lc.checks, fx: lc.fx, busy: lc.busy,
    canCheck: mode === "live", recordedDate: RECORDED.date, sandboxHoldShort: h?.paypalId ? h.paypalId.slice(-4) : "",
  };
}
