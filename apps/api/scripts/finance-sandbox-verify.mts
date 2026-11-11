import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Database } from '../../../packages/kernel/src/db.ts';
import { PayPalClient } from '../../../packages/paypal/src/index.ts';

// After a finance-agent run on a sandbox hold: (1) probe the refusal and the replay on the same live lease,
// (2) read the journal rows straight from Postgres, (3) GET the authorization from PayPal. Writes an allowlisted proof file.
const { MCP_URL, LEASE_TOKEN, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
const [tracePath, outPath, database, lease] = process.argv.slice(2);
if (!MCP_URL || !LEASE_TOKEN || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !tracePath || !outPath || !/^live_finance_[a-z0-9_]+$/.test(database ?? '') || !lease) throw new Error('Missing configuration');
const trace = (await readFile(tracePath, 'utf8')).trim().split(/\r?\n/).map(l => JSON.parse(l));
const first = trace.find(l => l.event === 'tool_call' && !l.result.isError);
const client = new Client({ name: 'pashadhara-verify', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { authorization: `Bearer ${LEASE_TOKEN}` } } }));
const rows = async () => (await pool.query("select count(*)::int n, coalesce(sum(price_minor),0)::int cents from tool_calls where lease_id=$1 and status='served'", [lease])).rows[0];
const db = new Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
const pool = { query: (sql: string, args: unknown[]) => db.transaction(null, tx => tx.query(sql, args)), end: () => db.end() };
try {
  const before = await rows();
  const bundleKey = `${randomUUID()}:${createHash('sha256').update('finance_payment_bundle').update('\0').update('all').digest('hex')}`;
  const bundle = await client.callTool({ name: 'finance_payment_bundle', arguments: { text: 'all', idempotency_key: bundleKey } });
  const afterRefusal = await rows();
  const replay = await client.callTool({ name: first.name, arguments: { text: first.text, idempotency_key: first.idempotency_key } });
  const afterReplay = await rows();
  const journal = (await pool.query("select (select count(*)::int from tool_calls where lease_id=$1 and status='served') served, (select count(*)::int from tool_calls where lease_id=$1 and status<>'served') refused, (select count(*)::int from tool_results where lease_id=$1) stored, (select coalesce(sum(price_minor),0)::int from tool_calls where lease_id=$1 and status='served') cents", [lease])).rows[0];
  const auth = (await pool.query("select paypal_authorization_id id, amount_minor::int amount, status from authorizations where lease_id=$1", [lease])).rows[0];
  const paypal = await new PayPalClient(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET).getAuthorization(auth.id);
  const body = paypal.body as { id?: string; status?: string; amount?: { value?: string; currency_code?: string } };
  const proof = {
    provenance: 'measured', note: 'Sandbox only. Allowlisted fields. The tool charges are local journal commitments; nothing was captured or paid out.',
    refusal_probe: { tool: 'finance_payment_bundle', isError: !!bundle.isError, reason: (bundle.structuredContent as { reason?: string })?.reason, served_before: before, served_after: afterRefusal },
    replay_probe: { tool: first.name, isError: !!replay.isError, replayed: (replay.structuredContent as { receipt?: { replayed?: boolean; charged_minor?: number } })?.receipt?.replayed, charged_minor: (replay.structuredContent as { receipt?: { charged_minor?: number } })?.receipt?.charged_minor, served_after: afterReplay },
    journal,
    local_authorization: { id_matches_paypal: auth.id === body.id, amount_minor: auth.amount, status: auth.status },
    paypal_get: { http_status: paypal.status, id_matches_local: body.id === auth.id, status: body.status, amount: body.amount },
  };
  await writeFile(outPath, JSON.stringify(proof, null, 1) + '\n');
  console.log(JSON.stringify(proof));
} finally { await client.close(); await pool.end(); }
