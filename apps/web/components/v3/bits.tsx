"use client";
/* Small pieces shared by the landing and the demo views. All numbers come from useBudget(). */
import type { ReactNode } from "react";
import s from "../../app/v3.module.css";
import { age, usd, utc } from "../../lib/showcase-store";
import { liveCheck, recordedCheck, RECORDED, type Budget } from "./state";

export const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(" ");
export const Svgs = () => (
  <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <defs>
      <symbol id="v3pasha" viewBox="0 0 48 48">
        <path d="M38 5C32 6 27 9 23 13A15 15 0 1 0 34.5 18.4" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        <path d="M31.4 20.9L37.6 15.8" stroke="hsl(8 84% 58%)" strokeWidth="3.6" strokeLinecap="round" />
        <circle cx="38" cy="5" r="3.2" fill="hsl(188 56% 55%)" />
      </symbol>
    </defs>
  </svg>
);
export const Mark = ({ className }: { className?: string }) => <svg className={className} viewBox="0 0 48 48" aria-hidden="true"><use href="#v3pasha" /></svg>;

export function Tag({ kind, children }: { kind: "measured" | "computed" | "replay" | "recorded" | "live"; children?: ReactNode }) {
  return <span className={cx(s.tag, kind === "computed" && s.dm, kind === "replay" && s.dm, kind === "recorded" && s.dm)}>{children ?? kind}</span>;
}

/* Where the numbers on screen come from. Always one line. */
export function Provenance({ b }: { b: Budget }) {
  if (b.mode === "loading") return <span className={s.dim}>Reading the live hold...</span>;
  if (b.mode === "recorded") return <span className={s.recBadge}>Recorded, not live</span>;
  return <span className={s.tag}>live read{b.stale ? ", last good read" : ""}</span>;
}

export function Readout({ b, host }: { b: Budget; host?: string | undefined }) {
  const v = (n: number) => (b.mode === "loading" ? "..." : usd(n));
  return (
    <div className={cx(s.read, host)} data-read>
      <div><small><i style={{ background: "hsl(188 58% 42%)" }} />Free</small><div className={s.num}>{v(b.free)}</div></div>
      <div><small><i style={{ background: "hsl(188 62% 64%)" }} />Committed</small><div className={s.num}>{v(b.committed)}</div></div>
      <div><small><i style={{ background: "hsl(8 84% 58%)" }} />Refused</small><div className={s.num}>{b.mode === "recorded" || b.mode === "loading" ? (b.mode === "loading" ? "..." : "n/a") : b.refused}</div></div>
    </div>
  );
}

export function Tape({ b }: { b: Budget }) {
  return (
    <>
      <div className={s.tape} data-tape role="log" aria-label="Recent calls">
        {b.rows.length === 0 ? (
          <div className={s.tpE}>{b.mode === "loading" ? "Reading the journal..." : b.mode === "recorded" ? "Recorded run. Use the checks to see its two decisions." : "No calls yet. The agent has a hold and nothing else."}</div>
        ) : b.rows.map(r => (
          <div key={r.key} className={cx(s.tp, r.status === "refused" && s.ref, r.check && s.chk)}>
            <span className={s.dim}>{String(r.n).padStart(2, "0")}</span>
            <span title={r.why}>{r.label}{r.why ? ` · ${r.why}` : ""}</span>
            <span className={s.pr}>{r.price != null ? usd(r.price) : ""}</span>
            <span className={s.st}>{r.status === "fits" ? "fits" : r.status}</span>
          </div>
        ))}
      </div>
      <p className={s.tapeNote}>Rows without "check" are journal rows from the live hold. A check posts nothing.</p>
    </>
  );
}

export const smallPrice = (b: Budget) => (b.lastSummarise != null && b.lastSummarise > 0 ? b.lastSummarise : 50);

/* The two actions the landing offers. Live: POST /api/showcase/try (real kernel check, posts nothing). Recorded: the recorded decision. */
export function useActions(b: Budget) {
  const live = b.mode === "live";
  const rec = b.mode === "recorded";
  const sp = smallPrice(b);
  return {
    disabled: b.busy || !(live || rec),
    smallLabel: rec ? `Replay the recorded lookup (${usd(RECORDED.servedPrice)})` : `Check a ${usd(sp)} call`,
    overLabel: rec ? `Replay the recorded refusal (${usd(RECORDED.blockedPrice)})` : `Try ${usd(b.free + 1)}, one cent over`,
    small: () => (rec ? recordedCheck("served") : liveCheck(sp)),
    over: () => (rec ? recordedCheck("blocked") : liveCheck(b.free + 1)),
  };
}

export function lastLine(b: Budget): string {
  const c = b.checks[b.checks.length - 1];
  if (!c) return "";
  const src = c.recorded ? "Recorded" : "Live check";
  if (c.reason === "error") return `${src}: ${c.error}`;
  if (c.ok && c.charged != null) return `${src}: ${usd(c.price)} lookup was served and committed in that run. ${c.after != null ? usd(c.after) : ""} left.`;
  return c.ok ? `${src}: ${usd(c.price)} fits${c.remaining != null ? `, ${usd(c.remaining)} free` : ""}. Nothing posted.` : `${src}: ${usd(c.price)} refused (${c.reason}). Nothing charged, tool did not run.`;
}

export function EndedNotice({ b }: { b: Budget }) {
  if (b.mode !== "ended" && !(b.mode === "live" && b.state === "expiring")) return null;
  return b.mode === "ended"
    ? <div className={s.notice} role="status"><b>Spending is closed.</b> The PayPal hold ended{b.honor ? ` ${utc(b.honor)}` : ""}. The gateway refuses new paid calls and checks are off. The record stays readable.</div>
    : <div className={s.notice} role="status"><b>The hold is close to ending.</b> After its guarantee window the gateway refuses paid calls until the owner approves a new hold.</div>;
}

export const readAge = (b: Budget, now: number) => (b.goodAt ? age(now - b.goodAt) : "");
