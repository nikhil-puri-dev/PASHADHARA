"use client";
import "../../app/v5.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { age } from "../../lib/showcase-store";
import { SiteBrand, SiteFooter, SitePages } from "./chrome";
import { setMode } from "./app";
import { fontVars } from "./fonts";
import { InstrumentCard, Minibar } from "./Instrument";
import { runApi } from "./run";
import { simApi } from "./sim";
import { useBudget, useNow } from "./state";
import { cx, Pv, Sprite, utc } from "./ui";

export const STEPS: { id: string; n: string; label: string; short: string }[] = [
  { id: "s0", n: "0", label: "Why", short: "Why" }, { id: "s1", n: "1", label: "Grant", short: "Grant" }, { id: "s2", n: "2", label: "Spend and refuse", short: "Spend" }, { id: "s3", n: "3", label: "Settle", short: "Settle" }, { id: "s4", n: "4", label: "Connect", short: "Connect" }, { id: "about", n: "5", label: "About", short: "About" },
];

function Sandbox() {
  const b = useBudget(), now = useNow(1000);
  const fresh = b.mode === "loading" ? <span className="dim">Reading the live hold…</span>
    : b.mode === "recorded" ? <span className="rec-badge">Recorded, not live</span>
    : b.stale && b.goodAt ? <span className="dim">Last good read {age(now - b.goodAt)} ago. The gateway did not answer.</span>
    : <span><b>Live</b> read {b.readAt ? utc(b.readAt) : ""}</span>;
  return <div className="sbx" role="note"><span>PayPal sandbox. No real money moves.</span>{fresh}</div>;
}

function useSpy() {
  const [on, setOn] = useState("");
  useEffect(() => {
    const els = STEPS.map(s => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(es => { es.forEach(e => { if (e.isIntersecting) setOn(e.target.id); }); }, { rootMargin: "-25% 0px -65% 0px" });
    els.forEach(e => io.observe(e));
    return () => io.disconnect();
  }, []);
  return on;
}

function Header() {
  const on = useSpy();
  const top = useRef<HTMLElement>(null);
  const [legend, setLegend] = useState(false), [menu, setMenu] = useState<false | "steps" | "pages">(false);
  useEffect(() => {
    const el = top.current; if (!el) return;
    const mb = document.querySelector<HTMLElement>(".minibar");
    const set = () => {
      const h = Math.round(el.getBoundingClientRect().height), m = mb && getComputedStyle(mb).display !== "none" ? Math.round(mb.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--hdr", `${h}px`); document.documentElement.style.setProperty("--stick", `${h + m}px`);
    };
    set(); const ro = new ResizeObserver(set); ro.observe(el); if (mb) ro.observe(mb);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setLegend(false); setMenu(false); } };
    document.addEventListener("keydown", key);
    return () => { ro.disconnect(); document.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => { if (legend) document.getElementById("legend")?.focus(); }, [legend]);
  useEffect(() => { if (menu === "steps") document.querySelector<HTMLElement>("#steps-menu a")?.focus(); }, [menu]);
  const cur = STEPS.find(s => s.id === on);
  return (
    <header className="top" id="top" ref={top}>
      <div className="top-in">
        <SiteBrand />
        <nav className="journey" aria-label="The financial journey">
          {STEPS.map(s => <a key={s.id} href={`#${s.id}`} className={cx(on === s.id && "on")} aria-current={on === s.id ? "step" : undefined}><b>{s.n}</b>{s.label}</a>)}
        </nav>
        <div className="top-r">
          <button className="menu-btn" type="button" aria-expanded={menu === "steps"} aria-controls="steps-menu" onClick={() => { setMenu(m => (m === "steps" ? false : "steps")); setLegend(false); }}>{cur ? `${cur.n} ${cur.short}` : "Steps"}<span aria-hidden="true"> ▾</span></button>
          <SitePages route="/" open={menu === "pages"} onToggle={() => { setMenu(m => (m === "pages" ? false : "pages")); setLegend(false); }} onClose={() => setMenu(false)} />
          <button className="legend-btn" type="button" aria-expanded={legend} aria-controls="legend" onClick={() => { setLegend(l => !l); setMenu(false); }}>Tags</button>
        </div>
      </div>
      {menu === "steps" && <nav className="steps-menu" id="steps-menu" aria-label="Journey steps">{STEPS.map(s => <a key={s.id} href={`#${s.id}`} className={cx(on === s.id && "on")} onClick={() => setMenu(false)}><b>{s.n}</b>{s.label}</a>)}</nav>}
      {legend && (
        <div className="legend" id="legend" tabIndex={-1}>
          <div><Pv k="live" /><span>Read from the running API just now.</span></div>
          <div><Pv k="last" /><span>The last good live read. The API did not answer since.</span></div>
          <div><Pv k="measured" /><span>A PayPal sandbox GET or a database query, kept as evidence.</span></div>
          <div><Pv k="computed" /><span>Derived from journal rows or a rule.</span></div>
          <div><Pv k="recorded" /><span>A past run kept as evidence. Not happening now.</span></div>
          <div><Pv k="fixture" /><span>Synthetic data (invoices, usage) inside a real sandbox run.</span></div>
          <div><Pv k="survey" /><span>A third-party survey or forecast, cited.</span></div>
          <div><Pv k="illustrative" /><span>Runs in your browser. No PayPal, no server. Hatched on purpose.</span></div>
        </div>
      )}
    </header>
  );
}

function Root({ children }: { children: ReactNode }) {
  const b = useBudget();
  useEffect(() => () => { simApi.pause(); runApi.pause(); setMode("live"); }, []);
  return (
    <div className={cx("v5", fontVars)}>
      <a className="skiplink" href="#story">Skip to content</a>
      <Sprite />
      <Sandbox />
      <Header />
      <div className="shell">
        <main className="story" id="story" tabIndex={-1}><Minibar />{children}</main>
        <aside className="rail" aria-label="The instrument"><InstrumentCard /></aside>
      </div>
      <SiteFooter honor={b.honor} />
    </div>
  );
}

export function V5Shell({ children }: { children: ReactNode }) { return <Root>{children}</Root>; }
