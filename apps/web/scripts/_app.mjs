// usage: node scripts/_app.mjs <baseUrl> <outDir> [widths] : enters live demo, shoots in-app routes. Never clicks Run.
import { chromium } from 'playwright';
const [base, out, w = '1440,390'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'msedge' });
for (const width of w.split(',').map(Number)) {
  const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 800 : 900 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage(); const errs = [];
  p.on('console', m => m.type() === 'error' && errs.push(m.text())); p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  await p.goto(base + '/', { waitUntil: 'load' }); await p.waitForTimeout(2000);
  await p.getByText('Open the live demo').first().click(); await p.waitForTimeout(3000);
  for (const route of ['(click)', '/escrow', '/settle', '/approve', '/proof', '/login']) {
    if (route !== '(click)') { await p.goto(base + route, { waitUntil: 'load' }); await p.waitForTimeout(2500); }
    const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight, url: location.pathname, btns: [...document.querySelectorAll('main button, main a[href]')].map(x => x.textContent.trim().slice(0, 28)).filter(Boolean).slice(0, 40) }));
    const name = 'app' + (route === '(click)' ? '_lease' : route.replace(/\W/g, '_')) + '-' + width;
    await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(name, JSON.stringify(o), o.sw > o.cw ? 'OVERFLOW' : '', errs.splice(0).join(' | '));
  }
  await ctx.close();
}
await b.close();
