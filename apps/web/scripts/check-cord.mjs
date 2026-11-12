// Browser check for the product UI (home, budget, activity, collect, escrow, developers, proof).
// Usage: pnpm --filter @pashadhara/web check:cord   (a web server must run; default http://localhost:3100, or CORD_URL)
// Every /api/showcase answer is stubbed here, so the check does not depend on the live API and never makes a paid run.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { audit } from "./_audit.mjs";

const origin = process.env.CORD_URL || "http://localhost:3100";
async function launch() {
  if (process.env.PLAYWRIGHT_EXECUTABLE) return chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE });
  if (existsSync(chromium.executablePath())) return chromium.launch();
  return chromium.launch({ channel: "msedge" });
}
const browser = await launch();
let step = 0;
const ok = label => console.log(`ok ${String(++step).padStart(2, "0")} ${label}`);
const ROUTES = ["/", "/budget", "/activity", "/collect", "/escrow", "/developers", "/proof"];
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
  // 1. Home: first viewport, one primary button, live rows, no fixture word
  {
    const { context, page, errors } = await session(1440, 900);
    const res = await page.goto(origin + "/", { waitUntil: "networkidle" });
    assert.equal(res.status(), 200);
    assert.match(await page.locator("h1").first().textContent(), /cannot overspend/);
    assert.match(await page.locator(".sbx").textContent(), /PayPal sandbox\. No real money moves\./);
    await page.locator(".live .call").first().waitFor();
    const viewportText = await page.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) { const e = n.parentElement; if (!e || e.closest("script,style,.sr")) continue; const r = e.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0 && e.checkVisibility()) out.push(n.textContent); } return out.join(" "); });
    assert.doesNotMatch(viewportText, /fixture/i, "no 'fixture' in the first viewport");
    assert.equal(await page.locator("main .btn.pri").count(), 1, "one primary button");
    assert.match(await page.locator(".live").textContent(), /\$1\.94 of \$2\.00 available/);
    ok("home: sandbox bar, headline, live rows, one primary button, no 'fixture' in the first viewport");

    // 2. Real refusal in one click, then the judge path to PayPal evidence
    await page.getByText("Refused before the model ran. Nothing charged.").waitFor(); // live check runs on load, no click needed
    await page.getByRole("button", { name: /Try to overspend/ }).click();
    await page.getByText("Refused before the model ran. Nothing charged.").waitFor();
    assert.match(await page.locator(".callout").textContent(), /\$0\.01 over/);
    ok("home: a live refusal shows on load and again on one click, with the amount over");
    let clicks = 0;
    await page.locator(".live .call").first().click(); clicks++;
    await page.waitForURL(/\/activity\?call=/);
    await page.locator(".sheet").waitFor();
    assert.match(await page.locator(".sheet .src").textContent(), /Source:/);
    await page.getByRole("link", { name: /PayPal evidence for this hold/ }).click(); clicks++;
    await page.waitForURL(/\/proof/);
    assert.match(await page.locator("#hold").textContent(), /0XU06317EW987240Y/);
    assert.ok(clicks <= 3, `judge path took ${clicks} clicks`);
    ok(`judge path: spend row, sheet with Source row, PayPal authorization id in ${clicks} clicks (the refusal is click 1 from home)`);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. Budget: band and check an amount; ended state
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(origin + "/budget", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Check an amount" }).click();
    await page.locator("#amt").fill("1.95");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.getByText(/Refused before the model ran/).waitFor();
    await page.locator("#amt").fill("1.00");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.getByText("This amount would be served.").waitFor();
    ok("budget: $1.95 refused and $1.00 served by the limit check");
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const past = new Date(Date.now() - 86400e3).toISOString();
    const { context, page } = await session(1440, 900, { showcase: () => { const r = read({ honor_until: past }); delete r.state; r.lease.authorizations[0].honor_until = past; return r; } });
    await page.goto(origin + "/budget", { waitUntil: "networkidle" });
    await page.getByText("Spending is closed.").first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Spending is closed" }).isDisabled(), true);
    assert.equal(await page.locator(".notice").count(), 1, "one banner only");
    await page.goto(origin + "/activity", { waitUntil: "networkidle" });
    assert.equal(await page.locator(".tbl tbody tr").count(), 2, "record stays readable when ended");
    ok("ended hold (past honor_until): spending closed, one banner, record readable");
    await context.close();
  }

  // 4. Last good read survives a failed read; a first failed read shows a labelled recorded run
  {
    let n = 0;
    const { context, page } = await session(1440, 900, { showcase: () => (++n === 1 ? read() : null) });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.locator(".live .call").first().waitFor();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByText(/Last good read .* ago\. The gateway did not answer\./).waitFor();
    assert.equal(await page.locator(".live .call").count() >= 2, true);
    assert.doesNotMatch(await page.locator("body").textContent(), /Recorded run/);
    ok("a failed later read keeps the last good rows and shows their age; no recorded fallback");
    await context.close();
    const s2 = await session(1440, 900, { showcase: () => null });
    await s2.page.goto(origin + "/", { waitUntil: "networkidle" });
    await s2.page.getByText(/Recorded run, 12 Nov\. Not live\./).waitFor();
    assert.doesNotMatch(await s2.page.locator("body").textContent(), /fixture/i);
    ok("first read failing: the recorded real run is labelled 'Not live'");
    await s2.context.close();
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
    await page.getByText("Calls your agent pays for will appear here.").waitFor();
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
