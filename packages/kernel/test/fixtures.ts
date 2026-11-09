import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as kernel from '../src/index.ts';

// Hard-coded to the isolated Kernel container. No environment or remote URL is read.
export const admin = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:15433/postgres' });
export const db = new kernel.Database('postgres://kernel_login@127.0.0.1:15433/postgres');
export const prefix = randomUUID();
export let seller: string;

export async function seed() {
  seller = (await admin.query<{ id: string }>(
    "insert into public.sellers(name,paypal_email,payout_hold_seconds) values ('Fixture','fixture@example.test',30) returning id",
  )).rows[0]!.id;
  await admin.query("update public.kernel_settings set value='5 days' where key='created_at_slack'");
  for (const price of [100n, 300n, 700n, 1000n]) {
    await admin.query("insert into public.tools(id,seller_id,name,price_minor) values ($1,$2,'Fixture',$3)", [toolId(price), seller, price]);
  }
}

export const toolId = (price: bigint) => `${prefix}-${price}`;
export function usd(amount: bigint) {
  return { currency_code: 'USD', value: `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}` };
}
export function authorization(amount: bigint, ageDays = 0) {
  const created = Date.now() - ageDays * 86_400_000;
  return {
    id: randomUUID(), status: 'CREATED', amount: usd(amount),
    create_time: new Date(created).toISOString(),
    expiration_time: new Date(created + 29 * 86_400_000).toISOString(),
  };
}

export async function active(cap = 1000n, exposure = cap, ageDays = 0) {
  const lease = (await kernel.createLease(db, { buyer_ref: 'fixture', cap_minor: cap, unsettled_limit_minor: exposure })).id;
  const order = await kernel.beginPayPalCall(db, lease, 'create_order');
  await kernel.markCallSent(db, lease, order.call_id);
  const orderId = await kernel.recordOrder(db, lease, order.call_id, { http_status: 201, body: { id: randomUUID() } });
  const call = await kernel.beginPayPalCall(db, lease, 'authorize');
  await kernel.markCallSent(db, lease, call.call_id);
  const resource = authorization(cap, ageDays);
  const auth = await kernel.recordAuthorization(db, lease, call.call_id, {
    http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [resource] } }] },
  });
  return { lease, auth: auth.id, paypalAuth: resource.id };
}

export function commit(lease: string, price: bigint, key = randomUUID() as string) {
  return kernel.commitUsage(db, lease, { kind: 'tool', tool_id: toolId(price), idempotency_key: key });
}
export function completed(id: string, amount: bigint, fee = 0n): kernel.Evidence {
  return { http_status: 200, body: { id, status: 'COMPLETED', amount: usd(amount),
    seller_receivable_breakdown: { paypal_fee: usd(fee) } } };
}
export const voided = { http_status: 204, body: {} };
export function declined(id: string, amount: bigint): kernel.Evidence {
  return { http_status: 200, body: { id, status: 'DECLINED', amount: usd(amount) } };
}
export async function ledger(lease: string) {
  const rows = (await admin.query<{ account: string; amount: string }>(`select account,
    sum(case when (direction='C')=(account in ('BUYER_COMMITMENT','SELLER_PAYABLE'))
      then amount_minor else -amount_minor end) amount
    from public.ledger_entries where lease_id=$1 group by account`, [lease])).rows;
  return Object.fromEntries(rows.map(row => [row.account, BigInt(row.amount)]));
}
