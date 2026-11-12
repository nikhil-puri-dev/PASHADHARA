"use client";
import { useEffect, useState } from "react";
import { parseDollars, runAgent, type RunResult } from "../../lib/showcase-actions";
import { usd, utc } from "../../lib/showcase-store";
import { liveCheck, recordedCheck, RECORDED, resetChecks, edgeOf, useBudget, type Budget, type Check } from "./state";
import { Verdict } from "./Verdict";
import { cx, Pv } from "./ui";

/* The nine things the gateway does with one call. A check runs the first five for real and posts nothing, so the rest are shown as "would run". */
const STEPS: [string, string][] = [
  ["Lease token", "One bearer token names one hold. A wrong token is a 401."],
  ["Idempotency key", "A new UUID per request. A repeat returns the stored result free."],
  ["Price", "Read from the server registry. The agent cannot set it."],
  ["Cap check", "Is the price within what is still free in the hold?"],
  ["Spend-limit check", "Would committed money pass the unsettled limit?"],
  ["Commit", "One journal group: committed up, free down."],
  ["Run the tool", "In the same transaction. A failure rolls the commit back."],
  ["Store the result", "So a lost answer can be replayed without paying twice."],
  ["Answer", "Result, price, remaining. A refusal says why."],
];
type St = "ok" | "fail" | "skip" | "ghost" | "idle";
const LAB: Record<St, string> = { ok: "pass", fail: "refused here", skip: "not reached", ghost: "would run", idle: "·" };
function planFor(c: Check | undefined): St[] {
  if (!c || c.reason === "error") return STEPS.map(() => "idle");
  if (c.ok) return ["ok", "ok", "ok", "ok", "ok", "ghost", "ghost", "ghost", "ghost"];
  if (c.reason === "cap_reached") return ["ok", "ok", "ok", "fail", "skip", "skip", "skip", "skip", "skip"];
  return ["ok", "ok", "ok", "ok", "fail", "skip", "skip", "skip", "skip"];
}

export function Pipeline({ c }: { c: Check | undefined }) {
  const plan = planFor(c);
  return (
    <ol className="pipe" aria-label="What the gateway does with one call" key={c?.n ?? 0}>
      {STEPS.map((s, i) => (
        <li key={i} className={cx(plan[i] !== "idle" && "lit", plan[i])} style={{ animationDelay: `${i * 110}ms` }}>
          <span><b>{s[0]}</b><span className="d">{s[1]}</span></span><em>{LAB[plan[i]!]}</em>
        </li>
      ))}
    </ol>
  );
}

/* Same guard and key as the Budget page: one paid run per tab until its outcome is known. */
const PENDING_RUN = "pd-showcase-unconfirmed";
function PaidRun({ b }: { b: Budget }) {
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [res, setRes] = useState<RunResult | null>(null);
  useEffect(() => { try { setUncertain(sessionStorage.getItem(PENDING_RUN) === "yes"); } catch { /* private mode */ } }, []);
  const closed = b.mode !== "live" || !(Date.now() < b.honorMs), none = b.remainingCalls === 0;
  const go = async () => {
    if (busy || uncertain || closed || none) return;
    try { if (sessionStorage.getItem(PENDING_RUN) === "yes") return; sessionStorage.setItem(PENDING_RUN, "yes"); } catch { /* the run proceeds */ }
    setBusy(true); setRes(null);
    try {
      const r = await runAgent();
      if (r.kind === "error" && r.unknown) setUncertain(true); else { try { sessionStorage.removeItem(PENDING_RUN); } catch { /* ignore */ } }
      setRes(r);
    } finally { setBusy(false); }
  };
  return (
    <details className="paid">
      <summary>Run a paid sandbox tool</summary>
      <p className="note" style={{ marginTop: 10 }}>Summarise the prepared note about how this PayPal hold works. A successful request commits the gateway's price to this sandbox hold. {b.lastSummarise != null ? `Last recorded price: ${usd(b.lastSummarise)}. ` : ""}{b.honor ? `Spending closes ${utc(b.honor)}.` : ""}</p>
      {uncertain ? <p className="warn">A public tool run may have committed. This page cannot safely retry it. Check the journal.</p>
        : none ? <p className="note">No public runs left. Use the checks instead.</p>
        : b.mode !== "live" ? <p className="note">Paid runs need a live, open hold.</p>
        : <button className="btn" type="button" disabled={busy || closed || b.remainingCalls == null} onClick={() => void go()}>{busy ? "Running…" : "Run sandbox summary"}</button>}
      {res?.kind === "served" && <div className="verdict good"><span className="v1">Served, charged {usd(res.price)}</span><span className="v2">Free after: {usd(res.remaining)}. The tool ran. No PayPal capture by this request.</span><div className="v3"><Pv k="live">live sandbox run</Pv></div></div>}
      {res?.kind === "refused" && <div className="verdict bad"><span className="v1">Refused: {res.reason}</span><span className="v2">The tool did not run. $0.00 charged.</span></div>}
      {res?.kind === "error" && <p className="warn" role="status">{res.message}</p>}
    </details>
  );
}

export function LiveCheck() {
  const b = useBudget();
  const edge = edgeOf(b), live = b.mode === "live", rec = b.mode === "recorded", ended = b.mode === "ended";
  const [raw, setRaw] = useState<string | null>(null);
  const typed = raw ?? ((edge + 1) / 100).toFixed(2);
  const amount = parseDollars(typed), bad = raw != null && amount == null;
  const go = () => { if (live && amount != null && !b.busy) void liveCheck(amount); };
  const last = b.checks[b.checks.length - 1];
  const preset = (c: number) => setRaw((c / 100).toFixed(2));
  return (
    <>
      {rec ? (
        <div className="comp">
          <p className="note" style={{ margin: 0, flexBasis: "100%" }}>The live hold cannot be reached, so checks are off. Two decisions from the recorded run of {b.recordedDate} are available.</p>
          <button className="btn neg" type="button" onClick={() => recordedCheck("blocked")}>Show the recorded refusal ({usd(RECORDED.blockedPrice)})</button>
          <button className="btn pri" type="button" onClick={() => recordedCheck("served")}>Show the recorded lookup ({usd(RECORDED.servedPrice)})</button>
        </div>
      ) : (
        <>
          <div className="comp">
            <div className="fld"><label htmlFor="v5-amt">Price of the next call</label>
              <div className="amount" data-bad={bad}><span>$</span><input id="v5-amt" inputMode="decimal" value={typed} autoComplete="off" aria-invalid={bad} disabled={!live} onChange={e => setRaw(e.target.value)} onKeyDown={e => { if (e.key === "Enter") go(); }} /></div></div>
            <button className="btn pri" type="button" disabled={!live || b.busy || amount == null} onClick={go}>{b.busy ? "Checking…" : "Check, free"}</button>
            <button className="btn sm" type="button" onClick={() => { resetChecks(); setRaw(null); }}>Reset view</button>
          </div>
          {bad && <p role="alert" className="warn">Enter an amount from $0.01 to $999,999.99.</p>}
          <div className="chips">
            {b.unsettled != null && <button className="chip" type="button" disabled={!live || edge < 1} onClick={() => preset(edge)}>{usd(edge)} · most it may spend</button>}
            <button className="chip" type="button" disabled={!live} onClick={() => preset(edge + 1)}>{usd(edge + 1)} · one cent over</button>
            <button className="chip" type="button" disabled={!live} onClick={() => preset(b.free + 1)}>{usd(b.free + 1)} · more than the hold has left</button>
          </div>
        </>
      )}
      {ended && <p className="note"><b>Spending is closed.</b> The hold ended; checks are off.</p>}
      <Pipeline c={last} />
      <div className="res" aria-live="polite"><Verdict c={last} b={b} /></div>
      <PaidRun b={b} />
    </>
  );
}
