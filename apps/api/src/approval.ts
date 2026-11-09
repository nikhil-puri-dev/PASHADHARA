import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import {
  beginPayPalCall, createLease, markCallSent, markUnknown, recordAuthorization, recordOrder, recordRejectedCall,
  type Database, type Evidence, type Intent, type ReadEvidence,
} from '../../../packages/kernel/src/index.ts';
import { isSuccess, objectField, paypalMinor, stringField } from '../../../packages/kernel/src/calls.ts';
import type { LeaseState } from '../../../packages/kernel/src/db.ts';
import { PayPalError, type PayPalClient, type PayPalResult } from '../../../packages/paypal/src/index.ts';
import { deriveKey, isUuid, issueToken, leaseEnd, signatureMatches } from './auth.ts';
import { API_BASE_PATH, type RouteHandler } from './routes.ts';
import { ApiError, logError } from './request-log.ts';

type Gateway = Pick<PayPalClient, 'createOrder' | 'getOrder' | 'authorize'>;
type ApprovalState = LeaseState | 'unknown' | 'not_ready' | 'not_found';
type ApprovalCall = Intent & { state: 'intent' | 'sent' | 'unknown' };
type ApprovalLease = { id: string; state: LeaseState; cap_minor: string; paypal_order_id: string | null; created_at: Date };
type CallbackAction = 'return' | 'cancel';
const usd = (amount: bigint) => ({ currency_code: 'USD', value: `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}` });
const evidenceOf = (result: PayPalResult): Evidence => ({ http_status: result.status, body: objectField(result.body) });
const problem = (status: number, title: string) => ({ status, body: { type: 'about:blank', status, title } });

function readOrder(evidence: Evidence, cap: bigint, expectedId?: string) {
  const { body } = evidence;
  const id = stringField(body.id);
  if (!isSuccess(evidence) || (expectedId !== undefined && id !== expectedId) || body.intent !== 'AUTHORIZE'
    || !Array.isArray(body.purchase_units) || body.purchase_units.length !== 1) {
    throw new ApiError('PayPal order does not match the lease');
  }
  const amount = objectField(objectField(body.purchase_units[0]).amount);
  if (amount.currency_code !== 'USD' || paypalMinor(amount.value) !== cap) throw new ApiError('PayPal order amount does not match the lease');
  return id;
}

function approvalUrl(evidence: Evidence, orderId: string) {
  const url = `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(orderId)}`;
  if (!Array.isArray(evidence.body.links) || !evidence.body.links.some(link => {
    const fields = objectField(link);
    return (fields.rel === 'approve' || fields.rel === 'payer-action') && fields.href === url;
  })) throw new ApiError('PayPal did not return a sandbox approval link');
  return url;
}

function callbackBase(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new ApiError('API_BASE_URL requires HTTPS outside loopback');
  }
  if (url.username || url.password || url.pathname.replace(/\/$/, '') !== API_BASE_PATH || url.search || url.hash) {
    throw new ApiError('API_BASE_URL must be the site origin plus /api');
  }
  return url.origin + API_BASE_PATH;
}

export function approvalFlow(db: Database, paypal: Gateway, baseUrl: string, leaseSecret: string, getLease: RouteHandler) {
  const callbackKey = deriveKey(leaseSecret, 'paypal-callback');
  const sign = (action: CallbackAction, lease: string) => createHmac('sha256', callbackKey).update(`${action}:${lease.toLowerCase()}`).digest();
  const callback = (base: string, action: CallbackAction, lease: string) =>
    `${base}/paypal/${action}/${lease}?sig=${sign(action, lease).toString('base64url')}`;
  const snapshot = (lease: string) => db.transaction(null, async tx => (await tx.query<ApprovalLease & { open: ApprovalCall | null }>(`
    select l.id,l.state,l.cap_minor,l.paypal_order_id,l.created_at,(
      select row_to_json(a) from (
        select id as call_id,request_id,state from public.paypal_calls
        where lease_id=l.id and op='authorize' and state in ('intent','sent','unknown')
      ) a
    ) as open from public.leases l where l.id=$1`, [lease])).rows[0]);

  async function definitiveRejection(lease: string, call: Intent, error: unknown) {
    if (!(error instanceof PayPalError)) return false;
    try {
      await recordRejectedCall(db, lease, call.call_id, evidenceOf(error));
      return true;
    } catch { return false; }
  }

  const create: RouteHandler = async ({ body }) => {
    const input = body as { buyer_ref: string; cap_minor: number; unsettled_limit_minor?: number };
    const cap = BigInt(input.cap_minor);
    const limit = input.unsettled_limit_minor === undefined ? cap / 2n : BigInt(input.unsettled_limit_minor);
    if (limit > cap) return problem(422, 'Unsettled limit exceeds lease cap');
    const base = callbackBase(baseUrl);
    const { id: lease } = await createLease(db, { buyer_ref: input.buyer_ref, cap_minor: cap, unsettled_limit_minor: limit });
    const saved = await snapshot(lease);
    if (!saved) throw new ApiError('Created lease could not be read');
    const call = await beginPayPalCall(db, lease, 'create_order');
    if (!await markCallSent(db, lease, call.call_id)) throw new ApiError('Order intent was not claimed');
    try {
      const evidence = evidenceOf(await paypal.createOrder(usd(cap), callback(base, 'return', lease),
        callback(base, 'cancel', lease), call.request_id));
      const orderId = readOrder(evidence, cap);
      if (!['CREATED', 'PAYER_ACTION_REQUIRED'].includes(String(evidence.body.status))) throw new ApiError('Order is not approvable');
      const url = approvalUrl(evidence, orderId);
      await recordOrder(db, lease, call.call_id, evidence);
      return { status: 201, body: { lease_id: lease, lease_token: issueToken(leaseSecret, 'lease', lease, leaseEnd(saved.created_at)), paypal_order_id: orderId, approve_url: url } };
    } catch (error) {
      if (await definitiveRejection(lease, call, error)) return problem(422, 'PayPal rejected order creation');
      await markUnknown(db, lease, call.call_id);
      throw error;
    }
  };

  async function approve(lease: string): Promise<ApprovalState> {
    const row = await snapshot(lease);
    if (!row?.paypal_order_id) return 'not_found';
    if (row.state !== 'pending_approval') return row.state;
    if (Date.now() >= leaseEnd(row.created_at) * 1000) return 'expired';
    const order = row.paypal_order_id;
    const evidence: ReadEvidence = { ...evidenceOf(await paypal.getOrder(order)), source: 'get' };
    readOrder(evidence, BigInt(row.cap_minor), order);
    if (evidence.body.status === 'COMPLETED') {
      const current = await snapshot(lease);
      if (current?.state === 'active') return 'active';
      if (!current?.open || current.open.state === 'intent') return 'unknown';
      try { await recordAuthorization(db, lease, current.open.call_id, evidence); }
      catch (error) { if ((await snapshot(lease))?.state !== 'active') throw error; }
      return 'active';
    }
    if (row.open && row.open.state !== 'intent') return 'unknown';
    if (evidence.body.status !== 'APPROVED') return 'not_ready';
    let call: Intent;
    try { call = row.open ?? await beginPayPalCall(db, lease, 'authorize'); }
    catch (error) {
      const current = await snapshot(lease);
      if (current?.state === 'active') return 'active';
      if (current?.open) return 'unknown';
      throw error;
    }
    if (!await markCallSent(db, lease, call.call_id)) return (await snapshot(lease))?.state === 'active' ? 'active' : 'unknown';
    try {
      const result = evidenceOf(await paypal.authorize(order, call.request_id));
      await recordAuthorization(db, lease, call.call_id, result);
      return 'active';
    } catch (error) {
      if (await definitiveRejection(lease, call, error)) return 'not_ready';
      try { await markUnknown(db, lease, call.call_id); }
      catch (writeError) { if ((await snapshot(lease))?.state !== 'active') throw writeError; }
      return (await snapshot(lease))?.state === 'active' ? 'active' : 'unknown';
    }
  }

  const authorize: RouteHandler = async input => {
    const state = await approve(input.params.leaseId!);
    if (state === 'active') return getLease(input);
    if (state === 'unknown') throw new ApiError('Authorization outcome unknown');
    return problem(409, 'Lease has no confirmed approval');
  };

  const callbacks = new Hono();
  for (const action of ['return', 'cancel'] as const) {
    callbacks.get(`/paypal/${action}/:leaseId`, async c => {
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      if (c.req.raw.method !== 'GET') return c.body(null, 405);
      const lease = c.req.param('leaseId');
      const sig = c.req.query('sig') ?? '';
      if (!isUuid(lease) || !signatureMatches(sign(action, lease), sig)) return c.body(null, 400);
      if (action === 'return') {
        try {
          // Only the signed lease selects the stored order. PayPal query parameters are ignored.
          if (await approve(lease) === 'unknown') throw new ApiError('Authorization outcome unknown');
        } catch (error) { logError(c.req.raw, 'paypalReturn', error); }
      }
      return c.redirect('/', 303);
    });
  }
  return { create, authorize, callbacks };
}
