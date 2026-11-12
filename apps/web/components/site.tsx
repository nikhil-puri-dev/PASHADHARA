"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import "../app/pd.css";
import { SiteBrand, SiteFooter, SitePages } from "./v5/chrome";
import { fontVars } from "./v5/fonts";
import { cx } from "./v5/ui";
import { age, hold, useShowcase, usd, utc, type Showcase } from "../lib/showcase-store";

export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

/* One line for freshness. Shown in the sandbox bar and nowhere else. */
export function Freshness({ s, now }: { s: ReturnType<typeof useShowcase>; now: number }) {
  if (!s.data) return <span className="stale">{s.loading ? "Reading the live hold..." : "Live read unavailable"}</span>;
  if (s.failedAt && s.goodAt) return <span className="stale">Last good read {age(now - s.goodAt)} ago. The gateway did not answer.</span>;
  return <span><b>Live</b> read {utc(s.data.read_at ?? s.goodAt)}</span>;
}

export function Shell({ route, recorded = false, children }: { route: string; recorded?: boolean; children: ReactNode }) {
  const s = useShowcase(!recorded);
  const now = useNow();
  const [menu, setMenu] = useState(false);
  const h = hold(s.data, now);
  return (
    <div className={cx("pd", fontVars)}>
      <a className="skiplink" href="#main">Skip to content</a>
      <div className="sbx" role="note"><span>PayPal sandbox. No real money moves.</span>{recorded ? <span className="rec-badge">Replay</span> : <Freshness s={s} now={now} />}</div>
      <header className="top">
        <div className="top-in">
          <SiteBrand />
          <div className="top-r"><SitePages route={`/${route}`} open={menu} onToggle={() => setMenu(value => !value)} onClose={() => setMenu(false)} /></div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>{children}</main>
      <SiteFooter honor={h?.honor ?? null} />
    </div>
  );
}

/* Hold state notice. Only one is ever rendered. */
export function HoldNotice({ d }: { d: Showcase | null }) {
  const now = useNow(60_000);
  const h = hold(d, now);
  if (!h) return null;
  if (h.state === "ended") return (
    <div className="notice end" role="status"><span><strong>Spending is closed.</strong> The PayPal guarantee for this hold ended{h.honor ? ` ${utc(h.honor)}` : ""}. The gateway refuses new paid calls. The record below stays readable.</span><Link className="btn sm" href="/activity">See the record</Link></div>
  );
  if (h.state === "expiring") {
    const mins = Math.max(0, Math.round((h.honorMs - now) / 60_000));
    const hours = Math.round(mins / 60);
    const when = mins < 45 ? "less than an hour" : `about ${hours} more hour${hours === 1 ? "" : "s"}`;
    return <div className="notice" role="status"><span><strong>PayPal guarantees this hold for {when}.</strong> After {utc(h.honor)} the gateway refuses paid calls until the owner approves a new hold.</span><Link className="btn sm" href="/developers#renew">How renewal works</Link></div>;
  }
  return null;
}

export function Source({ children }: { children: ReactNode }) {
  return <p className="src"><strong>Source:</strong> {children}</p>;
}

export function Pill({ kind, children }: { kind: "ok" | "no" | "wait" | "n"; children: ReactNode }) {
  return <span className={`tag t-${kind}`}>{children}</span>;
}

export const money = usd;
