import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const origin = process.env.BOUNDARY_URL ?? 'http://localhost:3138';
const shots = process.env.BOUNDARY_SHOTS;
const run = JSON.parse(fs.readFileSync(new URL('../components/boundary-record.json', import.meta.url)));
const browser = await chromium.launch({ channel: 'msedge' });

try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width < 500 ? 800 : 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/showcase', route => route.fulfill({ status: 503, json: {} }));
    const shot = name => shots && page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
    await page.goto(origin + '/review');
    const face = page.getByRole('region', { name: 'Spending boundary' });
    const replay = face.getByRole('button', { name: /See the decision for \$0\.07/ });
    await replay.waitFor();
    assert.doesNotMatch(await face.innerText(), /Refused/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot('initial');
    await replay.focus();
    assert.notEqual(await replay.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.keyboard.press('Enter');
    assert.match(await face.innerText(), /Refused[\s\S]*\$0\.01 over/);
    assert.match(await face.innerText(), /Tool[\s\S]*did not run[\s\S]*\$0\.00 charged[\s\S]*\$0\.06 remained/);
    assert.equal(await face.locator('.boundary-runner').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    const evidence = face.getByRole('link', { name: 'Run evidence' });
    if (width === 390) assert.equal(await evidence.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), true, 'phone refusal and evidence fit before scrolling');
    await shot('refused');
    await face.getByRole('button', { name: /See the lookup that fit/ }).click();
    assert.match(await face.innerText(), /Served[\s\S]*\$0\.02 committed[\s\S]*\$0\.04 left/);
    assert.match(await face.innerText(), /PAY-A, fixture/);
    await shot('served');
    await face.getByRole('link', { name: 'Run evidence' }).click();
    await page.locator('#boundary-run').waitFor();
    await page.getByText('Open evidence').click();
    const traceHref = await page.getByRole('link', { name: /Gateway and agent trace/ }).getAttribute('href');
    const trace = (await (await page.request.get(origin + traceHref)).text()).trim().split('\n').map(JSON.parse).filter(x => x.event === 'tool_call');
    assert.deepEqual(trace[0].result.structuredContent.price_minor, run.blocked.price);
    assert.deepEqual(trace[0].result.structuredContent.remaining_minor, run.blocked.remaining);
    assert.deepEqual(trace[0].result.structuredContent.reason, run.blocked.reason);
    assert.deepEqual(trace[1].result.structuredContent.evidence.detail, run.served.evidence);
    assert.deepEqual(trace[1].result.structuredContent.receipt.remaining_minor, run.served.remaining);
    await page.goto(origin + '/budget');
    await page.getByText('Live spending data unavailable').waitFor();
    await shot('unavailable');
    await page.unroute('**/api/showcase');
    await page.route('**/api/showcase', route => route.fulfill({ json: { state: 'ended', ended: true, lease: { cap_minor: 1000, balances: { hold_available: 997 }, authorizations: [{ honor_until: '2020-01-01T00:00:00Z' }] } } }));
    await page.reload();
    await page.getByText(/Live spending window ended/).waitFor();
    await shot('expired');
    await page.unroute('**/api/showcase');
    const fixture = { state: 'active', remaining_calls: 1, lease: {
      cap_minor: 1000, balances: { hold_available: 997, committed_unsettled: 3, captured_gross: 0 },
      authorizations: [{ honor_until: '2038-01-01T00:00:00Z', expires_at: '2038-01-29T00:00:00Z' }],
    }, calls: [{ id: 'fixture-call', tool_id: 'summarise', price_minor: 3, status: 'served', captured: false, created_at: '2026-11-12T08:33:00Z' }] };
    let checks = 0;
    await page.route('**/api/showcase', route => route.fulfill({ json: fixture }));
    await page.route('**/api/showcase/try?*', route => {
      checks++;
      assert.equal(new URL(route.request().url()).searchParams.get('price_minor'), '998');
      return route.fulfill({ status: 402, json: { reason: 'cap_reached', price_minor: 998, remaining_minor: 997 } });
    });
    let runs = 0;
    await page.route('**/api/showcase/run', route => {
      runs++;
      return runs === 1 ? route.fulfill({ json: { price_minor: 3, remaining_minor: 994, result: { summary: 'Fixture summary from the browser test.' } } }) : route.abort();
    });
    await page.goto(origin + '/budget');
    await face.getByRole('button', { name: /See the decision for \$9\.98/ }).waitFor();
    assert.equal(checks, 0);
    await face.getByRole('button', { name: /See the decision for \$9\.98/ }).click();
    await face.getByText(/Refused[\s\S]*\$0\.01 over/).waitFor();
    assert.equal(checks, 1);
    assert.match(await face.innerText(), /No journal posting/);
    await face.getByText('Run a paid sandbox tool', { exact: true }).click();
    await face.getByRole('button', { name: /Run sandbox summary/ }).click();
    await face.getByText('Fixture summary from the browser test.').waitFor();
    assert.match(await face.innerText(), /Served[\s\S]*\$0\.03 committed[\s\S]*\$9\.94 free in the hold/);
    await face.getByRole('button', { name: /Run sandbox summary/ }).click();
    await face.getByText(/Outcome unknown.*response was lost/).waitFor();
    assert.equal(await face.getByRole('button', { name: /Run sandbox summary/ }).count(), 0);
    await page.reload();
    await face.getByText(/cannot safely retry/).waitFor();
    assert.equal(runs, 2, 'no automatic paid retry');
    for (const [path, title] of [
      ['/activity?call=fixture-call', 'Journal'], ['/collect', 'Collect from the hold'],
      ['/escrow', '$2.41 reached the seller'], ['/developers', 'Connect your agent'], ['/proof', 'Proof'],
    ]) {
      await page.goto(origin + path);
      await page.getByRole('heading', { name: title, level: 1, exact: true }).waitFor();
      if (path.startsWith('/activity')) await page.getByRole('complementary', { name: 'Call detail' }).getByText('No completed capture in this journal').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, path + ' overflows');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Prepared replay, evidence, expiry, live fixtures, and product routes verified at 1440px and 390px.');
} finally {
  await browser.close();
}
