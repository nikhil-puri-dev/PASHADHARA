import { Database } from '../../../packages/kernel/src/db.ts';
import { PayPalClient } from '../../../packages/paypal/src/index.ts';
import { approvalFlow } from '../src/approval.ts';
import { isUuid } from '../src/auth.ts';
import { readHandlers } from '../src/read-handlers.ts';
import { seedSummarise } from './live-seed.ts';

async function main() {
  const { DATABASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, LEASE_TOKEN_SECRET, API_BASE_URL, SELLER_A_EMAIL } = process.env;
  if (!DATABASE_URL || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !LEASE_TOKEN_SECRET || !API_BASE_URL || !SELLER_A_EMAIL) {
    throw new Error('Missing showcase seed configuration. See docs/showcase.md.');
  }
  const [action, leaseId] = process.argv.slice(2);
  if (action !== 'create' && !(action === 'activate' && leaseId && isUuid(leaseId))) {
    throw new Error('Use showcase-seed.mts create or showcase-seed.mts activate LEASE_ID.');
  }
  const db = new Database(DATABASE_URL);
  try {
    const paypal = new PayPalClient(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET);
    const flow = approvalFlow(db, paypal, API_BASE_URL, LEASE_TOKEN_SECRET, readHandlers(db).getLease!);
    const input = { request: new Request('http://localhost'), principal: null, query: {}, params: { leaseId: leaseId ?? '' } };
    if (action === 'create') {
      await seedSummarise(db, SELLER_A_EMAIL);
      const created = await flow.create({ ...input, body: { buyer_ref: 'public-showcase', cap_minor: 777, unsettled_limit_minor: 777 } });
      if (created.status !== 201) throw new Error('Sandbox order creation failed.');
      const body = created.body as { lease_id: string; approve_url: string };
      await db.transaction(null, tx => tx.query('insert into public.showcase_leases(lease_id) values ($1)', [body.lease_id]));
      console.log(JSON.stringify({ http: created.status, lease_id: body.lease_id, approve_url: body.approve_url }));
    } else {
      const registered = await db.transaction(null, tx => tx.query('select 1 from public.showcase_leases where lease_id=$1', [leaseId]));
      if (!registered.rowCount) throw new Error('Sandbox order was not registered by showcase create.');
      const activated = await flow.authorize({ ...input, body: undefined });
      if (activated.status !== 200) throw new Error('Sandbox approval is not confirmed.');
      await db.transaction(leaseId!, async tx => {
        await tx.query('select pg_advisory_xact_lock(234171,4)');
        const published = await tx.query(`update public.showcase_leases s set published_at=coalesce(s.published_at,now())
          where s.lease_id=$1 and exists (select 1 from public.leases l join public.authorizations a on a.lease_id=l.id
            where l.id=s.lease_id and l.state='active' and a.status in ('created','partially_captured') and a.honor_until>clock_timestamp())`, [leaseId]);
        if (!published.rowCount) throw new Error('Sandbox approval has no active honor window.');
      });
      console.log(JSON.stringify({ http: activated.status, showcase_lease_id: leaseId }));
    }
  } finally {
    await db.end();
  }
}

await main().catch(error => {
  console.error(error instanceof Error && /^Use showcase|^Missing showcase|^Sandbox (order|approval)/.test(error.message)
    ? error.message : 'Showcase seed failed. Check the local database and sandbox order before retrying.');
  process.exitCode = 1;
});
