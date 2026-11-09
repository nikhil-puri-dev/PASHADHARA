import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { getRequestListener } from '@hono/node-server';

test('Vercel Services selects the prefixed API and its Hono bundle runs in production mode', async t => {
  const config = JSON.parse(await readFile(new URL('../../../vercel.json', import.meta.url), 'utf8'));
  const api = config.services.api;
  assert.equal(api.root, 'apps/api');
  assert.equal(api.framework, 'hono');
  assert.deepEqual(config.services.web, { root: 'apps/web', framework: 'nextjs' });
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: { service: 'api' } },
    { source: '/(.*)', destination: { service: 'web' } },
  ]);
  const handler = `${api.outputDirectory}/index.mjs`;
  const packagedContract = new URL(`../${api.functions[handler].includeFiles}`, import.meta.url);
  assert.deepEqual(await readFile(packagedContract),
    await readFile(new URL('../../../packages/contract/openapi.yaml', import.meta.url)));
  Object.assign(process.env, {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://kernel_login@127.0.0.1:15434/postgres',
    LEASE_TOKEN_SECRET: 'fixture-lease'.padEnd(32, 'x'), ADMIN_KEY: 'fixture-admin'.padEnd(32, 'x'),
    PAYPAL_CLIENT_ID: 'fixture-client', PAYPAL_CLIENT_SECRET: 'fixture-secret', PAYPAL_WEBHOOK_ID: '',
    API_BASE_URL: 'https://site.fixture.test/api',
  });
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => {
    assert.equal(new URL(input).hostname, '127.0.0.1', 'This fixture cannot contact PayPal');
    return fetchLocal(input, init);
  });
  const { default: app } = await import(new URL(`../${handler}`, import.meta.url).href);
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  assert.equal((await fetch(origin + '/health')).status, 404);
  const unauthorized = await fetch(origin + '/api/v1/leases');
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal((await fetch(origin + '/api')).status, 404);
  const spec = await (await fetch(origin + '/api/openapi.json')).json() as { servers: { url: string }[] };
  assert.deepEqual(spec.servers, [{ url: '/api' }]);
  assert.equal((await fetch(origin + '/api/webhooks/paypal', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'paypal-auth-algo': 'fixture', 'paypal-cert-url': 'fixture',
      'paypal-transmission-id': 'fixture', 'paypal-transmission-sig': 'fixture', 'paypal-transmission-time': 'fixture',
    },
    body: JSON.stringify({ id: 'fixture', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'capture' } }),
  })).status, 503);
});
