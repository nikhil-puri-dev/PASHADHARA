"use client";
/* Autopilot: scripted agents spending against a simulated hold, under the same two refusal rules the gateway applies
   (cap first, then the unsettled limit). It runs only in this browser. It never touches the API and is always labelled illustrative.
   The agents are scripts, not models. Prices other than summarise at 3 cents are made up for the drill. */
import { useSyncExternalStore } from "react";
import type { Fx } from "./state";

export type SimAgent = { id: string; color: [number, number, number]; pol: string; served: number; refused: number; charged: number; next: number; state: string; bad: boolean; n: number; streak: number; idle: boolean; learned: boolean; stood: number; backoffs: number };
export type SimEvent = { t: number; a: number; k: "ok" | "no" | "pre" };
export type SimRow = { key: number; stamp: string; agent: string; tool: string; price: number; ok: boolean; reason: string | null; group: number };
export type SimNote = { kind: "good" | "bad" | ""; text: string };
export type Sim = {
  cap: number; unsettled: number; hold: number; committed: number; refused: number; served: number; captured: number; fee: number; released: number;
  closed: boolean; t: number; running: boolean; idle: boolean; started: boolean; speed: number; runaway: boolean;
  agents: SimAgent[]; events: SimEvent[]; hist: { t: number; h: number }[]; rows: SimRow[]; gseq: number; fx: Fx; note: SimNote;
};
export type RopeEvent = { agent: number; kind: "served" | "refused"; text: string };

const AG: { id: string; color: [number, number, number]; pol: string }[] = [
  { id: "research", color: [188, 60, 62], pol: "Asks the free check_budget first. Buys a $0.03 summary only if it fits. Stands down when it does not." },
  { id: "finance", color: [40, 26, 92], pol: "Buys $0.02 lookups. Every fourth round it reaches for a $0.20 bundle. One refusal and it stops reaching." },
  { id: "runaway", color: [36, 66, 68], pol: "Never checks. Retries at once and raises the price each time. Gives up after repeated bursts of refusals." },
];
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
export const feeFor = (c: number) => 49 + Math.round(c * 0.0349);
export const decide = (price: number, v: { hold: number; committed: number; unsettled: number }): { ok: boolean; reason: "cap_reached" | "exposure_limit" | null } =>
  price > v.hold ? { ok: false, reason: "cap_reached" } : v.committed + price > v.unsettled ? { ok: false, reason: "exposure_limit" } : { ok: true, reason: null };
export const spendableOf = (v: { hold: number; committed: number; unsettled: number }) => Math.max(0, Math.min(v.hold, v.unsettled - v.committed));

const rng = (a: number) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let q = Math.imul(a ^ a >>> 15, 1 | a); q = q + Math.imul(q ^ q >>> 7, 61 | q) ^ q; return ((q ^ q >>> 14) >>> 0) / 4294967296; };
let rnd = rng(7);
let cfg = { cap: 1000, speed: 1, runaway: true };

function fresh(): Sim {
  const ag: SimAgent[] = AG.filter(a => cfg.runaway || a.id !== "runaway").map(a => ({ ...a, served: 0, refused: 0, charged: 0, next: .5 + rnd() * 1.1, state: "Waiting to start.", bad: false, n: 0, streak: 0, idle: false, learned: false, stood: 0, backoffs: 0 }));
  return { cap: cfg.cap, unsettled: Math.round(cfg.cap * .7), hold: cfg.cap, committed: 0, refused: 0, served: 0, captured: 0, fee: 0, released: 0, closed: false, t: 0, running: false, idle: false, started: false, speed: cfg.speed, runaway: cfg.runaway,
    agents: ag, events: [], hist: [{ t: 0, h: cfg.cap }], rows: [], gseq: 1, fx: { n: 0, kind: "pour", price: null }, note: { kind: "", text: "" } };
}

let sim: Sim = fresh();
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();
const ropeSubs = new Set<(e: RopeEvent) => void>();
const emit = () => { sim = { ...sim }; subs.forEach(f => f()); };
export const useSim = () => useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => sim, () => sim);
export const onRopeEvent = (f: (e: RopeEvent) => void) => { ropeSubs.add(f); return () => { ropeSubs.delete(f); }; };

function submit(i: number, tool: string, price: number) {
  const s = sim, a = s.agents[i]!, d = decide(price, s), stamp = `T+${Math.floor(s.t)}s`;
  if (d.ok) {
    s.committed += price; s.hold -= price; s.served++; a.served++; a.charged += price; s.gseq++;
    s.hist.push({ t: s.t, h: s.hold }); s.events.push({ t: s.t, a: i, k: "ok" });
    s.rows.unshift({ key: s.served + s.refused, stamp, agent: a.id, tool, price, ok: true, reason: null, group: s.gseq });
    s.fx = { n: s.fx.n + 1, kind: "pour", price };
    s.note = { kind: "good", text: `${a.id} · ${tool} · ${money(price)} served. Two journal rows, group-${s.gseq}.` };
    ropeSubs.forEach(f => f({ agent: i, kind: "served", text: "" }));
  } else {
    s.refused++; a.refused++; s.events.push({ t: s.t, a: i, k: "no" });
    s.rows.unshift({ key: s.served + s.refused, stamp, agent: a.id, tool, price, ok: false, reason: d.reason, group: 0 });
    s.fx = { n: s.fx.n + 1, kind: "steam", price };
    s.note = { kind: "bad", text: `${a.id} · ${tool} · ${money(price)} refused (${d.reason}). Nothing charged, the tool did not run.` };
    ropeSubs.forEach(f => f({ agent: i, kind: "refused", text: `${d.reason} ${money(price)}` }));
  }
  if (s.rows.length > 80) s.rows.length = 80;
  if (s.events.length > 600) s.events.splice(0, 100);
  return d;
}

function act(a: SimAgent, i: number) {
  const s = sim, sp = spendableOf(s), gap = 1.2 + rnd() * 1.6;
  if (a.id === "research") {
    s.events.push({ t: s.t, a: i, k: "pre" });
    if (3 <= sp) { a.state = `check_budget: yes (${money(sp)} left). Calling summarise.`; a.bad = false; submit(i, "summarise", 3); a.next = gap; }
    else { a.stood++; a.state = `check_budget: no, ${money(sp)} left. Standing down, nothing sent.`; a.bad = false; a.next = gap; if (a.stood >= 2) { a.idle = true; a.state = "Stood down. Never refused."; } }
  } else if (a.id === "finance") {
    a.n++;
    const big = a.n % 4 === 0 && !a.learned, d = submit(i, big ? "bundle" : "lookup", big ? 20 : 2);
    if (!d.ok) { a.streak++; a.bad = true; if (big) { a.learned = true; a.state = `Refused at $0.20 (${d.reason}). Stops reaching, buys lookups only.`; } else a.state = `Refused at $0.02 (${d.reason}).`; if (a.streak >= 2) { a.idle = true; a.state = "Out of room. Stopped after two refusals."; } }
    else { a.streak = 0; a.bad = false; a.state = `Lookup served. ${money(a.charged)} spent so far.`; }
    a.next = gap;
  } else {
    a.n++;
    const p = Math.min(60, 6 + 6 * a.n), d = submit(i, "report", p);
    if (!d.ok) {
      a.streak++; a.bad = true; a.state = `Refused (${d.reason}) at ${money(p)}. Retrying at once.`; a.next = .45 + rnd() * .4;
      if (a.streak >= 6) { a.streak = 0; a.backoffs++; a.next = 9; a.state = "Six refusals. Backing off."; if (a.backoffs >= 2) { a.idle = true; a.state = "Gave up. Every refusal cost $0.00."; } }
    } else { a.streak = 0; a.bad = false; a.state = `Served ${money(p)}. Raising the price.`; a.next = 1.1 + rnd() * .7; }
  }
}

function stop(done: boolean) {
  sim.running = false;
  if (timer) { clearInterval(timer); timer = null; }
  if (done) { sim.idle = true; sim.note = { kind: "", text: "Autopilot idle. Every agent has stopped or been stopped." }; }
  emit();
}
function tick() {
  const s = sim; if (!s.running) return;
  s.t += .1 * s.speed;
  s.agents.forEach((a, i) => { if (a.idle) return; a.next -= .1 * s.speed; if (a.next <= 0) act(a, i); });
  if (s.agents.every(a => a.idle) || s.t > 240) { stop(true); return; }
  emit();
}

export const simApi = {
  start() { if (sim.closed || sim.idle || sim.running) return; sim.running = true; sim.started = true; if (timer) clearInterval(timer); timer = setInterval(tick, 100); emit(); },
  pause() { if (sim.running) stop(false); },
  reset() { if (timer) { clearInterval(timer); timer = null; } rnd = rng(7); sim = fresh(); sim.note = { kind: "", text: "Reset. A fresh simulated hold, nothing spent." }; subs.forEach(f => f()); },
  setCap(c: number) { cfg = { ...cfg, cap: c }; simApi.reset(); },
  setRunaway(r: boolean) { cfg = { ...cfg, runaway: r }; simApi.reset(); },
  setSpeed(v: number) { cfg = { ...cfg, speed: v }; sim.speed = v; emit(); },
  overreach(i?: number) {
    const s = sim; if (s.closed || !s.agents.length) return;
    const k = i ?? s.agents.length - 1, price = spendableOf(s) + Math.max(1, Math.round(s.cap * .05));
    s.t += .01; const d = submit(k, "report", price); const a = s.agents[k]!; a.bad = !d.ok; a.state = `Pushed past the limit: ${d.ok ? "served" : `refused (${d.reason})`} at ${money(price)}.`; emit();
  },
  close() {
    if (sim.closed || sim.served === 0) return;
    stop(false);
    const s = sim;
    s.captured = s.committed; s.fee = feeFor(s.committed); s.released = s.hold; s.hold = 0; s.closed = true; s.idle = true;
    s.note = { kind: "good", text: `Settled (illustration): captured ${money(s.captured)}, released ${money(s.released)}. Reset to run again.` };
    emit();
  },
};
