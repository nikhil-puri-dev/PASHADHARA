import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const target = new URL("apps/web/components/proof-evidence.json", root);
const read = path => readFile(new URL(path, root), "utf8");
const jsonl = async path => (await read(path)).trim().split(/\r?\n/).map(JSON.parse);
const [spike, replacement, report, readonly] = await Promise.all([
  jsonl("evidence/spike2-log.masked.jsonl"),
  jsonl("evidence/live-20261109-replacement.jsonl"),
  read("docs/runs/replacement-sandbox-run.md"),
  jsonl("evidence/sandbox-readonly-20261108.jsonl"),
]);

function one(rows, predicate) {
  const matches = rows.filter(predicate);
  assert.equal(matches.length, 1, "Expected one evidence record");
  return matches[0];
}

function minor({ value, currency_code }) {
  assert.equal(currency_code, "USD");
  assert.match(value, /^\d{1,10}\.\d{2}$/);
  return Number(value.replace(".", ""));
}

function timestamp({ at }) {
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return at;
}

// Project fixed fields only. Never copy response bodies, URLs, headers or account data.
function capture({ body }) {
  assert.match(body.id, /^[A-Z0-9]{17}$/);
  assert.equal(body.status, "COMPLETED");
  return {
    id: body.id,
    status: body.status,
    amount: minor(body.amount),
    fee: minor(body.seller_receivable_breakdown.paypal_fee),
  };
}

function authorization(step) {
  return one(spike, row => row.step === step && row.status === 201);
}

const feeAuth = authorization("authorize C");
const feeAuthorization = feeAuth.body.purchase_units[0].payments.authorizations[0];
const feePath = "/v2/payments/authorizations/" + feeAuthorization.id + "/capture";
const feeDate = timestamp(feeAuth).slice(0, 10);
const fees = spike.filter(row => row.method === "POST" && row.path === feePath && row.status === 201)
  .map(row => {
    const at = timestamp(row);
    assert(at.startsWith(feeDate));
    return { ...capture(row), time: at.slice(11, 19) };
  });
assert.equal(fees.length, 12);
assert.equal(new Set(fees.map(row => row.id)).size, fees.length);
const cap = minor(feeAuthorization.amount);
const total = fees.reduce((sum, row) => sum + row.amount, 0);
assert(total <= cap);
const overageReply = one(spike, row => row.step === "C over-capture 20.00" && row.status === 422);
const overage = overageReply.body.details[0].description.match(/default overage limit is (\d+%)/)?.[1];
assert(overage, "Overage wording is missing");

const runDate = report.match(/^# Rails replacement approval \| (\d{4}-\d{2}-\d{2}) IST$/m)?.[1];
assert(runDate, "Replacement report date is missing");
const response = (op, http) => replacement.filter(row => row.event === "response" &&
  row.provenance === "measured" && row.op === op && row.http_status === http);
const posts = response("capture", 201);
const reads = response("get_capture", 200);
assert.equal(posts.length, 3);
const reconciliation = posts.map(row => {
  const posted = capture(row);
  const matches = reads.filter(read => read.body.id === posted.id);
  for (const read of matches) {
    assert(timestamp(read) > timestamp(row));
    assert.equal(read.lease, row.lease);
    assert.deepEqual(capture(read), posted);
  }
  const latest = matches.reduce((last, read) => read.at > last.at ? read : last, row);
  return { ...posted, state: matches.length ? "matched" : "post", date: timestamp(latest).slice(0, 10) };
});
assert(reads.every(read => reconciliation.some(row => row.id === read.body.id)));

const verdict = report.match(/^The USD (\d+\.\d{2}) escrow job received two real (pass)ing verdicts from ([A-Za-z][A-Za-z0-9-]{0,31}) and ([A-Za-z][A-Za-z0-9-]{0,31}), each scored (\d{1,3}) in the kernel\. The kernel derived a USD (\d+\.\d{2}) release and PayPal measured a USD (\d+\.\d{2}) fee\./m);
assert(verdict, "Escrow verdict or decision evidence is missing");
const [, job, outcome, firstProvider, secondProvider, score, released, escrowFee] = verdict;
assert(Number(score) <= 100);
assert.notEqual(firstProvider, secondProvider);
const usd = value => minor({ value, currency_code: "USD" });
assert.equal(usd(job), usd(released));

const payout = one(response("get_payout", 200), row => row.body.batch_header.batch_status === "SUCCESS");
const payoutPost = one(response("payout", 200).concat(response("payout", 201)),
  row => row.body.batch_header.payout_batch_id === payout.body.batch_header.payout_batch_id);
assert(timestamp(payout) > timestamp(payoutPost));
assert.equal(payout.lease, payoutPost.lease);
// The report gives the release amount and fee but omits the capture ID.
const escrowPost = one(posts, row => {
  if (row.lease !== payout.lease) return false;
  const posted = capture(row);
  return posted.amount === usd(released) && posted.fee === usd(escrowFee);
});
const escrowCapture = one(reconciliation, row => row.id === escrowPost.body.id);
assert.equal(payout.body.items.length, 1);
assert.equal(payout.body.items[0].transaction_status, "SUCCESS");
const { value: payoutValue, currency: payoutCurrency } = payout.body.batch_header.amount;
const paid = minor({ value: payoutValue, currency_code: payoutCurrency });
assert.equal(paid, escrowCapture.amount - escrowCapture.fee);

const untouched = authorization("authorize A");
const untouchedId = untouched.body.purchase_units[0].payments.authorizations[0].id;
const authorizationPath = "/v2/payments/authorizations/" + untouchedId;
assert(!spike.some(row => row.method === "POST" && row.path === authorizationPath + "/capture"));
const authorizationRead = one(readonly, row => row.operation === "authorization" &&
  row.method === "GET" && row.status === 200 && row.path === authorizationPath);
assert.equal(authorizationRead.response.id, untouchedId);
assert.equal(authorizationRead.response.status, "CREATED");
assert(timestamp(authorizationRead) > timestamp(untouched));

const manifest = {
  fees: {
    date: feeDate, cap, rows: fees, total, feeTotal: fees.reduce((sum, row) => sum + row.fee, 0),
    remaining: cap - total, singleCaptureEstimate: 49 + Number((349n * BigInt(total) + 5000n) / 10000n),
  },
  reconciliation: {
    rows: reconciliation,
    authorization: {
      logDate: timestamp(untouched).slice(0, 10),
      readAt: timestamp(authorizationRead).slice(0, 16).replace("T", " ") + "Z",
      status: authorizationRead.response.status,
    },
  },
  escrow: {
    date: runDate,
    verdicts: [firstProvider, secondProvider].map(provider => ({ provider, verdict: outcome, score: Number(score) })),
    decision: { status: "release", amount: usd(released) },
    capture: escrowCapture,
    payout: { status: "SUCCESS", amount: paid, date: timestamp(payout).slice(0, 10) },
  },
  limits: { overage, date: timestamp(overageReply).slice(0, 10) },
};

const output = JSON.stringify(manifest, null, 2) + "\n";
if (process.argv.includes("--check")) {
  assert.equal((await readFile(target, "utf8")).replaceAll("\r\n", "\n"), output, "Regenerate the Proof manifest");
  console.log("Computed manifest diff: 0 mismatches");
} else {
  await writeFile(target, output);
}
