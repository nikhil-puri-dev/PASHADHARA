import type { Database } from '../../../packages/kernel/src/db.ts';
import type { RouteHandler } from './routes.ts';

function safeInteger(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Database integer exceeds API safe range');
  return result;
}

/** The authenticator must authorize the principal for every path and body identifier. */
export function readHandlers(db: Database): Record<string, RouteHandler> {
  return {
    listTools: async () => ({
      status: 200,
      body: { tools: await db.transaction(null, async tx => {
        const result = await tx.query<{ id: string; name: string; description: string; price_minor: string; seller_id: string }>(
          'select id,name,description,price_minor,seller_id from public.tools where active order by id',
        );
        return result.rows.map(row => ({ ...row, price_minor: safeInteger(row.price_minor) }));
      }) },
    }),
    getJournal: async ({ params, query }) => ({
      status: 200,
      body: { entries: await db.transaction(null, async tx => {
        const after = BigInt(query.after ?? '0');
        if (after > 9223372036854775807n) return [];
        const result = await tx.query<{ id: string; amount_minor: string; created_at: Date } & Record<string, unknown>>(
          `select id,group_id,account,direction,amount_minor,ref_type,ref_id,created_at
           from public.ledger_entries where lease_id=$1 and id>$2 order by id`, [params.leaseId, after < 0n ? '0' : after.toString()],
        );
        return result.rows.map(row => ({ ...row, id: safeInteger(row.id), amount_minor: safeInteger(row.amount_minor), created_at: row.created_at.toISOString() }));
      }) },
    }),
  };
}
