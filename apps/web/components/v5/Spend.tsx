"use client";
import { setMode, useMode, type Mode } from "./app";
import { AgentRun } from "./AgentRun";
import { Autopilot } from "./Autopilot";
import { LiveCheck } from "./LiveCheck";
import { useBudget } from "./state";
import { cx, Pv } from "./ui";

const TABS: { m: Mode; label: string; sub: string }[] = [
  { m: "live", label: "Live hold", sub: "Ask the real limit check. Posts nothing." },
  { m: "run", label: "Agent run", sub: "Replay of a recorded run." },
  { m: "sim", label: "Autopilot", sub: "A drill in your browser." },
];

export function Spend() {
  const mode = useMode(), b = useBudget();
  const pv = (m: Mode) => m === "live" ? (b.mode === "live" ? <Pv k={b.stale ? "last" : "live"} /> : b.mode === "recorded" ? <Pv k="recorded" /> : null) : m === "run" ? <Pv k="recorded" /> : <Pv k="illustrative" />;
  return (
    <section className="stage" id="s2">
      <div className="stage-h"><span className="stage-n">2</span><h2>Agents spend. <em>The gateway decides.</em></h2></div>
      <p className="stage-lede"><b>Live</b> checks a spend against the current hold for free. The separate paid summary commits sandbox funds. <b>Agent run</b> replays a model’s recorded decisions. <b>Autopilot</b> is a browser simulation with scripted agents.</p>
      <div className="tabs" role="tablist" aria-label="Which view of the decision">
        {TABS.map(t => (
          <button key={t.m} className={cx("tab", t.m === "sim" && "simt")} role="tab" id={`tab-${t.m}`} aria-selected={mode === t.m} aria-controls={`pan-${t.m}`} tabIndex={mode === t.m ? 0 : -1} type="button" onClick={() => setMode(t.m)}
            onKeyDown={e => { const i = TABS.findIndex(x => x.m === mode); if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) { e.preventDefault(); const n = e.key === "Home" ? TABS[0]! : e.key === "End" ? TABS[TABS.length - 1]! : TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!; setMode(n.m); document.getElementById(`tab-${n.m}`)?.focus(); } }}>
            {t.label} {pv(t.m)}<small>{t.sub}</small>
          </button>
        ))}
      </div>
      {TABS.map(t => (
        <div key={t.m} className="panel" role="tabpanel" id={`pan-${t.m}`} aria-labelledby={`tab-${t.m}`} hidden={mode !== t.m}>
          {t.m === "live" ? <LiveCheck /> : t.m === "run" ? <AgentRun /> : <Autopilot />}
        </div>
      ))}
    </section>
  );
}
