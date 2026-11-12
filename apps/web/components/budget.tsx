"use client";
import Link from "next/link";
import { hold, usd, utc, useShowcase } from "../lib/showcase-store";
import { SpendingInstrument } from "./home";
import { Shell, Source, useNow } from "./site";

export function Budget() {
  const s = useShowcase();
  const h = hold(s.data, useNow(1000));
  const stale = !!s.failedAt && !!s.data;
  return <Shell route="budget"><div className="page">
    <div className="pagehead">
      <h1>Budget</h1>
      <p>The sandbox buyer approved one PayPal hold. Each paid call must fit both the free hold balance and the unsettled spending limit.</p>
    </div>
    {h?.state === "ended" && <div className="notice end" role="status"><span><strong>Spending is closed.</strong> Any balance left on the hold is no longer spendable. The recorded decision below still replays.</span><Link href="/developers#renew">How the owner renews</Link></div>}
    {h?.cap != null && (
      <dl className="compare" aria-label={stale ? "Last good budget read" : "Budget"}>
        <dt>Set by</dt><dd className="who"><span className="num">Sandbox buyer</span></dd>
        <dt>Held at PayPal</dt><dd><span className="num">{usd(h.cap)}</span><span className="unit">computed{stale ? ", last good read" : ""}</span></dd>
        {h.unsettled != null && <><dt>Unsettled spending limit</dt><dd><span className="num">{usd(h.unsettled)}</span><span className="unit">computed</span></dd></>}
        {(h.state === "active" || h.state === "expiring") && (h.spendable ?? h.available) != null && <><dt>Spendable now</dt><dd><span className="num">{usd(h.spendable ?? h.available)}</span><span className="unit">computed{stale ? ", last good read" : ""}</span></dd></>}
        <dt>{h.state === "ended" ? "Unspendable balance" : "Free in the hold"}</dt><dd><span className="num">{usd(h.available) || "Unavailable"}</span><span className="unit">computed{stale ? ", last good read" : ""}</span></dd>
        <dt>Committed</dt><dd><span className="num">{usd(h.spent) || "Unavailable"}</span><span className="unit">computed{stale ? ", last good read" : ""}</span></dd>
        <dt>Captured</dt><dd><span className="num">{usd(h.collected) || "Unavailable"}</span><span className="unit">journal{stale ? ", last good read" : ""}</span></dd>
      </dl>
    )}
    <SpendingInstrument place="budget" />
    <nav className="related" aria-label="Related">
      {(h?.spent ?? 0) > 0 ? <Link href="/collect">Review settlement</Link> : <Link href="/collect">Settlement</Link>}
      <Link href="/escrow">Recorded escrow</Link>
      <Link href="/developers">Connect an agent</Link>
    </nav>
    {h?.cap != null && (
      <details>
        <summary>Authorization details</summary>
        <dl className="kv">
          <dt>PayPal authorization</dt><dd>{h.last4 ? `Ending in ${h.last4}` : h.paypalId ?? "Unavailable"}</dd>
          <dt>Spending deadline</dt><dd>{utc(h.honor) || "Unavailable"}</dd>
          <dt>PayPal authorization expiry</dt><dd>{utc(h.expires) || "Unavailable"}</dd>
          <dt>Window state</dt><dd>{h.state}</dd>
        </dl>
        <Source>{s.failedAt ? "Last successful budget journal read" : "Budget journal"}{s.data?.read_at ? `, ${utc(s.data.read_at)}` : ""}. <Link href="/proof#hold">Authorization evidence</Link>.</Source>
      </details>
    )}
  </div></Shell>;
}
