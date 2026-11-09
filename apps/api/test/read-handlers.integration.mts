import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Database } from '../../../packages/kernel/src/db.ts';
import { createLease } from '../../../packages/kernel/src/lease.ts';
import { createRoutes, type Contract } from '../src/routes.ts';
import { readHandlers } from '../src/read-handlers.ts';

test('read handlers use Postgres and return OpenAPI-valid tools and journal', async () => {
  const db = new Database('postgres://kernel_login@127.0.0.1:15434/postgres');
  try {
    const lease = await createLease(db, { buyer_ref: 'fixture', cap_minor: 100n, unsettled_limit_minor: 50n });
    await db.transaction(null, async tx => {
      const seller = await tx.query<{ id: string }>("insert into public.sellers(name,paypal_email) values ('fixture','fixture@example.com') returning id");
      await tx.query("insert into public.tools(id,seller_id,name,price_minor) values ('fixture-tool',$1,'fixture tool',17)", [seller.rows[0].id]);
    });
    const contract = parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8')) as Contract;
    const app = createRoutes(contract, readHandlers(db), async () => ({ leaseId: lease.id }));
    const tools = await app.request('http://localhost/v1/tools');
    assert.equal(tools.status, 200);
    const payload = await tools.json() as { tools: { id: string; price_minor: number }[] };
    assert.equal(payload.tools.find(row => row.id === 'fixture-tool')?.price_minor, 17);
    const journal = await app.request(`http://localhost/v1/leases/${lease.id}/journal`);
    assert.equal(journal.status, 200);
    assert.deepEqual(await journal.json(), { entries: [] });
    const beyondBigint = await app.request(`http://localhost/v1/leases/${lease.id}/journal?after=9223372036854775808`);
    assert.equal(beyondBigint.status, 200);
    assert.deepEqual(await beyondBigint.json(), { entries: [] });
  } finally { await db.end(); }
});
