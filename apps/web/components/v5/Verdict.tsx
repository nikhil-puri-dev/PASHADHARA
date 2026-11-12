"use client";
import type { Budget, Check } from "./state";
import { cx, money, Pv } from "./ui";

/* One refusal or one pass, in plain words. A check is the real limit check and posts nothing. */
export function Verdict({ c, b }: { c: Check | undefined; b: Budget }) {
  if (!c) return null;
  if (c.reason === "error") return <div className="verdict bad"><span className="v1">No answer</span><span className="v2">{c.error}</span><div className="v3"><span>Nothing was charged and nothing was posted.</span></div></div>;
  const src = c.recorded ? <Pv k="recorded">recorded run, not live</Pv> : <Pv k="live">live answer</Pv>;
  if (c.ok) return <div className="verdict good"><span className="v1">Would be served</span><span className="v2">{money(c.price)} fits what may be spent.</span><div className="v3">{src}<span>A check posts nothing: no journal row, no tool run.</span></div></div>;
  const detail = c.reason === "cap_reached" ? `${money(c.price)} is more than the ${money(c.remaining ?? b.free)} still free in the hold.`
    : c.reason === "exposure_limit" ? `${money(c.price)} would take committed money past the ${b.unsettled != null ? money(b.unsettled) : "unsettled"} limit. Settling frees room.`
    : c.reason === "window_ended" ? "The hold is past its honor date. Spending is off."
    : `Refused: ${c.reason}.`;
  return <div className={cx("verdict", "bad")}><span className="v1">Refused: {c.reason}</span><span className="v2">{detail} The tool does not run. $0.00 charged.</span><div className="v3">{src}<span>A check posts nothing.</span></div></div>;
}
