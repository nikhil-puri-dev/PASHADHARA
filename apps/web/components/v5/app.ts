"use client";
/* Which view the instrument shows: the live hold, the recorded agent run, or the autopilot drill.
   One vessel, three sources. Each source keeps its own numbers; nothing is shared or mixed. */
import { useSyncExternalStore } from "react";
import { usd } from "../../lib/showcase-store";
import { RUN, runApi, useRun } from "./run";
import { simApi, useSim, spendableOf } from "./sim";
import type { Budget, Fx } from "./state";

export type Mode = "live" | "run" | "sim";
let mode: Mode = "live";
const subs = new Set<() => void>();
export const setMode = (m: Mode) => {
  if (m === mode) return;
  /* Nothing runs unseen: leaving a view pauses what it was doing. */
  if (mode === "sim") simApi.pause();
  if (mode === "run") runApi.pause();
  mode = m; subs.forEach(f => f());
};
export const useMode = (): Mode => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => mode, () => "live" as Mode);

export type View = {
  mode: Mode; cap: number; free: number; committed: number; refused: number; served: number;
  unsettled: number | null; spendable: number | null; closed: boolean; captured: number; fee: number; released: number; open: number;
  ended?: boolean;
  fx: Fx; loading: boolean; note: { kind: "good" | "bad" | ""; text: string };
};

export function liveNote(b: Budget): View["note"] {
  if (b.mode === "ended") return { kind: "", text: "The spending window has ended." };
  const c = b.checks[b.checks.length - 1];
  if (!c) return { kind: "", text: b.mode === "loading" ? "Reading the live hold." : "The vessel moves only when the books do." };
  const src = c.recorded ? "Recorded" : "Live check";
  if (c.reason === "error") return { kind: "bad", text: `${src}: ${c.error}` };
  return c.ok ? { kind: "good", text: `${src}: ${usd(c.price)} fits. Nothing posted.` } : { kind: "bad", text: `${src}: ${usd(c.price)} refused (${c.reason}). Nothing charged, tool did not run.` };
}

export function useView(b: Budget): View {
  const m = useMode(), sim = useSim(), run = useRun();
  if (m === "sim") return { mode: m, cap: sim.cap, free: sim.closed ? 0 : sim.hold, committed: sim.committed, refused: sim.refused, served: sim.served, unsettled: sim.unsettled, spendable: spendableOf(sim), closed: sim.closed, captured: sim.captured, fee: sim.fee, released: sim.released, open: 0, fx: sim.fx, loading: false, note: sim.note };
  if (m === "run") {
    const last = RUN.steps[run.step - 1];
    const text = !last ? "Recorded replay. Press Play." : last.kind === "call" ? `${last.tool} · ${usd(last.price ?? 0)} served. ${usd(run.free)} free.` : last.title ?? "";
    return { mode: m, cap: run.hold, free: run.free, committed: run.committed, refused: 0, served: run.served, unsettled: null, spendable: null, closed: run.settled, captured: run.captured, fee: run.fee, released: 0, open: run.settled ? run.free : 0, fx: run.fx, loading: false, note: { kind: last?.kind === "call" ? "good" : "", text } };
  }
  return { mode: m, cap: b.cap, free: b.free, committed: b.committed, refused: b.refused, served: b.served, unsettled: b.unsettled, spendable: b.spendable, closed: false, ended: b.mode === "ended", captured: 0, fee: 0, released: 0, open: 0, fx: b.fx, loading: b.mode === "loading", note: liveNote(b) };
}
