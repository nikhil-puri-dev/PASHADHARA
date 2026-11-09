import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/index.ts';

test('the default entry serves liveness without opening a database connection', async () => {
  const response = await app.request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
