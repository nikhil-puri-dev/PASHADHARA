import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/index.ts';

// No database is listening on this port. The probe must fail closed without naming the host, port or driver error.
test('db liveness returns 503 with no detail when Postgres is unreachable', async t => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://kernel_login:fixture-password@127.0.0.1:1/secretdb', LEASE_TOKEN_SECRET: 'fixture-lease'.padEnd(32, 'x'),
    ADMIN_KEY: 'fixture-only-admin-key'.padEnd(32, 'x'), API_BASE_URL: 'https://api.fixture.test/api', AI_ENABLED: 'false',
  });
  delete process.env.PAYPAL_CLIENT_ID;
  t.mock.method(console, 'error', () => {});
  const response = await app.request('/api/health/db');
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.doesNotMatch(text, /ECONNREFUSED|127\.0\.0\.1|secretdb|fixture-password|kernel_login/);
});
