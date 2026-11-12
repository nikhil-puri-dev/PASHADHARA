"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { cents, hold, REASON, usd, utc, useShowcase } from "../lib/showcase-store";
import { parseDollars, runAgent, tryAmount, type RunResult, type TryResult } from "../lib/showcase-actions";
import record from "./boundary-record.json";
import { Shell, useNow } from "./site";

type Tone = "refused" | "served" | "unknown";
type Mark = "ready" | "inside" | "over" | "unknown";

function Boundary({ state }: { state: Mark }) {
  return (
    <div className="boundary" data-state={state}>
      <div className="boundary-track" aria-hidden="true">
        <span className="boundary-rail" />
        <span className="boundary-limit" />
        <span className="boundary-runner"><span className="boundary-tick" /></span>
      </div>
      <div className="boundary-key"><span>Inside the limit</span><span>Past it</span></div>
    </div>
  );
}

function Receipt({ tone, decision, detail, rows, next }: {
  tone: Tone; decision: string; detail: string; rows: [string, ReactNode][]; next: ReactNode;
}) {
  return (
    <div className="verdict" data-tone={tone} role="status">
      <div className="verdict-top">
        <div>
          <p className="verdict-decision">{decision}</p>
          <p className="verdict-detail">{detail}</p>
        </div>
        <div className="verdict-next">{next}</div>
      </div>
      <dl className="ledger">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </div>
  );
}

function Replay({ reason, titled, onEngage }: { reason?: string; titled: boolean; onEngage?: () => void }) {
  const [step, setStep] = useState<"ready" | "blocked" | "served">("ready");
  const { blocked, served } = record;
  const available = step === "served" ? served.remaining : blocked.remaining;
  const Heading = titled ? "h1" : "h2";
  const advance = () => { onEngage?.(); setStep(step === "served" ? "blocked" : "blocked" === step ? "served" : "blocked"); };
  return (
    <section className="slip" aria-label="Spending boundary">
      <p className="origin">{reason ? `${reason}. ` : ""}Recorded run, {record.date}. Not live.</p>
      <Heading>{titled ? "Can this agent make this spend?" : "Check a spend"}</Heading>
      <dl className="compare">
        <dt>Set by</dt><dd className="who"><span className="num">Sandbox buyer</span></dd>
        <dt>Limit</dt><dd><span className="num">{usd(record.hold)}</span><span className="unit">measured</span></dd>
        <dt>Available</dt><dd><span className="num">{usd(available)}</span><span className="unit">{step === "served" ? "computed, after this lookup" : "computed"}</span></dd>
        <dt>This request</dt><dd className="request-amt"><span className="num">{usd(step === "served" ? served.price : blocked.price)}</span><span className="unit">computed</span></dd>
      </dl>
      <p className="ask">{step === "served" ? "Check invoice pair A. Fixture invoices." : "Check invoice payments. Fixture invoices."}</p>
      <Boundary state={step === "ready" ? "ready" : step === "blocked" ? "over" : "inside"} />
      <div className="actionline">
        <button className="go" onClick={advance}>
          {step === "ready" ? `See the decision for ${usd(blocked.price)}` : step === "blocked" ? "See the lookup that fit" : "Show the refusal"}
        </button>
      </div>
      {step === "blocked" && (
        <Receipt tone="refused" decision="Refused" detail={`${usd(blocked.price - blocked.remaining)} over the limit`} next={<Link href="/proof#boundary-run">Run evidence</Link>} rows={[
          ["Tool", `did not run. ${usd(0)} charged. ${usd(blocked.remaining)} remained available.`],
          ["Money", "No PayPal capture. Journal unchanged."],
          ["Requested", "Check invoice payments"],
          ["Amount", usd(blocked.price)],
          ["Why", "Above what is available on the hold"],
          ["Evidence", `Recorded run, ${record.date}. Fixture invoices.`],
        ]} />
      )}
      {step === "served" && (
        <Receipt tone="served" decision="Served" detail={`${usd(served.price)} committed. ${usd(served.remaining)} left after this lookup`} next={<Link href="/proof#boundary-run">Run evidence</Link>} rows={[
          ["Tool", `Ran. Result ${served.id}, fixture: ${served.evidence}`],
          ["Money", `${usd(served.price)} committed. ${usd(served.remaining)} left. Journal commitment only. No PayPal capture.`],
          ["Requested", "Check invoice pair A"],
          ["Amount", usd(served.price)],
          ["Why", "Inside the limit the sandbox buyer set"],
          ["Evidence", "Recorded run. First of three lookups. Two later lookups also committed $0.02. The final model answer was truncated."],
        ]} />
      )}
    </section>
  );
}

export function Refusal({ r, check = false }: { r: TryResult | RunResult; check?: boolean }) {
  if (r.kind === "error") {
    const unknown = "unknown" in r && r.unknown;
    return (
      <Receipt tone="unknown" decision={unknown ? "Unknown" : "Not completed"} detail={r.message} next={unknown || !check ? <Link href="/activity">Check the journal</Link> : null} rows={[
        ["Tool", unknown ? "Unconfirmed" : "Did not finish"],
        ["Money", unknown ? "May have committed. Do not retry from this page." : "No charge was committed."],
        ["Requested", check ? "Limit check" : "Paid sandbox summary"],
        ["Why", unknown ? "No receipt came back." : "The gateway answered with an error."],
        ["Evidence", unknown ? "The journal is the record. This page cannot tell." : "No new journal row."],
      ]} />
    );
  }
  if (r.kind === "served") {
    return (
      <Receipt tone="served" decision="Allowed" detail="Amount fits the current limits" next={<Link href="/proof#limit-check">What this check proves</Link>} rows={[
        ["Tool", "Did not run"],
        ["Money", "Nothing was posted. No journal posting."],
        ["Requested", "Limit check"],
        ["Amount", usd(r.price)],
        ["Why", `${usd(r.price)} is within the ${usd(r.remaining)} available`],
        ["Evidence", "Live check. Computed. PayPal was not contacted."],
      ]} />
    );
  }
  const delta = r.price != null && r.remaining != null ? r.price - r.remaining : 0;
  const why = REASON[r.reason] ?? r.reason;
  return (
    <Receipt tone="refused" decision="Refused" detail={r.reason === "cap_reached" && delta > 0 ? `${usd(delta)} over the limit` : why} next={check ? <Link href="/proof#limit-check">What this check proves</Link> : <Link href="/activity">Check the journal</Link>} rows={[
      ["Tool", "Did not run"],
      ["Money", check ? `${r.remaining != null ? `${usd(r.remaining)} available at the check. ` : ""}$0.00 charged. Model did not run. No journal posting.` : "No charge committed."],
      ["Requested", check ? "Limit check" : "Paid sandbox summary"],
      ["Amount", r.price != null ? usd(r.price) : "Unavailable"],
      ["Why", why],
      ["Evidence", check ? "Live check. Nothing posted." : "Gateway refusal. No charge committed."],
    ]} />
  );
}

const PENDING_RUN = "pd-showcase-unconfirmed";

export function SpendingInstrument({ forceReplay = false, place = "check" }: { forceReplay?: boolean; place?: "check" | "budget" }) {
  const s = useShowcase(!forceReplay);
  const now = useNow(1000);
  const h = hold(s.data, now);
  const [busy, setBusy] = useState<"check" | "run" | null>(null);
  const [outcome, setOutcome] = useState<{ mode: "check" | "run"; result: TryResult | RunResult } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [lockedReplay, setLockedReplay] = useState(false);
  useEffect(() => {
    try { setUncertain(sessionStorage.getItem(PENDING_RUN) === "yes"); } catch { /* private mode */ }
  }, []);
  const live = !s.failedAt && (h?.state === "active" || h?.state === "expiring") && h.available != null && h.cap != null;
  const showReplay = forceReplay || lockedReplay || !live;
  if (showReplay) {
    const reason = forceReplay || s.loading ? undefined
      : h?.state === "ended" ? `Live spending window ended${h.honor ? ` ${utc(h.honor)}` : ""}`
      : !live ? "Live spending data unavailable"
      : undefined;
    return <Replay titled={place === "check"} onEngage={() => setLockedReplay(true)} {...(reason ? { reason } : {})} />;
  }
  const before = h.available as number;
  const cap = h.cap as number;
  const fallback = before + 1;
  const typed = raw ?? (fallback / 100).toFixed(2);
  const amount = parseDollars(typed);
  const bad = raw != null && amount == null;
  const attempted = amount ?? fallback;
  const go = async (mode: "check" | "run", price = attempted) => {
    if (busy || Date.now() >= h.honorMs || (mode === "run" && uncertain)) return;
    if (mode === "check" && amount == null) return;
    if (mode === "check" && raw == null) setRaw(typed);
    if (mode === "run") {
      try {
        if (sessionStorage.getItem(PENDING_RUN) === "yes") return;
        sessionStorage.setItem(PENDING_RUN, "yes");
      } catch { /* the run still proceeds; reload cannot know */ }
    }
    setBusy(mode);
    setOutcome(null);
    try {
      const result = mode === "run" ? await runAgent() : await tryAmount(price);
      if (mode === "run") {
        if (result.kind === "error" && "unknown" in result && result.unknown) setUncertain(true);
        else { try { sessionStorage.removeItem(PENDING_RUN); } catch { /* ignore */ } }
      }
      setOutcome({ mode, result });
    } finally { setBusy(null); }
  };
  const r = outcome?.result;
  const overLimit = r?.kind === "refused" && (r.reason === "cap_reached" || r.reason === "exposure_limit" || r.reason === "refused_cap" || r.reason === "refused_exposure");
  const mark: Mark = !r ? "ready" : r.kind === "error" ? "unknown" : r.kind === "refused" ? (overLimit ? "over" : "unknown") : "inside";
  const minutes = Number.isFinite(h.honorMs) ? Math.max(0, Math.ceil((h.honorMs - now) / 60_000)) : null;
  const lastPrice = cents(s.data?.calls?.slice().reverse().find(c => c.tool_id === "summarise" && c.status === "served")?.price_minor);
  const timeLeft = minutes == null ? "" : minutes > 60 ? `about ${Math.ceil(minutes / 60)} hours left` : `${minutes} minutes left`;
  const Heading = place === "check" ? "h1" : "h2";
  const title = place === "check" ? "Can this agent make this spend?" : "Check a spend";
  const pending = uncertain && <p className="pending" role="status">A public tool run may have committed. This demo cannot safely retry it. <Link href="/activity">Check the journal</Link></p>;
  return (
    <section className="slip" aria-label="Spending boundary">
      <p className="origin">{place === "check" ? "Live check. Nothing posted." : "Live hold. This amount check posts nothing. A paid run below can commit."}</p>
      <Heading>{title}</Heading>
      <form onSubmit={e => { e.preventDefault(); void go("check"); }}>
        <dl className="compare">
          {place === "check" && <>
            <dt>Set by</dt><dd className="who"><span className="num">Sandbox buyer</span></dd>
            <dt>Limit</dt><dd><span className="num">{usd(cap)}</span><span className="unit">computed</span></dd>
            <dt>Available</dt><dd><span className="num">{usd(before)}</span><span className="unit">computed</span></dd>
          </>}
          <dt><label htmlFor="instrument-amount">Amount in USD</label></dt>
          <dd className="request-amt"><span className="num"><input className="amt" id="instrument-amount" value={typed} inputMode="decimal" aria-invalid={bad} onChange={e => { setRaw(e.target.value); setOutcome(null); }} /></span><span className="unit">live check</span></dd>
        </dl>
        <p className="ask">{bad ? "That amount cannot be checked. The tool does not run." : raw == null ? "Prepared as one cent over the available hold. Change the amount to test another. The tool does not run." : "Checking the amount in the field. The tool does not run."}</p>
        {bad && <p role="alert">Enter an amount from $0.01 to $999,999.99.</p>}
        <Boundary state={mark} />
        <div className="actionline">
          <button className="go" type="submit" disabled={!!busy || amount == null}>{busy === "check" ? "Checking…" : amount == null ? "Enter an amount" : `See the decision for ${usd(amount)}`}</button>
          <Link href="/review">Open the recorded run</Link>
        </div>
      </form>
      {r && outcome?.mode === "run" && r.kind === "served" ? (
        <Receipt tone="served" decision="Served" detail={`${usd(r.price)} committed. ${usd(r.remaining)} left`} next={<Link href="/activity">Open the journal</Link>} rows={[
          ["Tool", "summary" in r && r.summary ? `Ran. ${r.summary}` : "Ran. Model output was not returned."],
          ["Money", `${usd(r.price)} committed. ${usd(r.remaining)} left. Journal commitment. No PayPal capture by this request.`],
          ["Requested", "Summarise the prepared note"],
          ["Amount", usd(r.price)],
          ["Why", "Inside the limits at the moment of the call"],
          ["Evidence", "Live sandbox run. The price was set by the gateway."],
        ]} />
      ) : r && <Refusal r={r} check={outcome?.mode === "check"} />}
      {pending}
      {place === "budget" && (
        <details className="paid">
          <summary>Run a paid sandbox tool</summary>
          <p>Summarise the prepared note about how this PayPal hold works. A successful request commits the tool price to this sandbox hold. {lastPrice != null ? `Last recorded price: ${usd(lastPrice)}. ` : ""}The current price is set by the gateway and is not quoted here.</p>
          <p className="unit">{h.honor ? `Spending closes ${utc(h.honor)}. ${timeLeft}.` : "Spending deadline unavailable."}</p>
          {uncertain || s.data?.remaining_calls === 0 ? <p>{uncertain ? "Paid run unavailable in this tab." : "No public runs left. Use the recorded run."}</p> : (
            <p><button className="go secondary" type="button" disabled={!!busy || uncertain || !h.honor || s.data?.remaining_calls == null} onClick={() => void go("run")}>{busy === "run" ? "Running…" : "Run sandbox summary"}</button></p>
          )}
        </details>
      )}
    </section>
  );
}

export function Home({ review = false }: { review?: boolean }) {
  return (
    <Shell route="" recorded={review}>
      <div className="page desk">
        <SpendingInstrument forceReplay={review} place="check" />
      </div>
    </Shell>
  );
}
