/* "Held, not watched": agents inside a braided pasha, canvas soft-body rope. Ported from v3.html (initHeld).
   The loop radius follows the free balance given to update(). Agents roam, press on the rope, and the rope resists.
   Dragging an agent past the rope calls onOver (the page turns that into a real limit check). Nothing here knows money rules. */
export type HeldApi = {
  update(free: number): void; serve(): void; strain(label: string): void; clear(): void; refresh(): void; destroy(): void;
};
export type HeldOpts = { cap: number; mono: string; onOver: () => void; isStill: () => boolean };

type Agent = { name: string; c: number[]; x: number; y: number; z: number; zb: number; vx: number; vy: number; gx: number; gy: number; gt: number; ph: number; tr: number[][]; hot: number };

export function initHeld(host: HTMLElement, o: HeldOpts): HeldApi {
  let { cap } = o;
  const W = 900, K = .36, ZR = 84, TAU = Math.PI * 2;
  let H = 640, cx = 450, cy = 440;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Five autonomous agents move inside a braided rope, a pasha, that hangs from the PayPal hold. The loop tightens as the hold is spent and the rope resists when an agent pulls against it.");
  host.appendChild(canvas);
  const N = 96, SUB = 3, S = N * SUB, MID = S / 2;
  const u = new Float32Array(N), vv = new Float32Array(N);
  let free = cap, Rt = 350, R = 350, t = 0, running = false, visible = true, last = 0, scale = 1, dead = false;
  const Rfull = 350, Rmin = 190;
  let holdGlow = 0, flash = 0, label: { t0: number; th: number; x: number; y: number; txt: string } | null = null;
  let packets: { t0: number; sx: number; sy: number; done?: boolean }[] = [];
  let shocks: { t0: number; x: number; y: number }[] = [];
  let hover = -1, drag: { i: number; tx: number; ty: number } | null = null, dragFired = false;
  const NAMES = ["research", "finance", "runaway", "judge", "scribe"];
  const HSL = [[188, 60, 62], [40, 26, 92], [36, 66, 68], [188, 66, 76], [350, 34, 82]];
  const col = (c: number[], a?: number) => `hsl(${c[0]} ${c[1]}% ${c[2]}% / ${a == null ? 1 : a})`;
  const mul = (a0: number) => () => { let a = a0 |= 0; a = a + 0x6D2B79F5 | 0; let q = Math.imul(a ^ a >>> 15, 1 | a); q = q + Math.imul(q ^ q >>> 7, 61 | q) ^ q; a0 = a; return ((q ^ q >>> 14) >>> 0) / 4294967296; };
  const rnd = mul(11);
  const agents: Agent[] = NAMES.map((n, i) => { const a = i / 5 * TAU + .4, r = 70 + rnd() * 90; return { name: n, c: HSL[i]!, x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0, zb: 34 + rnd() * 64, vx: 0, vy: 0, gx: 0, gy: 0, gt: 0, ph: rnd() * TAU, tr: [], hot: 0 }; });
  const money2 = (c: number) => "$" + (c / 100).toFixed(2);

  const RX = new Float32Array(S + 1), RY = new Float32Array(S + 1), RU = new Float32Array(S + 1), RL = new Float32Array(S + 1), RNX = new Float32Array(S + 1), RNY = new Float32Array(S + 1);
  const TLmax = 260, TX = new Float32Array(TLmax + 1), TY = new Float32Array(TLmax + 1), TL = new Float32Array(TLmax + 1), TNX = new Float32Array(TLmax + 1), TNY = new Float32Array(TLmax + 1);
  let TN = 0;
  function buildRing() {
    for (let s = 0; s <= S; s++) {
      const ss = s % S, i = Math.floor(ss / SUB), f = (ss % SUB) / SUB, i2 = (i + 1) % N;
      const uu = u[i]! * (1 - f) + u[i2]! * f, th = (ss / S) * TAU, r = R + uu, x = r * Math.cos(th), y = r * Math.sin(th);
      RX[s] = cx + x; RY[s] = cy + y * K - ZR; RU[s] = uu;
    }
    RL[0] = 0;
    for (let s = 1; s <= S; s++) RL[s] = RL[s - 1]! + Math.hypot(RX[s]! - RX[s - 1]!, RY[s]! - RY[s - 1]!);
    for (let s = 0; s <= S; s++) { const a = RX[(s + 1) % S]! - RX[(s - 1 + S) % S]!, b = RY[(s + 1) % S]! - RY[(s - 1 + S) % S]!, m = Math.hypot(a, b) || 1; RNX[s] = -b / m; RNY[s] = a / m; }
  }
  function buildTail() {
    const y0 = RY[S * 3 / 4]!, yTop = 112; TN = Math.max(6, Math.min(TLmax, Math.floor((y0 - yTop) / 4)));
    for (let i = 0; i <= TN; i++) { TX[i] = RX[S * 3 / 4]!; TY[i] = y0 + (yTop - y0) * i / TN; TL[i] = i * ((y0 - yTop) / TN); TNX[i] = 1; TNY[i] = 0; }
    return y0;
  }
  const CORE = "hsl(350 32% 5%)", STF = ["hsl(40 26% 90%)", "hsl(40 22% 84%)", "hsl(40 24% 87%)"], STB = ["hsl(40 8% 52%)", "hsl(40 8% 46%)", "hsl(40 8% 49%)"];
  type F32 = Float32Array;
  function drawRope(px: F32, py: F32, nx: F32, ny: F32, L: F32, a: number, b: number, wrapEvery: number, w: number) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(px[a]!, py[a]!); for (let s = a + 1; s <= b; s++) ctx.lineTo(px[s]!, py[s]!);
    ctx.lineWidth = w + 6; ctx.strokeStyle = CORE; ctx.stroke();
    const PH = .11, AMP = w * .2;
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
      const cxp = px[s]!, cyp = py[s]!, hw = w * .5 + 2;
      ctx.beginPath(); ctx.moveTo(cxp - nx[s]! * hw, cyp - ny[s]! * hw); ctx.lineTo(cxp + nx[s]! * hw, cyp + ny[s]! * hw);
      ctx.lineWidth = w * .3; ctx.strokeStyle = "hsl(36 74% 44%)"; ctx.stroke();
      ctx.lineWidth = w * .1; ctx.strokeStyle = "hsl(40 85% 66%)"; ctx.stroke();
    }
  }
  function strainOverlay(a: number, b: number) {
    for (let s = a; s < b; s++) {
      const st = Math.abs(RU[s]!); if (st < 5) continue; const al = Math.min(1, (st - 4) / 34);
      ctx.beginPath(); ctx.moveTo(RX[s]!, RY[s]!); ctx.lineTo(RX[s + 1]!, RY[s + 1]!); ctx.lineWidth = 4; ctx.lineCap = "round";
      ctx.strokeStyle = `hsl(188 70% 66% / ${al * .8})`; ctx.stroke();
      if (flash > .02 && label) { const da = Math.abs(((s / S * TAU) - label.th + Math.PI * 3) % TAU - Math.PI); if (da < .9) { ctx.strokeStyle = `hsl(8 90% 62% / ${flash * (1 - da / .9)})`; ctx.lineWidth = 6; ctx.stroke(); } }
    }
  }
  function rr(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawKnot(x: number, y: number) {
    ctx.fillStyle = "hsl(36 70% 40%)"; rr(x - 21, y - 30, 42, 60, 10); ctx.fill();
    ctx.fillStyle = "hsl(40 78% 58%)"; rr(x - 18, y - 30, 22, 58, 9); ctx.fill();
    ctx.strokeStyle = "hsl(36 72% 28%)"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(x - 18, y + i * 14 - 4); ctx.lineTo(x + 18, y + i * 14 + 4); ctx.stroke(); }
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.ellipse(x + i * 11, y - 34, 6, 11, i * .5, 0, TAU); ctx.fillStyle = "hsl(40 78% 60%)"; ctx.fill(); ctx.strokeStyle = "hsl(36 72% 30%)"; ctx.lineWidth = 1.4; ctx.stroke(); }
  }
  function drawFinial(x: number, y: number) {
    if (holdGlow > .01) { const g = ctx.createRadialGradient(x, y, 0, x, y, 120); g.addColorStop(0, `hsl(188 70% 64% / ${holdGlow * .5})`); g.addColorStop(1, "hsl(188 70% 64% / 0)"); ctx.fillStyle = g; ctx.fillRect(x - 130, y - 130, 260, 260); }
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.ellipse(x + i * 13, y + 2 - Math.abs(i) * 3, 8, 22, i * .42, 0, TAU); ctx.fillStyle = `hsl(40 78% ${56 + holdGlow * 10}%)`; ctx.fill(); ctx.strokeStyle = "hsl(36 72% 28%)"; ctx.lineWidth = 1.4; ctx.stroke(); }
    ctx.fillStyle = "hsl(36 70% 38%)"; rr(x - 22, y + 14, 44, 14, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y - 24, 6.5, 0, TAU); ctx.fillStyle = "hsl(188 62% 62%)"; ctx.fill();
    ctx.font = `500 14px ${o.mono}`; const txt = "PayPal hold · " + money2(cap), tw = ctx.measureText(txt).width;
    ctx.fillStyle = "hsl(350 20% 11%)"; ctx.fillRect(x + 36, y - 14, tw + 28, 32); ctx.fillStyle = "hsl(40 26% 92%)"; ctx.fillText(txt, x + 50, y + 7);
  }
  const sc = (a: Agent) => .86 + .14 * ((a.y / Rfull) + 1) / 2;
  function drawAgent(a: Agent, i: number) {
    const sx = cx + a.x, sy = cy + a.y * K - a.z, s = sc(a), r = 14 * s, c = a.c, hot = a.hot;
    ctx.beginPath(); ctx.ellipse(sx, cy + a.y * K, 26 * s, 8 * s, 0, 0, TAU); ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fill();
    for (let j = 1; j < a.tr.length; j++) { const p0 = a.tr[j - 1]!, p1 = a.tr[j]!; ctx.beginPath(); ctx.moveTo(p0[0]!, p0[1]!); ctx.lineTo(p1[0]!, p1[1]!); ctx.lineWidth = r * .5 * (j / a.tr.length); ctx.lineCap = "round"; ctx.strokeStyle = col(c, .32 * (j / a.tr.length)); ctx.stroke(); }
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4.6); g.addColorStop(0, col(c, .38)); g.addColorStop(1, col(c, 0)); ctx.fillStyle = g; ctx.fillRect(sx - r * 5, sy - r * 5, r * 10, r * 10);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(t * .7 + a.ph); ctx.scale(1, .42); ctx.beginPath(); ctx.arc(0, 0, r * 2.5, 0, TAU); ctx.strokeStyle = col(c, .55); ctx.lineWidth = 1.4; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(-t * .5 + a.ph * 2); ctx.scale(1, .3); ctx.beginPath(); ctx.arc(0, 0, r * 3.3, 0, TAU); ctx.setLineDash([3, 7]); ctx.strokeStyle = col(c, .35); ctx.lineWidth = 1.3; ctx.stroke(); ctx.restore();
    const cg = ctx.createRadialGradient(sx - r * .3, sy - r * .35, 0, sx, sy, r); cg.addColorStop(0, "hsl(40 40% 98%)"); cg.addColorStop(.45, col(c, 1)); cg.addColorStop(1, col([c[0]!, c[1]!, Math.max(c[2]! - 28, 30)], 1));
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fillStyle = cg; ctx.fill();
    if (hot > .02) { ctx.beginPath(); ctx.arc(sx, sy, r * 1.9, 0, TAU); ctx.strokeStyle = `hsl(8 90% 62% / ${hot})`; ctx.lineWidth = 2.4; ctx.stroke(); }
    if (hover === i || (drag && drag.i === i)) { ctx.font = `500 14px ${o.mono}`; ctx.textAlign = "center"; ctx.fillStyle = "hsl(40 26% 92%)"; ctx.fillText("agent · " + a.name, sx, sy - r * 3.6); ctx.textAlign = "left"; }
  }
  function drawLinks() {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!, best: [number, number][] = [];
      for (let j = 0; j < agents.length; j++) { if (j === i) continue; best.push([Math.hypot(a.x - agents[j]!.x, a.y - agents[j]!.y), j]); }
      best.sort((p, q) => p[0] - q[0]);
      for (let k = 0; k < 2; k++) {
        const b = agents[best[k]![1]]!, d = best[k]![0];
        const ax = cx + a.x, ay = cy + a.y * K - a.z, bx = cx + b.x, by = cy + b.y * K - b.z, al = Math.max(.06, .3 - d / 900);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineWidth = 1; ctx.strokeStyle = `hsl(188 56% 62% / ${al})`; ctx.stroke();
        const f = (t * .35 + i * .31 + k * .5) % 1; ctx.beginPath(); ctx.arc(ax + (bx - ax) * f, ay + (by - ay) * f, 2, 0, TAU); ctx.fillStyle = `hsl(188 70% 76% / ${al * 2.4})`; ctx.fill();
      }
    }
  }
  function drawStage() {
    const f = Math.max(0, Math.min(1, (R - Rmin) / (Rfull - Rmin)));
    const g = ctx.createRadialGradient(cx, cy - 30, 0, cx, cy - 30, R * 1.5); g.addColorStop(0, `hsl(188 60% 40% / ${.12 + .1 * f})`); g.addColorStop(1, "hsl(188 60% 40% / 0)");
    ctx.save(); ctx.translate(0, cy); ctx.scale(1, K * 1.1); ctx.translate(0, -cy); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 2); ctx.restore();
    ctx.lineCap = "round";
    [[R * 1.14, .34], [R * 1.3, .26], [Rfull * 1.1, .2], [Rfull * 1.24, .14]].forEach(r => { ctx.beginPath(); ctx.ellipse(cx, cy, r[0]!, r[0]! * K, 0, 0, TAU); ctx.setLineDash([0, 8]); ctx.lineWidth = 2.4; ctx.strokeStyle = `hsl(350 12% 62% / ${r[1]})`; ctx.stroke(); });
    ctx.setLineDash([]);
    for (let i = 0; i < 48; i++) { const th = i / 48 * TAU, rx = Rfull * 1.24 + 14; ctx.beginPath(); ctx.arc(cx + Math.cos(th) * rx, cy + Math.sin(th) * rx * K, i % 4 === 0 ? 2.6 : 1.5, 0, TAU); ctx.fillStyle = `hsl(350 12% 62% / ${i % 4 === 0 ? .4 : .2})`; ctx.fill(); }
    ctx.strokeStyle = "hsl(40 26% 90% / .07)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cx - R, cy - ZR); ctx.lineTo(cx - R, cy - 190); ctx.moveTo(cx + R, cy - ZR); ctx.lineTo(cx + R, cy - 190); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy - 190, R, R * K, 0, 0, TAU); ctx.stroke();
  }
  function drawShocks() {
    shocks.forEach(s => { const age = t - s.t0; if (age > 1.1) return; const p = age / 1.1, rad = 20 + p * 150; ctx.beginPath(); ctx.ellipse(s.x, s.y, rad, rad * K * 1.6, 0, 0, TAU); ctx.lineWidth = 3 * (1 - p) + 1; ctx.strokeStyle = `hsl(8 90% 62% / ${(1 - p) * .9})`; ctx.stroke(); });
    if (label && t - label.t0 < 1.8) { const q = (t - label.t0) / 1.8; ctx.font = `500 14px ${o.mono}`; ctx.fillStyle = `hsl(8 92% 72% / ${1 - q * q})`; ctx.fillText(label.txt, label.x + 18, label.y - 14 - q * 26); }
  }
  function drawPackets(y0: number) {
    packets.forEach(p => {
      const age = t - p.t0; let x: number, y: number;
      if (age < .8) { const q = age / .8, e = q * q * (3 - 2 * q), sx = p.sx, sy = p.sy, ex = cx, ey = y0; x = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * ((sx + ex) / 2) + e * e * ex; y = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * (Math.min(sy, ey) - 70) + e * e * ey; }
      else if (age < 1.6) { const q2 = (age - .8) / .8, e2 = q2 * q2 * (3 - 2 * q2); x = cx; y = y0 + (112 - y0) * e2; }
      else { if (!p.done) { p.done = true; holdGlow = 1; } return; }
      const g = ctx.createRadialGradient(x, y, 0, x, y, 22); g.addColorStop(0, "hsl(188 80% 78% / .9)"); g.addColorStop(1, "hsl(188 80% 70% / 0)"); ctx.fillStyle = g; ctx.fillRect(x - 24, y - 24, 48, 48);
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fillStyle = "hsl(40 40% 96%)"; ctx.fill();
    });
  }
  function draw() {
    if (!canvas.width) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, W, H);
    buildRing(); const y0 = buildTail();
    drawStage();
    drawRope(RX, RY, RNX, RNY, RL, MID, S, 12, 30); strainOverlay(MID, S);
    drawRope(TX, TY, TNX, TNY, TL, 0, TN, 14, 30);
    drawKnot(cx, y0); drawFinial(cx, 84); drawPackets(y0); drawLinks();
    agents.slice().sort((p, q) => p.y - q.y).forEach(a => drawAgent(a, agents.indexOf(a)));
    drawRope(RX, RY, RNX, RNY, RL, 0, MID, 12, 30); strainOverlay(0, MID);
    drawShocks();
    ctx.font = `14px ${o.mono}`; ctx.textAlign = "center"; ctx.fillStyle = "hsl(350 8% 70%)"; ctx.fillText("Free inside the loop · " + money2(free), cx, cy + R * K + 54); ctx.textAlign = "left";
    const v = ctx.createRadialGradient(cx, H * .5, H * .3, cx, H * .5, H * .95); v.addColorStop(0, "rgba(9,5,7,0)"); v.addColorStop(1, "rgba(9,5,7,.7)"); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }
  function press(th: number, amt: number) { const idx = Math.round(((th % TAU) + TAU) % TAU / TAU * N) % N; for (let k = -6; k <= 6; k++) { const j = (idx + k + N) % N, v = amt * Math.exp(-k * k / 9); if (v > u[j]!) u[j] = u[j]! + (v - u[j]!) * .35; } }
  function step(dt: number) {
    t += dt; R += (Rt - R) * Math.min(1, dt * 3); holdGlow = Math.max(0, holdGlow - dt * 1.1); flash = Math.max(0, flash - dt * 1.1);
    const sub = 2, h = dt / sub;
    for (let s = 0; s < sub; s++) { for (let i = 0; i < N; i++) { const l = u[(i + N - 1) % N]!, r = u[(i + 1) % N]!; vv[i] = vv[i]! + (-16 * u[i]! - 4.4 * vv[i]! + 48 * (l + r - 2 * u[i]!)) * h; } for (let i = 0; i < N; i++) u[i] = u[i]! + vv[i]! * h; }
    const Rl = R - 22, f = Math.max(0, Math.min(1, (R - Rmin) / (Rfull - Rmin))), agit = 1 + 1.5 * (1 - f);
    agents.forEach((a, ai) => {
      a.hot = Math.max(0, a.hot - dt * 1.2);
      if (drag && drag.i === ai) { dragStep(a); }
      else {
        a.gt -= dt;
        if (a.gt <= 0) { const ang = rnd() * TAU, rad = Rfull * (.5 + .55 * rnd()); a.gx = Math.cos(ang) * rad; a.gy = Math.sin(ang) * rad; a.gt = 1.5 + rnd() * 2.6; }
        const dx = a.gx - a.x, dy = a.gy - a.y, d = Math.hypot(dx, dy) || 1, sp = 120 * agit;
        a.vx += dx / d * sp * dt; a.vy += dy / d * sp * dt;
        agents.forEach(b => { if (b === a) return; const ex = a.x - b.x, ey = a.y - b.y, ed = Math.hypot(ex, ey) || 1; if (ed < 64) { a.vx += ex / ed * (64 - ed) * 2.2 * dt; a.vy += ey / ed * (64 - ed) * 2.2 * dt; } });
        const dmp = Math.exp(-1.7 * dt), vmax = 150 * agit; a.vx *= dmp; a.vy *= dmp; const vm = Math.hypot(a.vx, a.vy); if (vm > vmax) { a.vx *= vmax / vm; a.vy *= vmax / vm; }
        a.x += a.vx * dt; a.y += a.vy * dt;
        const rr2 = Math.hypot(a.x, a.y);
        if (rr2 > Rl) { const over = rr2 - Rl, nx = a.x / rr2, ny = a.y / rr2; a.x = nx * (Rl + over * .12); a.y = ny * (Rl + over * .12); const vr = a.vx * nx + a.vy * ny; if (vr > 0) { a.vx -= vr * 1.4 * nx; a.vy -= vr * 1.4 * ny; } press(Math.atan2(a.y, a.x), Math.min(over, 60) * .5 + vr * .04); }
      }
      a.z = a.zb + 14 * Math.sin(t * .9 + a.ph);
      a.tr.push([cx + a.x, cy + a.y * K - a.z]); if (a.tr.length > 18) a.tr.shift();
    });
    packets = packets.filter(p => t - p.t0 < 1.7);
    shocks = shocks.filter(sh => t - sh.t0 < 1.2);
  }
  function dragStep(a: Agent) {
    if (!drag) return;
    let tx = drag.tx, ty = drag.ty; const r = Math.hypot(tx, ty), Rl = R - 22, over = Math.max(0, r - Rl), stretch = 64 * (1 - Math.exp(-over / 120)), lim = Rl + stretch;
    if (r > lim) { tx *= lim / r; ty *= lim / r; }
    a.x += (tx - a.x) * .35; a.y += (ty - a.y) * .35; a.vx = a.vy = 0;
    const th = Math.atan2(a.y, a.x); press(th, Math.max(0, Math.hypot(a.x, a.y) - Rl) * 1.15 + 4);
    a.hot = Math.max(a.hot, Math.min(1, over / 90));
    if (over > 100 && !dragFired) { dragFired = true; o.onOver(); }
  }
  const settle = () => { for (let i = 0; i < 140; i++) step(1 / 60); };
  function frame(ts: number) {
    if (!running || dead) return;
    if (o.isStill()) { running = false; settle(); draw(); return; }
    const dt = Math.min((ts - last) / 1000, .05); last = ts; step(dt); draw(); requestAnimationFrame(frame);
  }
  function start() { if (running || !visible || o.isStill() || dead) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
  function repaint() { if (o.isStill()) { running = false; settle(); draw(); } else start(); }
  function resize() {
    const w = host.clientWidth || 900; H = w < 640 ? 800 : 640; cy = H - 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * H / W * dpr); scale = canvas.width / W; repaint();
  }
  const ro = "ResizeObserver" in window ? new ResizeObserver(resize) : null; ro?.observe(host);
  const io = "IntersectionObserver" in window ? new IntersectionObserver(es => { visible = es[0]!.isIntersecting; if (visible) start(); else running = false; }, { threshold: 0 }) : null; io?.observe(host);

  const toL = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const pick = (lx: number, ly: number) => { let best = -1, bd = 40 * 40; agents.forEach((a, i) => { const sx = cx + a.x, sy = cy + a.y * K - a.z, d = (sx - lx) ** 2 + (sy - ly) ** 2; if (d < bd) { bd = d; best = i; } }); return best; };
  const down = (e: PointerEvent) => { const p = toL(e), i = pick(p[0], p[1]); if (i < 0) return; drag = { i, tx: agents[i]!.x, ty: agents[i]!.y }; dragFired = false; try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } canvas.style.cursor = "grabbing"; if (o.isStill()) settle(); start(); };
  const move = (e: PointerEvent) => { const p = toL(e); if (drag) { const a = agents[drag.i]!; drag.tx = p[0] - cx; drag.ty = (p[1] - cy + a.z) / K; if (o.isStill()) { dragStep(a); draw(); } } else { const i = pick(p[0], p[1]); if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? "grab" : "default"; if (o.isStill()) draw(); } } };
  const release = () => { if (!drag) return; drag = null; canvas.style.cursor = hover >= 0 ? "grab" : "default"; if (o.isStill()) { for (let i = 0; i < 30; i++) step(1 / 60); draw(); } };
  const leave = () => { if (!drag && hover !== -1) { hover = -1; if (o.isStill()) draw(); } };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release); canvas.addEventListener("pointerleave", leave);
  resize();

  return {
    update(fr) { free = fr; Rt = Rmin + (Rfull - Rmin) * Math.max(0, Math.min(1, cap > 0 ? fr / cap : 0)); if (o.isStill()) { R = Rt; settle(); draw(); } else start(); },
    serve() { const a = agents[Math.floor(rnd() * agents.length)]!; packets.push({ t0: t, sx: cx + a.x, sy: cy + a.y * K - a.z }); if (o.isStill()) { holdGlow = 1; draw(); } else start(); },
    strain(txt) {
      const i = drag ? drag.i : Math.floor(rnd() * agents.length), a = agents[i]!, th = Math.atan2(a.y, a.x);
      a.hot = 1; flash = 1; press(th, 70);
      for (let k = -8; k <= 8; k++) { const ix = (Math.round(((th % TAU) + TAU) % TAU / TAU * N) + k + N) % N; vv[ix] = vv[ix]! + 60 * Math.exp(-k * k / 14); }
      const px = cx + Math.cos(th) * R, py = cy + Math.sin(th) * R * K - ZR;
      shocks.push({ t0: t, x: px, y: py }); label = { t0: t, th: ((th % TAU) + TAU) % TAU, x: px, y: py, txt };
      a.vx += Math.cos(th) * 160; a.vy += Math.sin(th) * 160;
      if (o.isStill()) draw(); else start();
    },
    clear() { flash = 0; label = null; shocks = []; agents.forEach(a => { a.hot = 0; }); if (o.isStill()) draw(); },
    refresh: repaint,
    destroy() { dead = true; running = false; ro?.disconnect(); io?.disconnect(); canvas.remove(); },
  };
}
