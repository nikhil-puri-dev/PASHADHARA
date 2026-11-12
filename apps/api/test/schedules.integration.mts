import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/index.ts';

// Throwaway Postgres 15434 only. PayPal is configured with fixtures and any outbound fetch fails the test.
const database = process.env.GATEWAY_TEST_DATABASE ?? 'postgres';
if (!/^(postgres|live_[a-z0-9_]+)$/.test(database)) throw new Error('Invalid throwaway database name');
const adminKey = 'fixture-only-admin-key'.padEnd(32, 'x');
const cronSecret = 'fixture-only-cron-secret-0123456789';

test('vercel schedules: db liveness leaks only status, and the sweep is inert until CRON_SECRET is set', async t => {
  Object.assign(process.env, {
    DATABASE_URL: `postgres://kernel_login@127.0.0.1:15434/${database}`, LEASE_TOKEN_SECRET: 'fixture-lease'.padEnd(32, 'x'),
    ADMIN_KEY: adminKey, API_BASE_URL: 'https://api.fixture.test/api', AI_ENABLED: 'false',
    PAYPAL_CLIENT_ID: 'fixture-client', PAYPAL_CLIENT_SECRET: 'fixture-secret',
  });
  delete process.env.CRON_SECRET;
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No outbound request is allowed'));

  const live = await app.request('/api/health/db');
  assert.equal(live.status, 200);
  const liveBody = await live.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(liveBody).sort(), ['database', 'read_at', 'status']);
  assert.equal(liveBody.status, 'ok');
  assert.ok(Number.isFinite(Date.parse(String(liveBody.read_at))));

  const sweep = (authorization?: string) => app.request('/api/internal/settlement/sweep', {
    method: 'POST', headers: authorization === undefined ? {} : { authorization },
  });
  // CRON_SECRET unset: Vercel sends no Authorization header, and no guessable header may pass.
  for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Bearer undefined', 'Bearer null', `Bearer ${cronSecret}`]) {
    assert.equal((await sweep(header)).status, 401, `unset secret, header ${JSON.stringify(header)}`);
  }
  // A secret shorter than 16 characters never authorizes, even when sent exactly.
  process.env.CRON_SECRET = 'short-secret';
  assert.equal((await sweep('Bearer short-secret')).status, 401);
  process.env.CRON_SECRET = cronSecret;
  assert.equal((await sweep('Bearer wrong')).status, 401);
  assert.equal((await sweep(cronSecret)).status, 401, 'The Bearer scheme is required');
  const authorized = await sweep(`Bearer ${cronSecret}`);
  assert.equal(authorized.status, 200);
  assert.equal(((await authorized.json()) as { provenance: string }).provenance, 'computed');
  // The admin bearer keeps working for manual sweeps.
  assert.equal((await sweep(`Bearer ${adminKey}`)).status, 200);
  delete process.env.CRON_SECRET;
  assert.equal((await sweep(`Bearer ${cronSecret}`)).status, 401);
});
