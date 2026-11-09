import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createRoutes, type Contract } from '../src/routes.ts';

const contract = parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8')) as Contract;
const uuid = '11111111-1111-4111-8111-111111111111';
function sample(input: any): any {
  if (input.$ref) return sample(input.$ref.split('/').slice(1).reduce((a: any, k: string) => a[k], contract));
  if (input.oneOf) return sample(input.oneOf[0]);
  if (input.enum) return input.enum[0];
  const type = Array.isArray(input.type) ? input.type[0] : input.type;
  if (type === 'object') return Object.fromEntries((input.required ?? []).map((key: string) => [key, sample(input.properties[key])]));
  if (type === 'array') return [];
  if (type === 'integer' || type === 'number') return input.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (input.format === 'uuid') return uuid;
  if (input.format === 'date-time') return '2026-11-07T00:00:00Z';
  if (input.format === 'email') return 'seller@example.com';
  if (input.format === 'uri') return 'https://example.com/';
  return 'fixture';
}

for (const [path, methods] of Object.entries(contract.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!operation.operationId) continue;
    test(`contract fixture: ${operation.operationId}`, async () => {
      const status = Object.keys(operation.responses).find(x => x.startsWith('2'))!;
      const response = operation.responses[status];
      const content = response.content ?? {};
      const media = Object.keys(content)[0];
      const handlers = { [operation.operationId]: async () => ({ status: Number(status), ...(media && media !== 'text/event-stream' ? { body: sample(content[media].schema) } : {}) }) };
      const app = createRoutes(contract, handlers, async () => ({ fixture: true }));
      const requestBody = operation.requestBody?.required ? sample(operation.requestBody.content['application/json'].schema) : undefined;
      const url = `http://localhost${path.replace(/\{[^}]+\}/g, uuid)}`;
      const responseActual = await app.request(url, { method: method.toUpperCase(), headers: { 'content-type': 'application/json', 'X-Pashadhara-Lease': uuid, 'Idempotency-Key': 'fixture' }, ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }) });
      assert.equal(responseActual.status, media === 'text/event-stream' ? 503 : Number(status));
    });
  }
}

test('invalid request is rejected before a handler runs', async () => {
  let called = false;
  const app = createRoutes(contract, { createLease: async () => { called = true; return { status: 201, body: {} }; } }, async () => ({}));
  const response = await app.request('http://localhost/v1/leases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_ref: 'fixture', cap_minor: 0 }) });
  assert.equal(response.status, 400); assert.equal(called, false);
});

test('invalid handler response is rejected', async () => {
  const app = createRoutes(contract, { listTools: async () => ({ status: 200, body: { tools: [{}] } }) }, async () => ({}));
  const response = await app.request('http://localhost/v1/tools');
  assert.equal(response.status, 500);
});

test('protected routes fail closed without an authenticated principal', async () => {
  const app = createRoutes(contract, {}, async () => null);
  assert.equal((await app.request(`http://localhost/v1/leases/${uuid}`)).status, 401);
});
