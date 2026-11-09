import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as k from '../../../packages/kernel/src/index.ts';
import { compareJournal } from '../src/compare-journal.ts';

test('fixture responses post to real Postgres and reconcile each journal field', async () => {
  const db = new k.Database('postgres://kernel_login@127.0.0.1:15434/postgres');
  const records = readFileSync('evidence/spike2-log.masked.jsonl', 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const authPost = structuredClone(records.find(x => x.step === 'authorize C').body);
  authPost.id = randomUUID();
  const auth = authPost.purchase_units[0].payments.authorizations[0];
  auth.id = randomUUID();
  const capture = structuredClone(records.find(x => x.step === 'C capture #1 1.00').body);
  capture.id = randomUUID();
  // The recorded authorization is old, so the database clock requires fixture timestamps.
  const created = Date.now();
  auth.create_time = new Date(created).toISOString();
  auth.expiration_time = new Date(created + 29 * 86400000).toISOString();
  try {
    const lease = (await k.createLease(db, { buyer_ref: 'fixture', cap_minor: 2000n, unsettled_limit_minor: 100n })).id;
    const order = await k.beginPayPalCall(db, lease, 'create_order');
    await k.markCallSent(db, lease, order.call_id);
    await k.recordOrder(db, lease, order.call_id, { http_status: 200, body: { id: authPost.id } });
    const call = await k.beginPayPalCall(db, lease, 'authorize');
    await k.markCallSent(db, lease, call.call_id);
    const authorization = await k.recordAuthorization(db, lease, call.call_id, { http_status: 201, body: authPost });
    const tool = `fixture-${randomUUID()}`;
    await db.transaction(null, async tx => {
      const seller = await tx.query<{ id: string }>("insert into public.sellers(name,paypal_email) values ('fixture','fixture@example.test') returning id");
      await tx.query("insert into public.tools(id,seller_id,name,price_minor) values ($1,$2,'fixture',100)", [tool, seller.rows[0]!.id]);
    });
    const usage = await k.commitUsage(db, lease, { kind: 'tool', tool_id: tool, idempotency_key: randomUUID() });
    assert.equal(usage.status, 'served');
    const intent = await k.beginCapture(db, lease, { authorization_id: authorization.id, allocations: [{ ref_id: usage.id!, amount_minor: 100n }] });
    await k.markCallSent(db, lease, intent.call_id);
    // The recorded response predates this fixture intent and its invoice identity.
    capture.invoice_id = intent.capture_id;
    await k.completeCapture(db, lease, intent.capture_id, { http_status: 201, body: capture });
    const authorizationRead = { id: auth.id, status: 'PARTIALLY_CAPTURED', amount: auth.amount };
    const lines = await compareJournal(db, lease, authorizationRead, capture, 'fixture');
    assert.equal(lines.length, 7);
    assert.ok(lines.every(line => line.match));
    const diff = await compareJournal(db, lease, authorizationRead, { ...capture, amount: { currency_code: 'USD', value: '1.01' } }, 'fixture');
    assert.deepEqual(diff.filter(line => !line.match).map(line => line.field), ['capture.amount_minor']);
    writeFileSync('apps/api/fixture-reconcile.json', JSON.stringify({ provenance: 'fixture', lines }, null, 2) + '\n');
    const allowedCapture = { id: capture.id, status: capture.status, amount: capture.amount,
      seller_receivable_breakdown: { paypal_fee: capture.seller_receivable_breakdown.paypal_fee } };
    writeFileSync('apps/api/fixture-responses.jsonl', [
      { provenance: 'fixture', operation: 'authorization_read', body: authorizationRead },
      { provenance: 'fixture', operation: 'capture_read', body: allowedCapture },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    for (const line of lines) console.log(`fixture ${line.field}: ${line.match ? 'match' : 'diff'}`);
  } finally { await db.end(); }
});


