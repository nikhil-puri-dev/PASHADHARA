// Browser check for the cord interface (landing, sign up, log in, lease, escrow, settle, proof).
// Usage: pnpm --filter @pashadhara/web check:cord   (a web server must already run; default http://localhost:3100)
// Browser: Playwright Chromium if installed, else the installed Edge. Override with PLAYWRIGHT_EXECUTABLE.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const origin = process.env.CORD_URL || "http://localhost:3100";

async function launch() {
  const explicit = process.env.PLAYWRIGHT_EXECUTABLE;
  if (explicit) return chromium.launch({ executablePath: explicit });
  if (existsSync(chromium.executablePath())) return chromium.launch();
  console.log("Playwright Chromium missing, using installed Edge");
  return chromium.launch({ channel: "msedge" });
}

const browser = await launch();
let step = 0;
const ok = label => console.log(`ok ${String(++step).padStart(2, "0")} ${label}`);

async function session(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { context, page, errors };
}
const h1 = page => page.locator("h1").first().textContent();
const code = async (page, digits) => { await page.locator("#cboxes input").first().fill(digits); };

async function audit(page, name) {
  const issues = await page.evaluate(() => {
    const out = [], root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) out.push(`overflow ${root.scrollWidth}>${root.clientWidth}`);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || el.closest("svg,script,style,noscript,.sr") || !el.checkVisibility()) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 14) out.push(`small text "${n.textContent.trim().slice(0, 20)}"`);
    }
    return out;
  });
  assert.deepEqual(issues, [], `${name}: ${issues.join("; ")}`);
}

try {
  // 1. Desktop: landing, sign up, rules, lease
  {
    const { context, page, errors } = await session(1440, 900);
    const res = await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    assert.equal(res.status(), 200);
    await page.locator("#herocord svg").waitFor();
    assert.match(await h1(page), /Your agent can spend \$20\.00\.\s*Not \$20\.01\./);
    assert.equal((await page.locator(".brand .word").first().textContent()).trim(), "Pashadhara", "plain wordmark");
    assert.ok(await page.locator(".brand .mark").count(), "knot mark present");
    ok("landing renders with the knot mark and the two H bars");

    await page.goto(`${origin}/nope`); assert.equal((await page.goto(`${origin}/nope`)).status(), 404); ok("unknown path is a real 404");
    await page.goto(`${origin}/lease`, { waitUntil: "networkidle" });
    await page.waitForURL(`${origin}/`); ok("signed out /lease bounces to /");

    await page.goto(`${origin}/signup`, { waitUntil: "networkidle" });
    assert.equal(await h1(page), "Create your account");
    await page.getByRole("button", { name: "Send the code" }).click();
    assert.equal(await page.locator(".errtxt").count(), 2, "both fields explain themselves"); ok("sign up validates inline");
    await page.fill("#suName", "Nikhil"); await page.fill("#suEmail", "nikhil@example.com");
    await page.getByRole("button", { name: "Send the code" }).click();
    assert.equal(await h1(page), "Enter the code");
    await code(page, "000000"); await page.locator(".errtxt").waitFor();
    assert.match(await page.locator(".errtxt").textContent(), /does not match/); ok("wrong code is refused with a recovery");
    await code(page, "123456"); await page.getByRole("heading", { name: "Connect PayPal" }).waitFor(); ok("code accepted");
    await page.getByRole("button", { name: "Connect PayPal sandbox" }).click();
    await page.locator(".linked").waitFor(); await page.getByRole("button", { name: "Continue" }).click();
    assert.equal(await h1(page), "Set the rules");
    await page.locator('[data-act="su-cap"][data-v="5000"]').click();
    await page.locator('[data-act="su-per"][data-v="100"]').click();
    await page.locator('[data-act="su-cat"][data-v="Documents"]').click();
    await page.getByRole("button", { name: "Review and approve" }).click();
    assert.equal(await h1(page), "Approve the hold");
    await page.locator("#apGo").click(); await page.getByRole("heading", { name: "Connect your agent" }).waitFor();
    await page.getByRole("button", { name: "Send a test call" }).click(); await page.locator(".testres").waitFor();
    await page.getByRole("button", { name: "Open my lease" }).click();
    await page.waitForURL(/\/lease$/); assert.match(await h1(page), /\$50\.00 is free to spend/); ok("six step sign up lands on a $50.00 lease");

    for (let i = 0; i < 4; i++) await page.locator("#one").click();
    const log = await page.locator(".log li").allTextContents();
    assert.ok(log.some(l => /Documents is not on your allowed list/.test(l)), "category rule enforced");
    assert.ok(log.some(l => /Committed/.test(l)), "an allowed call committed its price"); ok("gateway enforces the rules chosen at sign up");

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#lead h1").waitFor(); assert.equal(new URL(page.url()).pathname, "/lease"); ok("a reload keeps the session");
    await page.getByRole("button", { name: "Sign out" }).click(); await page.waitForURL(`${origin}/`);
    await page.goBack(); await page.waitForTimeout(400); assert.ok(["/", "/signup"].includes(new URL(page.url()).pathname), "Back after sign out stays out of the app"); ok("sign out then Back does not re-enter the app");
    assert.deepEqual(errors, [], errors.join("\n")); await context.close();
  }
  // 2. Sample lease: spend, settle, escrow, void, proof
  {
    const { context, page, errors } = await session(1440, 900);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.locator('[data-act="sample"]').first().click();
    await page.waitForURL(/\/lease$/); assert.match(await h1(page), /\$10\.65 is free/);
    await page.getByRole("link", { name: "Settle $1.90" }).click(); await page.waitForURL(/\/settle$/);
    assert.match(await h1(page), /\$1\.90 owed/);
    await page.locator("#nr").fill("3");
    assert.match(await h1(page), /3 captures for \$1\.53/); ok("settle recomputes fees");
    await page.locator("#settleGo").click(); await page.getByRole("heading", { name: "Settled." }).waitFor();
    await page.getByRole("link", { name: "Escrow" }).click(); await page.waitForURL(/\/escrow$/);
    assert.equal(await page.locator(".payout").textContent(), "$1.50 to the seller");
    await page.locator('button[data-j="b"][data-v="0"]').click();
    assert.equal(await page.locator(".payout").textContent(), "$2.50 held"); ok("escrow rule: agree pays, a split holds");
    await page.getByRole("link", { name: "Proof" }).click(); await page.waitForURL(/\/proof$/);
    assert.equal(await page.locator(".proofrt tbody tr").count(), 12); ok("proof shows the 12 measured fee captures");
    await page.getByRole("link", { name: "Lease", exact: true }).click();
    await page.getByRole("button", { name: "Void lease" }).click();
    const voidBtn = page.locator("#voidGo");
    assert.equal(await voidBtn.getAttribute("aria-disabled"), "true");
    await page.fill("#vin", "1.00"); assert.equal(await voidBtn.getAttribute("aria-disabled"), "true");
    await page.fill("#vin", "10.65"); assert.equal(await voidBtn.getAttribute("aria-disabled"), "false");
    await voidBtn.click(); await page.getByRole("heading", { name: "The hold is released." }).waitFor(); ok("void needs the exact held amount");
    assert.deepEqual(errors, [], errors.join("\n")); await context.close();
  }
  // 3. Phone: every route, no overflow, no small text
  {
    const { context, page, errors } = await session(390, 844);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" }); await audit(page, "home 390");
    await page.goto(`${origin}/signup`, { waitUntil: "networkidle" }); await audit(page, "signup 390");
    await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
    await page.fill("#suEmail", "ada@example.com"); await page.getByRole("button", { name: "Send the code" }).click();
    await audit(page, "code 390"); await code(page, "123456"); await page.waitForURL(/\/lease$/);
    for (const p of ["lease", "escrow", "settle", "proof", "approve"]) {
      await page.getByRole("link", { name: p === "approve" ? "New lease" : p[0].toUpperCase() + p.slice(1), exact: true }).first().click();
      await page.waitForURL(new RegExp(`/${p}$`)); await audit(page, `${p} 390`);
    }
    ok("phone width: no overflow, no text under 14 px on any route");
    assert.deepEqual(errors, [], errors.join("\n")); await context.close();
  }
  console.log("PASS check:cord");
} finally {
  await browser.close();
}
