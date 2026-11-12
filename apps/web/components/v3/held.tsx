"use client";
import { useEffect, useRef } from "react";
import s from "../../app/v3.module.css";
import { cx, lastLine, Readout, useActions } from "./bits";
import { initHeld, type HeldApi } from "./held-engine";
import { useMotion } from "./motion";
import { liveCheck, recordedCheck, type Budget } from "./state";

/* "Held, not watched". The loop follows the real free balance. Dragging an agent past the rope runs a real limit check
   (or replays the recorded refusal when no live read exists). */
export function Held({ b }: { b: Budget }) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<HeldApi | null>(null);
  const { still } = useMotion();
  const stillRef = useRef(still); stillRef.current = still;
  const bRef = useRef(b); bRef.current = b;
  const a = useActions(b);
  const closed = b.mode === "ended";

  useEffect(() => {
    if (!host.current || b.mode === "loading") return;
    const mono = getComputedStyle(host.current).getPropertyValue("--mono").trim() || "ui-monospace,monospace";
    const eng = initHeld(host.current, {
      cap: b.cap, mono, isStill: () => stillRef.current,
      onOver: () => {
        const cur = bRef.current;
        if (cur.mode === "live") void liveCheck(cur.free + 1);
        else if (cur.mode === "recorded") recordedCheck("blocked");
      },
    });
    api.current = eng; eng.update(bRef.current.free);
    return () => { eng.destroy(); api.current = null; };
  }, [b.cap, b.mode === "loading"]);

  useEffect(() => { api.current?.update(b.free); }, [b.free]);
  useEffect(() => { api.current?.refresh(); }, [still]);
  const seen = useRef(b.fx.n);
  useEffect(() => {
    if (b.fx.n === seen.current) return;
    seen.current = b.fx.n;
    if (b.fx.kind === "steam") api.current?.strain(`cap_reached${b.fx.price != null ? ` · $${(b.fx.price / 100).toFixed(2)}` : ""}`);
    else api.current?.serve();
  }, [b.fx.n]);

  return (
    <section className={cx(s.sec, s.held, s.band0)} id="held" aria-labelledby="held-h">
      <div className={s.wrap}>
        <div className={s.stagebox}>
          <div className={s.hcanvas} ref={host} />
          <div className={s.hcopy}><h2 id="held-h">Held, <em>not</em> watched.</h2><p>The pasha is your hold. It tightens as money is committed, and it does not give.</p></div>
          <div className={s.hhint}>Drag any agent against the rope.</div>
          <Readout b={b} host={s.hread} />
          <div className={s.hact}>
            <button className={cx(s.btn, s.pri)} type="button" disabled={a.disabled || closed} onClick={() => void a.small()}>{a.smallLabel}</button>
            <button className={cx(s.btn, s.neg)} type="button" disabled={a.disabled || closed} onClick={() => void a.over()}>{b.mode === "recorded" ? "Replay the recorded refusal" : "Pull past the limit"}</button>
          </div>
        </div>
        <p className={s.hstatus}>{lastLine(b)}</p>
      </div>
    </section>
  );
}
