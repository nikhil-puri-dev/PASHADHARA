"use client";
import { useState } from "react";
import s from "../../app/v3.module.css";
import { parseDollars } from "../../lib/showcase-actions";
import { REASON, usd } from "../../lib/showcase-store";
import { cx, EndedNotice, Provenance, smallPrice } from "./bits";
import { Receipt } from "./receipt";
import { liveCheck, recordedCheck, RECORDED, resetChecks, type Budget } from "./state";
import { Thurible } from "./thurible";

/* Try a call: POST /api/showcase/try runs the real limit check against the live hold and posts nothing.
   With no live read, only the two recorded decisions are offered. */
export function TryView({ b }: { b: Budget }) {
  const [raw, setRaw] = useState<string | null>(null);
  const live = b.mode === "live";
  const typed = raw ?? ((b.free + 1) / 100).toFixed(2);
  const amount = parseDollars(typed);
  const bad = raw != null && amount == null;
  const check = () => { if (live && amount != null && !b.busy) void liveCheck(amount); };
  const last = b.checks[b.checks.length - 1];
  const preset = (c: number) => setRaw((c / 100).toFixed(2));

  return (
    <section aria-labelledby="try-h">
      <div className={s.mh}><h2 id="try-h" className={s.mhT}>Try a call</h2><span className={cx(s.num, s.dim)} style={{ fontSize: 14 }}>Free <b data-s="free" style={{ color: "var(--bone)", fontWeight: 500 }}>{b.mode === "loading" ? "..." : usd(b.free)}</b> · <Provenance b={b} /></span></div>
      <EndedNotice b={b} />
      <div className={s.bgrid}>
        <div>
          {b.mode === "recorded" ? (
            <>
              <p className={s.sub} style={{ margin: "0 0 16px" }}>The live hold cannot be reached, so checks are off. Two decisions from the recorded run of {b.recordedDate} are available.</p>
              <div className={s.ctrls} style={{ marginTop: 0 }}>
                <button className={cx(s.btn, s.neg)} type="button" onClick={() => recordedCheck("blocked")}>Show the recorded refusal ({usd(RECORDED.blockedPrice)})</button>
                <button className={cx(s.btn, s.pri)} type="button" onClick={() => recordedCheck("served")}>Show the recorded lookup ({usd(RECORDED.servedPrice)})</button>
                <button className={s.btn} type="button" onClick={resetChecks}>Reset view</button>
              </div>
            </>
          ) : (
            <>
              <div className={s.field}>
                <label htmlFor="v3-amt">Price of the next call</label>
                <div className={s.amount} data-bad={bad}><span>$</span><input id="v3-amt" inputMode="decimal" value={typed} autoComplete="off" aria-invalid={bad} disabled={!live} onChange={e => setRaw(e.target.value)} onKeyDown={e => { if (e.key === "Enter") check(); }} /></div>
                {bad && <p role="alert" className={s.dim} style={{ color: "hsl(8 90% 76%)", fontSize: 14 }}>Enter an amount from $0.01 to $999,999.99.</p>}
              </div>
              <div className={s.chips}>
                {b.lastSummarise != null && <button className={s.pre} type="button" disabled={!live} onClick={() => preset(smallPrice(b))}>{usd(smallPrice(b))} summarise</button>}
                <button className={s.pre} type="button" disabled={!live} onClick={() => preset(b.free + 1)}>one cent over</button>
                <button className={s.pre} type="button" disabled={!live || b.free < 1} onClick={() => preset(b.free)}>exactly what is left</button>
              </div>
              <div className={s.ctrls}>
                <button className={cx(s.btn, s.pri)} type="button" disabled={!live || b.busy || amount == null} onClick={check}>{b.busy ? "Checking..." : "Check the call"}</button>
                <button className={s.btn} type="button" onClick={() => { resetChecks(); setRaw(null); }} title="Clears this tab's checks. The hold is not changed.">Reset view</button>
              </div>
            </>
          )}
          <div style={{ marginTop: 32, maxWidth: 340 }}><Thurible id="T" levels={{ cap: b.cap, free: b.free, committed: b.committed }} fx={b.fx} served={live ? b.served : undefined} /></div>
        </div>
        <div className={s.out}>
          {!last ? <div className={s.ph}>The receipt appears here. A refusal leaves no charge and the tool never starts.</div>
            : last.reason === "error" ? <Receipt refused head={[`Check ${String(last.n).padStart(2, "0")}`, "not completed"]} amount={last.price != null ? usd(last.price) : "n/a"} rows={[["Result", "no answer"], ["Detail", last.error ?? ""], ["Charged", "$0.00"], ["Posted", "nothing"]]} />
            : <Receipt refused={!last.ok} head={[`Check ${String(last.n).padStart(2, "0")}`, last.recorded ? "recorded run, not live" : "live gateway check"]} amount={usd(last.price)}
                rows={[
                  ["Result", last.ok ? "allowed" : (REASON[last.reason] ? last.reason : last.reason)],
                  ["Free at the check", last.remaining != null ? usd(last.remaining) : "n/a"],
                  ["Free after", last.after != null ? usd(last.after) : last.remaining != null ? `${usd(last.remaining)} (unchanged)` : "n/a"],
                  ["Tool ran", last.charged != null ? "Yes, in the recorded run" : "No, a check never runs the tool"],
                  ["Charged", usd(last.charged ?? 0)],
                  ["PayPal capture", "none, not by this page"],
                ]} />}
        </div>
      </div>
    </section>
  );
}
