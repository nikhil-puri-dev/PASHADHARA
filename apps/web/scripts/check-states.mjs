import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.CORD_URL || 'http://127.0.0.1:3122';
const shots = resolve('evidence/ui-20261112');
mkdirSync(shots, { recursive: true });
const browser = existsSync(chromium.executablePath()) ? await chromium.launch() : await chromium.launch({ channel: 'msedge' });
const id = '11111111-1111-4111-8111-111111111111';
const base = {
  mode: 'live', provenance: 'computed', remaining_calls: 2, state: 'active', ended: false, read_at: '2026-11-12T12:00:00Z',
  lease: {
    id, state: 'active', cap_minor: 200, guaranteed_now: true,
    balances: { hold_available: 197, committed_unsettled: 3, total_captured: 0 },
    authorizations: [{ paypal_authorization_id: 'AUTH-FIXTURE', amount_minor: 200, status: 'created', honor_until: '2026-11-15T12:00:00Z' }],
  },
  journal: { entries: [{ id: 1, account: 'COMMITTED_UNSETTLED', direction: 'D', amount_minor: 3, ref_type: 'commit', created_at: '2026-11-12T12:00:00Z' }] },
  calls: [{ id: 'call-fixture', tool_id: 'summarise', status: 'served', price_minor: 3, captured: false, created_at: '2026-11-12T12:00:00Z' }],
  captures: [],
};
const cases = [
  { name: 'live', payload: base },
  { name: 'empty', payload: { mode: 'live', state: 'ended', ended: true, read_at: base.read_at } },
  { name: 'expired', payload: { ...base, state: 'ended', ended: true, remaining_calls: 0, lease: { ...base.lease, authorizations: [{ ...base.lease.authorizations[0], honor_until: '2026-11-11T12:00:00Z' }] } } },
  { name: 'unreachable', status: 503 },
];

try {
  for (const width of [1365, 390, 360]) {
    for (const scenario of cases) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      let paidCalls = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/showcase/run', route => { paidCalls++; return route.fulfill({ status: 418, body: '{}' }); });
      await page.route('**/api/showcase/try**', route => {
        const price = Number(new URL(route.request().url()).searchParams.get('price_minor'));
        return route.fulfill({ status: price > 197 ? 402 : 200, contentType: 'application/json', body: JSON.stringify({ provenance: 'computed', price_minor: price, remaining_minor: 197, reason: price > 197 ? 'cap_reached' : null }) });
      });
      await page.route('**/api/showcase', route => route.fulfill({ status: scenario.status ?? 200, contentType: 'application/json', body: JSON.stringify(scenario.payload ?? {}) }));
      await page.goto(origin + '/');
      await page.locator('.dk-mode').first().waitFor();
      await page.waitForFunction(() => document.querySelector('.dk-big')?.textContent?.includes('$'));
      const band = await page.locator('.dk-band').innerText();
      const balance = await page.locator('.dk-big').innerText();
      assert.equal(await page.locator('#h1cap').count(), 0, 'no static financial headline');
      assert.equal(balance, scenario.name === 'live' ? '$1.97' : '$2.00');
      assert.match(band, scenario.name === 'live' ? /LIVE PAYPAL SANDBOX/ : /INTERACTIVE SIMULATION/);
      if (scenario.name !== 'live') assert.doesNotMatch(band, /LIVE PAYPAL SANDBOX/);
      assert.doesNotMatch(band, /SAVED DEMO FIXTURE/);
      if (scenario.name === 'unreachable') assert.match(band, /gateway did not answer/);
      if (scenario.name === 'expired') assert.match(band, /spending closed/);
      const over = page.locator('.dk-pre.primary');
      assert.equal(await over.getAttribute('data-c'), scenario.name === 'live' ? '198' : '201');
      assert.match(await over.innerText(), scenario.name === 'live' ? /\$1\.98/ : /\$2\.01/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal overflow');
      if (scenario.name === 'live') {
        await over.click();
        await page.locator('.dk-r').first().waitFor();
        assert.match(await page.locator('.dk-r').first().innerText(), /Asked \$1\.98/);
        assert.match(await page.locator('.dk-r').first().innerText(), /Refused/);
      }
      if ((width === 1365 && scenario.name === 'live') || (width === 390 && scenario.name !== 'expired') || (width === 360 && scenario.name === 'live')) {
        await page.screenshot({ path: resolve(shots, `${scenario.name}-home-${width}.png`), fullPage: true });
      }
      await page.goto(origin + '/lease?showcase=1');
      const noJournal = scenario.name === 'empty' || scenario.name === 'unreachable';
      const readout = noJournal ? page.locator('main [role="status"]') : page.locator('#lead');
      await readout.filter({ hasText: noJournal ? /No showcase hold|gateway did not answer/ : /spend/ }).waitFor();
      const lead = await readout.innerText();
      if (scenario.name === 'live') {
        assert.match(lead, /\$1\.97 is free to spend/);
        assert.equal(await page.locator('[data-act="showcase-run"]').count(), 1);
      } else {
        assert.equal(await page.locator('[data-act="showcase-run"]').count(), 0);
        assert.doesNotMatch(lead, /is free to spend/);
      }
      if (noJournal) {
        assert.doesNotMatch(lead, /\$|fixture/i);
        assert.equal(await page.locator('#ledger').count(), 0);
      }
      if (scenario.name === 'expired') assert.match(lead, /cannot spend/);
      if (scenario.name === 'expired') {
        assert.doesNotMatch(await page.locator('#ledger').innerText(), /Free to spend/);
        assert.doesNotMatch(await page.locator('#cordKey').innerText(), /free to spend/);
      }
      assert.equal(paidCalls, 0, 'no paid showcase call sent');
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'lease has no horizontal overflow');
      if (width === 390 && scenario.name !== 'live') {
        await page.screenshot({ path: resolve(shots, `${scenario.name}-lease-${width}.png`), fullPage: true });
      }
      console.log(`PASS ${scenario.name} ${width}: home ${balance}; lease ${lead.split('\n')[0]}`);
      await context.close();
    }
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 850 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(origin + '/escrow');
  await page.locator('#escOut .payout').waitFor();
  assert.match(await page.locator('main').innerText(), /RECORDED EVIDENCE/);
  assert.match(await page.locator('main').innerText(), /INTERACTIVE SIMULATION/);
  assert.equal(await page.locator('.slimcord').count(), 0, 'standalone escrow has no sample lease balance');
  await page.locator('button[data-j="a"][data-v="0"]').click();
  await page.locator('button[data-j="b"][data-v="0"]').click();
  assert.match(await page.locator('#escOut .kernel').innerText(), /Two fails void/);
  await page.locator('button[data-j="a"][data-v="2"]').click();
  assert.match(await page.locator('#escOut .payout').innerText(), /held/);
  await page.screenshot({ path: resolve(shots, 'escrow-mobile-390.png'), fullPage: true });
  await page.goto(origin + '/quickstart');
  await page.locator('.quickstart h1').waitFor();
  assert.match(await page.locator('.quickstart').innerText(), /operator key/);
  assert.equal(await page.locator('[data-act="copy-code"]').count(), 2);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.locator('[data-act="copy-code"]').first().click();
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), (await page.locator('.quickstart .snippet code').first().textContent()).replace(/\r\n/g, '\n'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: resolve(shots, 'quickstart-mobile-390.png'), fullPage: true });
  await context.close();
  console.log('PASS escrow and quickstart mobile');

  const privateContext = await browser.newContext({ viewport: { width: 390, height: 850 }, reducedMotion: 'reduce' });
  const privatePage = await privateContext.newPage();
  const privateLease = { ...base.lease, balances: { hold_available: 147, committed_unsettled: 3, total_captured: 50 } };
  await privatePage.route(`**/api/v1/leases/${id}/journal`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [
    { id: 1, account: 'COMMITTED_UNSETTLED', direction: 'D', amount_minor: 53, ref_type: 'commit', created_at: '2026-11-12T12:00:00Z' },
  ] }) }));
  await privatePage.route(`**/api/v1/leases/${id}`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(privateLease) }));
  await privatePage.goto(`${origin}/lease#live=${id}.${'x'.repeat(24)}`);
  await privatePage.waitForFunction(() => document.querySelector('#lead h1')?.textContent?.includes('$1.47'));
  assert.match(await privatePage.locator('#ledger').innerText(), /Captured\s+\$0\.50/);
  assert.match(await privatePage.locator('#ledger').innerText(), /Owed, not captured\s+\$0\.03/);
  assert.doesNotMatch(await privatePage.locator('#lead').innerText(), /\$1\.97/);
  await privatePage.screenshot({ path: resolve(shots, 'private-lease-390.png'), fullPage: true });
  await privateContext.close();
  console.log('PASS private live lease uses authoritative balances after capture');

  const transitionContext = await browser.newContext({ viewport: { width: 390, height: 850 }, reducedMotion: 'reduce' });
  const transitionPage = await transitionContext.newPage();
  let currentSnapshot = base;
  await transitionPage.route('**/api/showcase/run', route => route.fulfill({ status: 418, body: '{}' }));
  await transitionPage.route('**/api/showcase', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentSnapshot) }));
  await transitionPage.goto(`${origin}/lease?showcase=1`);
  await transitionPage.waitForFunction(() => document.querySelector('#lead h1')?.textContent?.includes('$1.97'));
  currentSnapshot = cases.find(item => item.name === 'expired').payload;
  await transitionPage.waitForFunction(() => document.querySelector('#lead h1')?.textContent?.includes('cannot spend'), { timeout: 12000 });
  assert.match(await transitionPage.locator('#leaseSource').innerText(), /SPENDING CLOSED/);
  assert.doesNotMatch(await transitionPage.locator('#ledger').innerText(), /Free to spend/);
  currentSnapshot = { ...base, state: 'expiring', lease: { ...base.lease, id: '22222222-2222-4222-8222-222222222222' } };
  await transitionPage.locator('#leaseSource').filter({ hasText: 'HOLD ENDS SOON' }).waitFor({ timeout: 12000 });
  assert.equal(await transitionPage.locator('[data-act="showcase-run"]').count(), 1);
  await transitionContext.close();
  console.log('PASS live lease changes to closed and switches to its replacement without a reload');

  if (process.env.RAW_SHOWCASE_ORIGIN) {
    const response = await fetch(new URL('/api/showcase', process.env.RAW_SHOWCASE_ORIGIN), { cache: 'no-store' });
    assert.equal(response.status, 200);
    const raw = await response.json();
    assert.equal(raw.mode, 'live');
    const available = raw.lease.balances.hold_available;
    const liveContext = await browser.newContext({ viewport: { width: 390, height: 850 }, reducedMotion: 'reduce' });
    const livePage = await liveContext.newPage();
    let paidCalls = 0;
    await livePage.route('**/api/showcase/run', route => { paidCalls++; return route.fulfill({ status: 418, body: '{}' }); });
    await livePage.route('**/api/showcase', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(raw) }));
    await livePage.goto(origin + '/');
    await livePage.waitForFunction(() => document.querySelector('.dk-big')?.textContent?.includes('$'));
    assert.equal(await livePage.locator('.dk-big').innerText(), `$${Math.floor(available / 100)}.${String(available % 100).padStart(2, '0')}`);
    assert.equal(paidCalls, 0);
    await livePage.screenshot({ path: resolve(shots, 'raw-live-home-390.png'), fullPage: true });
    writeFileSync(resolve(shots, 'raw-live-read.json'), JSON.stringify({ source: process.env.RAW_SHOWCASE_ORIGIN, checked_at: new Date().toISOString(), mode: raw.mode, state: raw.lease.state, cap_minor: raw.lease.cap_minor, balances: { hold_available: available, committed_unsettled: raw.lease.balances.committed_unsettled, total_captured: raw.lease.balances.total_captured } }, null, 2) + '\n');
    console.log(`PASS raw sandbox journal read: available ${available} cents, committed ${raw.lease.balances.committed_unsettled} cents, captured ${raw.lease.balances.total_captured} cents`);
    await liveContext.close();
  }
} finally {
  await browser.close();
}
