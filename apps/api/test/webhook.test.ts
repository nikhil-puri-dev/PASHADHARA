import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveWebhook } from '../src/webhook.ts';
const headers = new Headers(Object.fromEntries(['paypal-auth-algo','paypal-cert-url','paypal-transmission-id','paypal-transmission-sig','paypal-transmission-time'].map(x => [x,'fixture'])));
test('fixture: verified delivery reconciles fetched state and duplicates do not reprocess', async () => {
  let claimed = false, deliveries = 0, reads = 0, reconciled: unknown;
  const kernel = { async recordWebhook(_id: string, event: unknown) { deliveries++; return event; }, async claimWebhook() { if (reconciled) return 'processed' as const; if (claimed) return 'busy' as const; claimed = true; return 'claimed' as const; }, async reconcileWebhook(_id: string, _resource: unknown, response: unknown) { reconciled = response; }, async releaseWebhook() { claimed = false; } };
  const paypal = { async verifyWebhookSignature() { return { body: { verification_status: 'SUCCESS' } }; }, async getCapture() { reads++; return { body: { status: 'fixture authoritative GET' } }; }, async getAuthorization() { throw Error('unexpected'); } };
  const event = { id:'fixture-id', event_type:'PAYMENT.CAPTURE.COMPLETED', resource:{ id:'fixture-capture', status:'untrusted payload' } };
  assert.equal(await receiveWebhook(event, headers, 'fixture', paypal, kernel, 'fixture'), 'processed');
  assert.equal(await receiveWebhook(event, headers, 'fixture', paypal, kernel, 'fixture'), 'duplicate');
  assert.equal(deliveries, 2); assert.equal(reads, 1); assert.deepEqual(reconciled, { status: 'fixture authoritative GET' });
});
test('fixture: failed signature stores only event metadata and is never read or processed', async () => {
  let stored = true;
  const kernel = { async recordWebhook(_id: string, event: unknown, verified: boolean) { stored = verified; assert.deepEqual(event, { event_type: 'PAYMENT.CAPTURE.COMPLETED' }); }, async claimWebhook() { throw Error('unexpected'); }, async reconcileWebhook() { throw Error('unexpected'); }, async releaseWebhook() {} };
  const paypal = { async verifyWebhookSignature() { return { body: { verification_status: 'FAILURE' } }; }, async getCapture() { throw Error('unexpected'); }, async getAuthorization() { throw Error('unexpected'); } };
  assert.equal(await receiveWebhook({ id:'fixture', event_type:'PAYMENT.CAPTURE.COMPLETED', resource: { id:'fixture' } }, headers, 'fixture', paypal, kernel, 'fixture'), 'unverified'); assert.equal(stored, false);
});

test('fixture: forged delivery cannot block a verified delivery with the same id', async () => {
  const rows = new Map<string, number>(); let reads = 0;
  const kernel = { async recordWebhook(id: string, _event: unknown, verified: boolean) { const key = `${id}:${verified}`; rows.set(key, (rows.get(key) ?? 0) + 1); return _event; }, async claimWebhook() { return 'claimed' as const; }, async reconcileWebhook() {}, async releaseWebhook() {} };
  const paypal = { async verifyWebhookSignature(payload: { transmission_sig: string }) { return { body: { verification_status: payload.transmission_sig === 'forged' ? 'FAILURE' : 'SUCCESS' } }; }, async getCapture() { reads++; return { body: {} }; }, async getAuthorization() { throw Error('unexpected'); } };
  const event = { id: 'same', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'capture' } };
  const forged = new Headers(headers);
  forged.set('paypal-transmission-sig', 'forged');
  assert.equal(await receiveWebhook(event, forged, 'fixture', paypal, kernel, 'fixture'), 'unverified');
  assert.equal(await receiveWebhook(event, headers, 'fixture', paypal, kernel, 'fixture'), 'processed');
  assert.equal(rows.get('same:false'), 1); assert.equal(rows.get('same:true'), 1); assert.equal(reads, 1);
});

test('fixture: verified duplicate uses canonical stored resource', async () => {
  let fetched = '';
  const canonical = { id: 'same', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'stored' } };
  const kernel = { async recordWebhook() { return canonical; }, async claimWebhook() { return 'claimed' as const; }, async reconcileWebhook() {}, async releaseWebhook() {} };
  const paypal = { async verifyWebhookSignature() { return { body: { verification_status: 'SUCCESS' } }; }, async getCapture(id: string) { fetched = id; return { body: {} }; }, async getAuthorization() { throw Error('unexpected'); } };
  await receiveWebhook({ ...canonical, resource: { id: 'incoming' } }, headers, 'fixture', paypal, kernel, 'fixture');
  assert.equal(fetched, 'stored');
});
test('fixture: missing webhook configuration is retryable', async () => {
  let called = false;
  const kernel = { async recordWebhook() { called = true; }, async claimWebhook() { return 'processed' as const; }, async reconcileWebhook() {}, async releaseWebhook() {} };
  await assert.rejects(() => receiveWebhook({ id: 'x', event_type: 'x' }, headers, '', {} as never, kernel, 'fixture'), /configuration/);
  assert.equal(called, false);
});
