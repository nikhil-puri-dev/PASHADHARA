// Motion check: reduced motion means no running animations, and a refresh keeps the same DOM nodes (no remount flicker).
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.MOTION_URL || "http://localhost:3100";
const browser = await chromium.launch({ channel: "msedge" });
const show = { read_at: new Date().toISOString(), honor_until: new Date(Date.now() + 3 * 86400e3).toISOString(),
  lease: { cap_minor: 200, authorizations: [{ paypal_authorization_id: "0XU06317EW987240Y" }], balances: { hold_available: 194, committed_unsettled: 6, captured_gross: 0 } },
  calls: [{ id: "c1", tool_id: "summarise", price_minor: "3", status: "served", created_at: "2026-11-11T20:12:34Z" }] };
try {
  for (const [width, reduced] of [[1440, "reduce"], [390, "reduce"], [1440, "no-preference"]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: reduced });
    const page = await context.newPage();
    await page.route("**/api/showcase", route => route.fulfill({ json: show }));
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.locator(".live .call").first().waitFor();
    if (reduced === "reduce") assert.equal(await page.evaluate(() => document.getAnimations().length), 0, `no animations under reduced motion at ${width}`);
    await page.evaluate(() => { window.__row = document.querySelector(".live .call"); });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__row === document.querySelector(".live .call") && window.__row.isConnected), true, "a refresh keeps the same row node");
    await context.close();
    console.log(`ok ${width}px ${reduced}: animations and refresh identity`);
  }
} finally { await browser.close(); }
