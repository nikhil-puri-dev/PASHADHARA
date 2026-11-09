import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Database } from '../../../packages/kernel/src/db.ts';
import { approvalUrl, evidenceTransport } from '../scripts/sandbox-evidence.ts';
import { awaitApproval, checkOrder } from '../scripts/sandbox-approval.ts';

const order = '9TH015679A190005R';
const lease = '11111111-1111-4111-8111-111111111111';
const intent = { call_id: '22222222-2222-4222-8222-222222222222', request_id: '33333333-3333-4333-8333-333333333333' };
const base = 'https://api-m.sandbox.paypal.com';
const resource = base + '/v2/checkout/orders/' + order;
const approved = { id: order, status: 'APPROVED', intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '20.00' } }] };

function evidence(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-rails-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'evidence.jsonl');
  return { file, rows: () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('budget counts OAuth and refuses a 26th transport call, excluding headers and payer data from evidence', async t => {
  const { file, rows } = evidence(t);
  let dispatched = 0;
  const transport = evidenceTransport(file, async url => {
    dispatched++;
    return Response.json(String(url).includes('oauth2') ? { access_token: 'never-log-token' } : { ...approved, payer: { email_address: 'never-log-email' } });
  }, ['never-log-email', 'never-log-token']);
  await assert.rejects(transport.send(resource, { method: 'GET' }), /unbound/);
  await transport.withIntent(lease, intent, async () => {
    await transport.send(base + '/v1/oauth2/token', { method: 'POST' });
    for (let i = 0; i < 24; i++) await transport.send(resource, { method: 'GET', headers: { authorization: 'never-log-header' } });
    await assert.rejects(transport.send(resource, { method: 'GET' }), /limit/);
  });
  assert.equal(dispatched, 25);
  assert.equal(transport.remaining(), 0);
  assert.equal(rows().filter(row => row.event === 'dispatch').length, 25);
  assert.equal(rows()[3].call_id, intent.call_id);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /never-log/);
});

test('an invalid projected body or unknown provider result locks the transport', async t => {
  const { file, rows } = evidence(t);
  let calls = 0;
  const transport = evidenceTransport(file, async () => {
    calls++;
    return Response.json({ ...approved, purchase_units: [{ amount: { currency_code: 'EUR', value: '20.00' } }] });
  });
  await assert.rejects(transport.withIntent(lease, intent, () => transport.send(resource, { method: 'GET' })), /stopped/);
  await assert.rejects(transport.withIntent(lease, intent, () => transport.send(resource, { method: 'GET' })), /stopped/);
  assert.equal(calls, 1);
  assert.equal(rows()[1].body_rejected, true);
  assert.equal(rows()[1].body, undefined);
});

test('lost transport does not permit a retry', async t => {
  const { file, rows } = evidence(t);
  const transport = evidenceTransport(file, async () => { throw new Error('simulated lost reply'); });
  await assert.rejects(transport.withIntent(lease, intent, () => transport.send(resource, { method: 'GET' })), /lost reply/);
  await assert.rejects(transport.withIntent(lease, intent, () => transport.send(resource, { method: 'GET' })), /stopped/);
  assert.deepEqual(rows().map(row => row.event), ['dispatch', 'transport_stopped']);
});

test('order terms and approval URL are bound to the expected sandbox order', () => {
  assert.equal(checkOrder(approved), 'APPROVED');
  assert.throws(() => checkOrder({ ...approved, intent: 'CAPTURE' }), /intent/);
  assert.throws(() => checkOrder({ ...approved, purchase_units: [{ amount: { currency_code: 'USD', value: '19.99' } }] }), /amount/);
  const href = 'https://www.sandbox.paypal.com/checkoutnow?token=' + order;
  assert.equal(approvalUrl({ links: [{ rel: 'payer-action', href }] }, order), href);
  assert.throws(() => approvalUrl({ links: [{ rel: 'approve', href: href + '&redirect=evil' }] }, order), /verified/);
});

test('approval polling stops on the reserved-call floor and only resumes for APPROVED', async () => {
  let now = 0;
  const wait = async (ms: number) => { now += ms; };
  const times: number[] = [];
  const check = async () => { times.push(now); now += 1_000; return times.length === 2 ? 'APPROVED' : 'CREATED'; };
  assert.equal(await awaitApproval(check, () => times.length < 2, wait, () => now), true);
  assert.deepEqual(times, [15000, 30000]);
  let polls = 0;
  assert.equal(await awaitApproval(async () => { polls++; return 'CREATED'; }, () => polls < 3, wait, () => now), false);
  assert.equal(polls, 3);
});

test('kernel accepts the session pooler host and refuses URL overrides', async () => {
  const url = 'postgresql://kernel_login.aaaaaaaaaaaaaaaaaaaa:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
  await new Database(url).end();
  for (const bad of [url + '?host=evil.test', url + '?port=6543', url + '?user=evil', url.replace(':5432', ':6543'), url.replace('supabase.com', 'example.com')]) {
    assert.throws(() => new Database(bad), /kernel_login/);
  }
});

test('multi-capture proof correlates every GET by id, amount, fee and invoice', async () => {
  const { compareJournal } = await import('../src/compare-journal.ts');
  const auth = { id: 'AUTHORIZATION0001', status: 'PARTIALLY_CAPTURED', amount: { currency_code: 'USD', value: '20.00' } };
  const first = { id: 'CAPTURE0001', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' }, invoice_id: lease, final_capture: false,
    seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '0.52' } } };
  const second = { ...first, id: 'CAPTURE0002', invoice_id: intent.call_id, amount: { currency_code: 'USD', value: '5.00' } };
  const rows = [first, second].map((r, i) => ({
    auth_id: auth.id, auth_status: 'partially_captured', auth_amount: '2000', capture_id: r.id,
    capture_status: 'completed', capture_amount: i ? '500' : '100', fee: '52', invoice_id: r.invoice_id,
  }));
  const db = { transaction: async (_lease: unknown, work: (tx: unknown) => Promise<unknown>) => work({ query: async () => ({ rows }) }) } as unknown as Database;
  assert.ok((await compareJournal(db, lease, auth, [second, first], 'fixture')).every(line => line.match));
  assert.deepEqual((await compareJournal(db, lease, auth, [first, { ...second, invoice_id: first.invoice_id, final_capture: true }], 'fixture'))
    .filter(line => !line.match).map(line => line.field), ['capture[CAPTURE0002].invoice_id', 'capture[CAPTURE0002].final_capture']);
  assert.ok((await compareJournal(db, lease, auth, [first, first], 'fixture')).some(line => !line.match));
  await assert.rejects(compareJournal(db, lease, auth, first, 'fixture'), /Multiple captures/);
});

test('approval resume carries the spent budget and rejects unknown or already approved history', async t => {
  const { pausedApproval } = await import('../scripts/sandbox-resume.ts');
  const { file } = evidence(t);
  const pending = { ...approved, status: 'PAYER_ACTION_REQUIRED' };
  const pair = (call: number, op: string, body?: unknown, httpStatus = 200) => {
    const suffix = call.toString().padStart(12, '0');
    const context = { lease, call_id: '22222222-2222-4222-8222-' + suffix, request_id: '33333333-3333-4333-8333-' + suffix };
    return [
      { call, op, event: 'dispatch', ...(body ? context : {}) },
      { call, op, event: 'response', http_status: httpStatus, ...(body ? { ...context, body } : {}) },
    ];
  };
  const rows = [...pair(1, 'oauth'), ...pair(2, 'create_order', pending),
    ...Array.from({ length: 9 }, (_, i) => pair(i + 3, 'get_order', pending)).flat()];
  const log = (input: unknown[]) => input.map(entry => JSON.stringify(entry)).join('\n');
  assert.equal(pausedApproval(log(rows)).used, 11);
  assert.throws(() => pausedApproval(log(rows.slice(0, -1))), /incomplete/);
  assert.throws(() => pausedApproval(log([...rows, { call: 12, op: 'get_order', event: 'transport_stopped' }])));
  assert.throws(() => pausedApproval(log([...rows, ...pair(12, 'get_order', approved)])), /order state/);
  assert.throws(() => pausedApproval(log([...rows, ...pair(12, 'oauth')])), /pair/);
  const duplicates = rows.map((r, i) => i === 6 || i === 7 ? { ...r, call_id: rows[4].call_id } : r);
  assert.throws(() => pausedApproval(log(duplicates)), /repeat/);
  const terminal = pair(8, 'authorize', { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
  const recovery = [...rows.slice(0, 12), ...pair(7, 'get_order', approved), ...terminal, ...pair(9, 'oauth'), ...pair(10, 'get_order', pending)];
  assert.equal(pausedApproval(log(recovery)).rejected, true);
  assert.equal(pausedApproval(log(recovery)).used, 10);
  assert.throws(() => pausedApproval(log(recovery.slice(0, -2))), /order state/);
  assert.throws(() => pausedApproval(log(recovery.map(r => r.call === 8 && r.event === 'response' ? { ...r, http_status: 200 } : r))), /prevents recovery/);
  const transport = evidenceTransport(file, async () => Response.json(pending), [], pausedApproval(log(rows)).used);
  assert.equal(transport.remaining(), 14);
  await transport.withIntent(lease, intent, async () => {
    await transport.send(base + '/v1/oauth2/token', { method: 'POST' });
    await transport.send(resource, { method: 'GET' });
  });
  assert.equal(transport.remaining(), 12);
});

test('an MCP exposure error must have a matching durable refusal row', async () => {
  const { scriptMeter } = await import('../scripts/sandbox-meter.ts');
  let persistRefusal = false;
  const query = async (sql: string) => {
    if (sql.includes('select * from public.tool_calls')) return { rows: [] };
    if (sql.includes('select active,price_minor')) return { rows: [{ active: true, price_minor: '100' }] };
    if (sql.includes('l.unsettled_limit_minor')) return { rows: [{ state: 'active', unsettled_limit_minor: '500', within_window: true, voiding: false }] };
    if (sql.includes('HOLD_AVAILABLE')) return { rows: [{ hold: '1400', committed: '500' }] };
    if (sql.includes('insert into public.tool_calls')) return { rows: [] };
    if (sql.includes('ledger_group_id from public.tool_calls')) return { rows: persistRefusal ? [{ id: intent.call_id, price_minor: '100', status: 'refused_exposure', ledger_group_id: null }] : [] };
    throw new Error('Unexpected SQL');
  };
  const db = { transaction: async (_lease: unknown, work: (tx: unknown) => Promise<unknown>) => work({ query }) } as unknown as Database;
  const tool = scriptMeter(db, lease);
  await assert.rejects(tool('first'), /differs from its kernel journal/);
  persistRefusal = true;
  assert.equal(await tool('second'), null);
});

test('judge adapters use two pinned models with a single bounded structured request each', async () => {
  const { runJudges } = await import('../../../packages/kernel/src/index.ts');
  const { judgeBudget, realJudges } = await import('../scripts/sandbox-judges.ts');
  const requests = new Map<string, Record<string, any>>();
  const verdict = JSON.stringify({ verdict: 'pass', score: 100, reasons: ['Arithmetic matches'] });
  const providers = realJudges('fixture-key-a', 'fixture-key-b', async (input, init) => {
    const host = new URL(String(input)).hostname;
    assert.ok(!requests.has(host));
    assert.equal(init?.redirect, 'error');
    requests.set(host, JSON.parse(String(init?.body)));
    return Response.json(host === 'api.openai.com' ? { choices: [{ message: { content: verdict } }] } : { content: [{ text: verdict }] });
  });
  const guard = judgeBudget();
  const result = await runJudges({ job_id: lease, deliverable: { text: '2 + 2 = 4', content_type: 'text/plain' }, acceptance: { max_bytes: 64 }, providers, guard });
  assert.equal(guard.reserved_minor, 300n);
  assert.deepEqual(result.verdicts.map(row => row.judge_provider), ['openai', 'anthropic']);
  assert.equal(requests.get('api.openai.com')?.max_completion_tokens, 512);
  assert.equal(requests.get('api.openai.com')?.response_format.json_schema.strict, true);
  assert.equal(requests.get('api.anthropic.com')?.max_tokens, 512);
  assert.deepEqual(requests.get('api.anthropic.com')?.output_config.format.schema.required, ['verdict', 'score', 'reasons']);
});

test('HTTP 421 costs exactly one wire request and cannot silently retry', async t => {
  const { createServer, request } = await import('node:http');
  const { oneShotFetch } = await import('../scripts/one-shot-fetch.ts');
  let wire = 0;
  const server = createServer((_req, res) => {
    res.statusCode = ++wire === 1 ? 421 : 200;
    res.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let response: Response;
  try {
    response = await oneShotFetch('http://127.0.0.1:' + address.port, { method: 'GET' }, request);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return t.skip('Shell blocks loopback TCP');
    throw error;
  }
  assert.equal(response.status, 421);
  assert.equal(wire, 1);
});
