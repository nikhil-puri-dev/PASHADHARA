"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import s from "../../app/v3.module.css";
import { age } from "../../lib/showcase-store";
import { cx, Mark, Svgs } from "./bits";
import { fontVars } from "./fonts";
import { MotionProvider, useMotion } from "./motion";
import { useBudget, useNow } from "./state";

function Bars({ view }: { view: "landing" | "demo" }) {
  const b = useBudget();
  const now = useNow(1000);
  const fresh = b.mode === "loading" ? <span className={s.stale}>Reading the live hold...</span>
    : b.mode === "recorded" ? <span className={s.recBadge}>Recorded, not live</span>
    : b.stale && b.goodAt ? <span className={s.stale}>Last good read {age(now - b.goodAt)} ago. The gateway did not answer.</span>
    : <span><b>Live</b> read {b.readAt ? new Date(b.readAt).toISOString().slice(11, 16) + " UTC" : ""}</span>;
  return (
    <>
      <div className={s.sbx} role="note"><span>PayPal sandbox. No real money moves.</span>{fresh}</div>
      <div className={s.top}><div className={cx(s.wrap, s.topIn)}>
        <Link className={s.brand} href="/" aria-label="Pashadhara home"><Mark />Pashadhara</Link>
        <nav className={s.tl} aria-label="Main">
          {view === "landing" && <><a className={s.hideS} href="#fleet">Fleet</a><a className={s.hideS} href="#proof">Proof</a></>}
          {view === "demo" && <Link className={s.hideS} href="/">Landing</Link>}
          <Link className={cx(s.btn, s.pri)} href="/demo" aria-current={view === "demo" ? "page" : undefined}>{view === "demo" ? "Demo" : "Open the demo"}</Link>
        </nav>
      </div></div>
    </>
  );
}

export function MotionButton() {
  const m = useMotion();
  return <button className={s.mt} type="button" onClick={m.toggle}>Motion: {m.still ? "off" : "on"}</button>;
}

function Root({ view, children }: { view: "landing" | "demo"; children: ReactNode }) {
  const m = useMotion();
  return (
    <div className={cx(s.v3, fontVars)} data-motion={m.attr} data-view={view}>
      <a className={s.skip} href="#main">Skip to content</a>
      <Svgs />
      <Bars view={view} />
      <main id="main" tabIndex={-1}>{children}</main>
    </div>
  );
}

export function V3Shell({ view, children }: { view: "landing" | "demo"; children: ReactNode }) {
  return <MotionProvider><Root view={view}>{children}</Root></MotionProvider>;
}
