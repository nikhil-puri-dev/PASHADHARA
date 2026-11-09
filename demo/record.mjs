import assert from "node:assert/strict";
import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("playwright");
const origin = process.env.DEMO_URL ?? "http://127.0.0.1:3105";
const folder = fileURLToPath(new URL("./.artifacts/", import.meta.url));
const destination = join(folder, process.argv.includes("--quick") ? "pashadhara-quick.webm" : "pashadhara-demo.webm");
const pace = process.argv.includes("--quick") ? .08 : 1;
await mkdir(folder, { recursive: true });
const scratch = await mkdtemp(join(folder, "capture-"));
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined });
let context;
try {
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: "light",
    recordVideo: { dir: scratch, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  const video = page.video();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const started = Date.now();
  const link = name => page.getByRole("link", { name, exact: true });
  const button = name => page.getByRole("button", { name, exact: true });
  async function beat(heading, seconds, label = heading) {
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${label}`);
    await page.waitForTimeout(seconds * 1000 * pace);
  }
  async function showRail(seconds, label) {
    const rail = page.locator(".lifecycle");
    await rail.evaluate(node => node.scrollIntoView({ block: "end", behavior: "instant" }));
    const box = await rail.boundingBox();
    assert(box.y >= -1 && box.y + box.height <= 901, `lifecycle rail is in the video viewport: ${JSON.stringify(box)}`);
    await beat("Authorization lifecycle", seconds, label);
  }

  await page.goto(`${origin}/capture/story?theme=light`);
  await beat("One PayPal hold. An AI spending lease.", 10, "One spending cap, five steps");
  await page.getByRole("slider", { name: "Step through lease activity" }).press("ArrowLeft");
  await page.waitForTimeout(2000 * pace);
  await link("Review buyer approval").click();
  await beat("Approve a hold.", 6, "Buyer reviews the fixture hold");
  await link("Review hold request").click();
  await page.getByLabel("Type the amount shown").pressSequentially("$20.00", { delay: 115 });
  await button("Confirm request").click();
  await beat("Waiting for approval.", 6, "Pending approval blocks tool calls");
  await link("View active lease").click();
  await beat("Budget in use.", 5, "Fixture lease and honor window");
  await showRail(4, "Authorization and expiry milestones");
  await link("Inspect fixture reauthorization").click();
  await page.getByRole("heading", { name: "Authorization renewed.", exact: true }).waitFor();
  await showRail(7, "Replacement uses the existing lease cap");
  await link("Back to active lease").click();

  await link("Review a capture timeout").click();
  await page.getByLabel("Type the amount shown").pressSequentially("$5.50", { delay: 115 });
  await page.waitForTimeout(3500 * pace);
  const hold = button("Hold to settle");
  await hold.hover();
  await page.mouse.down();
  await page.waitForURL("**/capture/lease/unknown?theme=light");
  await page.mouse.up();
  await beat("Capture outcome unknown.", 9, "Unknown leaves committed funds reserved");
  await link("Read capture status").click();
  await beat("Capture confirmed by a read.", 8, "Fixture API read confirms one posting");
  await link("View escrow").click();
  await beat("Where the reserve went.", 10, "Same lease, two job reserves");
  await link("See judged payout").click();
  await beat("Judged payout.", 8, "Kernel applies the buyer’s rubric");
  await link("View payout").click();
  await beat("Payout queued.", 7, "Buyer can appeal before the deadline");
  await page.getByRole("navigation").getByRole("link", { name: "Escrow" }).click();
  await link("See held verdict").click();
  await beat("Verdict held.", 8, "Disagreement keeps the reserve held");
  await link("View proof").click();
  await beat("Proof, line for line.", 7, "Kernel replay versus recorded sandbox fields");
  await page.getByLabel("Compare a record").selectOption("1");
  await page.waitForURL("**/capture/proof/2?theme=light");
  await link("Inspect a mismatch").click();
  await page.locator(".mismatch").waitFor();
  assert.equal(await page.getByLabel("Compare a record").inputValue(), "1");
  await page.waitForTimeout(7500 * pace);
  await page.locator(".webhook-strip").scrollIntoViewIfNeeded();
  await beat("One event, repeated delivery.", 8, "Fixture duplicate webhook deliveries");
  await link("View journal").click();
  await beat("Every movement.", 6, "Append-only lease journal");
  await link("Next movements").click();
  await page.locator('[data-journal-kind="capture"]').filter({ hasText: "Second tool batch" }).locator("summary").click();
  await page.waitForTimeout(5000 * pace);
  assert.deepEqual(errors, []);
  await context.close();
  await video.saveAs(destination);
  await video.delete();
  await rmdir(scratch);
  console.log(`Saved ${destination}`);
} finally {
  await context?.close();
  await browser.close();
}

