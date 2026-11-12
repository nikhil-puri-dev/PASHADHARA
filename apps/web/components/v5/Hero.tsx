"use client";
import { useView } from "./app";
import { Chip, Readout } from "./Instrument";
import { liveCheck, recordedCheck, RECORDED, smallPrice, edgeOf, useBudget, type Budget } from "./state";
import { Thurible } from "./Thurible";
import { Verdict } from "./Verdict";
import { cx, money } from "./ui";

/* Show the same live boundary as the amount check. */
export function Hero() {
  const b = useBudget(), v = useView(b);
  const figure = b.mode === "live";
  const shown = figure ? edgeOf(b) : null;
  const up = shown == null ? null : money(shown + 1);
  const rec = b.mode === "recorded", ended = b.mode === "ended", live = b.mode === "live";
  const edge = edgeOf(b), sp = smallPrice(b);
  const small = () => (rec ? recordedCheck("served") : liveCheck(sp));
  const over = () => (rec ? recordedCheck("blocked") : liveCheck(edge + 1));
  const off = b.busy || !(live || rec) || ended;
  const last = b.checks[b.checks.length - 1];
  return (
    <section className="hero" id="hero" aria-labelledby="hero-h">
      <div className="eyebrow"><Chip b={b} v={v} mode="live" /></div>
      {figure ? (
        <h1 id="hero-h">
          <span className="ln">Your agent can</span>
          <span className="ln">spend <span className="amt">{money(shown!)}</span>.</span>
          <span className="ln">Not {up!.slice(0, -1)}<span className="cut" aria-hidden="true">{up!.slice(-1)}</span><span className="sr">{up!.slice(-1)}</span>.</span>
        </h1>
      ) : (
        <h1 id="hero-h">
          <span className="ln">Your agent can</span>
          <span className="ln">spend <span className="amt">{ended ? "nothing more" : "what was held"}</span>.</span>
          <span className="ln">{ended ? "The hold has ended" : b.mode === "loading" ? "Reading the hold…" : "Not one cent over"}.</span>
        </h1>
      )}
      <p className="lede">
        {b.unsettled != null
          ? <><b>{money(b.cap)} authorized at PayPal.</b> The gateway allows up to {money(b.unsettled)} in unsettled commitments. A call that exceeds either limit is refused with <b>$0.00 charged</b>.{b.committed > 0 && <> Already committed: {money(b.committed)}.</>}</>
          : <>The limit is a <b>PayPal hold you approved</b>. Each paid call is checked against what is left before the tool runs. A call that does not fit is refused and <b>nothing is charged</b>.</>}
      </p>
      <div className="cta">
        <button className="btn pri" type="button" disabled={off} onClick={() => void small()}>{rec ? `Replay the recorded lookup (${money(RECORDED.servedPrice)})` : `Check a ${money(sp)} call`}</button>
        <button className="btn neg" type="button" disabled={off} onClick={() => void over()}>{rec ? `Replay the recorded refusal (${money(RECORDED.blockedPrice)})` : `Try ${money(edge + 1)}, one cent over`}</button>
        <a className="btn" href="#s1">Follow the money ↓</a>
      </div>
      <div className="hres" aria-live="polite">{last ? <Verdict c={last} b={b} /> : ended ? <div className="verdict"><span className="v1">Spending is closed</span><span className="v2">The PayPal hold ended. The gateway refuses new paid calls and checks are off. The record stays readable.</span></div> : null}</div>
      <div className="hero-vessel"><Thurible id="Rb" levels={{ cap: v.cap, free: v.free, committed: v.closed ? v.captured : v.committed, released: v.released, fee: v.fee, unsettled: v.unsettled }} fx={v.fx} served={v.mode === "live" && b.mode === "live" ? b.served : undefined} /><Readout v={v} /><p className={cx("cap-line")}>Switch the view with the button above.</p></div>
    </section>
  );
}
export type { Budget };
