"use client";
import Link from "next/link";
import { useState } from "react";
import { cents, hold, shortId, usd, utc, useShowcase } from "../lib/showcase-store";
import { parseDollars, runAgent, tryAmount, type RunResult, type TryResult } from "../lib/showcase-actions";
import { Refusal } from "./home";
import { HoldNotice, Shell, Source, useNow } from "./site";

export function Budget() {
  const s = useShowcase();
  const now = useNow(60_000);
  const h = hold(s.data, now);
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [asked, setAsked] = useState<{ cents: number; res: TryResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState<RunResult | null>(null);
  const [bad, setBad] = useState(false);
  const ended = h?.state === "ended";
  const lastServed = [...(s.data?.calls ?? [])].reverse().find(c => c.status === "served");
  const price = cents(lastServed?.price_minor);
  const check = async () => {
    const c = parseDollars(raw); setBad(!c); if (!c) return;
    setBusy(true); setAsked({ cents: c, res: await tryAmount(c) }); setBusy(false);
  };
  const run = async () => { setBusy(true); setRan(await runAgent()); setBusy(false); };
  const cap = h?.cap ?? null, avail = h?.available ?? null;
  const pct = (v: number | null) => (cap && v != null ? Math.max(0, Math.min(100, (v / cap) * 100)) : 0);
  const sp = h?.spent ?? 0, col = h?.collected ?? 0;
  return (
    <Shell route="budget">
      <div className="page">
        <div className="pagehead"><h1>Budget</h1><p className="muted">The demo agent&apos;s spending limit, backed by one PayPal authorization hold.</p></div>
        <HoldNotice d={s.data} />
        {!s.data ? <div className="panel"><div className="body"><p className="muted">{s.loading ? "Reading the live hold..." : "The live read is not answering. Nothing is shown in its place."}</p></div></div> : (
          <>
            <div className="budget">
              <div className="holdtile" data-ended={ended ? "1" : ""}>
                <span className="k">PAYPAL HOLD{h?.paypalId ? ` · ${shortId(h.paypalId)}` : ""}</span>
                <span className="big">{usd(cap)}</span>
                <span className="s">{ended ? `Guarantee ended ${utc(h?.honor)}` : h?.honor ? `Guaranteed until ${utc(h.honor)}` : ""}</span>
              </div>
              <div className="panel"><div className="body avail">
                <span className="muted small">{ended ? "Left on the hold, not spendable" : "Available to the agent"}</span>
                <span className="n mono">{avail != null ? usd(avail) : ""}</span>
                {cap ? <div className="meter" role="img" aria-label={`${usd(sp + col)} of ${usd(cap)} used`}><i style={{ width: `${pct(col)}%`, background: "var(--walnut)" }} /><i style={{ width: `${pct(sp)}%`, background: "var(--gold)" }} /><i style={{ width: `${pct(avail)}%`, background: "var(--teal)", opacity: .4 }} /></div> : null}
                <div className="legend">
                  {h?.collected != null && <span><b style={{ background: "var(--walnut)" }} />Collected {usd(col)}</span>}
                  {h?.spent != null && <span><b style={{ background: "var(--gold)" }} />Spent, not collected {usd(sp)}</span>}
                  {avail != null && <span><b style={{ background: "var(--teal)", opacity: .5 }} />{ended ? "Left on the hold" : "Available"} {usd(avail)}</span>}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>Check an amount</button>
                  <button className="btn pri" onClick={run} disabled={busy || ended || s.data.remaining_calls === 0}>{ended ? "Spending is closed" : `Run the agent${price != null ? ` · ${usd(price)}` : ""}`}</button>
                </div>
                {ran && (ran.kind === "served" ? <div className="act ok" role="status">Served. {usd(ran.price)} committed, {usd(ran.remaining)} left. <Link href="/activity">See it in Activity</Link>.</div> : <Refusal r={ran} />)}
              </div></div>
            </div>
            {open && (
              <section className="panel" aria-label="Check an amount">
                <div className="cap"><span>Check an amount against the hold</span><span>Runs the real limit check. Posts nothing.</span></div>
                <div className="body">
                  <div className="askform">
                    <label className="sr" htmlFor="amt">Amount in dollars</label>
                    <input id="amt" className="input" inputMode="decimal" placeholder={avail != null ? usd(avail + 1) : "0.00"} value={raw} onChange={e => setRaw(e.target.value)} onKeyDown={e => e.key === "Enter" && check()} aria-invalid={bad} />
                    <button className="btn" onClick={check} disabled={busy}>Check</button>
                    {avail != null && <button className="btn sm" onClick={() => setRaw(((avail + 1) / 100).toFixed(2))}>One cent over</button>}
                  </div>
                  {bad && <p className="muted small" role="alert">Enter an amount of at least $0.01.</p>}
                  {avail != null && cap ? (
                    <div className="band" role="img" aria-label={`Served up to ${usd(avail)}. Above that is refused.`}>
                      <div className="z-ok" style={{ width: `${Math.max(pct(avail), 12)}%` }}>Served up to {usd(avail)}</div>
                      <div className="z-no">{pct(avail) < 90 ? "Refused above" : ""}</div>
                      {asked && <span className="mk" style={{ left: `calc(${Math.min(100, (asked.cents / cap) * 100)}% - 2px)` }} />}
                    </div>
                  ) : null}
                  {asked && <Refusal r={asked.res} check />}
                </div>
              </section>
            )}
            <section className="panel">
              <div className="cap"><span>Details</span><span>{s.data.read_at ? `Read ${utc(s.data.read_at)}` : ""}</span></div>
              <div className="body">
                <dl className="kv">
                  {h?.paypalId && <><dt>PayPal authorization</dt><dd>{h.paypalId}</dd></>}
                  {h?.honor && <><dt>Guaranteed until</dt><dd>{utc(h.honor)}</dd></>}
                  {h?.expires && <><dt>PayPal authorization expires</dt><dd>{utc(h.expires)}</dd></>}
                  {s.data.remaining_calls != null && <><dt>Free demo runs left for you today</dt><dd>{s.data.remaining_calls}</dd></>}
                  <dt>Limit</dt><dd className="txt">Hard stop at 100% of available. A call that does not fit is refused before the model runs.</dd>
                  <dt>Release</dt><dd className="txt">Only the owner can release the hold, from the PayPal authorization.</dd>
                </dl>
                <Source>Budget journal{s.data.read_at ? `, read ${utc(s.data.read_at)}` : ""}. Balances are computed from our ledger, not a fresh PayPal GET. <Link href="/proof">PayPal evidence</Link></Source>
              </div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
