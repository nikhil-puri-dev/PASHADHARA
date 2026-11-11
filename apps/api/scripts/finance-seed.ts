import { Database } from '../../../packages/kernel/src/db.ts';

/** Prices are checked against the immutable registry after insert. */
export async function seedFinance(db: Database, email: string) {
  return db.transaction(null, async tx => {
    await tx.query('select pg_advisory_xact_lock(234171, 2)');
    const found = await tx.query<{ id: string }>('select id from public.sellers where paypal_email=$1 order by created_at limit 1', [email]);
    const seller = found.rows[0]?.id ?? (await tx.query<{ id: string }>("insert into public.sellers(name,paypal_email,payout_hold_seconds) values ('Fixture evidence seller',$1,30) returning id", [email])).rows[0]!.id;
    for (const [id, name, price] of [['finance_payment_lookup', 'Fixture payment lookup', 2], ['finance_payment_bundle', 'Fixture payment bundle', 20]] as const) {
      await tx.query('insert into public.tools (id,seller_id,name,description,price_minor) values ($1,$2,$3,$3,$4) on conflict (id) do nothing', [id, seller, name, price]);
      const row = await tx.query('select 1 from public.tools where id=$1 and active and price_minor=$2', [id, price]);
      if (row.rowCount !== 1) throw new Error(`Existing ${id} differs from fixture registry`);
    }
    return seller;
  });
}
