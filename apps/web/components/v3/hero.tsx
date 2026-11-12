"use client";
import Link from "next/link";
import s from "../../app/v3.module.css";
import { usd } from "../../lib/showcase-store";
import { cx, lastLine, Provenance, Readout, Tape, useActions } from "./bits";
import type { Budget } from "./state";
import { Thurible } from "./thurible";

/* Sliced "$20.01" headline. The amount in the words is the design's example; the numbers beside it are the live hold. */
export function Hero({ b }: { b: Budget }) {
  const a = useActions(b);
  const closed = b.mode === "ended";
  return (
    <header className={s.hero}>
      <div className={cx(s.wrap, s.heroGrid)}>
        <div>
          <h1>
            <span className={s.rise} style={{ animationDelay: ".2s", display: "block" }}>Your agent can</span>
            <span className={s.rise} style={{ animationDelay: ".35s", display: "block" }}>spend <em>$20.00.</em></span>
            <span className={cx(s.l3, s.rise)} style={{ animationDelay: ".5s", position: "relative" }}>Not $20.0<span className={s.cut} aria-hidden="true"><span className={s.g}>1</span><span className={s.up}>1</span><span className={s.dn}>1</span></span><span className={s.dotEnd}>.</span><span className={s.sronly}>1</span></span>
          </h1>
          <p className={cx(s.sub, s.rise)} style={{ animationDelay: ".8s" }}>The limit is a <b>PayPal hold you approved</b>. Every paid call is checked against it first. A call that does not fit is refused and nothing is charged.</p>
          <div className={cx(s.cta, s.rise)} style={{ animationDelay: ".95s" }}>
            <button className={cx(s.btn, s.pri)} type="button" disabled={a.disabled || closed} onClick={() => void a.small()}>{a.smallLabel}</button>
            <button className={cx(s.btn, s.neg)} type="button" disabled={a.disabled || closed} onClick={() => void a.over()}>{a.overLabel}</button>
            <Link className={s.lnk} href="/demo">Open the full demo <span aria-hidden="true">→</span></Link>
          </div>
          <p className={s.hstatus}><span className={cx(s.tag, s.dm)}>example</span> The headline amounts are the design's example. {b.mode === "live" || b.mode === "ended" ? `The live hold is ${usd(b.cap)}.` : b.mode === "recorded" ? `The recorded hold is ${usd(b.cap)}.` : ""}</p>
          <p className={s.hstatus} role="status" aria-live="polite">{lastLine(b)}</p>
          <Tape b={b} />
        </div>
        <div className={cx(s.heroV, s.rise)} style={{ animationDelay: "1s" }}>
          <Thurible id="L" levels={{ cap: b.cap, free: b.free, committed: b.committed }} fx={b.fx} served={b.mode === "live" ? b.served : undefined} />
          <Readout b={b} />
          <p className={s.hstatus}><Provenance b={b} /></p>
        </div>
      </div>
    </header>
  );
}
