"use client";
import type { ReactNode } from "react";
import { usd as money, utc } from "../../lib/showcase-store";

export const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(" ");
export { money, utc };

/* Kept so older imports still resolve; the mark is now one file, /mark.svg, used everywhere. */
export const Sprite = () => null;

/* Provenance chip. Every figure says where it came from. */
export type Kind = "live" | "last" | "measured" | "computed" | "recorded" | "survey" | "illustrative" | "fixture";
const LABEL: Record<Kind, string> = { live: "live", last: "last good read", measured: "measured", computed: "computed", recorded: "recorded", survey: "survey", illustrative: "illustrative", fixture: "fixture" };
const CLS: Record<Kind, string> = { live: "live", last: "snap", measured: "mea", computed: "com", recorded: "rec", survey: "sv", illustrative: "sim", fixture: "rec" };
export function Pv({ k, children }: { k: Kind; children?: ReactNode }) { return <span className={cx("pv", CLS[k])}>{children ?? LABEL[k]}</span>; }
