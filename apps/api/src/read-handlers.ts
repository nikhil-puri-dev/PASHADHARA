import type { Database, Tx } from '../../../packages/kernel/src/db.ts';
import type { RouteHandler } from './routes.ts';

const accounts = ['buyer_commitment', 'hold_available', 'committed_unsettled', 'captured_gross',
  'paypal_fees', 'seller_cost', 'seller_payable', 'released', 'written_off', 'chargeback_loss', 'total_captured'];

function safeInteger(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Database integer exceeds API safe range');
  return result;
}

export async function readLeases(tx: Tx, lease: string | null) {
  const rows = await tx.query<{
    id: string; state: string; cap_minor: string; unsettled_limit_minor: string;
    guaranteed_now: boolean; authorizations: Record<string, string>[]; balances: Record<string, string>;
  }>(`select l.id,l.state,l.cap_minor,l.unsettled_limit_minor,
    exists (select 1 from public.authorizations a where a.lease_id=l.id
      and a.status in ('created','partially_captured') and a.honor_until>now()) as guaranteed_now,
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'paypal_authorization_id',a.paypal_authorization_id,'parent_id',a.parent_id,
      'amount_minor',a.amount_minor::text,'status',a.status,'honor_until',a.honor_until,'expires_at',a.expires_at
    ) order by a.created_at) from public.authorizations a where a.lease_id=l.id),'[]') as authorizations,
    (select coalesce(jsonb_object_agg(account,amount::text),'{}') from (
      select lower(e.account::text) as account, sum(case when e.direction =
        case when e.account in ('BUYER_COMMITMENT','SELLER_PAYABLE') then 'C' else 'D' end
        then e.amount_minor else -e.amount_minor end) as amount
      from public.ledger_entries e where e.lease_id=l.id group by e.account
      union all
      select 'total_captured',coalesce(sum(c.amount_minor),0) from public.captures c
        where c.lease_id=l.id and c.status in ('completed','reversed')
    ) totals) as balances
    from public.leases l where ($1::uuid is null or l.id=$1) order by l.created_at desc,l.id`, [lease]);
  return rows.rows.map(row => ({
    ...row, cap_minor: safeInteger(row.cap_minor), unsettled_limit_minor: safeInteger(row.unsettled_limit_minor),
    authorizations: row.authorizations.map(auth => ({ ...auth, amount_minor: safeInteger(auth.amount_minor!) })),
    balances: Object.fromEntries(accounts.map(account => [account, safeInteger(row.balances[account] ?? '0')])),
  }));
}

export async function readJournal(tx: Tx, lease: string, after = 0n) {
  if (after > 9223372036854775807n) return [];
  const result = await tx.query<{ id: string; amount_minor: string; created_at: Date } & Record<string, unknown>>(
    `select id,group_id,account,direction,amount_minor,ref_type,ref_id,created_at
     from public.ledger_entries where lease_id=$1 and id>$2 order by id`, [lease, after < 0n ? '0' : after.toString()],
  );
  return result.rows.map(row => ({ ...row, id: safeInteger(row.id), amount_minor: safeInteger(row.amount_minor), created_at: row.created_at.toISOString() }));
}

/** The authenticator must authorize the principal for every path and body identifier. */
export function readHandlers(db: Database): Record<string, RouteHandler> {
  return {
    getLease: async ({ params }) => {
      const [lease] = await db.transaction(null, tx => readLeases(tx, params.leaseId!));
      return lease ? { status: 200, body: lease } : {
        status: 404, body: { type: 'about:blank', title: 'Lease not found', status: 404 },
      };
    },
    listLeases: async () => ({ status: 200, body: { leases: await db.transaction(null, tx => readLeases(tx, null)) } }),
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
      body: { entries: await db.transaction(null, tx => readJournal(tx, params.leaseId!, BigInt(query.after ?? '0'))) },
    }),
  };
}
