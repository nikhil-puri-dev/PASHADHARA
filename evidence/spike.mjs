// Sandbox spike: authorize -> 2 partial captures -> reauthorize -> void remainder.
// Usage: node --env-file=.env spike.mjs            (step 1: create order, prints approve link)
//        node --env-file=.env spike.mjs <ORDER_ID> (step 2: after you approved it as the sandbox buyer)
import { randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync } from "node:fs";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env");
  process.exit(1);
}
const LOG = "spike-log.jsonl";

async function token() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error("auth failed: " + JSON.stringify(j));
  return j.access_token;
}

async function call(step, tok, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  const rec = { step, method, path, status: r.status, body: json };
  appendFileSync(LOG, JSON.stringify(rec) + "\n");
  console.log(`\n## ${step}  HTTP ${r.status}`);
  console.log(JSON.stringify(json, null, 2).slice(0, 1500));
  return rec;
}

const tok = await token();
const orderId = process.argv[2];

if (!orderId) {
  writeFileSync(LOG, "");
  const o = await call("1 create order intent=AUTHORIZE 10.00", tok, "POST", "/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }],
    payment_source: { paypal: { experience_context: { return_url: "https://example.com/ok", cancel_url: "https://example.com/cancel", user_action: "PAY_NOW" } } },
  });
  const link = o.body.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  console.log("\nORDER_ID:", o.body.id);
  console.log("OPEN THIS LINK, log in as your sandbox BUYER account, approve:", link?.href);
  console.log("Then run: node --env-file=.env spike.mjs", o.body.id);
} else {
  const g = await call("2 get order", tok, "GET", `/v2/checkout/orders/${orderId}`);
  if (g.body.status !== "APPROVED") { console.log("Order not APPROVED yet:", g.body.status); process.exit(2); }
  const a = await call("3 authorize order", tok, "POST", `/v2/checkout/orders/${orderId}/authorize`, {});
  const authId = a.body.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authId) { console.log("No authorization id; stop."); process.exit(3); }
  console.log("\nAUTH_ID:", authId);
  const cap = (n, v, final) => call(`${n} capture ${v} final_capture=${final}`, tok, "POST", `/v2/payments/authorizations/${authId}/capture`,
    { amount: { currency_code: "USD", value: v }, final_capture: final, invoice_id: "spike-" + randomUUID().slice(0, 8) });
  await cap("4", "2.00", false);
  await call("5 get authorization (expect PARTIALLY_CAPTURED)", tok, "GET", `/v2/payments/authorizations/${authId}`);
  await cap("6", "3.00", false);
  await call("7 get authorization after 2nd capture", tok, "GET", `/v2/payments/authorizations/${authId}`);
  await call("8 reauthorize 5.00 (may be refused inside honor period; that is a finding)", tok, "POST", `/v2/payments/authorizations/${authId}/reauthorize`, { amount: { currency_code: "USD", value: "5.00" } });
  await call("9 void remainder", tok, "POST", `/v2/payments/authorizations/${authId}/void`);
  await call("10 get authorization final state", tok, "GET", `/v2/payments/authorizations/${authId}`);
  console.log("\nDone. Full responses in spike-log.jsonl");
}
