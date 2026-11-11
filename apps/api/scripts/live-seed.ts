import { Database } from '../../../packages/kernel/src/db.ts';
import { SUMMARISE_PRICE_MINOR } from '../src/summarise.ts';

/** Idempotent: one seller per email and one `summarise` tool at the fixed price. */
export async function seedSummarise(db: Database, email: string) {
  return db.transaction(null, async tx => {
    await tx.query('select pg_advisory_xact_lock(234171, 2)');
    const found = await tx.query<{ id: string }>('select id from public.sellers where paypal_email=$1 order by created_at limit 1', [email]);
    const seller = found.rows[0]?.id ?? (await tx.query<{ id: string }>(
      "insert into public.sellers(name,paypal_email,payout_hold_seconds) values ('SELLER_A',$1,30) returning id", [email],
    )).rows[0]!.id;
    await tx.query(`insert into public.tools (id,seller_id,name,description,price_minor)
      values ('summarise',$1,'Summarise','Summarise text in at most three sentences with Claude Haiku 5.5.',$2)
      on conflict (id) do nothing`, [seller, SUMMARISE_PRICE_MINOR]);
    const tool = await tx.query('select 1 from public.tools where id=\'summarise\' and active and price_minor=$1', [SUMMARISE_PRICE_MINOR]);
    if (tool.rowCount !== 1) throw new Error('Existing summarise tool differs from the gateway configuration');
    return seller;
  });
}

if (process.argv[1]?.endsWith('live-seed.ts')) {
  const { DATABASE_URL: url, SELLER_A_EMAIL: email } = process.env;
  if (!url || !email) { console.error('DATABASE_URL and SELLER_A_EMAIL are required'); process.exit(1); }
  const db = new Database(url);
  seedSummarise(db, email).then(() => console.log('computed: summarise tool seeded'), () => { console.error('seed failed'); process.exitCode = 1; }).finally(() => db.end());
}
