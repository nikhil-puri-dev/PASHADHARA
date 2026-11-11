import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("apps/web/package.json", root));
const { chromium } = require("playwright");
const read = file => readFile(new URL(file, root), "utf8");
const log = async file => (await read(file)).trim().split(/\r?\n/).map(JSON.parse);
const [spike, live, report, readonly] = await Promise.all([
  log("evidence/spike2-log.masked.jsonl"),
  log("evidence/live-20261109-replacement.jsonl"),
  read("docs/runs/replacement-sandbox-run.md"),
  log("evidence/sandbox-readonly-20261108.jsonl"),
]);

// Check the browser directly against the sources, without loading the manifest or its generator.
const feeRecords = spike.filter(({ step, status }) => /^C capture #\d+ 1\.00$/.test(step) && status === 201);
const day = ({ at }) => at.split("T")[0] + " UTC";
const measured = row => "measured · " + day(row);
const feeRows = feeRecords.map(({ step, at, body }) => [
  step.split("#")[1].split(" ")[0].padStart(2, "0"), body.id, at.split("T")[1].split(".")[0],
  "$" + body.amount.value, "$" + body.seller_receivable_breakdown.paypal_fee.value, body.status, "measured",
]);
const money = cents => "$" + (cents / 100).toFixed(2);
const cents = value => Number(value.replace(".", ""));
const cap = spike.find(row => row.step === "authorize C").body.purchase_units[0].payments.authorizations[0].amount.value;
const sum = index => feeRows.reduce((total, cells) => total + cents(cells[index].slice(1)), 0);
const gross = sum(3);
const totals = [
  ["Total", money(gross), money(sum(4)), "computed"],
  ["Estimated fee if captured together", money(gross), money(Math.round(49 + gross * 0.0349)), "computed"],
];

const posts = live.filter(row => row.op === "capture" && row.event === "response" && row.http_status === 201);
const reads = live.filter(row => row.op === "get_capture" && row.event === "response" && row.http_status === 200);
const captureChecks = posts.map(post => {
  const { body, at } = post;
  const match = reads.filter(read => read.at > at && read.body.id === body.id).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (match) {
    for (const key of ["status", "amount", "seller_receivable_breakdown"]) assert.deepEqual(match.body[key], body[key]);
  }
  const status = match ? "Matched by fresh GET" : "POST response only";
  return { id: body.id, amount: "$" + body.amount.value, status, evidence: match ?? post };
});
const captureDays = new Set(captureChecks.map(row => day(row.evidence)));
const sharedCaptureDay = captureDays.size === 1 ? [...captureDays][0] : null;
const reconcile = captureChecks.map(({ id, amount, status, evidence }) => [
  id, amount, status + " " + (sharedCaptureDay ? "measured" : measured(evidence)),
]);
const untouched = spike.find(row => row.step === "authorize A");
const untouchedAuth = untouched.body.purchase_units[0].payments.authorizations[0].id;
assert(!spike.some(row => row.method === "POST" && row.path.endsWith("/" + untouchedAuth + "/capture")));
const authRead = readonly.find(row => row.method === "GET" && row.status === 200 && row.response?.id === untouchedAuth);
const readAt = authRead.at.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "Z");
reconcile.push(["Earlier authorization", "", "No capture recorded for this authorization in the log. computed · " +
  day(untouched) + " Log entry in evidence/sandbox-readonly-20261108.jsonl records a PayPal GET response of " +
  authRead.response.status + ". measured · " + readAt]);

const runDate = report.match(/(\d{4}-\d{2}-\d{2}) IST/)[1];
const score = report.match(/each scored (\d+) in the kernel/)[1];
const release = report.match(/derived a USD ([\d.]+) release/)[1];
const [, outcome, names] = report.match(/\b(\w+)ing verdicts from (.+?), each scored/);
const providers = names.split(" and ");
const recorded = "recorded (run report) · " + runDate + " IST";
const escrowFee = report.match(/release and PayPal measured a USD ([\d.]+) fee/)[1];
const payoutRead = live.find(row => row.op === "get_payout" && row.event === "response");
const capturePost = posts.find(row => row.body.amount.value === release &&
  row.body.seller_receivable_breakdown.paypal_fee.value === escrowFee);
const { body: captured } = capturePost;
const captureCheck = captureChecks.find(row => row.id === captured.id);
const captureEvidence = captureCheck.status.replace("Matched by fresh GET", "Confirmed by PayPal GET") + " " +
  measured(captureCheck.evidence);
const { body: payout } = payoutRead;
const escrow = [
  ...providers.map(provider => [provider, outcome + " · " + score + " " + recorded]),
  ["Kernel decision", "release $" + release + " " + recorded],
  ["Capture", "$" + captured.amount.value + " · " + captured.status +
    " · fee $" + captured.seller_receivable_breakdown.paypal_fee.value + " " + captureEvidence],
  ["Payout", "$" + payout.batch_header.amount.value + " · " + payout.batch_header.batch_status + " Confirmed by PayPal GET " + measured(payoutRead)],
];
const overageReply = spike.find(row => row.body?.details?.some(detail => detail.issue === "MAX_CAPTURE_AMOUNT_EXCEEDED"));
const overage = overageReply.body.details[0].description.match(/\d+%/)[0];

const output = resolve(process.argv[2] ?? "apps/web/.next/proof-screenshots");
await mkdir(output, { recursive: true });
const browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" });
const origin = process.env.CORD_URL ?? "http://127.0.0.1:3100";
let mismatches = 0;
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    mismatches++;
    console.error(label, error.message);
  }
}

const measureLayout = locator => locator.evaluate(root => {
  const wrapped = [...root.querySelectorAll(".money,.tag,.tag-date")].filter(element => {
    if (!element.checkVisibility()) return false;
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = range.getClientRects();
    const clip = element.closest(".wide")?.getBoundingClientRect();
    return rects.length !== 1 || rects[0].left < (clip?.left ?? 0) - 1 ||
      rects[0].right > (clip?.right ?? innerWidth) + 1;
  }).map(element => element.textContent);
  const scrollRegions = [...root.querySelectorAll(".wide")].filter(element => element.scrollWidth > element.clientWidth);
  return { wrapped, scrollRegions: scrollRegions.length, pageOverflow: document.documentElement.scrollWidth > innerWidth };
});
const fits = { wrapped: [], scrollRegions: 0, pageOverflow: false };

try {
  for (const [width, height] of [[320, 844], [360, 844], [390, 844], [1440, 1000]]) {
    const name = width === 1440 ? "desktop" : "mobile-" + width;
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    const dataRequests = [];
    // Keep the check local and forbid every request except GET to the built web app.
    await page.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") || request.method() !== "GET") {
        dataRequests.push(url.pathname);
        return route.abort();
      }
      return url.origin === new URL(origin).origin ? route.continue() : route.abort();
    });
    await page.goto(new URL("/proof", origin).href);
    await page.locator("#sandbox-proof").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const cells = selector => page.locator(selector).evaluateAll(rows => rows.map(row =>
      [...row.children].map(cell => cell.innerText.trim().replace(/\s+/g, " "))));
    check(name + " fee rows", await cells(".proofrt tbody tr"), feeRows);
    check(name + " fee totals", await cells(".proofrt tfoot tr"), totals);
    check(name + " hold balances", await page.locator(".proof-balance .money").allTextContents(),
      ["$" + cap, money(cents(cap) - gross)]);
    check(name + " mixed headings", await page.locator("#sandbox-proof h2 .tag").count(), 0);
    check(name + " balance labels", await page.locator(".proof-balance .tag").allTextContents(),
      ["computed", "measured", "computed"]);
    check(name + " balance dates", await page.locator(".proof-balance .tag-date").allTextContents(),
      Array(3).fill(day(feeRecords[0])));
    check(name + " fee table label", await page.locator(".proofrt caption").textContent(),
      "Capture POST responses " + measured(feeRecords[0]));
    check(name + " reconciliation caption", await page.locator(".reconcile-rt caption").textContent(),
      "Replacement run captures measured" + (sharedCaptureDay ? " · " + sharedCaptureDay : ""));
    check(name + " overage wording", (await page.locator('[aria-labelledby="proof-limits"] p').first().textContent()).trim(),
      "PayPal mentioned a " + overage + " overage limit in an error response. " + measured(overageReply) + " The run did not test that boundary.");
    check(name + " reconciliation", await cells(".reconcile-rt tbody tr"), reconcile);
    check(name + " log path is plain text", await page.locator(".proof-log-path").evaluate(element => Boolean(element.closest("a"))), false);
    check(name + " escrow", await cells(".proof-escrow dl > div"), escrow);

    const capDollars = Number(cap);
    const tickLabels = [];
    for (let dollars = width <= 390 ? 5 : 0; dollars <= capDollars; dollars += 5) tickLabels.push("$" + dollars);
    const ticks = await page.locator(".proof-cord .tk").evaluateAll(elements => elements.map(element =>
      [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("")));
    check(name + " cord ticks", ticks, tickLabels);
    check(name + " cord knots", await page.locator(".proof-cord .knots title").allTextContents(),
      feeRecords.map(() => "Dollars: 1 knot, captured"));

    check(name + " Proof layout", await measureLayout(page.locator("body")), fits);
    if (width !== 360) await page.screenshot({ path: resolve(output, name + ".png"), fullPage: true });
    check(name + " Proof panels", await page.locator("#main > *").evaluateAll(nodes => nodes.map(node => node.id)), ["sandbox-proof"]);
    check(name + " data requests", dataRequests, []);
    if (width <= 390) {
      await page.goto(origin);
      const faq = page.locator("#faq");
      await faq.waitFor();
      const answer = question => faq.locator("details").filter({ has: page.getByText(question, { exact: true }) });
      for (const [question, expected] of [
        ["What if my agent tries to overspend?", /Both Run the agent and Preview cap decision refuse/],
        ["What happens when I void a lease?", /without any new charge.*token still authenticates.*window_ended/],
        ["Is this live?", /The showcase can run real agent calls/],
      ]) {
        const entry = answer(question);
        await entry.locator("summary").click();
        check(question, expected.test(await entry.locator("p").first().innerText()), true);
        const tagged = entry.locator("p").filter({ has: page.locator(".tag.computed") });
        check(question + " provenance", (await tagged.innerText()).endsWith("computed · stubbed provider tests · 2026-11-11"), true);
        if (question === "Is this live?") {
          check("Real model claim has no computed tag", await entry.locator("p").first().locator(".tag").count(), 0);
          check("Computed claim describes charge path", (await tagged.innerText()).startsWith("Run the agent uses the gateway path"), true);
        }
      }
      check(name + " FAQ layout", await measureLayout(faq), fits);
      check("FAQ per-call ceiling claims", /per-call ceiling/i.test(await faq.textContent()), false);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("Computed rendered Proof diff: " + mismatches + " mismatches");
process.exitCode = mismatches ? 1 : 0;
