"use client";
/* Replay of one recorded agent run (12 Nov 2026). It steps through what the trace says happened. It is a replay, never live,
   and it moves the same vessel as the other views only while this view is selected. */
import { useSyncExternalStore } from "react";
import data from "./agent-run.json";
import type { Fx } from "./state";

export type Step = { kind: string; title?: string; detail?: string; tool?: string; price?: number; ms?: number; why?: string; remaining?: number };
export const RUN = { ...data, steps: data.steps as Step[] };
export type RunView = { step: number; total: number; playing: boolean; hold: number; free: number; committed: number; served: number; captured: number; fee: number; settled: boolean; reconciled: boolean; fx: Fx };

let step = 0, playing = false, fxn = 0, fxKind: "pour" | "steam" = "pour", fxPrice: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
let snap: RunView = compute();

function compute(): RunView {
  let free = RUN.hold, committed = 0, served = 0, captured = 0, fee = 0, settled = false, reconciled = false;
  RUN.steps.slice(0, step).forEach(s => {
    if (s.kind === "call") { free -= s.price ?? 0; committed += s.price ?? 0; served++; }
    if (s.kind === "settle") { captured = RUN.settlement.captured; fee = RUN.settlement.fee; committed = 0; settled = true; }
    if (s.kind === "reconcile") reconciled = true;
  });
  return { step, total: RUN.steps.length, playing, hold: RUN.hold, free, committed, served, captured, fee, settled, reconciled, fx: { n: fxn, kind: fxKind, price: fxPrice } };
}
const emit = () => { snap = compute(); subs.forEach(f => f()); };
export const useRun = () => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => snap, () => snap);

const dwell = (k: string) => (k === "think" ? 900 : k === "call" ? 1200 : k === "settle" || k === "reconcile" ? 1500 : 1100);
function advance() {
  if (step >= RUN.steps.length) { playing = false; emit(); return; }
  const s = RUN.steps[step]!;
  step++;
  if (s.kind === "call") { fxn++; fxKind = "pour"; fxPrice = s.price ?? null; }
  emit();
}
function loop() {
  if (!playing) return;
  if (step >= RUN.steps.length) { playing = false; emit(); return; }
  advance();
  if (step >= RUN.steps.length) { playing = false; emit(); return; }
  timer = setTimeout(loop, dwell(RUN.steps[step - 1]!.kind));
}
export const runApi = {
  play() { if (playing) return; if (step >= RUN.steps.length) step = 0; playing = true; emit(); loop(); },
  pause() { playing = false; if (timer) { clearTimeout(timer); timer = null; } emit(); },
  next() { runApi.pause(); advance(); },
  restart() { runApi.pause(); step = 0; emit(); },
};
