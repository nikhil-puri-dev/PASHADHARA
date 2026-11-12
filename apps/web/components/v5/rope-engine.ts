/* The pasha: a braided rope loop. The loop radius follows how much may still be spent. A compact version of the V3 rope.
   Canvas only. It draws what the autopilot store tells it; it never owns a number. Agents can be dragged against the rope. */
export type RopeAgent = { id: string; color: [number, number, number] };
export type RopeApi = {
  setAgents(list: RopeAgent[]): void;
  update(frac: number, cap: number, spendTxt: string): void;
  served(i: number): void;
  refused(i: number, txt: string): void;
  active(b: boolean): void;
  reset(): void;
  destroy(): void;
};
type A = { name: string; c: [number, number, number]; x: number; y: number; z: number; zb: number; vx: number; vy: number; gx: number; gy: number; gt: number; ph: number; tr: [number, number][]; hot: number };

export function initRope(host: HTMLElement, o: { mono: string; isStill: () => boolean; onOver: (i: number) => void }): RopeApi {
  const W = 720, cx = 360, K = .30, ZR = 34, TAU = Math.PI * 2;
  let H = 300, cy = 206;
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Scripted agents inside a braided rope loop that hangs from the PayPal hold. The loop tightens as money is committed, and the rope resists when an agent pulls against it.");
  host.insertBefore(canvas, host.firstChild);
  const N = 72, SUB = 3, S_ = N * SUB, MID = S_ / 2;
  const u = new Float32Array(N), vv = new Float32Array(N);
  const Rfull = 290, Rmin = 175;
  let Rt = Rfull, R = Rfull, t = 0, running = false, visible = false, last = 0, scale = 1, holdGlow = 0, flash = 0, isActive = false, cap = 1000, spendTxt = "", hover = -1, dragFired = false;
  let label: { t0: number; txt: string; x: number; y: number; th: number } | null = null;
  let packets: { t0: number; sx: number; sy: number; done: boolean }[] = [];
  let shocks: { t0: number; x: number; y: number }[] = [];
  let drag: { i: number; tx: number; ty: number } | null = null;
  let agents: A[] = [];
  const mono = o.mono;
  const col = (c: number[], a?: number) => `hsl(${c[0]} ${c[1]}% ${c[2]}% / ${a ?? 1})`;
  const mul = (a0: number) => { let a = a0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let q = Math.imul(a ^ a >>> 15, 1 | a); q = q + Math.imul(q ^ q >>> 7, 61 | q) ^ q; return ((q ^ q >>> 14) >>> 0) / 4294967296; }; };
  let rn = mul(11);
  const RX = new Float32Array(S_ + 1), RY = new Float32Array(S_ + 1), RU = new Float32Array(S_ + 1), RL = new Float32Array(S_ + 1), RNX = new Float32Array(S_ + 1), RNY = new Float32Array(S_ + 1);
  const TLmax = 200, TX = new Float32Array(TLmax + 1), TY = new Float32Array(TLmax + 1), TL = new Float32Array(TLmax + 1), TNX = new Float32Array(TLmax + 1), TNY = new Float32Array(TLmax + 1);
  let TN = 0;

  function buildRing() {
    for (let s = 0; s <= S_; s++) {
      const ss = s % S_, i = Math.floor(ss / SUB), f = (ss % SUB) / SUB, i2 = (i + 1) % N;
      const uu = u[i]! * (1 - f) + u[i2]! * f, th = (ss / S_) * TAU, r = R + uu;
      RX[s] = cx + r * Math.cos(th); RY[s] = cy + r * Math.sin(th) * K - ZR; RU[s] = uu;
    }
    RL[0] = 0; for (let s = 1; s <= S_; s++) RL[s] = RL[s - 1]! + Math.hypot(RX[s]! - RX[s - 1]!, RY[s]! - RY[s - 1]!);
    for (let s = 0; s <= S_; s++) { const a = RX[(s + 1) % S_]! - RX[(s - 1 + S_) % S_]!, b = RY[(s + 1) % S_]! - RY[(s - 1 + S_) % S_]!, m = Math.hypot(a, b) || 1; RNX[s] = -b / m; RNY[s] = a / m; }
  }
  function buildTail() {
    const y0 = RY[S_ * 3 / 4]!, yTop = 36; TN = Math.max(6, Math.min(TLmax, Math.floor((y0 - yTop) / 4)));
    for (let i = 0; i <= TN; i++) { TX[i] = RX[S_ * 3 / 4]!; TY[i] = y0 + (yTop - y0) * i / TN; TL[i] = i * ((y0 - yTop) / TN); TNX[i] = 1; TNY[i] = 0; }
    return y0;
  }
  const CORE = "hsl(350 32% 5%)", STF = ["hsl(40 26% 90%)", "hsl(40 22% 84%)", "hsl(40 24% 87%)"], STB = ["hsl(40 8% 52%)", "hsl(40 8% 46%)", "hsl(40 24% 49%)"];
  function drawRope(px: Float32Array, py: Float32Array, nx: Float32Array, ny: Float32Array, L: Float32Array, a: number, b: number, wrapEvery: number, w: number) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(px[a]!, py[a]!); for (let s = a + 1; s <= b; s++) ctx.lineTo(px[s]!, py[s]!);
    ctx.lineWidth = w + 5; ctx.strokeStyle = CORE; ctx.stroke();
    const PH = .15, AMP = w * .2;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        for (let s = a; s < b; s++) {
          const p0 = L[s]! * PH + k * 2.094, p1 = L[s + 1]! * PH + k * 2.094;
          if ((Math.cos((p0 + p1) / 2) > 0 ? 1 : 0) !== pass) continue;
          const o0 = AMP * Math.sin(p0), o1 = AMP * Math.sin(p1);
          ctx.moveTo(px[s]! + nx[s]! * o0, py[s]! + ny[s]! * o0); ctx.lineTo(px[s + 1]! + nx[s + 1]! * o1, py[s + 1]! + ny[s + 1]! * o1);
        }
        ctx.lineWidth = pass ? w * .34 : w * .28; ctx.strokeStyle = pass ? STF[k]! : STB[k]!; ctx.stroke();
      }
    }
    for (let s = a; s <= b; s++) {
      if (s % wrapEvery) continue;
      const hw = w * .5 + 2;
      ctx.beginPath(); ctx.moveTo(px[s]! - nx[s]! * hw, py[s]! - ny[s]! * hw); ctx.lineTo(px[s]! + nx[s]! * hw, py[s]! + ny[s]! * hw);
      ctx.lineWidth = w * .3; ctx.strokeStyle = "hsl(36 74% 44%)"; ctx.stroke();
      ctx.lineWidth = w * .1; ctx.strokeStyle = "hsl(40 85% 66%)"; ctx.stroke();
    }
  }
  function strain(a: number, b: number) {
    for (let s = a; s < b; s++) {
      const st = Math.abs(RU[s]!); if (st < 4) continue; const al = Math.min(1, (st - 3) / 28);
      ctx.beginPath(); ctx.moveTo(RX[s]!, RY[s]!); ctx.lineTo(RX[s + 1]!, RY[s + 1]!); ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.strokeStyle = `hsl(188 70% 66% / ${al * .8})`; ctx.stroke();
      if (flash > .02 && label) { const da = Math.abs(((s / S_ * TAU) - label.th + Math.PI * 3) % TAU - Math.PI); if (da < .9) { ctx.strokeStyle = `hsl(8 90% 62% / ${flash * (1 - da / .9)})`; ctx.lineWidth = 5; ctx.stroke(); } }
    }
  }
  function rr(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawKnot(x: number, y: number) {
    ctx.save(); ctx.translate(x, y); ctx.scale(.7, .7);
    ctx.fillStyle = "hsl(36 70% 40%)"; rr(-21, -30, 42, 60, 10); ctx.fill();
    ctx.fillStyle = "hsl(40 78% 58%)"; rr(-18, -30, 22, 58, 9); ctx.fill();
    ctx.strokeStyle = "hsl(36 72% 28%)"; ctx.lineWidth = 2.4; ctx.lineCap = "round";
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(-18, i * 14 - 4); ctx.lineTo(18, i * 14 + 4); ctx.stroke(); }
    ctx.restore();
  }
  function drawFinial(x: number, y: number) {
    if (holdGlow > .01) { const g = ctx.createRadialGradient(x, y, 0, x, y, 100); g.addColorStop(0, `hsl(188 70% 64% / ${holdGlow * .5})`); g.addColorStop(1, "hsl(188 70% 64% / 0)"); ctx.fillStyle = g; ctx.fillRect(x - 110, y - 110, 220, 220); }
    ctx.save(); ctx.translate(x, y); ctx.scale(.75, .75);
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.ellipse(i * 13, 2 - Math.abs(i) * 3, 8, 22, i * .42, 0, TAU); ctx.fillStyle = `hsl(40 78% ${56 + holdGlow * 10}%)`; ctx.fill(); ctx.strokeStyle = "hsl(36 72% 28%)"; ctx.lineWidth = 1.4; ctx.stroke(); }
    ctx.fillStyle = "hsl(36 70% 38%)"; rr(-22, 14, 44, 14, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -24, 6.5, 0, TAU); ctx.fillStyle = "hsl(188 62% 62%)"; ctx.fill();
    ctx.restore();
    ctx.font = `500 13px ${mono}`; const txt = `PayPal hold · $${(cap / 100).toFixed(2)}`, tw = ctx.measureText(txt).width;
    ctx.fillStyle = "hsl(350 20% 11%)"; ctx.fillRect(x + 30, y - 13, tw + 22, 28); ctx.fillStyle = "hsl(40 26% 92%)"; ctx.fillText(txt, x + 41, y + 6);
  }
  const sc = (a: A) => .86 + .14 * ((a.y / Rfull) + 1) / 2;
  function drawAgent(a: A, i: number) {
    const sx = cx + a.x, sy = cy + a.y * K - a.z, s = sc(a), r = 11 * s, c = a.c, hot = a.hot;
    ctx.beginPath(); ctx.ellipse(sx, cy + a.y * K, 20 * s, 6 * s, 0, 0, TAU); ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fill();
    for (let j = 1; j < a.tr.length; j++) { const p0 = a.tr[j - 1]!, p1 = a.tr[j]!; ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineWidth = r * .5 * (j / a.tr.length); ctx.lineCap = "round"; ctx.strokeStyle = col(c, .32 * (j / a.tr.length)); ctx.stroke(); }
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4); g.addColorStop(0, col(c, .38)); g.addColorStop(1, col(c, 0)); ctx.fillStyle = g; ctx.fillRect(sx - r * 4.5, sy - r * 4.5, r * 9, r * 9);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(t * .7 + a.ph); ctx.scale(1, .42); ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, TAU); ctx.strokeStyle = col(c, .55); ctx.lineWidth = 1.3; ctx.stroke(); ctx.restore();
    const cg = ctx.createRadialGradient(sx - r * .3, sy - r * .35, 0, sx, sy, r); cg.addColorStop(0, "hsl(40 40% 98%)"); cg.addColorStop(.45, col(c, 1)); cg.addColorStop(1, col([c[0], c[1], Math.max(c[2] - 28, 30)], 1));
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fillStyle = cg; ctx.fill();
    if (hot > .02) { ctx.beginPath(); ctx.arc(sx, sy, r * 1.9, 0, TAU); ctx.strokeStyle = `hsl(8 90% 62% / ${hot})`; ctx.lineWidth = 2.2; ctx.stroke(); }
    ctx.font = `500 12px ${mono}`; ctx.textAlign = "center"; ctx.fillStyle = `hsl(40 26% ${(hover === i || drag?.i === i) ? 96 : 80}%)`; ctx.fillText(a.name, sx, sy + r * 2.9); ctx.textAlign = "left";
  }
  function drawLinks() {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!;
      for (let j = i + 1; j < agents.length; j++) {
        const b = agents[j]!, d = Math.hypot(a.x - b.x, a.y - b.y), al = Math.max(.05, .28 - d / 900);
        ctx.beginPath(); ctx.moveTo(cx + a.x, cy + a.y * K - a.z); ctx.lineTo(cx + b.x, cy + b.y * K - b.z); ctx.lineWidth = 1; ctx.strokeStyle = `hsl(188 56% 62% / ${al})`; ctx.stroke();
      }
    }
  }
  function drawStage() {
    const f = Math.max(0, Math.min(1, (R - Rmin) / (Rfull - Rmin)));
    const g = ctx.createRadialGradient(cx, cy - 30, 0, cx, cy - 30, R * 1.4); g.addColorStop(0, `hsl(188 60% 40% / ${.12 + .1 * f})`); g.addColorStop(1, "hsl(188 60% 40% / 0)");
    ctx.save(); ctx.translate(0, cy); ctx.scale(1, K * 1.1); ctx.translate(0, -cy); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 3); ctx.restore();
    ctx.lineCap = "round"; ctx.setLineDash([0, 8]);
    ([[R * 1.12, .34], [Rfull * 1.06, .2]] as const).forEach(r => { ctx.beginPath(); ctx.ellipse(cx, cy, r[0], r[0] * K, 0, 0, TAU); ctx.lineWidth = 2.2; ctx.strokeStyle = `hsl(350 12% 62% / ${r[1]})`; ctx.stroke(); });
    ctx.setLineDash([]);
  }
  function drawShocks() {
    shocks.forEach(s => { const age = t - s.t0; if (age > 1.1) return; const p = age / 1.1, rad = 16 + p * 120; ctx.beginPath(); ctx.ellipse(s.x, s.y, rad, rad * K * 1.6, 0, 0, TAU); ctx.lineWidth = 3 * (1 - p) + 1; ctx.strokeStyle = `hsl(8 90% 62% / ${(1 - p) * .9})`; ctx.stroke(); });
    if (label && t - label.t0 < 1.8) { const q = (t - label.t0) / 1.8; ctx.font = `500 13px ${mono}`; ctx.fillStyle = `hsl(8 92% 72% / ${1 - q * q})`; ctx.fillText(label.txt, Math.min(label.x + 14, W - 170), label.y - 12 - q * 22); }
  }
  function drawPackets(y0: number) {
    packets.forEach(p => {
      const age = t - p.t0; let x: number, y: number;
      if (age < .7) { const q = age / .7, e = q * q * (3 - 2 * q), ex = cx; x = (1 - e) * (1 - e) * p.sx + 2 * (1 - e) * e * ((p.sx + ex) / 2) + e * e * ex; y = (1 - e) * (1 - e) * p.sy + 2 * (1 - e) * e * (Math.min(p.sy, y0) - 60) + e * e * y0; }
      else if (age < 1.3) { const q2 = (age - .7) / .6, e2 = q2 * q2 * (3 - 2 * q2); x = cx; y = y0 + (36 - y0) * e2; }
      else { if (!p.done) { p.done = true; holdGlow = 1; } return; }
      const g = ctx.createRadialGradient(x, y, 0, x, y, 20); g.addColorStop(0, "hsl(188 80% 78% / .9)"); g.addColorStop(1, "hsl(188 80% 70% / 0)"); ctx.fillStyle = g; ctx.fillRect(x - 22, y - 22, 44, 44);
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fillStyle = "hsl(40 40% 96%)"; ctx.fill();
    });
  }
  function draw() {
    if (!canvas.width) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, W, H);
    buildRing(); const y0 = buildTail();
    drawStage();
    drawRope(RX, RY, RNX, RNY, RL, MID, S_, 12, 20); strain(MID, S_);
    drawRope(TX, TY, TNX, TNY, TL, 0, TN, 14, 20);
    drawKnot(cx, y0); drawFinial(cx, 38); drawPackets(y0); drawLinks();
    agents.slice().sort((p, q) => p.y - q.y).forEach(a => drawAgent(a, agents.indexOf(a)));
    drawRope(RX, RY, RNX, RNY, RL, 0, MID, 12, 20); strain(0, MID);
    drawShocks();
    ctx.font = `13px ${mono}`; ctx.textAlign = "center"; ctx.fillStyle = "hsl(350 8% 70%)"; ctx.fillText(spendTxt, cx, cy + Rfull * K - ZR + 30); ctx.textAlign = "left";
    const v = ctx.createRadialGradient(cx, H * .5, H * .3, cx, H * .5, H * .95); v.addColorStop(0, "rgba(9,5,7,0)"); v.addColorStop(1, "rgba(9,5,7,.6)"); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }
  function press(th: number, amt: number) { const idx = Math.round(((th % TAU) + TAU) % TAU / TAU * N) % N; for (let k = -5; k <= 5; k++) { const j = (idx + k + N) % N, v = amt * Math.exp(-k * k / 8); if (v > u[j]!) u[j] = u[j]! + (v - u[j]!) * .35; } }
  function step(dt: number) {
    t += dt; R += (Rt - R) * Math.min(1, dt * 3); holdGlow = Math.max(0, holdGlow - dt * 1.1); flash = Math.max(0, flash - dt * 1.1);
    const sub = 2, h = dt / sub;
    for (let s = 0; s < sub; s++) { for (let i = 0; i < N; i++) { const l = u[(i + N - 1) % N]!, r = u[(i + 1) % N]!; vv[i] = vv[i]! + (-16 * u[i]! - 4.4 * vv[i]! + 48 * (l + r - 2 * u[i]!)) * h; } for (let i = 0; i < N; i++) u[i] = u[i]! + vv[i]! * h; }
    const Rl = R - 20, f = Math.max(0, Math.min(1, (R - Rmin) / (Rfull - Rmin))), agit = 1 + 1.4 * (1 - f);
    agents.forEach((a, ai) => {
      a.hot = Math.max(0, a.hot - dt * 1.2);
      if (drag && drag.i === ai) dragStep(a);
      else {
        if (isActive) {
          a.gt -= dt;
          if (a.gt <= 0) { const ang = rn() * TAU, rad = Rl * (.35 + .6 * rn()); a.gx = Math.cos(ang) * rad; a.gy = Math.sin(ang) * rad; a.gt = 1.5 + rn() * 2.4; }
          const dx = a.gx - a.x, dy = a.gy - a.y, d = Math.hypot(dx, dy) || 1, sp = 95 * agit; a.vx += dx / d * sp * dt; a.vy += dy / d * sp * dt;
        }
        agents.forEach(b => { if (b === a) return; const ex = a.x - b.x, ey = a.y - b.y, ed = Math.hypot(ex, ey) || 1; if (ed < 56) { a.vx += ex / ed * (56 - ed) * 2 * dt; a.vy += ey / ed * (56 - ed) * 2 * dt; } });
        const dmp = Math.exp((isActive ? -1.7 : -4) * dt), vmax = 130 * agit; a.vx *= dmp; a.vy *= dmp; const vm = Math.hypot(a.vx, a.vy); if (vm > vmax) { a.vx *= vmax / vm; a.vy *= vmax / vm; }
        a.x += a.vx * dt; a.y += a.vy * dt;
        const rr2 = Math.hypot(a.x, a.y);
        if (rr2 > Rl) { const over = rr2 - Rl, nx = a.x / rr2, ny = a.y / rr2; a.x = nx * (Rl + over * .12); a.y = ny * (Rl + over * .12); const vr = a.vx * nx + a.vy * ny; if (vr > 0) { a.vx -= vr * 1.4 * nx; a.vy -= vr * 1.4 * ny; } press(Math.atan2(a.y, a.x), Math.min(over, 50) * .5 + vr * .04); }
      }
      a.z = a.zb + 10 * Math.sin(t * .9 + a.ph);
      a.tr.push([cx + a.x, cy + a.y * K - a.z]); if (a.tr.length > 16) a.tr.shift();
    });
    packets = packets.filter(p => t - p.t0 < 1.4); shocks = shocks.filter(x => t - x.t0 < 1.2);
  }
  function dragStep(a: A) {
    if (!drag) return;
    let tx = drag.tx, ty = drag.ty; const r = Math.hypot(tx, ty), Rl = R - 20, over = Math.max(0, r - Rl), stretch = 56 * (1 - Math.exp(-over / 110)), lim = Rl + stretch;
    if (r > lim) { tx *= lim / r; ty *= lim / r; }
    a.x += (tx - a.x) * .35; a.y += (ty - a.y) * .35; a.vx = a.vy = 0;
    press(Math.atan2(a.y, a.x), Math.max(0, Math.hypot(a.x, a.y) - Rl) * 1.1 + 3);
    a.hot = Math.max(a.hot, Math.min(1, over / 80));
    if (over > 90 && !dragFired) { dragFired = true; o.onOver(drag.i); }
  }
  const settle = (n = 120) => { for (let i = 0; i < n; i++) step(1 / 60); };
  function frame(ts: number) {
    if (!running) return;
    if (o.isStill()) { running = false; settle(); draw(); return; }
    const dt = Math.min((ts - last) / 1000, .05); last = ts; step(dt); draw(); requestAnimationFrame(frame);
  }
  function start() { if (running || !visible || o.isStill()) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
  function repaint() { if (!visible) return; if (o.isStill()) { settle(); draw(); } else start(); }
  function resize() {
    const w = host.clientWidth; if (!w) return;
    H = w < 560 ? 430 : 300; cy = H - 94;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * H / W * dpr); scale = canvas.width / W; repaint();
  }
  const ro = "ResizeObserver" in window ? new ResizeObserver(resize) : null; ro?.observe(host);
  const io = "IntersectionObserver" in window ? new IntersectionObserver(es => { visible = !!es[0]?.isIntersecting; if (visible) resize(); else running = false; }, { threshold: 0 }) : null; io?.observe(host); if (!io) visible = true;
  const toL = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const pick = (lx: number, ly: number) => { let best = -1, bd = 34 * 34; agents.forEach((a, i) => { const sx = cx + a.x, sy = cy + a.y * K - a.z, d = (sx - lx) ** 2 + (sy - ly) ** 2; if (d < bd) { bd = d; best = i; } }); return best; };
  const down = (e: PointerEvent) => { const p = toL(e), i = pick(p[0], p[1]); if (i < 0) return; drag = { i, tx: agents[i]!.x, ty: agents[i]!.y }; dragFired = false; try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } canvas.style.cursor = "grabbing"; canvas.style.touchAction = "none"; if (o.isStill()) settle(); start(); };
  const move = (e: PointerEvent) => { const p = toL(e); if (drag) { const a = agents[drag.i]!; drag.tx = p[0] - cx; drag.ty = (p[1] - cy + a.z) / K; if (o.isStill()) { dragStep(a); draw(); } } else { const i = pick(p[0], p[1]); if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? "grab" : "default"; if (o.isStill()) draw(); } } };
  const release = () => { if (!drag) return; drag = null; canvas.style.cursor = "default"; canvas.style.touchAction = "pan-y"; if (o.isStill()) { settle(30); draw(); } };
  const leave = () => { if (!drag && hover !== -1) { hover = -1; if (o.isStill()) draw(); } };
  canvas.style.touchAction = "pan-y";
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release); canvas.addEventListener("pointerleave", leave);
  const pos = (i: number, n: number) => { const a = i / Math.max(n, 1) * TAU + .5, r = 70 + rn() * 60; return { x: Math.cos(a) * r, y: Math.sin(a) * r }; };

  return {
    setAgents(list) { rn = mul(11); agents = list.map((a, i) => { const p = pos(i, list.length); return { name: a.id, c: a.color, x: p.x, y: p.y, z: 0, zb: 30 + rn() * 40, vx: 0, vy: 0, gx: p.x, gy: p.y, gt: 0, ph: rn() * TAU, tr: [], hot: 0 }; }); if (o.isStill() && visible) { settle(30); draw(); } },
    update(frac, c, txt) { cap = c; spendTxt = txt; Rt = Rmin + (Rfull - Rmin) * Math.max(0, Math.min(1, frac)); if (o.isStill()) { R = Rt; if (visible) { settle(60); draw(); } } else start(); },
    served(i) { const a = agents[i]; if (!a || o.isStill()) return; packets.push({ t0: t, sx: cx + a.x, sy: cy + a.y * K - a.z, done: false }); },
    refused(i, txt) { const a = agents[i]; if (!a) return; a.hot = 1; flash = 1; const sx = cx + a.x, sy = cy + a.y * K - a.z; label = { t0: t, txt, x: sx, y: sy, th: Math.atan2(a.y, a.x) }; if (!o.isStill()) shocks.push({ t0: t, x: sx, y: sy }); press(Math.atan2(a.y, a.x), 34); if (o.isStill() && visible) { settle(8); draw(); } },
    active(b) { isActive = b; if (b) start(); },
    reset() { u.fill(0); vv.fill(0); packets = []; shocks = []; label = null; holdGlow = 0; flash = 0; Rt = Rfull; R = Rfull; },
    destroy() { running = false; ro?.disconnect(); io?.disconnect(); canvas.remove(); },
  };
}
