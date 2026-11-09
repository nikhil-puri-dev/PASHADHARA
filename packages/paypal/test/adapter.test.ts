import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, PayPalError, PayPalUnknownError } from '../src/index.ts';
const fixtureToken = { access_token: 'fixture-token', expires_in: 3600 };
test('fixture: cache token and preserve raw capture fields and request headers', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => { const url = String(input); calls.push({ url, init }); return Response.json(url.endsWith('/token') ? fixtureToken : { id: 'fixture-capture', amount: { value: '1.00' }, seller_receivable_breakdown: { paypal_fee: { value: '0.52' } } }); };
  const client = new PayPalClient('fixture', 'fixture', fetcher);
  const result = await client.capture('auth', { currency_code: 'USD', value: '1.00' }, 'invoice', 'request');
  await client.getCapture('capture');
  assert.equal(calls.length, 3); assert.equal((calls[1].init?.headers as Record<string,string>)['PayPal-Request-Id'], 'request');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { amount: { currency_code: 'USD', value: '1.00' }, final_capture: false, invoice_id: 'invoice' });
  assert.equal((result.body as any).seller_receivable_breakdown.paypal_fee.value, '0.52');
  assert.throws(() => client.capture('auth', { currency_code: 'USD', value: '1.001' }, 'invoice', 'request'), TypeError);
});
test('fixture: typed PayPal errors retain issue and body', async () => {
  const fetcher: typeof fetch = async input => String(input).endsWith('/token') ? Response.json(fixtureToken) : Response.json({ details: [{ issue: 'AUTHORIZATION_VOIDED' }] }, { status: 422 });
  await assert.rejects(new PayPalClient('fixture','fixture',fetcher).authorize('order','request'), (e: unknown) => e instanceof PayPalError && e.status === 422 && e.issues[0] === 'AUTHORIZATION_VOIDED');
});
test('fixture: transport failure is unknown', async () => {
  const fetcher: typeof fetch = async input => { if (String(input).endsWith('/token')) return Response.json(fixtureToken); throw Error('fixture timeout'); };
  await assert.rejects(new PayPalClient('fixture','fixture',fetcher).void('auth','request'), PayPalUnknownError);
});

test('fixture: server failure is an unknown outcome', async () => {
  const fetcher: typeof fetch = async input => String(input).endsWith('/token') ? Response.json(fixtureToken) : Response.json({ name: 'fixture' }, { status: 500 });
  await assert.rejects(new PayPalClient('fixture', 'fixture', fetcher).void('auth', 'request'), PayPalUnknownError);
});

test('fixture: response body failure after mutation has unknown outcome', async () => {
  const fetcher: typeof fetch = async input => String(input).endsWith('/token') ? Response.json(fixtureToken) : new Response(new ReadableStream({ start(controller) { controller.error(Error('fixture interrupted body')); } }), { status: 201 });
  await assert.rejects(new PayPalClient('fixture', 'fixture', fetcher).void('auth', 'request'), PayPalUnknownError);
});
