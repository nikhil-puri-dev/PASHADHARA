// Browser check for the V3 port (landing and the four demo views).
// Usage: CORD_URL=http://127.0.0.1:3140 node scripts/check-v3.mjs   (a production server must run)
// Every /api/showcase answer is stubbed. The paid Run endpoint is never called: any request to it is counted and fails the check.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.CORD_URL || "http://127.0.0.1:3140";
const shotDir = fileURLToPath(new URL("../../../design/v3-screens/", import.meta.url));
mkdirSync(shotDir, { recursive: true });
async function launch() {
  if (process.env.PLAYWRIGHT_EXECUTABLE) return chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE });
  if (existsSync(chromium.executablePath())) return chromium.launch();
  return chromium.launch({ channel: "msedge" });
}
const browser = await launch();
let step = 0;
const ok = label => console.log(`ok ${String(++step).padStart(2, "0")} ${label}`);
const soon = () => new Date(Date.now() + 3 * 86400e3).toISOString();
const read = (over = {}) => ({
  provenance: "computed", mode: "live", state: "active", read_at: new Date().toISOString(), honor_until: soon(), remaining_calls: 2,
  lease: { id: "L1", state: "active", cap_minor: 1000, guaranteed_now: true,
    authorizations: [{ id: "A1", status: "created", honor_until: soon(), expires_at: "2026-12-10T16:08:35+00:00", paypal_authorization_id: "0XU06317EW987240Y", amount_minor: 1000 }],
    balances: { buyer_commitment: 1000, hold_available: 700, committed_unsettled: 300, captured_gross: 0 } },
  calls: [
    { id: "c1", tool_id: "summarise", price_minor: "3", status: "served", created_at: "2026-11-11T20:12:34Z", ledger_group_id: "g1", captured: false },
    { id: "c2", tool_id: "summarise", price_minor: "3", status: "served", created_at: "2026-11-11T21:59:25Z", ledger_group_id: "g2", captured: false }],
  captures: [], ...over,
});

// Audit: horizontal overflow, text under 14 px, WCAG contrast of visible text (svg and canvas text excluded).
async function audit(page, name) {
  const issues = await page.evaluate(() => {
    const out = [], root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) out.push(`overflow ${root.scrollWidth}>${root.clientWidth}`);
    const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const bgOf = el => { const chain = []; for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0) { chain.push(b); if (b.a === 1) break; } } let c = { r: 9, g: 5, b: 7, a: 1 }; for (const b of chain.reverse()) c = over(b, c); return c; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest("svg,script,style,noscript,canvas,[aria-hidden=true],a[href=\"#main\"]") || !el.checkVisibility()) continue;
      const cs = getComputedStyle(el), box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1 || box.left < -1000) continue;
      if (parseFloat(cs.fontSize) < 14) out.push(`small text "${n.textContent.trim().slice(0, 24)}" ${cs.fontSize}`);
      if (el.closest(":disabled")) continue;
      let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el), f = over({ ...fg, a: fg.a * op }, bg);
      const l1 = lum(f), l2 = lum(bg), ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
      if (ratio < 4.5) out.push(`contrast ${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  return issues.map(i => `${name}: ${i}`);
}

const calls = { run: 0, try: [] };
async function session(width, height, { scheme = "dark", reduced = true, showcase = () => read() } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference", colorScheme: scheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route("**/api/showcase/run*", route => { calls.run++; route.fulfill({ status: 500, body: "paid run must never be called by this check" }); });
  await page.route("**/api/showcase/try*", route => {
    const cents = Number(new URL(route.request().url()).searchParams.get("price_minor"));
    calls.try.push(cents);
    route.fulfill({ status: cents > 700 ? 402 : 200, json: { provenance: "computed", price_minor: cents, remaining_minor: 700, reason: cents > 700 ? "cap_reached" : null } });
  });
  await page.route("**/api/showcase", route => { const r = showcase(); if (r === null) route.fulfill({ status: 500, body: "x" }); else route.fulfill({ json: r }); });
  return { context, page, errors };
}
const settle = page => page.waitForTimeout(250);
const txt = (page, sel) => page.locator(sel).first().innerText();

try {
  // 1. Landing content, shared state, refusal and allowed-check flows, drag, reset.
  {
    const { context, page, errors } = await session(1440, 900);
    assert.equal((await page.goto(origin + "/", { waitUntil: "networkidle" })).status(), 200);
    const h1 = await page.locator("h1").innerText();
    assert.match(h1.replace(/\s+/g, " "), /Your agent can spend \$20\.00\. Not \$20\.0.*1/);
    ok("landing headline present");
    for (const t of ["Many agents.", "Every number says", "It is sandbox money.", "A hold ends.", "पाशधारा"]) await page.getByText(t).first().waitFor();
    await page.getByText("Held,", { exact: false }).first().waitFor();
    ok("landing sections: held canvas, fleet graph, proof row, plain truths, footer");
    await page.getByText("$7.00").first().waitFor();
    const heroRead = await txt(page, "[data-read]");
    assert.match(heroRead, /\$7\.00/); assert.match(heroRead, /\$3\.00/);
    ok("hero readout is the live hold: free $7.00, committed $3.00 (from /api/showcase)");
    const box = await page.locator("canvas").first().boundingBox(); assert.ok(box.width > 600 && box.height > 400);
    ok("held canvas renders");

    await page.getByRole("button", { name: "Try $7.01, one cent over" }).first().click();
    await page.getByText("refused (cap_reached)").first().waitFor();
    assert.deepEqual(calls.try, [701]);
    const tape = await txt(page, "[data-tape]");
    assert.match(tape, /check, nothing posted/); assert.match(tape, /refused/);
    assert.match(await txt(page, "[data-read]"), /\$7\.00/, "refusal must not change free");
    ok("refusal flow: POST /try 701, red row on the tape, nothing charged, free unchanged");
    await page.getByRole("button", { name: "Check a $0.03 call" }).first().click();
    await page.getByText("fits", { exact: false }).first().waitFor();
    assert.deepEqual(calls.try, [701, 3]);
    assert.match(await page.locator("p[role=status]").first().innerText(), /\$0\.03 fits, \$7\.00 free\. Nothing posted\./);
    ok("allowed flow: POST /try 3, 'fits ... Nothing posted'");

    const before = calls.try.length;
    const cv = page.locator("canvas").first(); await cv.scrollIntoViewIfNeeded(); await settle(page);
    const cb = await cv.boundingBox();
    let dragged = false;
    for (let gx = 0.30; gx <= 0.70 && !dragged; gx += 0.04) for (let gy = 0.35; gy <= 0.80 && !dragged; gy += 0.05) {
      const x = cb.x + cb.width * gx, y = cb.y + cb.height * gy;
      await page.mouse.move(x, y);
      const cur = await page.evaluate(() => document.querySelector("canvas").style.cursor);
      if (cur === "grab") { await page.mouse.down(); await page.mouse.move(cb.x + cb.width * 0.99, y, { steps: 12 }); await page.mouse.move(cb.x + cb.width * 0.995, cb.y + cb.height * 0.02, { steps: 6 }); await page.mouse.up(); dragged = true; }
    }
    assert.ok(dragged, "found an agent to drag");
    await page.waitForTimeout(500);
    assert.equal(calls.try.length, before + 1, "dragging an agent past the rope runs exactly one real check");
    assert.equal(calls.try.at(-1), 701);
    ok("drag an agent past the rope: exactly one real check, 701 cents");

    await page.getByRole("link", { name: "Open the demo" }).first().click();
    await page.waitForURL("**/demo");
    await page.getByRole("heading", { name: "Budget" }).waitFor();
    assert.match(await txt(page, "[data-read]"), /\$7\.00/);
    assert.match(await txt(page, "[data-tape]"), /check, nothing posted/);
    ok("hero and Budget share one state: same free/committed, the landing checks are on the Budget tape");
    await page.getByRole("button", { name: "Reset view" }).click();
    assert.doesNotMatch(await txt(page, "[data-tape]"), /check, nothing posted/);
    assert.match(await txt(page, "[data-read]"), /\$7\.00/);
    ok("reset flow: checks cleared, journal rows stay, hold unchanged");
    assert.equal(calls.run, 0); ok("the paid Run endpoint was never called");
    assert.deepEqual(errors, []); ok("no console or page errors (landing to demo)");
    await context.close();
  }

  // 2. Try a call.
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(origin + "/demo/try", { waitUntil: "networkidle" });
    assert.equal(await page.locator("#v3-amt").inputValue(), "7.01");
    await page.getByRole("button", { name: "Check the call" }).click();
    await page.getByText("REFUSED").waitFor();
    let out = await txt(page, "[role=status]"); assert.match(out, /cap_reached/); assert.match(out, /Charged\s*\$0\.00/); assert.match(out, /Tool ran\s*No/);
    ok("try: $7.01 shows a REFUSED receipt with charged $0.00 and tool did not run");
    await page.locator("#v3-amt").fill("0.03"); await page.getByRole("button", { name: "Check the call" }).click();
    await page.getByText("allowed").first().waitFor();
    out = await txt(page, "[role=status]"); assert.match(out, /Free after\s*\$7\.00 \(unchanged\)/); assert.match(out, /PayPal capture\s*none/);
    ok("try: $0.03 shows an allowed receipt, free unchanged, no PayPal capture");
    await page.locator("#v3-amt").fill("abc");
    assert.ok(await page.getByRole("button", { name: "Check the call" }).isDisabled()); await page.getByText("Enter an amount from").waitFor();
    const n = calls.try.length;
    ok("try: invalid amount is blocked with an alert");
    await page.getByRole("button", { name: "exactly what is left" }).click(); assert.equal(await page.locator("#v3-amt").inputValue(), "7.00");
    await page.getByRole("button", { name: "one cent over" }).click(); assert.equal(await page.locator("#v3-amt").inputValue(), "7.01");
    assert.equal(calls.try.length, n); ok("try: presets fill the field without calling the API");
    await page.getByRole("button", { name: "Reset view" }).click(); await page.getByText("The receipt appears here").waitFor(); ok("try: reset clears the receipt");
    assert.deepEqual(errors, []); await context.close();
  }

  // 3. Settle and Connect.
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(origin + "/demo/settle", { waitUntil: "networkidle" });
    for (const [name, needles] of [["Approve", ["$10.00", "measured"]], ["Spend", ["$3.00", "$7.00", "computed"]], ["Refuse", ["$7.01", "replay", "cap_reached"]], ["Settle", ["$3.00", "$0.59", "$2.41", "$7.00", "measured", "computed"]]]) {
      await page.getByRole("button", { name, exact: true }).click(); await settle(page);
      const body = await page.locator("main").innerText();
      for (const k of needles) assert.ok(body.includes(k), `${name} missing ${k}`);
    }
    ok("settle: four steps, figures come from the proof JSON (3.00, 0.59, 2.41, 7.00, 10.00) and each line is tagged measured, computed or replay");
    await page.goto(origin + "/demo/connect", { waitUntil: "networkidle" });
    assert.match(await txt(page, "pre"), /api\/mcp/);
    await page.getByRole("button", { name: "Refusal" }).click(); assert.match(await txt(page, "pre"), /cap_reached/);
    await page.getByRole("button", { name: "Paid call" }).click(); assert.match(await txt(page, "pre"), /"charged": 3/);
    assert.match(await page.locator("main").innerText(), /Recorded, not live/);
    ok("connect: three samples, shapes labelled recorded, not live");
    assert.equal(calls.run, 0); assert.deepEqual(errors, []); await context.close();
  }

  // 4. API unreachable: recorded run labelled, no live checks.
  {
    const { context, page, errors } = await session(1440, 900, { showcase: () => null });
    const before = calls.try.length;
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => /\$0\.06/.test(document.querySelector("[data-read]").innerText), null, { timeout: 10000 });
    assert.ok(await page.locator("[role=note]").getByText("Recorded, not live").count(), "sandbox bar says Recorded, not live");
    await page.getByRole("button", { name: /Replay the recorded refusal/ }).first().click();
    await page.getByText("Recorded: $0.07 refused (cap_reached)").first().waitFor();
    assert.equal(calls.try.length, before); assert.equal(calls.run, 0);
    ok("unreachable: 'Recorded, not live' badge, $0.06 recorded hold, recorded refusal replays with zero API checks");
    await page.goto(origin + "/demo/try", { waitUntil: "networkidle" }); await page.getByText("Recorded, not live").first().waitFor();
    assert.equal(await page.locator("#v3-amt").count(), 0); ok("unreachable: Try a call offers only the two recorded decisions");
    assert.deepEqual(errors, []); await context.close();
  }

  // 5. Last good read kept with its age; ended hold closes spending.
  {
    let phase = 0;
    const { context, page } = await session(1440, 900, { showcase: () => (phase === 0 ? read() : null) });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByText("$7.00").first().waitFor();
    phase = 1;
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.getByText(/Last good read .* ago\. The gateway did not answer\./).waitFor({ timeout: 15000 });
    assert.match(await txt(page, "[data-read]"), /\$7\.00/);
    ok("failed later read: last good read kept with its age, numbers unchanged, never the recording");
    await context.close();
    const e = await session(1440, 900, { showcase: () => read({ honor_until: new Date(Date.now() - 3600e3).toISOString() }) });
    await e.page.goto(origin + "/demo", { waitUntil: "networkidle" });
    await e.page.getByText("Spending is closed.").waitFor();
    assert.ok(await e.page.getByRole("button", { name: /^Try \$7\.01/ }).isDisabled());
    ok("ended hold: notice shown, checks disabled"); await e.context.close();
  }

  // 5b. Malformed answers: a call without status must not crash; a partial read must not replace the last good read.
  {
    let phase = 0;
    const { context, page, errors } = await session(1440, 900, { showcase: () => (phase === 0 ? read({ calls: [{ id: "x1", tool_id: "summarise", price_minor: "3", created_at: "2026-11-11T20:12:34Z" }, ...read().calls] }) : {}) });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByText("$7.00").first().waitFor();
    assert.deepEqual(errors, []);
    phase = 1;
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.getByText(/Last good read .* ago/).waitFor({ timeout: 15000 });
    assert.match(await txt(page, "[data-read]"), /\$7\.00/);
    assert.equal(await page.locator("[role=note]").getByText("Recorded, not live").count(), 0);
    ok("malformed answers: a call without status renders, a partial read keeps the last good read with its age");
    assert.deepEqual(errors, []); await context.close();
  }

  // 6. Motion switch and reduced motion.
  {
    const { context, page } = await session(1440, 900, { reduced: true });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    const root = () => page.locator("[data-motion]").first();
    assert.equal(await root().getAttribute("data-motion"), "auto");
    const btn = page.getByRole("button", { name: /Motion:/ });
    assert.match(await btn.innerText(), /Motion: off/);
    ok("system reduced-motion: switch reads 'Motion: off'");
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector("h1 [aria-hidden=true]"), "::after").animationDuration);
    assert.ok(parseFloat(anim) < 0.01, `slice animation ${anim}`);
    await btn.click(); assert.equal(await root().getAttribute("data-motion"), "on"); assert.match(await btn.innerText(), /Motion: on/);
    await page.reload({ waitUntil: "networkidle" }); assert.equal(await root().getAttribute("data-motion"), "on");
    ok("motion switch: explicit 'on' overrides the system setting and is remembered");
    await page.getByRole("button", { name: /Motion:/ }).click(); assert.equal(await root().getAttribute("data-motion"), "off"); ok("motion switch: off");
    await context.close();
    const m2 = await session(1440, 900, { reduced: false });
    await m2.page.goto(origin + "/", { waitUntil: "networkidle" });
    assert.match(await m2.page.getByRole("button", { name: /Motion:/ }).innerText(), /Motion: on/);
    ok("no system preference: switch reads 'Motion: on'"); await m2.context.close();
  }

  // 7. Screenshots, overflow, text size and contrast at 1440 and 390, both system schemes.
  {
    const issues = [];
    const PAGES = { landing: "/", budget: "/demo", try: "/demo/try", settle: "/demo/settle", connect: "/demo/connect" };
    for (const [w, h] of [[1440, 900], [390, 844]]) for (const scheme of ["light", "dark"]) {
      const { context, page, errors } = await session(w, h, { scheme });
      for (const [name, path] of Object.entries(PAGES)) {
        await page.goto(origin + path, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
        if (name === "landing" || name === "budget") { const b = page.getByRole("button", { name: /^Try \$7\.01/ }).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(300); } }
        if (name === "try") { await page.getByRole("button", { name: "Check the call" }).click(); await page.waitForTimeout(300); }
        if (name === "settle") { await page.getByRole("button", { name: "Settle", exact: true }).click(); await page.waitForTimeout(1200); }
        issues.push(...await audit(page, `${name} ${w} ${scheme}`));
        await page.screenshot({ path: `${shotDir}${name}-${w}-${scheme}.png`, fullPage: name === "landing" });
      }
      assert.deepEqual(errors, [], `console errors at ${w} ${scheme}`);
      await context.close();
    }
    assert.deepEqual([...new Set(issues)], []);
    ok("overflow, text >= 14 px and contrast >= 4.5:1 on 5 pages x 1440/390 x light/dark; screenshots in design/v3-screens/");
  }
  assert.equal(calls.run, 0);
  console.log(`all ${step} checks passed; paid run calls: ${calls.run}`);
} finally { await browser.close(); }
