import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { Database } from '../../../packages/kernel/src/db.ts';
import { createApp } from '../src/app.ts';
import { approvalFlow } from '../src/approval.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import entry from '../src/index.ts';
import type { Contract } from '../src/routes.ts';

const contract = parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8')) as Contract;
const lease = '11111111-1111-4111-8111-111111111111';
const secret = 'fixture-secret-for-api-review-tests';
const admin = 'fixture-admin-key-for-review-tests';
const db = {} as Database;
const options = { contract, db, authenticate: async () => null, resolveMcpLease: async () => null };
const json = { 'content-type': 'application/json' };
const event = { id: 'fixture', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'fixture-capture' } };
const paypalHeaders = {
  ...json, 'paypal-auth-algo': 'fixture', 'paypal-cert-url': 'fixture', 'paypal-transmission-id': 'fixture',
  'paypal-transmission-sig': 'fixture', 'paypal-transmission-time': 'fixture',
};

test('1a webhook refuses each missing signature header before storing anything', async () => {
  let stored = 0;
  const app = createApp({ ...options, webhook: {
    webhookId: 'fixture', paypal: { async verifyWebhookSignature() { assert.fail('no verification expected'); },
      async getCapture() { assert.fail(); }, async getAuthorization() { assert.fail(); } },
    kernel: { async recordWebhook() { stored++; }, async claimWebhook() { assert.fail(); },
      async reconcileWebhook() { assert.fail(); }, async releaseWebhook() { assert.fail(); } },
  } });
  for (const name of Object.keys(paypalHeaders).filter(key => key.startsWith('paypal-'))) {
    const headers = new Headers(paypalHeaders);
    headers.delete(name);
    assert.equal((await app.request('/api/webhooks/paypal', { method: 'POST', headers, body: JSON.stringify(event) })).status, 400);
  }
  assert.equal(stored, 0);
});

test('1b webhook and lease creation cap streamed request bytes before JSON parsing', async () => {
  const app = createApp({ ...options, handlers: {
    createLease: async () => assert.fail('oversized lease reached handler'),
    receivePayPalWebhook: async () => assert.fail('oversized webhook reached handler'),
  } });
  for (const path of ['/api/webhooks/paypal', '/api/v1/leases']) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request('http://fixture.test' + path, {
      method: 'POST', headers: { ...paypalHeaders, 'content-length': '1' }, body, duplex: 'half',
    } as RequestInit);
    assert.equal((await app.fetch(request)).status, 413);
  }
});

test('1c buyer_ref above 128 characters is refused before the create handler', async () => {
  const app = createApp({ ...options, handlers: { createLease: async () => assert.fail('long buyer_ref reached handler') } });
  const response = await app.request('/api/v1/leases', {
    method: 'POST', headers: json, body: JSON.stringify({ buyer_ref: 'x'.repeat(129), cap_minor: 100 }),
  });
  assert.equal(response.status, 400);
});

test('2a either short secret blocks the production entry and logs which setting to fix', async t => {
  Object.assign(process.env, { DATABASE_URL: 'postgres://kernel_login@127.0.0.1:15434/postgres' });
  const logged = t.mock.method(console, 'error', () => {});
  for (const name of ['LEASE_TOKEN_SECRET', 'ADMIN_KEY']) {
    Object.assign(process.env, { LEASE_TOKEN_SECRET: secret, ADMIN_KEY: admin, [name]: 'x'.repeat(31) });
    assert.equal((await entry.request('/api/v1/leases')).status, 503);
    assert.match(JSON.stringify(logged.mock.calls.at(-1)?.arguments), new RegExp(name));
  }
  assert.doesNotMatch(JSON.stringify(logged.mock.calls.map(call => call.arguments)), /fixture-secret|fixture-admin|xxxxxxxx/);
});

test('2b a bearer MAC signed with the root secret is refused', async () => {
  const payload = Buffer.from(JSON.stringify({ scope: 'lease', id: lease, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  const request = new Request('https://fixture.test/api/mcp', { headers: { authorization: `Bearer ${payload}.${signature}` } });
  assert.equal(await createAuth(db, secret, admin).resolveMcpLease(request), null);
  for (const scope of ['lease', 'seller'] as const) {
    const [claims, signed] = issueToken(secret, scope, lease).split('.');
    const key = createHmac('sha256', secret).update(`pashadhara/api/v1/${scope}`).digest();
    assert.equal(signed, createHmac('sha256', key).update(claims!).digest('base64url'));
  }
});

test('3 logs handler and auth failures with operation and request id without exception data', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const app = createApp({ ...options, authenticate: async () => { throw new TypeError('private-fixture-token'); },
    handlers: { listTools: async () => { throw new Error('private-fixture-body'); } },
  });
  assert.equal((await app.request('/api/v1/tools')).status, 500);
  assert.equal((await app.request('/api/v1/leases')).status, 503);
  const lines = logged.mock.calls.map(call => JSON.stringify(call.arguments));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /listTools.*[0-9a-f]{8}-[0-9a-f-]{27}.*Error.*message/i);
  assert.match(lines[1]!, /listLeases.*[0-9a-f]{8}-[0-9a-f-]{27}.*TypeError.*message/i);
  assert.doesNotMatch(lines.join(' '), /private-fixture/);
});

test('4 unsigned callbacks cannot query the lease or PayPal', async () => {
  let lookups = 0;
  const database = { async transaction() { lookups++; return { id: lease, state: 'pending_approval', cap_minor: '100', paypal_order_id: 'fixture' }; } } as unknown as Database;
  const gateway = {
    async createOrder() { assert.fail(); }, async authorize() { assert.fail(); },
    async getOrder() { return { status: 200, body: { id: 'fixture', intent: 'AUTHORIZE', status: 'CREATED',
      purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }] } }; },
  };
  const { callbacks } = approvalFlow(database, gateway, 'https://fixture.test/api', secret, async () => assert.fail());
  for (const action of ['return', 'cancel']) {
    assert.equal((await callbacks.request(`/paypal/${action}/${lease}`)).status, 400);
  }
  assert.equal(lookups, 0);
});
