"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import "../app/pd.css";
import { age, hold, useShowcase, usd, utc, type Showcase } from "../lib/showcase-store";

export const NAV: [string, string][] = [["/budget", "Budget"], ["/activity", "Activity"], ["/collect", "Collect"], ["/escrow", "Escrow"], ["/developers", "Developers"], ["/proof", "Proof"]];

export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

/* One line for freshness. Shown in the sandbox bar and nowhere else. */
export function Freshness({ s, now }: { s: ReturnType<typeof useShowcase>; now: number }) {
  if (!s.data) return <span className="stale">{s.loading ? "Reading the live hold..." : "Live read unavailable"}</span>;
  if (s.failedAt && s.goodAt) return <span className="stale">Last good read {age(now - s.goodAt)} ago. The gateway did not answer.</span>;
  return <span>Budget read {utc(s.data.read_at ?? s.goodAt)}</span>;
}

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const s = useShowcase();
  const now = useNow();
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [sysDark, setSysDark] = useState(false);
  useEffect(() => {
    try { const t = localStorage.getItem("pd-theme"); if (t === "light" || t === "dark") setTheme(t); } catch {}
    const mq = matchMedia("(prefers-color-scheme: dark)");
    setSysDark(mq.matches);
    const on = () => setSysDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme ? theme === "dark" : sysDark;
  const toggle = () => { const n = dark ? "light" : "dark"; setTheme(n); try { localStorage.setItem("pd-theme", n); } catch {} };
  return (
    <div className="pd" data-theme={theme ?? undefined}>
      <a className="skip" href="#main">Skip to content</a>
      <div className="sbx" role="note"><span>PayPal sandbox. No real money moves.</span><Freshness s={s} now={now} /></div>
      <header className="hd">
        <Link className="brand" href="/" aria-label="Pashadhara home"><img src="/mark.svg" alt="" width={34} height={34} />Pashadhara</Link>
        <nav className="nav" aria-label="Main">
          {NAV.map(([href, label]) => <Link key={href} href={href} aria-current={route === href.slice(1) ? "page" : undefined}>{label}</Link>)}
        </nav>
        <button className="tbtn" onClick={toggle} aria-pressed={dark}>{dark ? "Light view" : "Dark view"}</button>
      </header>
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="foot"><span>Pashadhara. A PayPal authorization hold as an AI agent budget. Sandbox only.</span><span><Link href="/developers">Connect an agent</Link> · <Link href="/proof">PayPal evidence</Link></span></footer>
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
    const hrs = Math.max(1, Math.round((h.honorMs - now) / 3_600_000));
    return <div className="notice" role="status"><span><strong>PayPal guarantees this hold for about {hrs} more hour{hrs === 1 ? "" : "s"}.</strong> After {utc(h.honor)} the gateway refuses paid calls until the owner approves a new hold.</span><Link className="btn sm" href="/developers#renew">How renewal works</Link></div>;
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
