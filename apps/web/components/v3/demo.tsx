"use client";
import Link from "next/link";
import s from "../../app/v3.module.css";
import { V3Shell } from "./shell";
import { useBudget } from "./state";
import { BudgetView } from "./view-budget";
import { ConnectView } from "./view-connect";
import { SettleView } from "./view-settle";
import { TryView } from "./view-try";

export type DemoView = "budget" | "try" | "settle" | "connect";
const TABS: [DemoView, string, string][] = [["budget", "/demo", "Budget"], ["try", "/demo/try", "Try a call"], ["settle", "/demo/settle", "Settle"], ["connect", "/demo/connect", "Connect"]];

function Body({ view }: { view: DemoView }) {
  const b = useBudget();
  return (
    <div className={s.app}>
      <nav className={s.side} aria-label="Demo views">
        {TABS.map(([k, href, label]) => <Link key={k} href={href} aria-current={view === k ? "page" : undefined}>{label}</Link>)}
        <span className={s.sp} />
        <Link href="/">← Landing</Link>
      </nav>
      <div className={s.main}>
        {view === "budget" && <BudgetView b={b} />}
        {view === "try" && <TryView b={b} />}
        {view === "settle" && <SettleView />}
        {view === "connect" && <ConnectView />}
      </div>
    </div>
  );
}

export function Demo({ view }: { view: DemoView }) { return <V3Shell view="demo"><Body view={view} /></V3Shell>; }
