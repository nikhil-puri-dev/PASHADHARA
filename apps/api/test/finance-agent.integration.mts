import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse } from 'yaml';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createApp } from '../src/app.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';
import { financeTools, pairIds } from '../src/finance-fixtures.ts';
import { readHandlers } from '../src/read-handlers.ts';
import type { Contract } from '../src/routes.ts';
import { settlementFlow } from '../src/settlement.ts';
import { seedFinance } from '../scripts/finance-seed.ts';

// Real HTTP API, SDK, kernel and throwaway Postgres. The model, financial responses and business inputs are fixtures.
// Create a fresh database first: scripts/live-db.sh live_replay. No external network or spend.
const database = process.env.REPLAY_TEST_DATABASE ?? 'live_replay';
if (!/^live_[a-z0-9_]+$/.test(database)) throw new Error('Invalid throwaway test database name');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
const servers: { close(): unknown }[] = [];
after(async () => { servers.forEach(s => s.close()); await db.end(); });

async function lease(cap: bigint) {
  const id = (await kernel.createLease(db, { buyer_ref: 'agent-e2e', cap_minor: cap, unsettled_limit_minor: cap })).id;
  const order = await kernel.beginPayPalCall(db, id, 'create_order');
  await kernel.markCallSent(db, id, order.call_id);
  const orderId = await kernel.recordOrder(db, id, order.call_id, { http_status: 201, body: { id: randomUUID() } });
  const call = await kernel.beginPayPalCall(db, id, 'authorize');
  await kernel.markCallSent(db, id, call.call_id);
  const now = Date.now();
  const resource = { id: `FIXTURE-${randomUUID()}`, status: 'CREATED', amount: { currency_code: 'USD', value: `${cap / 100n}.${String(cap % 100n).padStart(2, '0')}` }, create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86_400_000).toISOString() };
  await kernel.recordAuthorization(db, id, call.call_id, { http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [resource] } }] } });
  return { id, orderId, resource };
}
const use = (id: string, name: string, text: string, reason = 'test') => ({ type: 'tool_use', id, name, input: { text, reason } });
const finding = (pair: string, cls: string, cited: boolean, mention = false) => ({ pair, classification: cls, citations: [`INV-${pair}1`, `INV-${pair}2`, ...(cited ? [`PAY-${pair}`] : [])], rationale: mention ? `PAY-${pair} settles it.` : 'Free fields only.' });

test('finance fixture over public HTTP: budget, lost reply, refusal, partial findings and settlement reconciliation', { timeout: 60000 }, async () => {
  await seedFinance(db, 'agent-e2e@example.test');
  const secret = randomUUID() + randomUUID();
  const { id, orderId, resource } = await lease(20n);
  let capturePosts = 0;
  let capture: Record<string, unknown>;
  const settlement = settlementFlow(db, {
    async capture(authorizationId, amount, invoiceId) {
      assert.equal(authorizationId, resource.id);
      assert.deepEqual(amount, { value: '0.06', currency_code: 'USD' });
      capturePosts++;
      capture = { id: `FIXTURE-${randomUUID()}`, invoice_id: invoiceId, status: 'COMPLETED', amount,
        seller_receivable_breakdown: { paypal_fee: { value: '0.01', currency_code: 'USD' } } };
      throw new Error('Fixture capture response lost after submission');
    },
    async getOrder(requested) {
      assert.equal(requested, orderId);
      return { status: 200, body: { id: orderId, purchase_units: [{ payments: { captures: [capture] } }] } };
    },
    async getCapture(requested) {
      assert.equal(requested, capture.id);
      return { status: 200, body: capture };
    },
    async getAuthorization(requested) {
      assert.equal(requested, resource.id);
      return { status: 200, body: { ...resource, status: 'PARTIALLY_CAPTURED' } };
    },
    async void() { assert.fail('Unexpected void'); },
    async reauthorize() { assert.fail('Unexpected reauthorization'); },
  }, readHandlers(db).getLease!);
  const executions: string[] = [];
  const tools = financeTools.map(tool => ({ ...tool, admit(text: string) {
    const admission = tool.admit(text)!;
    return { ...admission, async run(input: string, signal?: AbortSignal) {
      executions.push(`${tool.name}:${input}`);
      return admission.run(input, signal);
    } };
  } }));
  const app = createApp({
    contract: parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8')) as Contract,
    db, ...createAuth(db, secret, ''), meter: kernelMeter(db, undefined, resultStore(db)), tools, handlers: settlement.handlers,
  });
  let lostReply = false;
  const mcp = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const rpc = request.method === 'POST' && new URL(request.url).pathname === '/api/mcp'
      ? await request.clone().json() as { method?: string; params?: { name?: string; arguments?: { text?: string } } }
      : undefined;
    const response = await app.fetch(request);
    if (!lostReply && rpc?.method === 'tools/call' && rpc.params?.name === 'finance_payment_lookup'
      && rpc.params.arguments?.text === 'A') {
      lostReply = true;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    return response;
  } }); servers.push(mcp);
  await new Promise<void>(r => mcp.once('listening', r));
  const mcpPort = (mcp.address() as { port: number }).port;

  const modelRequests: { max_tokens: number; messages: object[]; tools: { name: string }[] }[] = [];
  const good = pairIds.map(p => finding(p, ['A', 'C'].includes(p) ? 'potential_duplicate' : 'abstain', ['A', 'B', 'C'].includes(p), ['A', 'B', 'C'].includes(p)));
  good[1] = { ...good[1]!, classification: 'not_duplicate' };
  const script: Record<string, unknown>[] = [
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 'x', name: 'finance_payment_bundle', input: { text: 'all', reason: 'cut off mid-turn' } }], usage: { input_tokens: 900, output_tokens: 8000 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'budget', name: 'check_budget', input: { tool: 'finance_payment_bundle' } }], usage: { input_tokens: 900, output_tokens: 60 } },
    { stop_reason: 'tool_use', content: [use('l0', 'finance_payment_lookup', 'A')], usage: { input_tokens: 1000, output_tokens: 40 } },
    { stop_reason: 'tool_use', content: [use('t1', 'finance_payment_bundle', 'all')], usage: { input_tokens: 1050, output_tokens: 40 } },
    { stop_reason: 'tool_use', content: ['B', 'C'].map(p => use(`l${p}`, 'finance_payment_lookup', p)), usage: { input_tokens: 1100, output_tokens: 120 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's1', name: 'submit_findings', input: { findings: [finding('A', 'potential_duplicate', false, true)] } }], usage: { input_tokens: 1300, output_tokens: 90 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's2', name: 'submit_findings', input: { findings: good } }], usage: { input_tokens: 1500, output_tokens: 700 } },
  ];
  let n = 0;
  const model = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      modelRequests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(script[n++] ?? { stop_reason: 'end_turn', content: [] }));
    });
  }); servers.push(model);
  await new Promise<void>(r => model.listen(0, '127.0.0.1', r));
  const modelPort = (model.address() as { port: number }).port;

  const base = `http://127.0.0.1:${mcpPort}/api`;
  const token = issueToken(secret, 'lease', id);
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/finance-agent.ts'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ANTHROPIC_API_KEY: 'stub-not-a-key', MODEL_API_URL_FOR_TESTS: `http://127.0.0.1:${modelPort}/v1/messages`, MCP_URL: base + '/mcp', INVESTIGATION_BUDGET_CENTS: '20', LEASE_TOKEN: token } });
  let out = ''; child.stdout.on('data', c => out += c);
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', value => resolve(value ?? 1));
  });
  const lines = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const ev = (e: string) => lines.filter(l => l.event === e);

  assert.equal(code, 0, out);
  assert.deepEqual(modelRequests.slice(0, 2).map(request => request.max_tokens), [8000, 16000]);
  assert.ok(modelRequests[0]!.tools.some(tool => tool.name === 'check_budget'), 'the model can call the free MCP preflight');
  assert.match(JSON.stringify(modelRequests[2]!.messages.at(-1)), /affordable\\":true/);
  assert.match(JSON.stringify(modelRequests[4]!.messages.at(-1)), /cap_reached/);
  assert.equal(ev('turn_truncated_retrying').length, 1);
  const calls = ev('tool_call');
  assert.deepEqual(calls.map(c => [c.name, c.text]), [
    ['finance_payment_lookup', 'A'], ['finance_payment_bundle', 'all'], ['finance_payment_lookup', 'B'], ['finance_payment_lookup', 'C'],
  ]);
  const [a, refused, b, c] = calls.map(call => call.result.structuredContent);
  assert.equal(ev('tool_transport_retry').length, 1);
  assert.equal(a.receipt.replayed, true);
  assert.equal(a.receipt.charged_minor, 0);
  assert.equal(a.receipt.original_charged_minor, 2);
  assert.equal(refused.reason, 'cap_reached');
  assert.equal(refused.remaining_minor, 18);
  for (const [result, pair] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
    assert.equal(result.provenance, 'fixture');
    assert.equal(result.evidence.id, `PAY-${pair}`);
  }
  assert.deepEqual(executions, ['finance_payment_lookup:A', 'finance_payment_lookup:B', 'finance_payment_lookup:C']);
  const submissions = ev('submission');
  assert.equal(submissions.length, 2);
  assert.ok(submissions[0].problems.length > 0 && submissions[1].problems.length === 0);
  assert.equal(ev('artifact').length, 1);
  const summary = ev('run_summary')[0];
  assert.equal(summary.evidence_spent_cents, 6);
  assert.equal(summary.uninterrupted, true);
  assert.equal(summary.truncations, 1);
  assert.equal(summary.model_usage.requests, script.length);
  assert.ok(summary.model_cost_usd_estimate > 0);
  const evaluation = ev('evaluation')[0];
  assert.equal(evaluation.agent.unsupported_or_incomplete_citations, 0);
  assert.equal(evaluation.agent.spent_cents, 6);
  assert.equal(evaluation.agent.abstentions, 9);

  const request = (path: string, method = 'GET') => fetch(`${base}/v1/leases/${id}${path}`, {
    method, headers: { authorization: `Bearer ${token}` },
  });
  const { entries } = await (await request('/journal')).json() as { entries: Record<string, unknown>[] };
  const commits = entries.filter(entry => entry.ref_type === 'commit');
  assert.equal(commits.length, 6);
  for (const result of [a, b, c]) {
    const { tool_call_id, ledger_group_id } = result.receipt;
    assert.deepEqual(commits.filter(entry => entry.ref_id === tool_call_id)
      .map(entry => [entry.group_id, entry.account, entry.direction, entry.amount_minor]).sort(), [
      [ledger_group_id, 'COMMITTED_UNSETTLED', 'D', 2], [ledger_group_id, 'HOLD_AVAILABLE', 'C', 2],
    ]);
  }
  const { rows: [refusal] } = await db.transaction(null, tx => tx.query(
    'select status, ledger_group_id from public.tool_calls where lease_id=$1 and idempotency_key=$2', [
      id, calls[1].idempotency_key + ':' + createHash('sha256').update('finance_payment_bundle\0all').digest('hex'),
    ],
  ));
  assert.deepEqual(refusal, { status: 'refused_cap', ledger_group_id: null });

  const firstSettle = await request('/settle', 'POST');
  assert.equal(firstSettle.status, 409);
  assert.match(await firstSettle.text(), /reconcile before retrying/);
  const { rows: [unknownCapture] } = await db.transaction(null, tx => tx.query<{ id: string; status: string }>(
    'select id,status from public.captures where lease_id=$1', [id],
  ));
  assert.equal(unknownCapture?.status, 'unknown');
  assert.equal((await request('/settle', 'POST')).status, 409);
  const reconciled = await request('/reconcile', 'POST');
  assert.equal(reconciled.status, 200);
  const proof = await reconciled.json() as { all_match: boolean; lines: { subject: string; match: boolean }[] };
  assert.equal(proof.all_match, true);
  assert.deepEqual(proof.lines.filter(line => line.subject.startsWith('capture ')).map(line => [line.subject, line.match]),
    [[`capture ${unknownCapture.id}`, true]]);
  assert.equal(capturePosts, 1);
  const { rows: allocations } = await db.transaction(null, tx => tx.query<{ capture_id: string; ref_id: string; amount_minor: string }>(
    'select capture_id,ref_id,amount_minor from public.capture_allocations where lease_id=$1', [id],
  ));
  assert.deepEqual(allocations.map(row => [row.capture_id, row.ref_id, row.amount_minor]).sort(),
    [a, b, c].map(result => [unknownCapture.id, result.receipt.tool_call_id, '2']).sort());
  const settled = await request('');
  assert.equal(settled.status, 200);
  const { balances } = await settled.json() as { balances: Record<string, number> };
  assert.deepEqual([balances.buyer_commitment, balances.hold_available, balances.committed_unsettled,
    balances.total_captured, balances.paypal_fees, balances.released, balances.written_off], [20, 14, 0, 6, 1, 0, 0]);

  const bundleLease = await lease(20n);
  const client = new Client({ name: 'bundle-fixture-probe', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${issueToken(secret, 'lease', bundleLease.id)}` } },
    }));
    const bundle = await client.callTool({ name: 'finance_payment_bundle', arguments: { text: 'all', idempotency_key: randomUUID() } });
    assert.equal(bundle.isError, undefined);
    const product = bundle.structuredContent as { provenance: string; evidence: { pair: string }[]; receipt: { charged_minor: number; remaining_minor: number } };
    assert.equal(product.provenance, 'fixture');
    assert.deepEqual(product.evidence.map(row => row.pair), pairIds);
    assert.deepEqual([product.receipt.charged_minor, product.receipt.remaining_minor], [20, 0]);
    assert.equal(executions.at(-1), 'finance_payment_bundle:all');
  } finally { await client.close(); }
});
