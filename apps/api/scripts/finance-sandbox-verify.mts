import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { objectField, paypalMinor } from '../../../packages/kernel/src/calls.ts';
import { Database } from '../../../packages/kernel/src/db.ts';
import { PayPalClient } from '../../../packages/paypal/src/index.ts';
import { isUuid } from '../src/auth.ts';
import { meterReasons } from '../src/meter.ts';
import { readLeases } from '../src/read-handlers.ts';

type ToolCall = {
  event: 'tool_call'; name: string; text: string; idempotency_key: string;
  result: { isError?: boolean; structuredContent?: {
    reason?: string; lease_id?: string; price_minor?: number;
    receipt?: { lease_id: string; tool_call_id: string; ledger_group_id: string;
      charged_minor: number; replayed?: boolean; original_charged_minor?: number };
  } };
};

// Inspect a dedicated local run. The optional sandbox reads use GETs. This script submits no tool or settlement requests.
const [tracePath, outPath, database, lease, flag] = process.argv.slice(2);
if (!tracePath || !outPath || !/^live_finance_[a-z0-9_]+$/.test(database ?? '') || !isUuid(lease)
  || (flag !== undefined && flag !== '--paypal-sandbox-read')) {
  throw new Error('Usage: finance-sandbox-verify.mts TRACE NEW_PROOF_FILE live_finance_DATABASE LEASE_UUID [--paypal-sandbox-read]');
}
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (flag && (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)) throw new Error('Sandbox credentials are required for PayPal GETs');
const traceText = await readFile(tracePath, 'utf8');
const trace = traceText.trim().split(/\r?\n/).map(line => JSON.parse(line))
  .filter((row): row is ToolCall => row.event === 'tool_call');
assert.ok(trace.length, 'Trace has no tool calls');

const db = new Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
try {
  const snapshot = await db.transaction(null, async tx => ({
    lease: (await readLeases(tx, lease))[0],
    commits: (await tx.query<{ group_id: string; ref_id: string; account: string; direction: string; amount_minor: string }>(
      "select group_id,ref_id,account,direction,amount_minor from public.ledger_entries where lease_id=$1 and ref_type='commit'", [lease])).rows,
    authorizations: (await tx.query<{ paypal_authorization_id: string; status: string; amount_minor: string }>(
      'select paypal_authorization_id,status,amount_minor from public.authorizations where lease_id=$1 order by created_at,id', [lease])).rows,
    calls: (await tx.query<{ id: string; tool_id: string; idempotency_key: string; status: string; price_minor: string; ledger_group_id: string | null }>(
      'select id,tool_id,idempotency_key,status,price_minor,ledger_group_id from public.tool_calls where lease_id=$1 order by created_at,id', [lease])).rows,
    captures: (await tx.query<{ id: string; paypal_capture_id: string | null; amount_minor: string; fee_minor: string | null; status: string }>(
      'select id,paypal_capture_id,amount_minor,fee_minor,status from public.captures where lease_id=$1 order by created_at,id', [lease])).rows,
    allocations: (await tx.query<{ capture_id: string; ref_id: string; amount_minor: string }>(
      'select capture_id,ref_id,amount_minor from public.capture_allocations where lease_id=$1 order by capture_id,ref_id', [lease])).rows,
  }), 'repeatable read');
  assert.ok(snapshot.lease, 'Lease missing');
  const { commits } = snapshot;
  const seen = new Set<string>();
  const actions = trace.map(({ name, text, idempotency_key, result }) => {
    const content = result.structuredContent;
    const digest = createHash('sha256').update(name).update('\0').update(text).digest('hex');
    const nonce = idempotency_key.slice(0, 36);
    assert.ok(isUuid(nonce));
    const key = nonce.toLowerCase() + ':' + digest;
    assert.ok(idempotency_key === nonce || idempotency_key.toLowerCase() === key, 'Recorded key differs from the tool input');
    const row = snapshot.calls.find(call => call.idempotency_key === key);
    if (result.isError && !row) {
      assert.ok(content?.reason !== 'cap_reached' && content?.reason !== 'exposure_limit', 'Budget refusal has no durable call row');
      return { name, text, status: 'error_without_posting', reason: content?.reason };
    }
    assert.ok(row, 'No database row matches the tool call');
    assert.equal(row.tool_id, name);
    assert.ok(!seen.has(row.id), 'Duplicate call in trace');
    seen.add(row.id);
    const postings = commits.filter(entry => entry.ref_id === row.id);
    if (result.isError) {
      assert.equal(meterReasons[row.status as keyof typeof meterReasons], content?.reason);
      assert.equal(content?.lease_id, lease);
      assert.equal(content?.price_minor, Number(row.price_minor));
      assert.equal(row.ledger_group_id, null);
      assert.equal(postings.length, 0);
    } else {
      const receipt = content?.receipt;
      assert.equal(row.status, 'served');
      assert.equal(receipt?.lease_id, lease);
      assert.equal(receipt?.tool_call_id, row.id);
      assert.equal(receipt.ledger_group_id, row.ledger_group_id);
      assert.equal(receipt.replayed ? receipt.original_charged_minor : receipt.charged_minor, Number(row.price_minor));
      if (receipt.replayed) assert.equal(receipt.charged_minor, 0);
      assert.deepEqual(postings.map(entry => [entry.group_id, entry.account, entry.direction, entry.amount_minor]).sort(), [
        [row.ledger_group_id, 'COMMITTED_UNSETTLED', 'D', row.price_minor], [row.ledger_group_id, 'HOLD_AVAILABLE', 'C', row.price_minor],
      ]);
    }
    return { name, text, status: row.status, price_minor: row.price_minor, tool_call_id: row.id, ledger_group_id: row.ledger_group_id };
  });
  assert.ok(snapshot.calls.every(call => call.status !== 'served' || seen.has(call.id)), 'Lease has a served call missing from the trace');
  const served = snapshot.calls.filter(call => call.status === 'served');
  assert.equal(commits.length, served.length * 2, 'Unexpected journal commitments on the dedicated lease');
  for (const capture of snapshot.captures) {
    const allocations = snapshot.allocations.filter(row => row.capture_id === capture.id);
    assert.equal(allocations.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n), BigInt(capture.amount_minor));
    assert.ok(allocations.every(row => served.some(call => call.id === row.ref_id)), 'Capture allocates outside the traced tool calls');
  }
  const { balances } = snapshot.lease;
  const conservation = ['hold_available', 'committed_unsettled', 'released', 'written_off', 'total_captured']
    .reduce((sum, account) => sum + BigInt(balances[account]!), 0n);
  assert.equal(conservation, BigInt(balances.buyer_commitment!));
  assert.ok(conservation <= BigInt(snapshot.lease.cap_minor));
  let paypal;
  if (flag) {
    assert.ok(snapshot.authorizations.length && snapshot.authorizations.every(auth => !auth.paypal_authorization_id.startsWith('FIXTURE-')),
      'A PayPal sandbox authorization is required for fresh reads');
    assert.ok(snapshot.captures.every(capture => capture.status === 'completed' && capture.paypal_capture_id && capture.fee_minor !== null),
      'Resolve outstanding captures through the operator reconciliation flow before requesting PayPal proof');
    const client = new PayPalClient(PAYPAL_CLIENT_ID!, PAYPAL_CLIENT_SECRET!);
    function check(result: { status: number; body: unknown }, id: string, status: string, minor: string,
      capture?: { feeMinor: string; invoiceId: string }) {
      assert.equal(result.status, 200);
      const body = objectField(result.body);
      const amount = objectField(body.amount);
      assert.equal(body.id, id);
      assert.equal(body.status, status);
      assert.equal(amount.currency_code, 'USD');
      assert.equal(paypalMinor(amount.value), BigInt(minor));
      const fee = capture && objectField(objectField(body.seller_receivable_breakdown).paypal_fee);
      if (capture && fee) {
        assert.equal(fee.currency_code, 'USD');
        assert.equal(paypalMinor(fee.value), BigInt(capture.feeMinor));
        if (body.invoice_id !== undefined) assert.equal(body.invoice_id, capture.invoiceId);
      }
      return { id, status, amount, fee, invoice_id: capture && body.invoice_id, http_status: result.status, read_at: new Date().toISOString() };
    }
    const authReads = [];
    const captureReads = [];
    for (const auth of snapshot.authorizations) {
      authReads.push(check(await client.getAuthorization(auth.paypal_authorization_id), auth.paypal_authorization_id,
        auth.status.toUpperCase(), auth.amount_minor));
    }
    for (const capture of snapshot.captures) {
      captureReads.push(check(await client.getCapture(capture.paypal_capture_id!), capture.paypal_capture_id!,
        'COMPLETED', capture.amount_minor, { feeMinor: capture.fee_minor!, invoiceId: capture.id }));
    }
    paypal = { provenance: 'measured', source: 'PayPal sandbox GET, allowlisted fields', authorizations: authReads, captures: captureReads };
  }
  const proof = {
    provenance: 'computed', lease_id: lease, trace_sha256: createHash('sha256').update(traceText).digest('hex'),
    actions, untraced_refusals: snapshot.calls.filter(call => !seen.has(call.id)).length,
    served_minor: served.reduce((sum, call) => sum + BigInt(call.price_minor), 0n).toString(), balances,
    authorizations: snapshot.authorizations, captures: snapshot.captures, allocations: snapshot.allocations, paypal_reads: paypal ?? null,
  };
  await writeFile(outPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ lease_id: lease, traced_actions: actions.length, untraced_refusals: proof.untraced_refusals,
    served_minor: proof.served_minor, captures: proof.captures.length, paypal_reads: Boolean(paypal) }));
} finally { await db.end(); }
