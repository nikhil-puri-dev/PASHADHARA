import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.MOTION_URL || "http://localhost:3100";
const browser = await chromium.launch({ channel: "msedge" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(origin);
  await page.locator('[data-act="sample"]').first().click();
  await page.locator("#cord svg").evaluate(svg => {
    window.beforeSvg = svg;
    window.beforePendant = svg.querySelector(".pen");
  });
  await page.locator("#one").click();
  assert.equal(await page.locator("#cord svg").evaluate(svg => (
    svg === window.beforeSvg && svg.querySelector(".pen") === window.beforePendant
  )), true, "A paid call should preserve the cord and existing pendants");
  console.log("Paid call preserves SVG and pendant identity");

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await phone.goto(origin);
  const illustration = phone.locator("#howvis svg");
  const height = async () => illustration.evaluate(node => node.getBoundingClientRect().height);
  const first = await height();
  for (const label of ["Spend", "Judge", "Void"]) {
    await phone.getByRole("tab", { name: label }).click();
    assert.equal(await height(), first, `${label} preserves the illustration height`);
  }
  console.log("How illustrations keep the same height on a 390 px viewport");
} finally {
  await browser.close();
}
