import type { Database } from '../../../packages/kernel/src/db.ts';

type Money = { currency_code?: string; value?: string };
export type Resource = { id?: string; status?: string; amount?: Money; invoice_id?: string; final_capture?: boolean; seller_receivable_breakdown?: { paypal_fee?: Money } };
export type Comparison = { field: string; ours: string | null; paypal: string | null; match: boolean; ours_provenance: 'computed'; paypal_provenance: 'measured' | 'fixture' | 'computed' };

function cents(value: Money | undefined): string | null {
  if (value?.currency_code !== 'USD' || typeof value.value !== 'string' || !/^\d+\.\d{2}$/.test(value.value)) return null;
  return BigInt(value.value.replace('.', '')).toString();
}

export async function compareJournal(db: Database, lease: string, authorization: Resource, capture: Resource | readonly Resource[], provenance: 'measured' | 'fixture'): Promise<Comparison[]> {
  const rows = await db.transaction(null, async tx => {
    const result = await tx.query<{ auth_id: string; auth_status: string; capture_id: string; invoice_id: string; capture_status: string; auth_amount: string | null; capture_amount: string | null; fee: string | null }>(`select a.paypal_authorization_id auth_id, a.status auth_status, c.paypal_capture_id capture_id, c.id::text invoice_id, c.status capture_status,
      (select sum(amount_minor)::text from public.ledger_entries where lease_id=$1 and ref_type='authorize' and ref_id=a.id::text and account='HOLD_AVAILABLE' and direction='D') auth_amount,
      (select sum(amount_minor)::text from public.ledger_entries where lease_id=$1 and ref_type='capture' and ref_id=c.id::text and account='CAPTURED_GROSS' and direction='D') capture_amount,
      coalesce((select sum(amount_minor)::text from public.ledger_entries where lease_id=$1 and ref_type='capture' and ref_id=c.id::text and account='PAYPAL_FEES' and direction='D'),'0') fee
      from public.authorizations a join public.captures c on c.authorization_id=a.id and c.lease_id=a.lease_id where a.lease_id=$1 order by c.id`, [lease]);
    if (!result.rows.length || result.rows.some(row => row.auth_id !== result.rows[0].auth_id)) throw new Error('Expected captures against exactly one authorization');
    return result.rows;
  });
  const reads: readonly Resource[] = Array.isArray(capture) ? capture : [capture as Resource];
  if (!Array.isArray(capture) && rows.length !== 1) throw new Error('Multiple captures require one GET per capture');
  const row = rows[0];
  const fields: [string, string | null, string | null][] = [
    ['authorization.id', row.auth_id, authorization.id ?? null],
    ['authorization.status', row.auth_status.toUpperCase(), authorization.status ?? null],
    ['authorization.amount_minor', row.auth_amount, cents(authorization.amount)],
  ];
  if (Array.isArray(capture)) fields.push(['captures.get_count', String(rows.length), String(reads.length)]);
  for (const stored of rows) {
    const matching = reads.filter(read => read.id === stored.capture_id);
    const read = Array.isArray(capture) ? (matching.length === 1 ? matching[0] : undefined) : reads[0];
    const prefix = Array.isArray(capture) ? `capture[${stored.capture_id ?? 'unresolved'}]` : 'capture';
    fields.push(
      [prefix + '.id', stored.capture_id, read?.id ?? null],
      [prefix + '.status', stored.capture_status.toUpperCase(), read?.status ?? null],
      [prefix + '.amount_minor', stored.capture_amount, cents(read?.amount)],
      [prefix + '.fee_minor', stored.fee, cents(read?.seller_receivable_breakdown?.paypal_fee)],
    );
    if (Array.isArray(capture)) fields.push(
      [prefix + '.invoice_id', stored.invoice_id, read?.invoice_id ?? null],
      [prefix + '.final_capture', 'false', typeof read?.final_capture === 'boolean' ? String(read.final_capture) : null],
    );
  }
  return fields.map(([field, ours, paypal]) => ({ field, ours, paypal, match: ours !== null && paypal !== null && ours === paypal, ours_provenance: 'computed', paypal_provenance: field === 'captures.get_count' && provenance === 'measured' ? 'computed' : provenance }));
}
