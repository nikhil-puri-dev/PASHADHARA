// Browser check for the V5 journey page (/).
// Usage: CORD_URL=http://127.0.0.1:3160 node scripts/check-v5.mjs   (a production server must run)
// Every /api answer is stubbed. The paid run endpoint is never called: any request to it is counted and fails the check.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const origin = process.env.CORD_URL || "http://127.0.0.1:3160";
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
  lease: { id: "L1", state: "active", cap_minor: 1000, unsettled_limit_minor: 700, guaranteed_now: true,
    authorizations: [{ id: "A1", status: "created", honor_until: soon(), expires_at: new Date(Date.now() + 29 * 86400e3).toISOString(), paypal_authorization_id: "0XU06317EW987240Y", paypal_authorization_last4: "987240Y".slice(-4), amount_minor: 1000 }],
    balances: { buyer_commitment: 1000, hold_available: 997, committed_unsettled: 3, captured_gross: 0, spendable_minor: 697 } },
  journal: { entries: [
    { id: 1, group_id: "group-1", account: "HOLD_AVAILABLE", direction: "D", amount_minor: 1000, created_at: new Date(Date.now() - 3600e3).toISOString() },
    { id: 2, group_id: "group-1", account: "BUYER_COMMITMENT", direction: "C", amount_minor: 1000, created_at: new Date(Date.now() - 3600e3).toISOString() },
    { id: 3, group_id: "group-2", account: "COMMITTED_UNSETTLED", direction: "D", amount_minor: 3, created_at: new Date(Date.now() - 1800e3).toISOString() },
    { id: 4, group_id: "group-2", account: "HOLD_AVAILABLE", direction: "C", amount_minor: 3, created_at: new Date(Date.now() - 1800e3).toISOString() }] },
  calls: [{ id: "c1", tool_id: "summarise", price_minor: "3", status: "served", created_at: new Date(Date.now() - 1800e3).toISOString(), ledger_group_id: "g1", captured: false }],
  captures: [], ...over,
});

// Audit: horizontal overflow, text under 14 px, WCAG contrast, overlapping text boxes, undersized targets (phone and desktop controls).
async function audit(page, name, { targets = true } = {}) {
  const issues = await page.evaluate(({ targets }) => {
    const out = [], root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) out.push(`overflow ${root.scrollWidth}>${root.clientWidth}`);
    const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const bgOf = el => { const chain = []; for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0) { chain.push(b); if (b.a === 1) break; } } let c = { r: 9, g: 5, b: 7, a: 1 }; for (const b of chain.reverse()) c = over(b, c); return c; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), boxes = [];
    for (let n; (n = walker.nextNode());) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest("svg,script,style,noscript,canvas,[aria-hidden=true],.skiplink") || !el.checkVisibility()) continue;
      const cs = getComputedStyle(el), box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1 || box.left < -1000) continue;
      if (parseFloat(cs.fontSize) < 14) out.push(`small text "${n.textContent.trim().slice(0, 24)}" ${cs.fontSize}`);
      const rg = document.createRange(); rg.selectNodeContents(n); const rb = rg.getBoundingClientRect();
      if (rb.width > 2 && rb.height > 2) for (const q of rg.getClientRects()) if (q.width > 2 && q.height > 2) boxes.push({ el, t: n.textContent.trim().slice(0, 20), x0: q.left, y0: q.top + scrollY, x1: q.right, y1: q.bottom + scrollY });
      if (el.closest(":disabled,[aria-disabled=true]")) continue;
      let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el), f = over({ ...fg, a: fg.a * op }, bg);
      const l1 = lum(f), l2 = lum(bg), ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
      if (ratio < 4.5) out.push(`contrast ${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 24)}"`);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ha = a.el.closest("h1,h2"); if (ha && ha === b.el.closest("h1,h2")) continue; /* tight display leading overlaps line boxes by design, not glyphs */
      if (a.el.closest(".minibar,.top") || b.el.closest(".minibar,.top")) continue;
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const area = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
      if (w > 4 && h > 4 && (w * h) / area > .35) out.push(`overlap "${a.t}" with "${b.t}"`);
    }
    if (targets) document.querySelectorAll("button:not(:disabled), a.src, .ft a, .journey a, .steps-menu a, a.btn, summary, input:not([type=hidden])").forEach(el => {
      if (!el.checkVisibility()) return; const r = (el.closest("label.chk") || el).getBoundingClientRect();
      if (r.width > 1 && (r.height < 43.5 || (r.width < 43.5 && !/Tags/.test(el.textContent)))) out.push(`target ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 22)}"`);
    });
    return out;
  }, { targets });
  return issues.map(i => `${name}: ${i}`);
}

const calls = { run: 0, try: [], mcp: 0 };
async function session(width, height, { reduced = true, showcase = () => read(), mcp = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? "reduce" : "no-preference", colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route("**/api/showcase/run*", route => { calls.run++; route.fulfill({ status: 500, body: "paid run must never be called by this check" }); });
  await page.route("**/api/showcase/try*", route => {
    const cents = Number(new URL(route.request().url()).searchParams.get("price_minor"));
    calls.try.push(cents);
    const reason = cents > 997 ? "cap_reached" : cents > 697 ? "exposure_limit" : null;
    route.fulfill({ status: reason ? 402 : 200, json: { provenance: "computed", price_minor: cents, remaining_minor: 997, reason } });
  });
  await page.route("**/api/showcase", route => { const r = showcase(); if (r === null) route.fulfill({ status: 500, body: "x" }); else route.fulfill({ json: r }); });
  await page.route("**/api/mcp", route => { calls.mcp++; if (!mcp) return route.abort(); route.fulfill({ status: 401, headers: { "www-authenticate": 'Bearer realm="pashadhara-lease"' }, json: { error: "unauthorized" } }); });
  return { context, page, errors };
}
const txt = (page, sel) => page.locator(sel).first().innerText();
const num = s => Number(String(s).replace(/[^0-9.]/g, ""));

try {
  // 1. Desktop, live hold: headline and readout agree, live checks refuse and pass.
  {
    const { context, page, errors } = await session(1440, 900);
    assert.equal((await page.goto(origin + "/", { waitUntil: "networkidle" })).status(), 200);
    await page.locator("#inst").getByText("$6.97").first().waitFor();
    const h1 = (await page.locator("h1").innerText()).replace(/\s+/g, " ");
    assert.match(h1, /Your agent can spend \$6\.97\. Not \$6\.9.*8/);
    ok("headline shows $6.97 spendable and $6.98 refused, within a $10 hold");
    const read1 = await txt(page, "#inst .read");
    assert.match(read1, /\$6\.97/); assert.match(read1, /\$0\.03/); assert.match(read1, /\$3\.00/);
    assert.match(await txt(page, "#inst .inst-chip"), /live/i);
    ok("instrument: spendable $6.97, committed $0.03, held back $3.00, tagged live");
    await page.getByRole("button", { name: "Try $6.98, one cent over" }).click();
    await page.getByText("Refused: exposure_limit").first().waitFor();
    assert.deepEqual(calls.try, [698]);
    assert.match(await txt(page, "#inst .evt"), /refused \(exposure_limit\)/);
    assert.match(await txt(page, "#inst .read"), /\$6\.97/, "a refusal must not change spendable");
    ok("one cent over the spend limit: POST /try 698, exposure_limit, nothing changed");
    await page.getByRole("button", { name: "Check a $0.03 call" }).click();
    await page.getByText("Would be served").first().waitFor();
    assert.deepEqual(calls.try, [698, 3]);
    ok("a $0.03 check: POST /try 3, would be served, nothing posted");

    // sticky: scrolled far down, the header and the instrument are still in view
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, document.getElementById("s3").offsetTop); });
    await page.waitForTimeout(200);
    const pos = await page.evaluate(() => ({ h: document.querySelector(".top").getBoundingClientRect().top, i: document.querySelector("#inst").getBoundingClientRect().top, ib: document.querySelector("#inst").getBoundingClientRect().bottom }));
    assert.ok(pos.h === 0 && pos.i > 0 && pos.i < 200 && pos.ib <= 900, JSON.stringify(pos));
    ok("header and instrument stay in view while scrolling");

    // cap_reached from the Spend step preset
    await page.evaluate(() => scrollTo(0, document.getElementById("s2").offsetTop));
    await page.getByRole("button", { name: /more than the hold has left/ }).click();
    await page.getByRole("button", { name: "Check, free" }).click();
    await page.getByText("Refused: cap_reached").first().waitFor();
    assert.deepEqual(calls.try, [698, 3, 998]);
    ok("above the whole hold: cap_reached, the gateway steps stop at the cap check");
    const steps = await page.locator(".pipe li").evaluateAll(l => l.map(x => x.className.replace("lit ", "")));
    assert.deepEqual(steps, ["ok", "ok", "ok", "fail", "skip", "skip", "skip", "skip", "skip"]);
    assert.equal(calls.run, 0);
    ok("the paid run endpoint was never called");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 2. Recorded agent run replay: the vessel follows the trace, tagged recorded, never live.
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /Agent run/ }).click();
    assert.match(await txt(page, "#inst .inst-chip"), /recorded/i);
    for (let i = 0; i < 13; i++) await page.getByRole("button", { name: "Next step" }).click();
    await page.getByText("Books match PayPal").first().waitFor();
    const r = await txt(page, "#inst .read");
    assert.match(r, /\$0\.10/); assert.match(r, /Left open/);
    assert.equal(await page.locator(".trace li.done").count(), 13);
    ok("agent run replay: five 2-cent lookups, one 10-cent capture, fee 10 cents, 10 cents left open, books match PayPal");
    await page.getByRole("button", { name: "Restart" }).click();
    assert.match(await txt(page, "#inst .read"), /\$0\.00/);
    assert.equal(await page.locator(".trace li.done").count(), 0);
    ok("replay restarts to an empty run");
    await page.getByRole("tab", { name: /Live hold/ }).click();
    assert.match(await txt(page, "#inst .inst-chip"), /live/i);
    assert.match(await txt(page, "#inst .read"), /\$6\.97/);
    ok("back to the live hold: numbers are the live ones again");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. Autopilot: the same rules, a drill, settled and reset. The hero never changes.
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /Autopilot/ }).click();
    await page.getByRole("button", { name: "8x" }).click();
    await page.getByRole("button", { name: "Run autopilot" }).click();
    await page.getByText("Autopilot idle.").first().waitFor({ timeout: 45000 });
    const read3 = await txt(page, "#inst .read");
    const committed = num(read3.match(/Committed\s*\$([0-9.]+)/)[1]), refused = num(read3.match(/Refused\s*([0-9]+)/)[1]);
    assert.ok(committed <= 7.0001 && committed > 3, `committed ${committed}`);
    assert.ok(refused > 0, "the runaway agent was refused");
    assert.match(await txt(page, "#inst .inst-chip"), /illustrative/i);
    assert.match((await page.locator("h1").innerText()).replace(/\s+/g, " "), /spend \$6\.97\./);
    ok(`autopilot: ${committed.toFixed(2)} committed (never over the $7.00 limit), ${refused} refusals, tagged illustrative, hero unchanged`);
    await page.getByRole("tab", { name: /Live hold/ }).click();
    assert.match(await txt(page, "#inst .read"), /\$6\.97/);
    ok("switching to the live hold shows the live numbers, not the drill's");
    await page.getByRole("tab", { name: /Autopilot/ }).click();
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, document.getElementById("s3").offsetTop); });
    await page.getByRole("button", { name: "Close the lease and capture" }).click();
    await page.getByText("conserved").first().waitFor();
    const rs = await txt(page, "#inst .read");
    assert.match(rs, /Captured/); assert.match(rs, /Released/);
    ok("settle the drill: captured + released equals the hold (conserved)");
    await page.getByRole("tab", { name: /Autopilot/ }).click();
    await page.getByRole("button", { name: "Reset" }).click();
    assert.match(await txt(page, "#inst .read"), /\$7\.00/);
    ok("reset: a fresh drill hold");
    assert.equal(calls.run, 0);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3b. Nothing runs unseen: leaving a view pauses it.
  {
    const { context, page } = await session(1440, 900);
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /Autopilot/ }).click();
    await page.getByRole("button", { name: "3x" }).click();
    await page.getByRole("button", { name: "Run autopilot" }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("tab", { name: /Live hold/ }).click();
    const n1 = await page.locator("#pan-sim .tp").count();
    await page.waitForTimeout(2500);
    assert.equal(await page.locator("#pan-sim .tp").count(), n1, "autopilot kept running off-view");
    await page.getByRole("tab", { name: /Agent run/ }).click();
    await page.getByRole("button", { name: "Play the replay" }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("tab", { name: /Live hold/ }).click();
    const d1 = await page.locator(".trace li.done").count();
    await page.waitForTimeout(3000);
    assert.equal(await page.locator(".trace li.done").count(), d1, "replay kept running off-view");
    const ctl = await page.locator("[role=tab]").evaluateAll(t => t.map(x => !!document.getElementById(x.getAttribute("aria-controls"))));
    assert.deepEqual(ctl, [true, true, true]);
    ok("leaving a view pauses the autopilot and the replay; every tab controls a real panel");
    await context.close();
  }

  // 4. Connect: outcomes change what lights up; the probe is labelled live when answered and recorded when not.
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Over the spend limit" }).click();
    await page.getByText("exposure_limit").first().waitFor();
    assert.equal(await page.locator(".stn .sbtn.fail").count(), 1);
    await page.getByRole("button", { name: "tools/call, no token" }).click();
    await page.getByText("answered just now").first().waitFor();
    assert.match(await page.locator(".probe-row + div pre.code").innerText(), /unauthorized/);
    ok("connect: outcomes light the stations; the live probe answers 401 and says live");
    await context.close();
    const s2 = await session(1440, 900, { mcp: false });
    await s2.page.goto(origin + "/", { waitUntil: "networkidle" });
    await s2.page.getByRole("button", { name: "tools/list" }).click();
    await s2.page.getByText("recorded 12 Nov 15:35 UTC").first().waitFor();
    ok("an unreachable endpoint falls back to the recorded answer and says recorded");
    await s2.context.close();
  }

  // 5. Ended hold and failed read.
  {
    const gone = () => { const past = new Date(Date.now() - 3600e3).toISOString(); const r = read({ state: "ended", honor_until: past }); r.lease.authorizations[0].honor_until = past; return r; };
    const { context, page } = await session(1440, 900, { showcase: gone });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.getByText("Spending is closed").first().waitFor();
    assert.ok(await page.getByRole("button", { name: "Try $0.01, one cent over" }).isDisabled());
    assert.equal(await txt(page, "#inst [data-b=spendable]"), "$0.00");
    assert.doesNotMatch(await page.locator("h1").innerText(), /\$/, "no figure in the headline after the hold ended");
    ok("ended hold: spending closed, checks off, headline shows no figure");
    await context.close();
    const f = await session(1440, 900, { showcase: () => null });
    await f.page.goto(origin + "/", { waitUntil: "networkidle" });
    await f.page.getByText("Recorded, not live").first().waitFor();
    assert.doesNotMatch(await f.page.locator("h1").innerText(), /\$/, "no figure in the headline without a live read");
    await f.page.getByRole("button", { name: /Replay the recorded refusal/ }).first().click();
    await f.page.getByText("recorded run, not live").first().waitFor();
    ok("no live read: tagged recorded, shows the recorded $0.06 run, replays the recorded refusal");
    await f.context.close();
  }

  // 6. Phone: slim chrome, a steps menu, a vessel in the hero, no overflow.
  {
    const { context, page, errors } = await session(390, 844);
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.locator(".minibar").getByText("$6.97").first().waitFor();
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, 1500); });
    await page.waitForTimeout(250);
    const chrome = await page.evaluate(() => ({ hdr: document.querySelector(".top").getBoundingClientRect().height, bar: document.querySelector(".minibar").getBoundingClientRect().height, top: document.querySelector(".minibar").getBoundingClientRect().top }));
    assert.ok(chrome.hdr <= 58 && chrome.bar <= 64 && chrome.hdr + chrome.bar <= 120 && Math.abs(chrome.top - chrome.hdr) <= 1, JSON.stringify(chrome));
    ok(`phone chrome: header ${Math.round(chrome.hdr)} px + bar ${Math.round(chrome.bar)} px (${Math.round((chrome.hdr + chrome.bar) / 844 * 100)}% of the screen)`);
    await page.getByRole("button", { name: /Steps|^\d / }).first().click();
    await page.getByRole("link", { name: /3\s*Settle/ }).click();
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => { const h = document.querySelector("#s3 .stage-h").getBoundingClientRect().top, bar = document.querySelector(".minibar").getBoundingClientRect().bottom; return h >= bar - 1 && h < 300; }), "the anchored heading must clear the sticky header and bar");
    ok("steps menu jumps to Settle");
    await page.getByRole("button", { name: /Showing: Live hold/ }).click();
    assert.match(await txt(page, ".minibar .mchip"), /recorded/i);
    ok("the bar's view button cycles to the recorded run and says recorded");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 6b. Every page: one header, one footer, one mark, consistent titles, no motion switch, no page scrollbar, no dead internal links.
  {
    const { context, page, errors } = await session(1440, 900);
    const seen = new Set();
    for (const path of ["/", "/check", "/review", "/budget", "/activity", "/collect", "/escrow", "/developers", "/proof", "/finance", "/nope"]) {
      const res = await page.goto(origin + path, { waitUntil: "networkidle" });
      assert.equal(res.status(), path === "/nope" ? 404 : 200, path);
      assert.ok(await page.locator("header.top .brand img[src='/mark.svg']").count() || await page.locator("header.top .brand").count(), path + " header");
      assert.equal(await page.locator("footer .wm").count(), 1, path + " footer");
      assert.equal(await page.getByRole("button", { name: /Motion/ }).count(), 0, path + " has a motion switch");
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarWidth), "none", path + " page scrollbar");
      const title = await page.title();
      assert.ok(path === "/" ? title === "Pashadhara | A budget your agent cannot break" : path === "/nope" ? true : /| Pashadhara$/.test(title), path + " title: " + title);
      for (const href of await page.locator("a[href^='/']").evaluateAll(a => a.map(x => x.getAttribute("href")))) seen.add(href.split("#")[0] || "/");
    }
    for (const p of seen) { const r = await page.request.get(origin + p, { maxRedirects: 5 }); assert.ok(r.status() < 400, "dead link " + p + " " + r.status()); }
    for (const [from, to] of [["/signup", "/developers#setup"], ["/login", "/developers#setup"], ["/approve", "/developers#setup"], ["/delegation", "/#s2"], ["/demo/try", "/#s2"], ["/lease", "/budget"], ["/settle", "/collect"], ["/quickstart", "/developers"]]) {
      await page.goto(origin + from, { waitUntil: "networkidle" });
      assert.equal(page.url(), origin + to, from);
      if (to.includes("#")) assert.equal(await page.locator(to.slice(to.indexOf("#"))).count(), 1, to);
    }
    for (const [p, type] of [["/favicon.ico", /icon/], ["/icon.svg", /svg/], ["/apple-icon.png", /png/], ["/icon-192.png", /png/], ["/icon-512.png", /png/], ["/mark.svg", /svg/], ["/site.webmanifest", /json|manifest/]]) { const r = await page.request.get(origin + p); assert.equal(r.status(), 200, p); assert.match(r.headers()["content-type"] ?? "", type, p); }
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    const links = await page.locator("#about a").evaluateAll(a => a.map(x => x.getAttribute("href")));
    assert.deepEqual(links, ["https://github.com/nikhil-puri-dev"]);
    assert.match(await page.locator("#about").innerText(), /Nikhil Puri/);
    assert.deepEqual(errors, []);
    ok(`all pages: shared header, mark and footer; ${seen.size} internal links resolve; retired routes redirect to existing sections; icons and manifest served`);
    await context.close();
  }

  // 7. Audit at both sizes.
  const found = [];
  for (const [w, h, name] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
    const { context, page } = await session(w, h);
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.locator(w > 960 ? "#inst" : ".minibar").getByText("$6.97").first().waitFor();
    found.push(...await audit(page, `${name} live`));
    await page.getByRole("tab", { name: /Agent run/ }).click();
    found.push(...await audit(page, `${name} run`, { targets: true }));
    await page.getByRole("tab", { name: /Autopilot/ }).click();
    found.push(...await audit(page, `${name} autopilot`));
    await context.close();
  }
  if (found.length) { console.log(found.slice(0, 40).join("\n")); assert.fail(`${found.length} audit issues`); }
  ok("audit: no overflow, no text under 14 px, contrast at least 4.5, no overlapping text, targets at least 44 px (desktop and phone, three views)");

  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const { context, page, errors } = await session(width, height);
    const shot = async name => {
      if (process.env.V5_SCREENSHOTS) await page.screenshot({ path: join(process.env.V5_SCREENSHOTS, `${name}-${width}.png`) });
    };
    let pageLinks;
    for (const path of ["/", "/check", "/budget", "/developers", "/finance"]) {
      await page.goto(origin + path, { waitUntil: "networkidle" });
      const pages = page.getByRole("button", { name: "Pages" });
      await pages.click();
      const menu = page.getByRole("navigation", { name: "Site pages" });
      const links = await menu.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")));
      pageLinks ??= links;
      assert.deepEqual(links, pageLinks, path);
      assert.ok(links.includes("/finance"), path);
      assert.equal(await menu.locator("[aria-current=page]").getAttribute("href"), path);
      await page.keyboard.press("Escape");
      assert.ok(await menu.isHidden());
      assert.equal(await pages.evaluate(el => el === document.activeElement), true);
      assert.ok(await page.locator("footer a").evaluateAll(links => links.every(link => link.offsetHeight >= 44 && link.offsetWidth >= 44)), path);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, path);

      if (path === "/check" || path === "/budget") {
        assert.match(await page.locator(".compare").first().innerText(), /Spendable now\s+\$6\.97/);
        assert.match(await page.locator(".compare").first().innerText(), /Held at PayPal\s+\$10\.00/);
        const amount = page.getByLabel("Amount in USD");
        assert.equal(await amount.inputValue(), "6.98");
        if (path === "/check") {
          await page.getByRole("button", { name: "See the decision for $6.98" }).click();
          await page.getByRole("status").filter({ hasText: "Refused" }).waitFor();
          assert.match(await txt(page, ".verdict"), /\$9\.97 free in the hold/);
        }
      }
      if (path === "/developers") {
        assert.match(await page.getByRole("row", { name: /summarise/ }).innerText(), /\$0\.03/);
        assert.match(await page.getByRole("row", { name: /check_budget/ }).innerText(), /Free/);
        await page.getByRole("button", { name: "Cursor", exact: true }).click();
        const cfg = JSON.parse(await page.locator("#setup pre code").first().innerText());
        assert.equal(cfg.mcpServers.pashadhara.headers.Authorization, "Bearer ${env:BUDGET_TOKEN}");
        const copy = page.getByRole("button", { name: "Copy config" });
        assert.ok(await copy.evaluate(el => el.offsetHeight >= 44 && parseFloat(getComputedStyle(el).paddingInlineStart) >= 16));
      }
      await shot(path === "/" ? "home" : path.slice(1));
    }
    assert.deepEqual(errors, []);
    ok(`${width}px: shared Pages menu and keyboard focus, 44px footer targets, matching spendable figures and working Developer controls`);
    await context.close();
  }
  assert.equal(calls.run, 0);
} finally {
  await browser.close();
}
console.log(`done: ${step} checks, paid run calls ${calls.run}`);
