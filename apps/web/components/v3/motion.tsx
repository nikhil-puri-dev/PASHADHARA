"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/* Motion switch. With no saved choice the system reduced-motion setting decides ("auto", handled in CSS and here).
   Pressing the button saves an explicit "on" or "off" for this browser. */
type M = { still: boolean; toggle: () => void; attr: "on" | "auto" | "off" };
const Ctx = createContext<M>({ still: false, toggle: () => {}, attr: "auto" });
export const useMotion = () => useContext(Ctx);
const KEY = "pd-v3-motion";

export function MotionProvider({ children }: { children: ReactNode }) {
  const [sys, setSys] = useState(false);
  const [choice, setChoice] = useState<"on" | "off" | null>(null);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setSys(mq.matches);
    try { const v = localStorage.getItem(KEY); if (v === "on" || v === "off") setChoice(v); } catch { /* private mode */ }
    const on = () => setSys(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const still = choice ? choice === "off" : sys;
  const toggle = () => { const n = still ? "on" : "off"; setChoice(n); try { localStorage.setItem(KEY, n); } catch { /* ignore */ } };
  return <Ctx.Provider value={{ still, toggle, attr: choice ?? "auto" }}>{children}</Ctx.Provider>;
}
