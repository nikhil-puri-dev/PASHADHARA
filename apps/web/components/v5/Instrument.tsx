"use client";
/* The persistent instrument: one vessel, three sources (live hold, recorded agent run, autopilot drill).
   Desktop: sticky card beside the story. Phones: a slim bar under the header (Minibar) plus one vessel in the hero. */
import { age } from "../../lib/showcase-store";
import { setMode, useMode, useView, type Mode, type View } from "./app";
import { useBudget, useNow, type Budget } from "./state";
import { Thurible } from "./Thurible";
import { cx, money, Pv, utc } from "./ui";

export const MODES: { m: Mode; label: string }[] = [{ m: "live", label: "Live hold" }, { m: "run", label: "Agent run" }, { m: "sim", label: "Autopilot" }];

export function Chip({ b, v, short, mode = v.mode }: { b: Budget; v: View; short?: boolean; mode?: Mode }) {
  const now = useNow(1000);
  if (mode === "sim") return <><Pv k="illustrative" />{!short && <span>Simulated {money(v.cap)} hold. Runs in this browser. No PayPal.</span>}</>;
  if (mode === "run") return <><Pv k="recorded" />{!short && <span>Replay of a run on 12 Nov. Not happening now.</span>}</>;
  if (b.mode === "loading") return <span className="dim">Reading the live hold…</span>;
  if (b.mode === "recorded") return <><Pv k="recorded">recorded, not live</Pv>{!short && <span>The live hold could not be reached. This is the {b.recordedDate} run.</span>}</>;
  const stale = b.stale && b.goodAt;
  return <><Pv k={stale ? "last" : "live"} />{!short && <span>{b.mode === "ended" ? "Hold ended. " : ""}{b.last4 ? `Sandbox hold ····${b.last4}, ` : ""}{stale ? `read ${age(now - b.goodAt!)} ago, the gateway did not answer` : `read ${b.readAt ? utc(b.readAt) : ""}`}</span>}</>;
}

export function ModeSwitch({ small }: { small?: boolean }) {
  const m = useMode();
  return (
    <div className={cx("seg", small && "seg-s")} role="group" aria-label="What the instrument shows">
      {MODES.map(x => <button key={x.m} type="button" aria-pressed={m === x.m} onClick={() => setMode(x.m)}>{x.label}</button>)}
    </div>
  );
}

/* Readout. With a spend limit: spendable now, committed, held back, refused. Without one: free, committed, refused. */
export function Readout({ v }: { v: View }) {
  const d = (n: number) => (v.loading ? "…" : money(n));
  const lim = v.spendable != null;
  if (v.closed) return (
    <div className="read">
      <div><small><i style={{ background: "var(--water2)" }} />Captured</small><span className="num">{d(v.captured)}</span></div>
      <div><small><i style={{ background: "var(--saf)" }} />PayPal fee</small><span className="num">{d(v.fee)}</span></div>
      {v.open > 0 ? <div><small><i style={{ background: "var(--n4)", boxShadow: "inset 0 0 0 1px var(--faint)" }} />Left open</small><span className="num">{d(v.open)}</span></div> : <div><small><i style={{ background: "var(--faint)" }} />Released</small><span className="num">{d(v.released)}</span></div>}
    </div>
  );
  return (
    <div className={cx("read", lim && "read4")}>
      {lim ? <div><small><i style={{ background: "var(--water)" }} />Spendable now</small><span className="num" data-b="spendable">{d(v.spendable!)}</span></div>
        : <div><small><i style={{ background: "var(--water)" }} />Free</small><span className="num" data-b="free">{d(v.free)}</span></div>}
      <div><small><i style={{ background: "var(--water2)" }} />Committed</small><span className="num" data-b="committed">{d(v.committed)}</span></div>
      {lim && <div><small><i style={{ background: "var(--saf)" }} />{v.ended ? "Unspendable" : "Held back"}</small><span className="num" data-b="heldback">{d(v.free - v.spendable!)}</span></div>}
      <div><small><i style={{ background: "var(--red)" }} />Refused</small><span className="num" data-b="refused">{v.loading ? "…" : String(v.refused)}</span></div>
    </div>
  );
}

function Caption({ v }: { v: View }) {
  if (v.ended) return <>The spending window has ended. The vessel shows the last hold balance and commitments.</>;
  if (v.closed) return v.open > 0 ? <>Captured once and the fee taken. The rest of the hold is still an open authorization, not voided.</> : <>Settled. Captured money left the vessel, the fee went to PayPal, the rest was released.</>;
  if (v.unsettled != null) return <>The vessel is the {money(v.cap)} hold. Calls draw from above the dashed line. The {money(v.cap - v.unsettled)} below it is held back for fees and the capture.</>;
  return <>The vessel is the {money(v.cap)} hold. Water is what is still free.</>;
}

export function InstrumentCard() {
  const b = useBudget(), v = useView(b);
  return (
    <div className={cx("inst", v.mode === "sim" && "is-sim", v.mode === "run" && "is-run")} id="inst">
      <ModeSwitch />
      <div className="inst-chip" style={{ marginTop: 10 }}><Chip b={b} v={v} /></div>
      <Thurible id="Ra" levels={{ cap: v.cap, free: v.free, committed: v.closed ? v.captured : v.committed, released: v.released, fee: v.fee, unsettled: v.unsettled }} fx={v.fx} served={v.mode === "live" && b.mode === "live" ? b.served : undefined} />
      <Readout v={v} />
      <div className={cx("evt", v.note.kind)} role="status" aria-live="polite">{v.note.text}</div>
      <p className="cap-line"><Caption v={v} /></p>
    </div>
  );
}

/* Phones: a slim sticky bar. Tag, three numbers, a gauge with the spend limit marked. The vessel itself sits in the hero. */
export function Minibar() {
  const b = useBudget(), v = useView(b);
  const lim = v.unsettled != null;
  const cp = v.closed ? v.captured : v.committed, fr = v.closed ? 0 : v.free;
  return (
    <div className={cx("minibar", v.mode === "sim" && "is-sim")}>
      <div className="mrow">
        <span className="mchip"><Chip b={b} v={v} short /></span>
        <span className="mnum"><b className="num">{v.loading ? "…" : money(v.spendable ?? v.free)}</b> <span className="mw">{v.spendable != null ? "spendable" : "free"}</span></span>
        <ModeCycle />
      </div>
      <div className="gauge" role="img" aria-label={`Committed ${money(cp)} of ${money(v.cap)}`}>
        <i className="gc" style={{ width: `${cp / v.cap * 100}%` }} /><i className="gf" style={{ width: `${fr / v.cap * 100}%` }} /><i className="gr" style={{ width: `${(v.closed ? v.released : 0) / v.cap * 100}%` }} />
        {lim && !v.closed && <span className="gl" style={{ left: `${v.unsettled! / v.cap * 100}%` }} />}
      </div>
    </div>
  );
}

const NEXT: Record<Mode, Mode> = { live: "run", run: "sim", sim: "live" };
function ModeCycle() {
  const m = useMode();
  const label = MODES.find(x => x.m === m)!.label;
  return <button className="mcycle" type="button" onClick={() => setMode(NEXT[m])} aria-label={`Showing: ${label}. Switch view.`}>{label}<span aria-hidden="true"> ⇄</span></button>;
}
