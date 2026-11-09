import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../../../packages/kernel/src/db.ts';
import { recordWebhookEvent } from '../../../packages/kernel/src/reconcile.ts';

test('kernel webhook upsert preserves verified and unverified evidence under concurrent deliveries', async () => {
  const url = 'postgres://kernel_login@127.0.0.1:15434/postgres';
  const first = new Database(url);
  const second = new Database(url);
  const id = `fixture-${randomUUID()}`;
  const input = { id, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'fixture-original' }, signature_verified: false };
  try {
    await recordWebhookEvent(first, input);
    await Promise.all([
      recordWebhookEvent(first, { ...input, signature_verified: true }),
      recordWebhookEvent(second, { ...input, signature_verified: true, resource: { id: 'fixture-altered' } }),
    ]);
    const rows = await first.transaction(null, async tx => (await tx.query(
      'select signature_verified, deliveries, resource, processed_at from public.webhook_events where id=$1 order by signature_verified', [id],
    )).rows);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.signature_verified, row.deliveries, row.processed_at]), [[false, 1, null], [true, 2, null]]);
    assert.ok(['fixture-original', 'fixture-altered'].includes(rows[1].resource.id));
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
});
