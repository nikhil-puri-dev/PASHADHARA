// Browser check for live mode. A web server must already run (default http://localhost:3100).
// Usage: node scripts/check-live.mjs <spec.json>
// spec.json (keep it outside git): [{ "api": "http://127.0.0.1:3000", "lease": "<uuid>", "token": "<lease token>" }, ...]
// For each lease: open /lease#live=..., compare the page with GET /api/v1/leases/{id}, reload, open /proof with no session.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const origin = process.env.CORD_URL || "http://localhost:3100";
const specs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = existsSync(chromium.executablePath()) ? await chromium.launch() : await chromium.launch({ channel: "msedge" });
const usd = c => `$${(c / 100).toFixed(2)}`;
let failed = 0;

for (const [n, spec] of specs.entries()) {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // The page calls /api on its own origin. Send each lease's reads to the API instance that owns it.
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const response = await fetch(spec.api + url.pathname + url.search, { headers: route.request().headers() });
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  });
  try {
    const lease = await (await fetch(`${spec.api}/api/v1/leases/${spec.lease}`, { headers: { authorization: `Bearer ${spec.token}` } })).json();
    const journal = await (await fetch(`${spec.api}/api/v1/leases/${spec.lease}/journal`, { headers: { authorization: `Bearer ${spec.token}` } })).json();
    const commits = journal.entries.filter(e => e.ref_type === "commit" && e.account === "COMMITTED_UNSETTLED" && e.direction === "D");
    await page.goto(`${origin}/lease#live=${spec.lease}.${spec.token}`);
    await page.waitForSelector("#ledger tbody tr");
    const read = async () => ({
      h1: (await page.locator("h1").first().textContent()).trim(),
      rows: await page.locator("#ledger tbody tr").count(),
      who: (await page.locator(".who").textContent()).trim(),
      url: new URL(page.url()),
    });
    for (const phase of ["first load", "after reload"]) {
      if (phase === "after reload") { await page.reload(); await page.waitForSelector("#ledger tbody tr"); }
      const view = await read();
      assert.equal(view.h1, `${usd(lease.balances.hold_available)} is free to spend.`, `${phase}: free amount`);
      assert.equal(view.rows, commits.length, `${phase}: call rows`);
      assert.equal(view.who, "Live lease");
      assert.equal(view.url.hash, "", "token must not stay in the address bar");
      assert.equal(await page.locator("#run").count(), 0, "no simulated spend control in live mode");
    }
    await page.goto(`${origin}/proof`);
    await page.waitForSelector("tbody tr");
    assert.equal(await page.locator("tbody tr").count(), 12, "proof rows");
    assert.deepEqual(errors, []);
    console.log(`ok run ${n + 1}: free ${usd(lease.balances.hold_available)}, ${commits.length} call row(s), reload kept live, /proof opens`);
  } catch (error) {
    failed++;
    console.log(`FAIL run ${n + 1}: ${error.message.split("\n")[0]}`);
  }
  await context.close();
}
await browser.close();
if (failed) process.exit(1);
console.log("PASS check:live");
