"use client";
import { useEffect, useRef } from "react";
import { setMode } from "./app";
import { useMotion } from "./motion";
import { initRope, type RopeApi } from "./rope-engine";
import { onRopeEvent, simApi, spendableOf, useSim, type Sim } from "./sim";
import { cx, money, Pv } from "./ui";

function RopeCanvas({ sim }: { sim: Sim }) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<RopeApi | null>(null);
  const { still } = useMotion();
  const stillRef = useRef(still); stillRef.current = still;
  useEffect(() => {
    if (!host.current) return;
    const mono = getComputedStyle(host.current).getPropertyValue("--mono").trim() || "ui-monospace,monospace";
    const eng = initRope(host.current, { mono, isStill: () => stillRef.current, onOver: i => simApi.overreach(i) });
    api.current = eng;
    const off = onRopeEvent(e => { if (e.kind === "served") eng.served(e.agent); else eng.refused(e.agent, e.text); });
    return () => { off(); eng.destroy(); api.current = null; };
  }, []);
  useEffect(() => { api.current?.setAgents(sim.agents); api.current?.reset(); }, [sim.agents]);
  useEffect(() => { api.current?.active(sim.running); }, [sim.running]);
  const sp = spendableOf(sim);
  useEffect(() => { api.current?.update(sp / sim.unsettled, sim.cap, `May still be spent · ${money(sp)}`); }, [sp, sim.unsettled, sim.cap, sim.agents, still]);
  return <div className="ropewrap" ref={host} />;
}

/* Each agent's calls over time, and the hold's free balance under them. */
function Lanes({ sim }: { sim: Sim }) {
  const n = sim.agents.length, W = 640, gx = 78, gw = W - gx - 12, laneH = 26, top = 4;
  if (!sim.started) return <div className="lanes"><svg viewBox="0 0 640 70" role="img" aria-label="Calls over time appear here after the autopilot starts"><text x="320" y="38" textAnchor="middle">Calls over time appear here once the autopilot runs.</text></svg></div>;
  const Tm = Math.max(40, sim.t + 3), x = (t: number) => gx + t / Tm * gw;
  const yb = top + n * laneH + 26, ch = 84, cy = (v: number) => yb + ch - v / sim.cap * ch;
  let pts = "", last: number | null = null;
  sim.hist.forEach(p => { if (last !== null) pts += ` ${x(p.t).toFixed(1)},${cy(last).toFixed(1)}`; pts += ` ${x(p.t).toFixed(1)},${cy(p.h).toFixed(1)}`; last = p.h; });
  pts += ` ${x(sim.t).toFixed(1)},${cy(last ?? sim.cap).toFixed(1)}`;
  const sl = cy(sim.cap - sim.unsettled);
  return (
    <div className="lanes">
      <svg viewBox={`0 0 ${W} ${yb + ch + 10}`} role="img" aria-label="Each agent's calls over time: teal diamonds are served, red crosses are refused. Below, the hold's free balance.">
        {sim.agents.map((a, i) => { const y = top + i * laneH + laneH / 2; return <g key={a.id}><line x1={gx} x2={W - 8} y1={y} y2={y} stroke="hsl(350 15% 17%)" /><text x="0" y={y + 4}>{a.id}</text></g>; })}
        {sim.events.map((e, i) => { const yy = top + e.a * laneH + laneH / 2, xx = x(e.t);
          return e.k === "ok" ? <path key={i} d={`M${xx} ${yy - 5}l4 5l-4 5l-4 -5z`} fill="hsl(188 62% 64%)" />
            : e.k === "no" ? <path key={i} d={`M${xx - 4} ${yy - 4}l8 8m0 -8l-8 8`} stroke="hsl(8 84% 58%)" strokeWidth="2" strokeLinecap="round" />
            : <circle key={i} cx={xx} cy={yy} r="2.4" fill="none" stroke="hsl(350 8% 56%)" />; })}
        <polygon points={`${x(0).toFixed(1)},${yb + ch} ${pts.trim()} ${x(sim.t).toFixed(1)},${yb + ch}`} fill="hsl(188 58% 42% / .28)" />
        <polyline points={pts.trim()} fill="none" stroke="hsl(188 62% 64%)" strokeWidth="1.8" />
        <line x1={gx} x2={W - 8} y1={sl} y2={sl} stroke="hsl(40 78% 58%)" strokeDasharray="4 4" />
        <text x={W - 8} y={sl - 5} textAnchor="end" style={{ fill: "hsl(40 78% 58%)" }}>spend limit leaves {money(sim.cap - sim.unsettled)} free</text>
        <text x="0" y={yb + 12}>free</text><text x="0" y={yb + 26}>{money(sim.hold)}</text><text x={gx} y={yb - 8}>{money(sim.cap)} hold</text>
      </svg>
    </div>
  );
}

export function Autopilot() {
  const sim = useSim();
  const seg = (v: number, set: (n: number) => void, opts: number[], fmt: (n: number) => string, label: string) => (
    <div className="fld"><span>{label}</span><div className="seg" role="group" aria-label={label}>{opts.map(o => <button key={o} type="button" aria-pressed={v === o} onClick={() => set(o)}>{fmt(o)}</button>)}</div></div>
  );
  return (
    <>
      <div className="ctl">
        {seg(sim.cap, simApi.setCap, [500, 1000, 2000], c => `$${c / 100}`, "Hold size")}
        {seg(sim.speed, simApi.setSpeed, [1, 3, 8], n => `${n}x`, "Speed")}
        <label className="chk"><input type="checkbox" checked={sim.runaway} onChange={e => simApi.setRunaway(e.target.checked)} />include a runaway agent</label>
      </div>
      <div className="ctl">
        {sim.running ? <button className="btn" type="button" onClick={simApi.pause}>Pause</button>
          : !sim.idle && !sim.closed ? <button className="btn pri" type="button" onClick={() => { setMode("sim"); simApi.start(); }}>{sim.started ? "Resume autopilot" : "Run autopilot"}</button> : null}
        <button className="btn" type="button" disabled={sim.closed} onClick={() => { setMode("sim"); simApi.overreach(); }}>Push an agent past the limit</button>
        <button className="btn" type="button" onClick={simApi.reset}>Reset</button>
      </div>
      <RopeCanvas sim={sim} />
      <p className="rope-cap">The loop is how much the agents may still spend. It tightens as money is committed and it does not give. Drag an agent past it.</p>
      <div className="roster">
        {sim.agents.map(a => (
          <div className="ag" key={a.id}>
            <div className="nm"><i style={{ background: `hsl(${a.color[0]} ${a.color[1]}% ${a.color[2]}%)` }} />{a.id}</div>
            <div className="pol">{a.pol}</div>
            <div className="cn"><span><b>{a.served}</b> served · {money(a.charged)}</span><span className={cx(a.refused > 0 && "red")}><b>{a.refused}</b> refused · $0.00</span></div>
            <div className={cx("st", a.bad && "bad")}>{a.state}</div>
          </div>
        ))}
      </div>
      <Lanes sim={sim} />
      <div className="tape scroll" role="log" aria-label="Simulated calls">
        {sim.rows.length === 0 ? <div className="tape-e">No calls yet. The agents have a hold and nothing else.</div>
          : sim.rows.map(r => (
            <div key={r.key} className={cx("tp", !r.ok && "ref")}><span className="dim">{r.stamp}</span><span className="a">{r.agent} · {r.tool}</span><span className="pr num">{money(r.price)}</span><span className="vd">{r.ok ? `served · group-${r.group}` : `refused · ${r.reason} · no ledger group`}</span></div>
          ))}
      </div>
      {sim.idle && !sim.closed && (
        <div className="idle"><span><b>Autopilot idle.</b> {sim.served} served for {money(sim.committed)} committed. {sim.refused} refused, each charged $0.00. Nobody pressed anything.</span><a className="btn pri sm" href="#s3">Settle this run ↓</a></div>
      )}
      <p className="note"><Pv k="illustrative" /> A simulation in this browser. The rules are the gateway's (cap first, then the spend limit). The agents are scripts, and prices other than $0.03 for summarise are made up.</p>
    </>
  );
}
