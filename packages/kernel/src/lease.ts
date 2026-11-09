import { randomUUID } from 'node:crypto';
import { type Database, one, type Tx } from './db.ts';
import { finish, intent, isSuccess, loadCall, objectField, paypalMinor, stringField, type Call, type Evidence } from './calls.ts';
import { balances, post } from './journal.ts';

type LiveAuthorization = { id: string; paypal_authorization_id: string };

export function createLease(db: Database, input: { buyer_ref: string; cap_minor: bigint; unsettled_limit_minor: bigint }) {
  return db.transaction(null, tx => one<{ id: string }>(tx, `insert into public.leases
    (buyer_ref,cap_minor,unsettled_limit_minor) values ($1,$2,$3) returning id`,
  [input.buyer_ref, input.cap_minor, input.unsettled_limit_minor]));
}

export function beginPayPalCall(db: Database, lease: string, op: 'create_order' | 'authorize' | 'get', request: string = randomUUID()) {
  return db.transaction(lease, async (tx, state) => {
    if (op !== 'get' && state !== 'pending_approval') throw new Error('Lease is no longer awaiting approval');
    if (op !== 'get') {
      const open = await tx.query(`select 1 from public.paypal_calls
        where lease_id=$1 and op in ('create_order','authorize') and state in ('intent','sent','unknown')`, [lease]);
      if (open.rowCount) throw new Error('Lease already has an unresolved approval call');
      const row = await one<{ paypal_order_id: string | null }>(tx,
        'select paypal_order_id from public.leases where id=$1', [lease]);
      if ((op === 'authorize') !== (row.paypal_order_id !== null)) throw new Error('Order state does not allow this operation');
    }
    return intent(tx, lease, op, request, null);
  });
}

export function recordOrder(db: Database, lease: string, callId: string, evidence: Evidence) {
  return db.transaction(lease, async tx => {
    const call = await loadCall(tx, lease, callId);
    if (call.op !== 'create_order' || call.state !== 'sent' || !isSuccess(evidence) || 'source' in evidence) {
      throw new Error('Expected the direct response to the sent PayPal order creation');
    }
    const order = stringField(evidence.body.id);
    await finish(tx, call, 'succeeded', evidence);
    await tx.query('update public.leases set paypal_order_id=$2 where id=$1', [lease, order]);
    return order;
  });
}

function liveAuthorization(tx: Tx, lease: string) {
  return one<LiveAuthorization>(tx, `select id,paypal_authorization_id from public.authorizations
    where lease_id=$1 and status in ('created','partially_captured')`, [lease]);
}

function authorizationFields(evidence: Evidence, resource: unknown) {
  const auth = objectField(resource);
  const money = objectField(auth.amount);
  if (!isSuccess(evidence) || auth.status !== 'CREATED' || money.currency_code !== 'USD') {
    throw new Error('Expected a created USD PayPal authorization');
  }
  return {
    id: stringField(auth.id), amount: paypalMinor(money.value),
    created: stringField(auth.create_time), expires: stringField(auth.expiration_time),
  };
}

async function addAuthorization(tx: Tx, lease: string, data: ReturnType<typeof authorizationFields>, parent: string | null) {
  return one<{ id: string }>(tx, `insert into public.authorizations
    (lease_id,parent_id,paypal_authorization_id,amount_minor,status,created_at,honor_until,expires_at)
    values ($1,$2,$3,$4,'created',$5::timestamptz,$5::timestamptz + interval '3 days',$6) returning id`,
  [lease, parent, data.id, data.amount, data.created, data.expires]);
}

export function recordAuthorization(db: Database, lease: string, callId: string, evidence: Evidence) {
  return db.transaction(lease, async tx => {
    const call = await loadCall(tx, lease, callId);
    if (call.op !== 'authorize') throw new Error('Expected an authorize call');
    const order = await one<{ paypal_order_id: string }>(tx, 'select paypal_order_id from public.leases where id=$1', [lease]);
    if (evidence.body.id !== order.paypal_order_id || evidence.body.status !== 'COMPLETED') {
      throw new Error('PayPal authorization evidence is for a different or incomplete order');
    }
    const units = evidence.body.purchase_units;
    if (!Array.isArray(units) || units.length !== 1) throw new Error('Expected exactly one PayPal purchase unit');
    const resources = objectField(objectField(units[0]).payments).authorizations;
    if (!Array.isArray(resources) || resources.length !== 1) throw new Error('Expected exactly one PayPal authorization');
    const data = authorizationFields(evidence, resources[0]);
    await finish(tx, call, 'succeeded', evidence);
    const auth = await addAuthorization(tx, lease, data, null);
    await post(tx, lease, 'authorize', auth.id, data.amount);
    await tx.query("update public.leases set state='active' where id=$1", [lease]);
    return auth;
  });
}

export function beginReauthorize(db: Database, lease: string, request: string = randomUUID()) {
  return db.transaction(lease, async (tx, state) => {
    if (state !== 'active') throw new Error('Lease is not active');
    const parent = await one<LiveAuthorization & { remaining: string }>(tx, `with recursive chain as (
      select id,parent_id,0 as depth from public.authorizations where lease_id=$1 and status in ('created','partially_captured')
      union all select a.id,a.parent_id,c.depth+1 from public.authorizations a join chain c on a.id=c.parent_id
    )
    select a.id,a.paypal_authorization_id,l.cap_minor-coalesce((select sum(c.amount_minor)
      from public.captures c where c.lease_id=l.id and c.status in ('completed','reversed')),0) as remaining
    from public.authorizations a join public.leases l on l.id=a.lease_id
    where a.lease_id=$1 and a.status in ('created','partially_captured')
      and a.honor_until<=clock_timestamp() and a.expires_at>clock_timestamp()
      and (select max(depth) from chain)<public.setting('max_reauth_depth')::integer
      and not exists (select 1 from public.captures where lease_id=$1 and status in ('intent','pending','unknown'))`, [lease]);
    const amount = BigInt(parent.remaining);
    const call = await intent(tx, lease, 'reauthorize', request, amount);
    return { ...call, authorization_id: parent.id, paypal_authorization_id: parent.paypal_authorization_id, amount_minor: amount };
  });
}

export async function finishReauthorize(tx: Tx, lease: string, call: Call, evidence: Evidence) {
  if (call.op !== 'reauthorize') throw new Error('Expected a reauthorize call');
  if (call.state !== 'sent' || 'source' in evidence) throw new Error('Cannot correlate a replacement authorization GET to this intent');
  const parent = await liveAuthorization(tx, lease);
  const data = authorizationFields(evidence, evidence.body);
  if (call.amount_minor === null || data.id === parent.paypal_authorization_id || data.amount !== BigInt(call.amount_minor)) {
    throw new Error('PayPal reauthorization does not match its intent');
  }
  await finish(tx, call, 'succeeded', evidence);
  await tx.query("update public.authorizations set status='superseded' where id=$1", [parent.id]);
  return addAuthorization(tx, lease, data, parent.id);
}

export function completeReauthorize(db: Database, lease: string, callId: string, evidence: Evidence) {
  return db.transaction(lease, async tx => finishReauthorize(tx, lease, await loadCall(tx, lease, callId), evidence));
}

export function beginVoid(db: Database, lease: string, request: string = randomUUID()) {
  return db.transaction(lease, async tx => {
    if ((await balances(tx, lease)).committed !== 0n) throw new Error('Settle or return commitments before voiding the authorization');
    const auth = await liveAuthorization(tx, lease);
    const call = await intent(tx, lease, 'void', request, null);
    return { ...call, authorization_id: auth.id, paypal_authorization_id: auth.paypal_authorization_id };
  });
}

export async function finishVoid(tx: Tx, lease: string, call: Call, evidence: Evidence) {
  if (call.op !== 'void' || !isSuccess(evidence)) throw new Error('Expected successful PayPal void evidence');
  const auth = await liveAuthorization(tx, lease);
  if ('source' in evidence || evidence.http_status !== 204) {
    if (evidence.body.id !== auth.paypal_authorization_id || evidence.body.status !== 'VOIDED') {
      throw new Error('PayPal void evidence names a different authorization or status');
    }
  }
  const { hold, committed } = await balances(tx, lease);
  if (committed !== 0n) throw new Error('Lease still has unsettled commitments');
  await finish(tx, call, 'succeeded', evidence);
  await tx.query("update public.authorizations set status='voided' where id=$1", [auth.id]);
  if (hold > 0n) await post(tx, lease, 'void', call.id, hold);
}

export function completeVoid(db: Database, lease: string, callId: string, evidence: Evidence) {
  return db.transaction(lease, async tx => finishVoid(tx, lease, await loadCall(tx, lease, callId), evidence));
}

export function closeLease(db: Database, lease: string) {
  return db.transaction(lease, async (tx, state) => {
    if (state !== 'closed') await tx.query("update public.leases set state='closed',closed_at=clock_timestamp() where id=$1", [lease]);
  });
}
