import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const mode = process.argv[2];
if (!['create','run'].includes(mode)) throw Error('Usage: node --env-file=.env packages/paypal/scripts/live-spike.mjs create | run ORDER_A ORDER_B ORDER_C');
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw Error('Missing sandbox credentials');
const logPath = 'evidence/live-spike.jsonl';
const redact = value => { let text = JSON.stringify(value); for (const secret of [process.env.BUYER_EMAIL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, auth.access_token]) if (secret) text = text.replaceAll(secret, '[redacted]'); return text; };
const base = 'https://api-m.sandbox.paypal.com';
const authResponse = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
const auth = await authResponse.json();
if (!authResponse.ok || !auth.access_token) throw Error('OAuth failed');
const call = async (step, path, body, headers = {}) => {
  const requestId = randomUUID();
  appendFileSync(logPath, JSON.stringify({ label: 'computed', at: new Date().toISOString(), step, request_id: requestId, outcome: 'intent' }) + '\n');
  let response;
  try { response = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': requestId, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) }); }
  catch { appendFileSync(logPath, JSON.stringify({ label: 'measured', at: new Date().toISOString(), step, request_id: requestId, outcome: 'unknown' }) + '\n'); throw Error('Unknown outcome. Reconcile before retry.'); }
  const text = await response.text(); let result; try { result = JSON.parse(text); } catch { result = text; }
  appendFileSync(logPath, redact({ label: 'measured', at: new Date().toISOString(), step, request_id: requestId, status: response.status, body: result }) + '\n');
  if (response.status >= 500) throw Error('Unknown server outcome. Reconcile before continuing.');
  return { status: response.status, body: result };
};
if (mode === 'create') {
  if (existsSync('evidence/approval-links.md')) throw Error('Approval links already exist. Preserve them and use the existing orders.');
  writeFileSync('evidence/approval-links.md', '# Sandbox approval links\n\nMeasured: sandbox orders awaiting buyer approval.\n\n');
  for (const label of ['A', 'B', 'C']) {
    const result = await call(`create ${label}`, '/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '20.00' } }], payment_source: { paypal: { experience_context: { return_url: 'https://example.com/ok', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW' } } } });
    const link = result.body?.links?.find(item => item.rel === 'payer-action' || item.rel === 'approve')?.href;
    if (result.status >= 300 || !result.body?.id || !link) throw Error('Order creation failed or approval link missing. See log.');
    appendFileSync('evidence/approval-links.md', `- ${label}: order ${result.body.id}, [approve](${link})\n`);
    console.log(`${label}: ${result.body.id} ${link}`);
  }
  appendFileSync('evidence/approval-links.md', '\nAfter approval, run `node --env-file=.env packages/paypal/scripts/live-spike.mjs run ORDER_A ORDER_B ORDER_C`.\n');
} else {
  const orders = process.argv.slice(3);
  if (orders.length !== 3 || new Set(orders).size !== 3 || orders.some(x => !/^[A-Za-z0-9]+$/.test(x))) throw Error('Provide three distinct order ids');
  const marker = 'evidence/live-spike-run-started.json';
  if (existsSync(marker)) throw Error('Run already started. Reconcile all intents before any further action.');
  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), orders }), { flag: 'wx' });
  const auths = [];
  for (const [i, order] of orders.entries()) {
    const result = await call(`authorize ${i}`, `/v2/checkout/orders/${order}/authorize`, {});
    const authId = result.body?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
    if (result.status >= 300 || !authId) throw Error('Authorization failed. Stop and inspect log.');
    auths.push(authId);
  }
  const capture = (step, authId, value, headers) => call(step, `/v2/payments/authorizations/${authId}/capture`, { amount: { currency_code: 'USD', value }, final_capture: false, invoice_id: randomUUID() }, headers);
  for (const [step, value] of [['first capture', '1.00'], ['second capture', '1.00']]) { const r = await capture(step, auths[0], value); if (r.status >= 300 || r.body?.status !== 'COMPLETED') throw Error(`${step} did not complete`); }
  await capture('remaining plus one cent', auths[0], '18.01');
  await capture('115 percent boundary', auths[1], '23.00');
  for (const code of ['INSTRUMENT_DECLINED', 'DUPLICATE_INVOICE_ID', 'INTERNAL_SERVER_ERROR']) await capture(`mock ${code}`, auths[2], '1.00', { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: code }) });
  const voided = await call('void', `/v2/payments/authorizations/${auths[2]}/void`);
  if (voided.status >= 300) throw Error('Void failed; capture after void skipped');
  await capture('capture after void', auths[2], '1.00');
  console.log('Measured responses recorded in evidence/live-spike.jsonl.');
}
