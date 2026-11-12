// Browser check for the product UI (home, budget, activity, collect, escrow, developers, proof).
// Usage: pnpm --filter @pashadhara/web check:cord   (a web server must run; default http://localhost:3100, or CORD_URL)
// Every /api/showcase answer is stubbed here, so the check does not depend on the live API and never makes a paid run.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
// Shared browser audits: horizontal overflow, text under 14 px, WCAG contrast of visible text.
async function audit(page, name, { contrast = true } = {}) {
  const issues = await page.evaluate(contrastOn => {
    const out = [], root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) out.push(`overflow ${root.scrollWidth}>${root.clientWidth}`);
    const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const bgOf = el => { const chain = []; for (let e = el; e; e = e.parentElement) { const st = getComputedStyle(e); let b = parse(st.backgroundColor); if (st.backgroundImage.includes('gradient')) { const stops = [...st.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(m => parse(m[0])); b = stops.sort((x, y) => lum(y) - lum(x))[0]; } if (b && b.a > 0) { chain.push(b); if (b.a === 1) break; } } let c = { r: 255, g: 255, b: 255, a: 1 }; for (const b of chain.reverse()) c = over(b, c); return c; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest("svg,script,style,noscript,.sr,.skip") || !el.checkVisibility()) continue;
      const box = el.getBoundingClientRect(); if (box.width <= 1 || box.height <= 1) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < 14) out.push(`small text "${n.textContent.trim().slice(0, 24)}"`);
      if (contrastOn && !el.closest(":disabled")) {
        let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const fg = parse(cs.color); if (!fg) continue;
        const bg = bgOf(el), f = over({ ...fg, a: fg.a * op }, bg);
        const l1 = lum(f), l2 = lum(bg), ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
        if (ratio < 4.5) out.push(`contrast ${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 24)}"`);
      }
    }
    return out;
  }, contrast);
  return issues.map(i => `${name}: ${i}`);
}

const origin = process.env.CORD_URL || "http://localhost:3100";
async function launch() {
  if (process.env.PLAYWRIGHT_EXECUTABLE) return chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE });
  if (existsSync(chromium.executablePath())) return chromium.launch();
  return chromium.launch({ channel: "msedge" });
}
const browser = await launch();
let step = 0;
const ok = label => console.log(`ok ${String(++step).padStart(2, "0")} ${label}`);
const ROUTES = ["/check", "/review", "/budget", "/activity", "/collect", "/escrow", "/developers", "/proof"];
const soon = () => new Date(Date.now() + 3 * 86400e3).toISOString();

const read = (over = {}) => ({
  provenance: "computed", mode: "live", state: "active", read_at: new Date().toISOString(), honor_until: soon(), remaining_calls: 2,
  lease: { id: "L1", state: "active", cap_minor: 200, guaranteed_now: true,
    authorizations: [{ id: "A1", status: "created", honor_until: soon(), expires_at: "2026-12-10T16:08:35+00:00", paypal_authorization_id: "0XU06317EW987240Y", amount_minor: 200 }],
    balances: { buyer_commitment: 200, hold_available: 194, committed_unsettled: 6, captured_gross: 0 } },
  calls: [
    { id: "c1", tool_id: "summarise", price_minor: "3", status: "served", created_at: "2026-11-11T20:12:34Z", ledger_group_id: "64800c8a-3109-44e1-b9f2-ace8406f495f", captured: false },
    { id: "c2", tool_id: "summarise", price_minor: "3", status: "served", created_at: "2026-11-11T21:59:25Z", ledger_group_id: "884d6fe4-b687-47f3-a0f1-8e1fc4986759", captured: false }],
  captures: [], ...over,
});

async function session(width, height, { scheme = "light", showcase = () => read() } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: scheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route("**/api/showcase", route => { const r = showcase(); if (r === null) route.fulfill({ status: 500, body: "x" }); else route.fulfill({ json: r }); });
  await page.route("**/api/showcase/try*", route => {
    const cents = Number(new URL(route.request().url()).searchParams.get("price_minor"));
    route.fulfill({ status: cents > 194 ? 402 : 200, json: { provenance: "computed", price_minor: cents, remaining_minor: 194, reason: cents > 194 ? "cap_reached" : null } });
  });
  return { context, page, errors };
}

try {
  // Live amount preview is opt-in; inspect its evidence, then check another amount.
  {
    const { context, page, errors } = await session(1440, 900);
    let previews = 0;
    page.on("request", req => { if (req.url().includes("/api/showcase/try")) previews++; });
    assert.equal((await page.goto(origin + "/check")).status(), 200);
    await page.getByRole("button", { name: "See the decision for $1.95" }).waitFor();
    assert.equal(previews, 0);
    await page.getByRole("button", { name: "See the decision for $1.95" }).click();
    await page.getByText(/Refused[\s\S]*\$0\.01 over/).waitFor();
    assert.equal(previews, 1);
    await page.getByRole("link", { name: "What this check proves" }).click();
    await page.getByRole("heading", { name: "What an amount check proves" }).waitFor();
    await page.goto(origin + "/budget");
    await page.getByLabel("Amount in USD").fill("1.00");
    await page.getByRole("button", { name: "See the decision for $1.00" }).click();
    await page.getByText("Amount fits the current limits").waitFor();
    assert.deepEqual(errors, []);
    ok("preview requires a click, links to evidence, and can check a different amount on Budget");
    await context.close();
  }

  {
    let n = 0;
    const { context, page } = await session(1440, 900, { showcase: () => (++n === 1 ? read() : null) });
    await page.goto(origin + "/budget");
    await page.getByRole("button", { name: /See the decision for \$1\.95/ }).waitFor();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByText(/Last good read .* ago/).waitFor();
    await page.getByText("Live spending data unavailable").waitFor();
    assert.equal(await page.getByRole("button", { name: /See the decision for \$1\.95/ }).count(), 0);
    await page.getByRole("button", { name: /See the decision for \$0\.07/ }).waitFor();
    ok("failed refresh retains the last read and disables live controls; the replay is available");
    await context.close();
  }

  // 5. Missing optional fields hide their elements
  {
    const { context, page, errors } = await session(1440, 900, { showcase: () => ({ read_at: new Date().toISOString() }) });
    for (const r of ROUTES) { await page.goto(origin + r, { waitUntil: "networkidle" }); await page.locator("h1").first().waitFor(); }
    await page.goto(origin + "/collect", { waitUntil: "networkidle" });
    assert.equal(await page.locator("text=Captures on this hold").count(), 0);
    assert.deepEqual(errors, []);
    ok("a minimal /api/showcase answer renders every page without errors or invented numbers");
    await context.close();
  }

  // 6. Activity: empty state, filter, refusal sheet
  {
    const { context, page } = await session(1440, 900, { showcase: () => read({ calls: [] }) });
    await page.goto(origin + "/activity", { waitUntil: "networkidle" });
    await page.getByText("No calls on this hold yet.").waitFor();
    await context.close();
    const s = await session(1440, 900, { showcase: () => read({ calls: [...read().calls, { id: "c3", tool_id: "summarise", price_minor: "3", status: "refused_cap", created_at: "2026-11-12T06:39:00Z" }] }) });
    await s.page.goto(origin + "/activity", { waitUntil: "networkidle" });
    await s.page.getByRole("button", { name: "Refused", exact: true }).click();
    assert.equal(await s.page.locator(".tbl tbody tr").count(), 1);
    await s.page.locator(".tbl tbody tr").first().click();
    assert.match(await s.page.locator(".sheet").textContent(), /Refused before the model ran/);
    ok("activity: empty state, Refused filter, refusal detail sheet");
    await s.context.close();
  }

  // 7. Every page, both themes, desktop and phone: overflow, text size, contrast
  for (const [w, h] of [[1440, 900], [390, 844], [375, 800]]) for (const scheme of ["light", "dark"]) {
    const { context, page, errors } = await session(w, h, { scheme });
    const issues = [];
    for (const r of ROUTES) { await page.goto(origin + r + (r === "/activity" ? "?call=c1" : ""), { waitUntil: "networkidle" }); await page.waitForTimeout(150); issues.push(...await audit(page, `${r} ${w} ${scheme}`)); }
    assert.deepEqual(issues, [], issues.join("\n"));
    assert.deepEqual(errors, []);
    await context.close();
  }
  ok("all pages at 1440, 390 and 375, light and dark: no overflow, no text under 14 px, contrast at least 4.5:1, no console errors");

  // 8. Routing
  {
    const { context, page } = await session(1440, 900);
    assert.equal((await page.goto(origin + "/nope")).status(), 404);
    await page.goto(origin + "/lease", { waitUntil: "networkidle" });
    assert.match(page.url(), /\/budget$/);
    await context.close();
    ok("unknown paths are 404, /lease moves to /budget");
  }
} finally {
  await browser.close();
}
