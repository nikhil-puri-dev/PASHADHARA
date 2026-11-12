import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/index.ts';

test('the default entry serves liveness without opening a database connection', async () => {
  const response = await app.request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await app.request('/health')).status, 404);
  const contract = await (await app.request('/api/openapi.json')).json() as {
    servers: { url: string }[]; paths: Record<string, unknown>;
  };
  assert.deepEqual(contract.servers, [{ url: '/api' }]);
  assert.deepEqual(contract.paths, {});
});
