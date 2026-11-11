import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { serve } from '@hono/node-server';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import { createMcp, registeredTools } from '../src/mcp.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';
import { financeTools, pairIds } from '../src/finance-fixtures.ts';
import { seedFinance } from '../scripts/finance-seed.ts';

// Whole path with a scripted model: real MCP server, real kernel on throwaway Postgres 15434, real SDK client, real agent script.
// Create a fresh database first: scripts/live-db.sh live_replay. No network, no spend, no PayPal.
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
  const resource = { id: randomUUID(), status: 'CREATED', amount: { currency_code: 'USD', value: `${cap / 100n}.${String(cap % 100n).padStart(2, '0')}` }, create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86_400_000).toISOString() };
  await kernel.recordAuthorization(db, id, call.call_id, { http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [resource] } }] } });
  return id;
}
const use = (id: string, name: string, text: string, reason = 'test') => ({ type: 'tool_use', id, name, input: { text, reason } });
const finding = (pair: string, cls: string, cited: boolean, mention = false) => ({ pair, classification: cls, citations: [`INV-${pair}1`, `INV-${pair}2`, ...(cited ? [`PAY-${pair}`] : [])], rationale: mention ? `PAY-${pair} settles it.` : 'Free fields only.' });

test('agent finishes in one run: truncation retried in place, over-budget bundle refused, bad submission corrected', { timeout: 60000 }, async () => {
  await seedFinance(db, 'agent-e2e@example.test');
  const secret = randomUUID() + randomUUID();
  const id = await lease(6n);
  const app = createMcp(kernelMeter(db, undefined, resultStore(db)), createAuth(db, secret, '').resolveMcpLease, registeredTools(db, financeTools.map(t => t.name)), financeTools);
  const mcp = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); servers.push(mcp);
  await new Promise<void>(r => mcp.once('listening', r));
  const mcpPort = (mcp.address() as { port: number }).port;

  // Scripted model. Request 1 is truncated, 2 is its retry. 3 buys, 4 submits a bad artifact, 5 a good one.
  const maxTokensSeen: number[] = [];
  const good = pairIds.map(p => finding(p, ['A', 'C'].includes(p) ? 'potential_duplicate' : 'abstain', ['A', 'B', 'C'].includes(p), ['A', 'B', 'C'].includes(p)));
  good[1] = { ...good[1]!, classification: 'not_duplicate' };
  const script: Record<string, unknown>[] = [
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 'x', name: 'finance_payment_bundle', input: { text: 'all', reason: 'cut off mid-turn' } }], usage: { input_tokens: 900, output_tokens: 8000 } },
    { stop_reason: 'tool_use', content: [use('t1', 'finance_payment_bundle', 'all', 'one purchase for everything')], usage: { input_tokens: 900, output_tokens: 60 } },
    { stop_reason: 'tool_use', content: ['A', 'B', 'C'].map((p, i) => use(`l${i}`, 'finance_payment_lookup', p)), usage: { input_tokens: 1100, output_tokens: 120 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's1', name: 'submit_findings', input: { findings: [finding('A', 'potential_duplicate', false, true)] } }], usage: { input_tokens: 1300, output_tokens: 90 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's2', name: 'submit_findings', input: { findings: good } }], usage: { input_tokens: 1500, output_tokens: 700 } },
  ];
  let n = 0;
  const model = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      maxTokensSeen.push(JSON.parse(body).max_tokens);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(script[n++] ?? { stop_reason: 'end_turn', content: [] }));
    });
  }); servers.push(model);
  await new Promise<void>(r => model.listen(0, '127.0.0.1', r));
  const modelPort = (model.address() as { port: number }).port;

  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/finance-agent.ts'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ANTHROPIC_API_KEY: 'stub-not-a-key', MODEL_API_URL_FOR_TESTS: `http://127.0.0.1:${modelPort}/v1/messages`, MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, INVESTIGATION_BUDGET_CENTS: '6', LEASE_TOKEN: issueToken(secret, 'lease', id) } });
  let out = ''; child.stdout.on('data', c => out += c);
  const code = await new Promise<number>(r => child.once('exit', v => r(v ?? 1)));
  const lines = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const ev = (e: string) => lines.filter(l => l.event === e);

  assert.equal(code, 0, out);
  assert.deepEqual(maxTokensSeen.slice(0, 2), [8000, 16000], 'truncated turn retried with a larger limit');
  assert.equal(ev('turn_truncated_retrying').length, 1);
  const calls = ev('tool_call');
  assert.equal(calls[0].result.isError, true);
  assert.equal(calls[0].result.structuredContent.reason, 'cap_reached', 'the 20 cent bundle is refused by the kernel against a 6 cent lease');
  assert.equal(calls.filter(c => !c.result.isError).length, 3);
  const submissions = ev('submission');
  assert.equal(submissions.length, 2);
  assert.ok(submissions[0].problems.length > 0 && submissions[1].problems.length === 0);
  assert.equal(ev('artifact').length, 1);
  const summary = ev('run_summary')[0];
  assert.equal(summary.evidence_spent_cents, 6);
  assert.equal(summary.uninterrupted, true);
  assert.equal(summary.truncations, 1);
  assert.equal(summary.model_usage.requests, 5);
  assert.equal(summary.model_usage.output_tokens, 8000 + 60 + 120 + 90 + 700);
  assert.ok(summary.model_cost_usd_estimate > 0);
  const evaluation = ev('evaluation')[0];
  assert.equal(evaluation.agent.unsupported_or_incomplete_citations, 0);
  assert.equal(evaluation.agent.spent_cents, 6);
  const rows = await db.transaction(null, tx => tx.query<{ status: string; n: string }>('select status,count(*) n from public.tool_calls where lease_id=$1 group by status', [id]));
  assert.deepEqual(Object.fromEntries(rows.rows.map(r => [r.status, Number(r.n)])), { served: 3, refused_cap: 1 });
});
