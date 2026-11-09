import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { Database } from '../../../packages/kernel/src/db.ts';
import { createApp } from '../src/app.ts';
import type { Contract } from '../src/routes.ts';

const contract = parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8')) as Contract;
const fixture = { id: 'fixture-event', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'fixture-capture' } };
const sign = (event: unknown) => createHmac('sha256', 'fixture-only-signing-key').update(JSON.stringify(event)).digest('hex');

test('fixture: signed webhook delivery survives a forged copy and reconciles once across repeats', async () => {
  const stored = new Map<boolean, unknown>();
  const deliveries: boolean[] = [];
  let claimed = false;
  let reads = 0;
  let applied = 0;
  let markGetStarted!: () => void;
  let releaseGet!: () => void;
  const getStarted = new Promise<void>(resolve => { markGetStarted = resolve; });
  const finishGet = new Promise<void>(resolve => { releaseGet = resolve; });
  const app = createApp({
    contract,
    db: {} as Database,
    authenticate: async () => null,
    resolveMcpLease: async () => null,
    webhook: {
      webhookId: 'fixture-webhook',
      paypal: {
        async verifyWebhookSignature(payload) {
          assert.equal(payload.webhook_id, 'fixture-webhook');
          return { body: { verification_status: sign(payload.webhook_event) === payload.transmission_sig ? 'SUCCESS' : 'FAILURE' } };
        },
        async getCapture(id) {
          assert.equal(id, 'fixture-capture');
          reads++;
          if (reads === 1) {
            markGetStarted();
            await finishGet;
            throw new Error('fixture transport failure');
          }
          return { body: { id, status: 'COMPLETED' } };
        },
        async getAuthorization() { assert.fail('fixture capture should not read an authorization'); },
      },
      kernel: {
        async recordWebhook(_id, event, verified) {
          deliveries.push(verified);
          if (!stored.has(verified)) stored.set(verified, event);
          return stored.get(verified);
        },
        async claimWebhook() {
          if (applied) return 'processed';
          if (claimed) return 'busy';
          claimed = true;
          return 'claimed';
        },
        async releaseWebhook() { claimed = false; },
        async reconcileWebhook(id, resource, response) {
          assert.equal(id, fixture.id);
          assert.deepEqual(resource, { kind: 'capture', id: 'fixture-capture' });
          assert.deepEqual(response, { id: 'fixture-capture', status: 'COMPLETED' });
          applied++;
        },
      },
    },
  });
  function post(body: unknown, signature: string) {
    return app.request('/webhooks/paypal', { method: 'POST', body: JSON.stringify(body), headers: {
      'content-type': 'application/json', 'paypal-auth-algo': 'fixture-hmac-sha256',
      'paypal-cert-url': 'https://fixture.invalid/cert', 'paypal-transmission-id': 'fixture-transmission',
      'paypal-transmission-time': '2026-11-09T00:00:00Z', 'paypal-transmission-sig': signature,
    } });
  }
  assert.equal((await post({ ...fixture, resource: { id: 'fixture-tampered' } }, sign(fixture))).status, 400);
  assert.equal(reads, 0);
  const first = post(fixture, sign(fixture));
  await getStarted;
  const overlap = await post(fixture, sign(fixture));
  releaseGet();
  assert.equal((await first).status, 500);
  assert.equal(overlap.status, 500);
  assert.equal((await post(fixture, sign(fixture))).status, 200);
  assert.equal((await post(fixture, sign(fixture))).status, 200);
  assert.deepEqual(deliveries, [false, true, true, true, true]);
  assert.equal(reads, 2);
  assert.equal(applied, 1);
});
