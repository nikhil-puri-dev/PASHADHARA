"use client";
/* The thurible: a hanging silver censer that holds the water instead of incense. Ported from v3.html.
   Water = free on the hold. Cup = committed. A served call pours into the cup. A refused call makes the water go
   still and the thurible exhales steam. All levels come from props; nothing here owns a number. */
import { useEffect, useMemo, useRef } from "react";
import s from "../../app/v3.module.css";
import { useMotion } from "./motion";
import type { Fx } from "./state";

const NS = "http://www.w3.org/2000/svg";

function tickCount(cap: number) { return cap > 0 && cap % 4 === 0 ? 4 : cap > 0 && cap % 2 === 0 ? 2 : 1; }

export function vesselSvg(id: string, cap: number): string {
  const DOME = "M150 290C150 232 170 192 200 172C212 164 223 150 230 132C237 150 248 164 260 172C290 192 310 232 310 290Z";
  const BOWL = "M140 312C126 362 150 424 230 430C310 424 334 362 320 312Z";
  const WBOT = 426, WH = 250;
  const nt = tickCount(cap);
  let ticks = "";
  for (let t = 0; t <= nt; t++) {
    const y = WBOT - (t / nt) * WH, val = (cap * t / nt) / 100;
    ticks += `<line x1="76" x2="90" y1="${y}" y2="${y}" stroke="hsl(350 7% 42%)" stroke-width="1.5"/><text x="70" y="${y + 4}" text-anchor="end" font-family="var(--mono)" font-size="11" fill="hsl(350 8% 62%)">$${val.toFixed(2)}</text>`;
  }
  let rings = "";
  [226, 192, 158].forEach((r, k) => { rings += `<circle cx="230" cy="300" r="${r}" fill="none" stroke="hsl(350 9% ${26 - k * 3}%)" stroke-width="2" stroke-dasharray="0 7" stroke-linecap="round"/>`; });
  const dia = (cx: number, cy: number, w: number, h: number) => `M${cx} ${cy - h / 2}L${cx + w / 2} ${cy}L${cx} ${cy + h / 2}L${cx - w / 2} ${cy}Z`;
  let holes = "";
  [[208, 206], [252, 206], [190, 238], [230, 238], [270, 238], [172, 268], [210, 268], [250, 268], [288, 268]].forEach(p => { holes += `<path d="${dia(p[0]!, p[1]!, 22, 32)}" fill="#000"/>`; });
  holes += '<ellipse cx="230" cy="372" rx="58" ry="38" fill="#000"/><ellipse cx="160" cy="372" rx="8" ry="26" fill="#000"/><ellipse cx="300" cy="372" rx="8" ry="26" fill="#000"/>';
  let beadsC = "", beadsF = "", scal = "", win = "";
  for (let x = 142; x <= 318; x += 11) beadsC += `<circle cx="${x}" cy="300" r="2.3" fill="hsl(350 12% 20%)"/>`;
  for (let x = 176; x <= 284; x += 11) beadsF += `<circle cx="${x}" cy="488" r="2" fill="hsl(350 12% 22%)"/>`;
  for (let x = 146; x <= 306; x += 16) scal += `M${x} 322q8 9 16 0`;
  for (let a = 0; a < 26; a++) { const th = a / 26 * Math.PI * 2; win += `<circle cx="${(230 + Math.cos(th) * 66).toFixed(1)}" cy="${(372 + Math.sin(th) * 46).toFixed(1)}" r="2" fill="hsl(350 12% 20%)"/>`; }
  const ribs = '<path d="M230 136C222 170 200 196 176 214M230 136C238 170 260 196 284 214M230 136C228 172 214 196 202 208M230 136C232 172 246 196 258 208" fill="none" stroke="hsl(350 10% 26%)" stroke-width="1.4"/>';
  const chain = (x1: number, y1: number, x2: number, y2: number) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="hsl(40 8% 78%)" stroke-width="4.4" stroke-dasharray="7 3" stroke-linecap="round" fill="none"/><path d="M${x1} ${y1}L${x2} ${y2}" stroke="hsl(350 12% 14%)" stroke-width="1.6" stroke-dasharray="2 8" fill="none"/>`;
  let wave = "M-200 0"; for (let w = 0; w < 30; w++) wave += "q15 -7 30 0t30 0";

  return `<svg viewBox="0 0 460 540" role="img" aria-label="A hanging silver thurible holding the PayPal hold as water. Calls pour out of its spout into a cup. A refused call makes it breathe out steam."><defs>` +
    `<linearGradient id="${id}mg" gradientUnits="userSpaceOnUse" x1="124" y1="0" x2="336" y2="0"><stop offset="0" stop-color="hsl(40 6% 34%)"/><stop offset=".22" stop-color="hsl(40 8% 72%)"/><stop offset=".42" stop-color="hsl(40 10% 92%)"/><stop offset=".68" stop-color="hsl(40 6% 56%)"/><stop offset="1" stop-color="hsl(350 8% 26%)"/></linearGradient>` +
    `<clipPath id="${id}c"><path d="${DOME}"/><rect x="134" y="286" width="192" height="28" rx="12"/><path d="${BOWL}"/></clipPath>` +
    `<mask id="${id}m" maskUnits="userSpaceOnUse" x="100" y="100" width="260" height="400"><rect x="100" y="100" width="260" height="400" fill="#fff"/>${holes}</mask>` +
    `<clipPath id="${id}k1"><path d="M372 410H440L432 492H380Z"/></clipPath><clipPath id="${id}k2"><path d="M372 330H440L435 390H377Z"/></clipPath>` +
    `<pattern id="${id}h" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" fill="hsl(350 20% 9%)"/><rect width="3" height="9" fill="hsl(350 10% 26%)"/></pattern>` +
    `<filter id="${id}f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter><filter id="${id}f2" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>` +
    rings + ticks +
    `<g class="${s.thSway}"><g id="${id}sw" class="${s.thHit}">` +
    `<g clip-path="url(#${id}c)"><rect x="100" y="100" width="260" height="400" fill="hsl(350 34% 4%)"/>` +
    `<g id="${id}rel" style="transition:transform .9s var(--ease)" transform="translate(0 520)"><rect x="100" y="0" width="260" height="400" fill="url(#${id}h)"/></g>` +
    `<g id="${id}w" class="${s.wtr}" style="transition:transform .9s var(--ease)" transform="translate(0 520)"><g class="${s.wv}"><path d="${wave}V14H-200Z" transform="translate(0 -6)" fill="hsl(188 58% 54%)"/></g><rect x="100" y="6" width="260" height="400" fill="hsl(188 58% 42%)"/></g></g>` +
    `<g mask="url(#${id}m)"><path d="${DOME}" fill="url(#${id}mg)"/><path d="${BOWL}" fill="url(#${id}mg)"/></g>` +
    ribs + `<path d="${scal}" fill="none" stroke="hsl(350 12% 22%)" stroke-width="1.6" stroke-linecap="round"/>` +
    `<ellipse cx="230" cy="372" rx="58" ry="38" fill="none" stroke="hsl(350 14% 18%)" stroke-width="3.4"/><ellipse cx="230" cy="372" rx="60" ry="40" fill="none" stroke="hsl(40 12% 86% / .55)" stroke-width="1.4"/>` + win +
    `<ellipse cx="160" cy="372" rx="9" ry="27" fill="none" stroke="hsl(350 14% 18%)" stroke-width="2.4"/><ellipse cx="300" cy="372" rx="9" ry="27" fill="none" stroke="hsl(350 14% 18%)" stroke-width="2.4"/>` +
    `<rect x="134" y="288" width="192" height="24" rx="12" fill="url(#${id}mg)"/>${beadsC}` +
    `<path d="M316 366l36 12l-5 10l-34 -8z" fill="url(#${id}mg)" stroke="hsl(350 14% 18%)" stroke-width="1.6"/>` +
    `<path d="M205 428H255L248 458H212Z" fill="url(#${id}mg)"/><path d="M168 486C168 468 198 460 230 460C262 460 292 468 292 486Z" fill="url(#${id}mg)"/><rect x="158" y="484" width="144" height="10" rx="5" fill="url(#${id}mg)"/>${beadsF}` +
    `<circle cx="230" cy="124" r="5.5" fill="url(#${id}mg)"/><circle cx="230" cy="113" r="6" fill="none" stroke="hsl(40 8% 78%)" stroke-width="3"/>` +
    chain(230, 52, 138, 296) + chain(230, 52, 230, 288) + chain(230, 52, 322, 296) +
    `<circle cx="230" cy="40" r="12" fill="none" stroke="hsl(40 8% 82%)" stroke-width="4.4"/><path d="M230 28V0" stroke="hsl(40 8% 78%)" stroke-width="4.4" stroke-dasharray="7 3"/>` +
    `</g></g>` +
    `<path d="M372 410H440L432 492H380Z" fill="hsl(350 30% 6%)" stroke="hsl(40 8% 62%)" stroke-width="3"/><g clip-path="url(#${id}k1)"><rect id="${id}k1w" x="360" y="492" width="100" height="100" fill="hsl(188 62% 64%)" style="transition:y .9s var(--ease)"/></g>` +
    `<path id="${id}k2p" d="M372 330H440L435 390H377Z" fill="hsl(350 30% 6%)" stroke="hsl(40 8% 62%)" stroke-width="3" style="opacity:0;transition:opacity .5s"/><g id="${id}k2g" clip-path="url(#${id}k2)" style="opacity:0;transition:opacity .5s"><rect id="${id}k2w" x="360" y="390" width="100" height="60" fill="hsl(350 8% 56%)" style="transition:y .9s var(--ease)"/></g>` +
    `<g id="${id}fx"></g></svg>`;
}

export type Levels = { cap: number; free: number; committed: number; released?: number; fee?: number };

export function Thurible({ id, levels, fx, served }: { id: string; levels: Levels; fx?: Fx | undefined; served?: number | undefined }) {
  const host = useRef<HTMLDivElement>(null);
  const { still } = useMotion();
  const stillRef = useRef(still); stillRef.current = still;
  const html = useMemo(() => vesselSvg(id, levels.cap), [id, levels.cap]);
  const el = (suffix: string) => host.current?.querySelector<SVGElement>(`#${id}${suffix}`) ?? null;

  /* levels */
  useEffect(() => {
    const { cap, free, committed } = levels, rel = levels.released ?? 0, fee = levels.fee ?? 0;
    const WBOT = 426, WH = 250, held = Math.max(cap, 1);
    el("w")?.setAttribute("transform", `translate(0 ${free <= 0 ? 520 : WBOT - Math.min(free / held, 1) * WH})`);
    el("rel")?.setAttribute("transform", `translate(0 ${rel <= 0 ? 520 : WBOT - Math.min(rel / held, 1) * WH})`);
    el("k1w")?.setAttribute("y", String(492 - Math.min(committed / held, 1) * 82));
    const two = fee > 0;
    const p = el("k2p"), g = el("k2g");
    if (p) p.style.opacity = two ? "1" : "0";
    if (g) g.style.opacity = two ? "1" : "0";
    el("k2w")?.setAttribute("y", String(390 - Math.min(fee / held, 1) * 60));
  }, [html, levels.cap, levels.free, levels.committed, levels.released, levels.fee]);

  const mk = (tag: string, attrs: Record<string, string | number>) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, String(attrs[k])); return n as SVGElement; };
  const hit = () => { const g = el("sw"); if (!g) return; g.classList.remove(s.thHit!); void g.getBoundingClientRect(); g.classList.add(s.thHit!); };
  const pour = () => {
    if (stillRef.current) return;
    const f = el("fx"); if (!f) return;
    for (let i = 0; i < 4; i++) {
      const c = mk("circle", { r: 5, fill: "hsl(188 62% 66%)" }); c.style.opacity = "0"; f.appendChild(c);
      const a = c.animate([{ transform: "translate(350px,386px)", opacity: 1 }, { transform: "translate(381px,398px)", opacity: 1, offset: .45 }, { transform: "translate(404px,448px)", opacity: 0 }], { duration: 560, delay: i * 110, easing: "cubic-bezier(.4,0,.8,.6)", fill: "both" });
      a.onfinish = () => c.remove();
    }
  };
  const steam = () => {
    const f = el("fx"), w = el("w"); if (!f || !w) return;
    w.classList.add(s.still!); setTimeout(() => w.classList.remove(s.still!), 2600);
    hit();
    if (stillRef.current) {
      const st = mk("g", { opacity: .4 });
      [[218, 170, 18], [240, 150, 22], [226, 126, 26]].forEach(p => st.appendChild(mk("circle", { cx: p[0]!, cy: p[1]!, r: p[2]!, fill: "hsl(40 22% 90%)", filter: `url(#${id}f)` })));
      f.appendChild(st); setTimeout(() => st.remove(), 2400); return;
    }
    for (let i = 0; i < 9; i++) {
      const dx = (Math.random() - .5) * 60, rise = 210 + Math.random() * 90, r = 16 + Math.random() * 12;
      const c = mk("circle", { cx: 230 + (Math.random() - .5) * 50, cy: 236, r, fill: "hsl(40 22% 90%)", filter: `url(#${id}f)` });
      c.style.opacity = "0"; c.style.transformBox = "fill-box"; c.style.transformOrigin = "center"; f.appendChild(c);
      const a = c.animate([{ transform: "translate(0px,0px) scale(.6)", opacity: 0 }, { opacity: .5, offset: .28 }, { transform: `translate(${dx}px,-${rise}px) scale(2.7)`, opacity: 0 }], { duration: 3000 + Math.random() * 900, delay: i * 200, easing: "cubic-bezier(.2,.5,.3,1)", fill: "both" });
      a.onfinish = () => c.remove();
    }
    const lp = mk("ellipse", { cx: 230, cy: 236, rx: 44, ry: 13, fill: "none", stroke: "hsl(40 26% 94%)", "stroke-width": 5, filter: `url(#${id}f2)` });
    lp.style.opacity = "0"; lp.style.transformBox = "fill-box"; lp.style.transformOrigin = "center"; f.appendChild(lp);
    const la = lp.animate([{ transform: "translate(0px,0px) scale(1.15,1.1)", opacity: 0 }, { opacity: .85, offset: .3 }, { transform: "translate(0px,-262px) scale(.5,.62)", opacity: 0 }], { duration: 3800, delay: 600, easing: "cubic-bezier(.3,.4,.2,1)", fill: "both" });
    la.onfinish = () => lp.remove();
  };

  /* events: a refused or allowed check, or a settle step */
  const seen = useRef(fx?.n ?? 0);
  useEffect(() => {
    if (!fx || fx.n === seen.current) return;
    seen.current = fx.n;
    if (fx.kind === "steam") steam(); else pour();
  }, [fx?.n]);
  /* a newly served call in the journal pours */
  const servedRef = useRef(served);
  useEffect(() => {
    if (served != null && servedRef.current != null && served > servedRef.current) pour();
    servedRef.current = served;
  }, [served]);

  return <div className={s.vwrap} ref={host} dangerouslySetInnerHTML={{ __html: html }} />;
}
