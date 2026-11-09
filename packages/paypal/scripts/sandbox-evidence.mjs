import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const out = 'evidence/sandbox-reads.jsonl';
const env = process.env;
const safe = value => JSON.parse(JSON.stringify(value).replaceAll(env.BUYER_EMAIL || '\u0000', '[redacted buyer email]').replaceAll(env.PAYPAL_CLIENT_ID || '\u0000', '[redacted client id]').replaceAll(env.PAYPAL_CLIENT_SECRET || '\u0000', '[redacted client secret]'));
const log = record => appendFileSync(out, JSON.stringify(safe({ label: 'measured', at: new Date().toISOString(), ...record })) + '\n');
const base = 'https://api-m.sandbox.paypal.com';
let token;
try {
  const r = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000) });
  const body = await r.json(); token = body.access_token; if (token) body.access_token = '[redacted access token]';
  log({ operation: 'oauth', status: r.status, body });
  if (!r.ok || !token) throw Error('OAuth failed');
  async function call(operation, method, path, data, requestId = randomUUID()) {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', 'PayPal-Request-Id': requestId }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000) });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    log({ operation, status: r.status, body }); return { status: r.status, body };
  }
  const sentinels = JSON.parse(readFileSync('evidence/sentinels.json'));
  for (const entry of Object.values(sentinels)) await call('sentinel GET', 'GET', `/v2/payments/authorizations/${encodeURIComponent(entry.authorization_id)}`);
  async function poll(batch) { const until = Date.now() + 120000; do { const result = await call('payout GET', 'GET', `/v1/payments/payouts/${encodeURIComponent(batch)}`); if (result.body?.batch_header?.batch_status === 'SUCCESS' || result.status >= 400) break; await new Promise(r => setTimeout(r, 10000)); } while (Date.now() < until); }
  await poll('EWN23HN7964XJ');
  if (!env.BUYER_EMAIL) throw Error('BUYER_EMAIL missing');
  if (existsSync(out) && /new sandbox payout|payout intent/.test(readFileSync(out, 'utf8'))) throw Error('Payout previously attempted. Reconcile it before any new payout.');
  const request = randomUUID();
  log({ operation: 'payout intent', request_id: request });
  const result = await call('new sandbox payout', 'POST', '/v1/payments/payouts', { sender_batch_header: { sender_batch_id: request, email_subject: 'Sandbox payout' }, items: [{ recipient_type: 'EMAIL', amount: { value: '1.00', currency: 'USD' }, receiver: env.BUYER_EMAIL, sender_item_id: request }] }, request);
  if (result.body?.batch_header?.payout_batch_id) await poll(result.body.batch_header.payout_batch_id);
} catch (error) { log({ operation: 'failure', error: String(error), cause: String(error.cause || '') }); console.error('Sandbox call failed; see evidence, no credentials printed.'); process.exitCode = 1; }
