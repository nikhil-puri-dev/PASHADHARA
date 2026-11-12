// Rasterises app/icon.svg into the PNG and ICO assets, and writes a preview sheet.
// Usage: node scripts/make-brand.mjs   (run from apps/web; needs Playwright's Chromium or Edge)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const svg = readFileSync(root + "app/icon.svg", "utf8");
const browser = existsSync(chromium.executablePath()) ? await chromium.launch() : await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
async function png(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const out = {};
for (const s of [16, 32, 48, 180, 192, 512]) out[s] = await png(s);
writeFileSync(root + "public/icon-192.png", out[192]);
writeFileSync(root + "public/icon-512.png", out[512]);
writeFileSync(root + "app/apple-icon.png", out[180]);
// favicon.ico with PNG-compressed 16, 32 and 48 px images
const sizes = [16, 32, 48], head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => { const b = 6 + i * 16; head[b] = s; head[b + 1] = s; head.writeUInt16LE(1, b + 4); head.writeUInt16LE(32, b + 6); head.writeUInt32LE(out[s].length, b + 8); head.writeUInt32LE(offset, b + 12); offset += out[s].length; });
writeFileSync(root + "app/favicon.ico", Buffer.concat([head, ...sizes.map(s => out[s])]));
// preview: the favicon at real sizes, magnified, and the header mark
const mark = readFileSync(root + "public/mark.svg", "utf8");
await page.setViewportSize({ width: 900, height: 360 });
const uri = b => `data:image/png;base64,${b.toString("base64")}`;
await page.setContent(`<body style="margin:0;background:#1a1416;color:#ddd;font:14px sans-serif;display:flex;gap:28px;padding:24px;align-items:flex-end">
<div>16 px<br><img src="${uri(out[16])}" width="16" height="16"><br><br>16 px at 8x<br><img src="${uri(out[16])}" width="128" height="128" style="image-rendering:pixelated"></div>
<div>32 px<br><img src="${uri(out[32])}" width="32" height="32"><br><br>32 px at 4x<br><img src="${uri(out[32])}" width="128" height="128" style="image-rendering:pixelated"></div>
<div>48 px<br><img src="${uri(out[48])}"></div><div>180<br><img src="${uri(out[180])}" width="150"></div>
<div>header mark<br><div style="width:150px">${mark.replace("<svg ", '<svg width="150" height="150" ')}</div></div></body>`);
await page.screenshot({ path: root + "../../design/v5-screens/brand-sheet.png" });
await browser.close();
console.log("brand assets written");
