import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { issueToken } from '../src/auth.ts';
import app from '../src/index.ts';

const databaseUrl = 'postgres://kernel_login@127.0.0.1:15434/postgres';
const leaseSecret = 'fixture-only-lease-signing-secret';
const adminKey = 'fixture-only-admin-key'.padEnd(32, 'x');
const webhookId = 'fixture-only-webhook';
const wire = (event: unknown) => JSON.stringify(event, null, 2);
const sign = (body: string) => createHmac('sha256', 'fixture-webhook-signature').update(body).digest('hex');
const money = (value: string) => ({ currency_code: 'USD', value });

test('production entry serves sandbox approval, scoped auth and durable signed webhook reconciliation', async t => {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, LEASE_TOKEN_SECRET: leaseSecret, ADMIN_KEY: adminKey,
    API_BASE_URL: 'https://api.fixture.test/api', PAYPAL_WEBHOOK_ID: webhookId,
    PAYPAL_CLIENT_ID: 'fixture-client', PAYPAL_CLIENT_SECRET: 'fixture-secret',
  });
  const db = new kernel.Database(databaseUrl);
  t.after(() => db.end());
  const orders = new Map<string, Record<string, any>>();
  const captures = new Map<string, Record<string, any>>();
  let authorizes = 0;
  let orderReads = 0;
  let captureReads = 0;
  let failCaptureRead = false;
  let loseApproval = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api-m.sandbox.paypal.com');
    const body = init.body ? (target.pathname.endsWith('/token') ? null : JSON.parse(String(init.body))) : null;
    if (target.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'fixture', expires_in: 300 });
    if (target.pathname === '/v2/checkout/orders') {
      const id = randomUUID();
      const order = { id, intent: body.intent, status: 'PAYER_ACTION_REQUIRED', purchase_units: body.purchase_units,
        links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
        urls: body.payment_source.paypal.experience_context };
      orders.set(id, order);
      return Response.json(order, { status: 201 });
    }
    if (target.pathname.startsWith('/v2/checkout/orders/')) {
      const order = orders.get(target.pathname.split('/')[4]!)!;
      assert.ok(order);
      if (init.method === 'GET') { orderReads++; return Response.json(order); }
      assert.equal(order.status, 'APPROVED');
      authorizes++;
      const created = Date.now() - 1000;
      order.status = 'COMPLETED';
      order.purchase_units[0].payments = { authorizations: [{
        id: randomUUID(), status: 'CREATED', amount: order.purchase_units[0].amount,
        create_time: new Date(created).toISOString(), expiration_time: new Date(created + 29 * 86400000).toISOString(),
      }] };
      if (loseApproval) throw new Error('fixture lost response after PayPal authorized');
      return Response.json(order, { status: 201 });
    }
    if (target.pathname === '/v1/notifications/verify-webhook-signature') {
      assert.equal(body.webhook_id, webhookId);
      const original = String(init.body).match(/,"webhook_event":([\s\S]*)}$/)?.[1];
      assert.ok(original);
      return Response.json({ verification_status: body.transmission_sig === sign(original) ? 'SUCCESS' : 'FAILURE' });
    }
    if (target.pathname.startsWith('/v2/payments/captures/')) {
      captureReads++;
      if (failCaptureRead) { failCaptureRead = false; throw new Error('fixture temporary GET failure'); }
      return Response.json(captures.get(target.pathname.split('/').at(-1)!));
    }
    assert.fail(`Unexpected fixture URL ${target.pathname}`);
  });

  const post = (path: string, body: unknown, token?: string) => app.request(path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const create = async () => {
    const response = await post('/api/v1/leases', { buyer_ref: 'fixture', cap_minor: 2000, unsettled_limit_minor: 500 });
    assert.equal(response.status, 201);
    return await response.json() as { lease_id: string; lease_token: string; paypal_order_id: string; approve_url: string };
  };
  const first = await create();
  const second = await create();
  const order = orders.get(first.paypal_order_id)!;
  const otherOrder = orders.get(second.paypal_order_id)!;
  const returned = new URL(order.urls.return_url);
  const cancelled = new URL(order.urls.cancel_url);
  assert.equal(returned.origin + returned.pathname, `https://api.fixture.test/api/paypal/return/${first.lease_id}`);
  assert.equal(cancelled.origin + cancelled.pathname, `https://api.fixture.test/api/paypal/cancel/${first.lease_id}`);
  assert.match(returned.searchParams.get('sig') ?? '', /^[\w-]{43}$/);
  assert.match(cancelled.searchParams.get('sig') ?? '', /^[\w-]{43}$/);
  const redirect = async (url: string | URL) => {
    const response = await app.request(url);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(await response.text(), '');
  };
  const forged = new URL(returned);
  forged.searchParams.set('sig', cancelled.searchParams.get('sig')!);
  assert.equal((await app.request(forged)).status, 400);
  forged.search = returned.search;
  forged.pathname = forged.pathname.replace(first.lease_id, second.lease_id);
  assert.equal((await app.request(forged)).status, 400);
  assert.equal((await app.request(returned, { method: 'HEAD' })).status, 405);
  await redirect(cancelled);
  assert.equal(orderReads, 0);
  assert.equal(authorizes, 0);
  const createdAt = await db.transaction(null, async tx => (await tx.query<{ created_at: Date; state: string }>(
    'select created_at,state from public.leases where id=$1', [first.lease_id],
  )).rows[0]!);
  assert.equal(createdAt.state, 'pending_approval');
  const { exp } = JSON.parse(Buffer.from(first.lease_token.split('.')[0]!, 'base64url').toString());
  assert.equal(exp, Math.floor(createdAt.created_at.getTime() / 1000) + 29 * 86400);
  await redirect(returned);
  const journal = (lease: string, token: string) => app.request(`/api/v1/leases/${lease}/journal`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await journal(first.lease_id, first.lease_token)).status, 200);
  assert.equal((await journal(second.lease_id, first.lease_token)).status, 401);
  assert.equal((await journal(first.lease_id, first.lease_token + 'x')).status, 401);
  assert.equal((await journal(first.lease_id, issueToken(leaseSecret, 'lease', first.lease_id, 1))).status, 401);
  assert.equal((await app.request('/api/v1/tools/fixture-tool/call', {
    method: 'POST',
    headers: { authorization: `Bearer ${first.lease_token}`, 'X-Pashadhara-Lease': second.lease_id, 'Idempotency-Key': 'fixture' },
  })).status, 401);
  const invoke = async (token: string) => {
    const hash = createHash('sha256').update('summarise\0fixture').digest('hex');
    const response = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'summarise', arguments: { text: 'fixture', idempotency_key: `${randomUUID()}:${hash}` },
      } }),
    });
    assert.equal(response.status, 200);
    return JSON.stringify(await response.json());
  };
  // No model key in this test environment, so the gateway refuses before any charge or provider call.
  assert.match(await invoke(first.lease_token), /tool_unavailable/);
  assert.match(await invoke(first.lease_token + 'x'), /valid lease token is required/);
  const sellerPath = '/api/v1/sellers';
  const sellerBody = { name: 'Fixture', paypal_email: 'fixture@example.test' };
  assert.equal((await post(sellerPath, sellerBody, adminKey + 'x')).status, 401);
  const created = await post(sellerPath, sellerBody, adminKey);
  assert.equal(created.status, 201);
  const seller = await created.json() as { id: string; seller_key: string };
  assert.equal((await post(sellerPath, sellerBody, seller.seller_key)).status, 401);
  const toolPath = (sellerId: string) => `/api/v1/sellers/${sellerId}/tools`;
  const toolBody = { id: 'fixture-tool', name: 'Fixture', price_minor: 100 };
  assert.equal((await post(toolPath(randomUUID()), toolBody, seller.seller_key)).status, 401);
  assert.equal((await post(toolPath(seller.id), { ...toolBody, seller_id: randomUUID() }, seller.seller_key)).status, 401);

  otherOrder.status = 'APPROVED';
  const spoofedOrder = new URL(returned);
  spoofedOrder.searchParams.set('token', otherOrder.id);
  await redirect(spoofedOrder);
  assert.equal(authorizes, 0);
  order.status = 'APPROVED';
  loseApproval = true;
  await redirect(returned);
  assert.equal(await db.transaction(null, async tx => (await tx.query(
    "select state from public.paypal_calls where lease_id=$1 and op='authorize'", [first.lease_id],
  )).rows[0]?.state), 'unknown');
  await redirect(returned);
  await redirect(returned);
  assert.equal(authorizes, 1);
  assert.equal(((await (await journal(first.lease_id, first.lease_token)).json()) as { entries: unknown[] }).entries.length, 2);
  const authorized = await app.request(`/api/v1/leases/${first.lease_id}/authorize`, {
    method: 'POST', headers: { authorization: `Bearer ${first.lease_token}` },
  });
  assert.equal(authorized.status, 200);
  const lease = await authorized.json() as { state: string; balances: { hold_available: number } };
  assert.equal(lease.state, 'active');
  assert.equal(lease.balances.hold_available, 2000);
  assert.equal(authorizes, 1);

  const auth = await db.transaction(null, async tx => (await tx.query<{ id: string }>(
    'select id from public.authorizations where lease_id=$1', [first.lease_id],
  )).rows[0]!);
  const tool = randomUUID();
  await db.transaction(null, tx => tx.query("insert into public.tools(id,seller_id,name,price_minor) values ($1,$2,'Fixture',100)", [tool, seller.id]));
  const usage = await kernel.commitUsage(db, first.lease_id, { kind: 'tool', tool_id: tool, idempotency_key: randomUUID() });
  const capture = await kernel.beginCapture(db, first.lease_id, { authorization_id: auth.id, allocations: [{ ref_id: usage.id!, amount_minor: 100n }] });
  await kernel.markCallSent(db, first.lease_id, capture.call_id);
  await kernel.markUnknown(db, first.lease_id, capture.call_id);
  const captureId = randomUUID();
  const read = { id: captureId, invoice_id: capture.invoice_id, status: 'COMPLETED', amount: money('1.00'),
    seller_receivable_breakdown: { paypal_fee: money('0.52') } };
  captures.set(captureId, read);
  const event = { id: randomUUID(), event_type: 'PAYMENT.CAPTURE.PENDING', resource: { id: captureId, status: 'DENIED' } };
  const send = (item = event, signature = sign(wire(item))) => app.request('/api/webhooks/paypal', { method: 'POST', body: wire(item), headers: {
    'content-type': 'application/json', 'paypal-auth-algo': 'fixture-hmac-sha256',
    'paypal-cert-url': 'https://fixture.invalid/cert', 'paypal-transmission-id': 'fixture-transmission',
    'paypal-transmission-time': '2026-11-09T00:00:00Z', 'paypal-transmission-sig': signature,
  } });
  assert.equal((await app.request('/api/webhooks/paypal', {
    method: 'POST', body: wire(event), headers: { 'content-type': 'application/json' },
  })).status, 400);
  const unsignedRows = await db.transaction(null, tx => tx.query('select 1 from public.webhook_events where id=$1', [event.id]));
  assert.equal(unsignedRows.rowCount, 0);
  assert.equal((await send({ ...event, resource: { id: randomUUID(), status: 'DENIED' } }, sign(wire(event)))).status, 400);
  assert.equal(captureReads, 0);
  failCaptureRead = true;
  assert.equal((await send()).status, 500);
  captures.set(captureId, { ...read, seller_receivable_breakdown: { paypal_fee: money('2.00') } });
  assert.equal((await send()).status, 500);
  await db.transaction(null, async tx => {
    const unresolved = (await tx.query(`select c.state,e.processed_at from public.paypal_calls c
      cross join public.webhook_events e where c.id=$1 and e.id=$2 and e.signature_verified`, [capture.call_id, event.id])).rows[0];
    assert.deepEqual(unresolved, { state: 'unknown', processed_at: null });
  });
  captures.set(captureId, read);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(captureReads, 3);
  await db.transaction(null, async tx => {
    const stored = (await tx.query('select signature_verified, deliveries, processed_at, resource from public.webhook_events where id=$1 order by signature_verified', [event.id])).rows;
    assert.deepEqual(stored.map(row => [row.signature_verified, row.deliveries, Boolean(row.processed_at)]), [[false, 1, false], [true, 4, true]]);
    assert.equal(stored[0]!.resource, null);
    assert.deepEqual(stored[1]!.resource, event.resource);
    const call = (await tx.query('select state,response from public.paypal_calls where id=$1', [capture.call_id])).rows[0];
    assert.deepEqual(call, { state: 'succeeded', response: read });
    const lines = await tx.query("select amount_minor from public.ledger_entries where ref_type='capture' and ref_id=$1 order by amount_minor", [capture.capture_id]);
    assert.deepEqual(lines.rows.map(row => row.amount_minor), ['52', '52', '100', '100']);
  });
});
