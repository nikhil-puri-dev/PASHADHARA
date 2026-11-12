import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { parse } from 'yaml';

test('the built Vercel API serves requests without node_modules', async t => {
  const config = JSON.parse(await readFile(new URL('../../../vercel.json', import.meta.url), 'utf8'));
  const api = config.services.api;
  assert.equal(api.root, 'apps/api');
  assert.equal(api.framework, 'hono');
  assert.deepEqual(config.services.web, { root: 'apps/web', framework: 'nextjs' });
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: { service: 'api' } },
    { source: '/(.*)', destination: { service: 'web' } },
  ]);
  const contract = parse(await readFile(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8'));
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'pashadhara-api-'));
  const originalCwd = process.cwd();
  t.after(async () => {
    process.chdir(originalCwd);
    await rm(scratch, { recursive: true, force: true });
  });
  for (let dir = scratch; ; dir = dirname(dir)) {
    assert.ok(!existsSync(join(dir, 'node_modules')), `node_modules found at ${dir}`);
    if (dir === dirname(dir)) break;
  }
  await cp(new URL(`../${api.outputDirectory}/`, import.meta.url), scratch, { recursive: true });
  assert.ok(!existsSync(join(scratch, 'node_modules')), 'The build output contains node_modules');
  process.chdir(scratch);
  const database = process.env.GATEWAY_TEST_DATABASE ?? 'postgres';
  if (!/^(postgres|live_[a-z0-9_]+)$/.test(database)) throw new Error('Invalid throwaway database name');
  Object.assign(process.env, {
    NODE_ENV: 'production', DATABASE_URL: `postgres://kernel_login@127.0.0.1:15434/${database}`,
    LEASE_TOKEN_SECRET: 'fixture-lease'.padEnd(32, 'x'), ADMIN_KEY: 'fixture-admin'.padEnd(32, 'x'),
    PAYPAL_CLIENT_ID: 'fixture-client', PAYPAL_CLIENT_SECRET: 'fixture-secret', PAYPAL_WEBHOOK_ID: '',
    API_BASE_URL: 'https://site.fixture.test/api',
  });
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => {
    assert.equal(new URL(input).hostname, '127.0.0.1', 'This fixture cannot contact PayPal');
    return fetchLocal(input, init);
  });
  const { default: app } = await import(pathToFileURL(join(scratch, 'index.mjs')).href);
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(origin + '/health')).status, 404);
  const spec = await fetch(origin + '/api/openapi.json');
  assert.equal(spec.status, 200);
  const served = await spec.json() as typeof contract;
  assert.deepEqual(served.servers, [{ url: '/api' }]);
  const expected = new Set(['listLeases', 'createLease', 'getLease', 'authorizeLease', 'recoverPayouts',
    'settleLease', 'reauthorizeLease', 'closeLease', 'getJournal', 'listTools', 'createJob', 'getJob',
    'deliverJob', 'createSeller', 'reconcileLease']);
  for (const [path, methods] of Object.entries(served.paths as Record<string, Record<string, { operationId: string }>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(expected.delete(operation.operationId), operation.operationId);
      assert.deepEqual(operation, contract.paths[path][method]);
      const response = await fetch(origin + '/api' + path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000001'), { method });
      assert.ok((operation.operationId === 'listTools' ? [200] : [400, 401]).includes(response.status), `${operation.operationId}: ${response.status}`);
    }
  }
  assert.equal(expected.size, 0);
  const unauthorized = await fetch(origin + '/api/v1/leases');
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal((await fetch(origin + '/api')).status, 404);
  assert.equal((await fetch(origin + '/api/webhooks/paypal', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'paypal-auth-algo': 'fixture', 'paypal-cert-url': 'fixture',
      'paypal-transmission-id': 'fixture', 'paypal-transmission-sig': 'fixture', 'paypal-transmission-time': 'fixture',
    },
    body: JSON.stringify({ id: 'fixture', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'capture' } }),
  })).status, 404);
});
