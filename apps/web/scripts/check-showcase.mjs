// Run with a built local web server and a separate local API configured with a showcase lease.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const web = process.env.CORD_URL ?? 'http://127.0.0.1:3110';
const api = process.env.SHOWCASE_TEST_API;
assert.match(api ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'Use a local sandbox API origin');
const browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/api\/showcase(?:[/?]|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await fetch(api + url.pathname + url.search, { method: request.method(), headers: request.headers() });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  const started = Date.now();
  await page.goto(web);
  await page.getByRole('link', { name: 'Open showcase lease' }).click();
  await page.getByRole('button', { name: 'Run the agent' }).waitFor({ timeout: 20000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20000);
  const run = page.waitForResponse(r => new URL(r.url()).pathname === '/api/showcase/run');
  await page.getByRole('button', { name: 'Run the agent' }).click();
  const runResponse = await run;
  assert.equal(runResponse.status(), 200);
  const paid = await runResponse.json();
  assert.match(paid.result.model, /^claude-haiku/);
  await page.locator('#showcase-result').filter({ hasText: 'Computed charge' }).waitFor();
  await page.getByLabel('Price in cents').fill(String(paid.remaining_minor + 1));
  const attempt = page.waitForResponse(r => new URL(r.url()).pathname === '/api/showcase/try');
  await page.getByRole('button', { name: 'Try to break it' }).click();
  assert.equal((await attempt).status(), 402);
  await page.locator('#showcase-result').filter({ hasText: 'Refused: cap_reached' }).waitFor();
  const balance = await page.locator('#showcase-budget').textContent();
  await page.reload();
  await page.locator('#showcase-result').filter({ hasText: 'Refused: cap_reached' }).waitFor();
  assert.equal(await page.locator('#showcase-budget').textContent(), balance);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(web + '/proof');
  await page.locator('#showcase-proof').getByRole('heading', { name: 'Journal' }).waitFor();
  assert.match(await page.locator('#showcase-proof').textContent(), /"status": "served"/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ measured: true, elapsed_ms: elapsed, run_http: 200, try_http: 402, refresh: true, proof_without_session: true }));
} finally {
  await browser.close();
}
