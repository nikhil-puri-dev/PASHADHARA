// Reality spike 2.
//   node --env-file=.env spike2.mjs create            -> creates 3 AUTHORIZE orders (A, B sentinels; C capture-limit test), prints approve links
//   node --env-file=.env spike2.mjs run <A> <B> <C>   -> authorizes all, runs the experiments, writes sentinels.json + spike2-log.jsonl
import { randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync } from "node:fs";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) { console.error("Missing credentials in .env"); process.exit(1); }
const LOG = "spike2-log.jsonl";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error("auth failed");
  return j.access_token;
}
const tok = await token();

async function call(step, method, path, body, extraHeaders = {}) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "PayPal-Request-Id": randomUUID(), Prefer: "return=representation", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  appendFileSync(LOG, JSON.stringify({ step, at: new Date().toISOString(), ms: Date.now() - t0, method, path, status: r.status, headers: extraHeaders, body: json }) + "\n");
  return { status: r.status, body: json };
}
const brief = (x) => (x.body?.name ? `${x.body.name}: ${(x.body.details || []).map((d) => d.issue).join(",") || x.body.message}` : x.body?.status || "");
const mk = (label) => call(`create ${label}`, "POST", "/v2/checkout/orders", {
  intent: "AUTHORIZE",
  purchase_units: [{ custom_id: `spike2-${label}`, amount: { currency_code: "USD", value: "20.00" } }],
  payment_source: { paypal: { experience_context: { return_url: "https://example.com/ok", cancel_url: "https://example.com/cancel", user_action: "PAY_NOW" } } },
});

const mode = process.argv[2];

if (mode === "create") {
  writeFileSync(LOG, "");
  for (const label of ["A-sentinel-untouched", "B-sentinel-partial", "C-capture-limit"]) {
    const o = await mk(label);
    const link = o.body.links?.find((l) => l.rel === "payer-action")?.href;
    console.log(`\n${label}\n  ORDER_ID: ${o.body.id}\n  APPROVE:  ${link}`);
  }
  console.log("\nApprove all three as the sandbox BUYER, then run: node --env-file=.env spike2.mjs run <A> <B> <C>");
} else if (mode === "run") {
  const [A, B, C] = process.argv.slice(3);
  const sentinels = {};
  const auth = async (label, id) => {
    const a = await call(`authorize ${label}`, "POST", `/v2/checkout/orders/${id}/authorize`, {});
    const au = a.body.purchase_units?.[0]?.payments?.authorizations?.[0];
    console.log(`authorize ${label}: HTTP ${a.status} ${au?.status || brief(a)} id=${au?.id}`);
    return au;
  };
  const aA = await auth("A", A), aB = await auth("B", B), aC = await auth("C", C);
  if (!aA?.id || !aB?.id || !aC?.id) { console.log("An authorization failed; see log."); process.exit(2); }
  const stamp = (label, order, au) => ({ label, order_id: order, authorization_id: au.id, amount: "20.00 USD", created: new Date().toISOString(), expiration_time: au.expiration_time });
  sentinels.A = stamp("untouched", A, aA);
  // B: partially capture $2 so we learn reauthorize semantics on a partly captured authorization
  const bc = await call("B capture 2.00 final=false", "POST", `/v2/payments/authorizations/${aB.id}/capture`, { amount: { currency_code: "USD", value: "2.00" }, final_capture: false, invoice_id: "b-" + randomUUID().slice(0, 8) });
  console.log(`B capture 2.00: HTTP ${bc.status} ${bc.body.status}`);
  sentinels.B = { ...stamp("partly captured $2", B, aB), partial_capture_id: bc.body.id };
  writeFileSync("sentinels.json", JSON.stringify(sentinels, null, 2));
  console.log("sentinels.json written. Day 4 is ~96h after:", sentinels.A.created);

  // C: 12 captures of $1 to find limits and per-capture fees
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    const c = await call(`C capture #${i} 1.00`, "POST", `/v2/payments/authorizations/${aC.id}/capture`, { amount: { currency_code: "USD", value: "1.00" }, final_capture: false, invoice_id: `c${i}-` + randomUUID().slice(0, 6) });
    const f = c.body.seller_receivable_breakdown;
    rows.push({ i, http: c.status, status: c.body.status || brief(c), fee: f?.paypal_fee?.value, net: f?.net_amount?.value });
    await sleep(300);
  }
  console.table(rows);
  // decline simulation via mock header
  const mock = await call("C capture with mock INSTRUMENT_DECLINED", "POST", `/v2/payments/authorizations/${aC.id}/capture`, { amount: { currency_code: "USD", value: "1.00" }, final_capture: false, invoice_id: "mock-" + randomUUID().slice(0, 6) }, { "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" }) });
  console.log(`mock decline: HTTP ${mock.status} ${brief(mock)}`);
  // over-capture: remaining is ~$8, ask $20
  const over = await call("C over-capture 20.00", "POST", `/v2/payments/authorizations/${aC.id}/capture`, { amount: { currency_code: "USD", value: "20.00" }, final_capture: false, invoice_id: "over-" + randomUUID().slice(0, 6) });
  console.log(`over-capture 20.00: HTTP ${over.status} ${brief(over)}`);
  const g1 = await call("C get authorization before void", "GET", `/v2/payments/authorizations/${aC.id}`);
  console.log(`C status before void: ${g1.body.status}`);
  const v = await call("C void remainder", "POST", `/v2/payments/authorizations/${aC.id}/void`);
  console.log(`C void: HTTP ${v.status} ${brief(v)}`);
  const after = await call("C capture after void", "POST", `/v2/payments/authorizations/${aC.id}/capture`, { amount: { currency_code: "USD", value: "1.00" }, final_capture: false, invoice_id: "after-" + randomUUID().slice(0, 6) });
  console.log(`capture after void: HTTP ${after.status} ${brief(after)}`);
  const g2 = await call("C get authorization after void", "GET", `/v2/payments/authorizations/${aC.id}`);
  console.log(`C status after void: ${g2.body.status}`);
  // Payouts: 1 USD to the sandbox buyer
  const buyerEmail = process.env.BUYER_EMAIL;
  if (buyerEmail) {
    const p = await call("payout 1.00", "POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: "spike2-" + randomUUID().slice(0, 8), email_subject: "spike2 payout" },
      items: [{ recipient_type: "EMAIL", amount: { value: "1.00", currency: "USD" }, receiver: buyerEmail, sender_item_id: "item-" + randomUUID().slice(0, 6) }],
    });
    console.log(`payout: HTTP ${p.status} ${brief(p)} batch=${p.body.batch_header?.payout_batch_id}`);
    if (p.body.batch_header?.payout_batch_id) {
      await sleep(4000);
      const pg = await call("payout get", "GET", `/v1/payments/payouts/${p.body.batch_header.payout_batch_id}`);
      console.log(`payout batch status: ${pg.body.batch_header?.batch_status}; item: ${pg.body.items?.[0]?.transaction_status}`);
    }
  } else console.log("BUYER_EMAIL not set; payout test skipped.");
  console.log("\nDone. Raw responses in spike2-log.jsonl, sentinels in sentinels.json");
}
