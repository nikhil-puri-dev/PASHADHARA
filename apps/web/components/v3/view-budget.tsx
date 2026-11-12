"use client";
import { useEffect, useState } from "react";
import s from "../../app/v3.module.css";
import { runAgent, type RunResult } from "../../lib/showcase-actions";
import { shortId, usd, utc } from "../../lib/showcase-store";
import { cx, EndedNotice, lastLine, Provenance, Readout, Tape, useActions } from "./bits";
import { Receipt } from "./receipt";
import { resetChecks, type Budget } from "./state";
import { Thurible } from "./thurible";

/* Same guard and key as the existing Budget page: one paid run per tab until its outcome is known. */
const PENDING_RUN = "pd-showcase-unconfirmed";

function PaidRun({ b }: { b: Budget }) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [res, setRes] = useState<RunResult | null>(null);
  useEffect(() => { try { setUncertain(sessionStorage.getItem(PENDING_RUN) === "yes"); } catch { /* private mode */ } }, []);
  const closed = b.mode !== "live" || !(Date.now() < b.honorMs);
  const none = b.remainingCalls === 0;
  const go = async () => {
    if (busy || uncertain || closed || none) return;
    try { if (sessionStorage.getItem(PENDING_RUN) === "yes") return; sessionStorage.setItem(PENDING_RUN, "yes"); } catch { /* the run proceeds; reload cannot know */ }
    setBusy(true); setRes(null);
    try {
      const r = await runAgent();
      if (r.kind === "error" && r.unknown) setUncertain(true); else { try { sessionStorage.removeItem(PENDING_RUN); } catch { /* ignore */ } }
      setRes(r);
    } finally { setBusy(false); }
  };
  return (
    <details className={s.paid}>
      <summary>Run a paid sandbox tool</summary>
      <p>Summarise the prepared note about how this PayPal hold works. A successful request commits the tool price to this sandbox hold. {b.lastSummarise != null ? `Last recorded price: ${usd(b.lastSummarise)}. ` : ""}The current price is set by the gateway and is not quoted here.</p>
      {b.honor && <p>Spending closes {utc(b.honor)}.</p>}
      {uncertain ? <p className={s.warn}>A public tool run may have committed. This page cannot safely retry it. Check the journal.</p>
        : none ? <p>No public runs left. Use the checks instead.</p>
        : b.mode !== "live" ? <p>Paid runs need a live, open hold.</p>
        : <button className={s.btn} type="button" disabled={busy || closed || b.remainingCalls == null} onClick={() => void go()}>{busy ? "Running..." : "Run sandbox summary"}</button>}
      {res && res.kind === "served" && <Receipt refused={false} head={["Paid run", "live sandbox run"]} amount={usd(res.price)} rows={[["Result", "served"], ["Free after", usd(res.remaining)], ["Tool ran", "Yes"], ["Charged", usd(res.price)], ["PayPal capture", "none, not by this request"]]} />}
      {res && res.kind === "refused" && <Receipt refused head={["Paid run", "gateway refusal"]} amount={res.price != null ? usd(res.price) : "n/a"} rows={[["Result", res.reason], ["Tool ran", "No"], ["Charged", "$0.00"]]} />}
      {res && res.kind === "error" && <p className={s.warn} role="status">{res.message}</p>}
    </details>
  );
}

export function BudgetView({ b }: { b: Budget }) {
  const a = useActions(b);
  const closed = b.mode === "ended";
  return (
    <section aria-labelledby="bud-h">
      <div className={s.mh}><h2 id="bud-h" className={s.mhT}>Budget</h2><span className={cx(s.num, s.dim)} style={{ fontSize: 14 }}>{b.paypalId ? `Sandbox hold ${shortId(b.paypalId)} · ` : ""}<Provenance b={b} />{b.mode === "recorded" ? ` · ${b.recordedDate}` : ""}</span></div>
      <EndedNotice b={b} />
      <div className={s.bgrid}>
        <div><Thurible id="A" levels={{ cap: b.cap, free: b.free, committed: b.committed }} fx={b.fx} served={b.mode === "live" ? b.served : undefined} /><Readout b={b} /></div>
        <div>
          <div className={s.stats}>
            <div><small>Committed {b.mode === "live" && <span className={s.tag}>computed</span>}</small><div className={s.num} data-s="spent">{b.mode === "loading" ? "..." : usd(b.committed)}</div></div>
            <div><small>Free {b.mode === "live" && <span className={s.tag}>computed</span>}</small><div className={s.num} data-s="free">{b.mode === "loading" ? "..." : usd(b.free)}</div></div>
            <div><small>Served, journal</small><div className={s.num} data-s="served">{b.mode === "recorded" || b.mode === "loading" ? "n/a" : b.served}</div></div>
            <div><small>Refused, charged $0.00</small><div className={s.num} data-s="refd">{b.mode === "recorded" || b.mode === "loading" ? "n/a" : b.refused}</div></div>
          </div>
          <div className={s.ctrls}>
            <button className={cx(s.btn, s.pri)} type="button" disabled={a.disabled || closed} onClick={() => void a.small()}>{a.smallLabel}</button>
            <button className={cx(s.btn, s.neg)} type="button" disabled={a.disabled || closed} onClick={() => void a.over()}>{a.overLabel}</button>
            <button className={s.btn} type="button" onClick={resetChecks} title="Clears this tab's checks. The hold is not changed.">Reset view</button>
          </div>
          <p className={s.hstatus} role="status" aria-live="polite">{lastLine(b)}</p>
          <Tape b={b} />
          <PaidRun b={b} />
        </div>
      </div>
    </section>
  );
}
