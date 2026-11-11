// usage: node scripts/_shots.mjs <baseUrl> <outDir> [routes csv] [widths csv]
import { chromium } from 'playwright';
const [base, out, r = '/,/lease,/approve,/escrow,/settle,/proof,/signup', w = '1440,768,390'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'msedge' });
for (const width of w.split(',').map(Number)) {
  const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 800 : 900 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', m => m.type() === 'error' && errs.push(m.text()));
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('requestfailed', q => errs.push('REQFAIL ' + q.url()));
  for (const route of r.split(',')) {
    await p.goto(base + route, { waitUntil: 'load' }); await p.waitForTimeout(2500);
    const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight, url: location.pathname, title: document.title }));
    const name = (route === '/' ? 'home' : route.slice(1).replace(/\W/g, '_')) + '-' + width;
    await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(name, JSON.stringify(o), o.sw > o.cw ? 'OVERFLOW' : '', errs.splice(0).join(' | '));
  }
  await ctx.close();
}
await b.close();
