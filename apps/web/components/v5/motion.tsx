"use client";
import { useEffect, useState } from "react";

/* Motion follows the system setting and nothing else. With prefers-reduced-motion the page is still:
   no loops, no travelling packets, no steam. Without it, loops run only while they are near the screen. */
export function useMotion() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setStill(mq.matches);
    const on = () => setStill(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return { still };
}

/* Mark an element's looping CSS animations as paused while it is far off screen, and resume just before it returns. */
export function useNearScreen(ref: { current: Element | null }, margin = 240) {
  useEffect(() => {
    const el = ref.current; if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(es => { el.setAttribute("data-near", es[0]?.isIntersecting ? "true" : "false"); }, { rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
}
