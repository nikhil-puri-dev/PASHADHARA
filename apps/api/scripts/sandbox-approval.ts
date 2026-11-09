import { createLease, beginPayPalCall, markCallSent, markUnknown, recordOrder, recordRejectedCall, type Database, type Evidence, type Intent } from '../../../packages/kernel/src/index.ts';
import { finish, loadCall, objectField } from '../../../packages/kernel/src/calls.ts';
import { PayPalClient, PayPalError, type PayPalResult } from '../../../packages/paypal/src/index.ts';
import { approvalUrl, resourceId } from './sandbox-evidence.ts';
import { setTimeout as sleep } from 'node:timers/promises';

export const usd = (cents: bigint) => ({ currency_code: 'USD', value: (cents / 100n) + '.' + (cents % 100n).toString().padStart(2, '0') });
export class RunStop extends Error {}

export function kernelCalls(db: Database, stop: () => void, withIntent: <T>(lease: string, intent: Intent, work: () => Promise<T>) => Promise<T>) {
  async function dispatch<T>(lease: string, call: Intent, send: () => Promise<PayPalResult>, apply: (evidence: Evidence) => Promise<T>, alreadySent = false) {
    if (!alreadySent && !await markCallSent(db, lease, call.call_id)) throw new RunStop('Kernel did not claim intent');
    try {
      const result = await withIntent(lease, call, send);
      return await apply({ http_status: result.status, body: result.status === 204 && result.body === null ? {} : objectField(result.body) });
    } catch (error) {
      stop();
      if (error instanceof PayPalError) {
        try {
          await recordRejectedCall(db, lease, call.call_id, { http_status: error.status, body: objectField(error.body) });
        } catch {
          await markUnknown(db, lease, call.call_id);
          throw new RunStop('PayPal response did not establish a definitive outcome');
        }
        throw new RunStop('PayPal rejected the request');
      }
      await markUnknown(db, lease, call.call_id);
      throw new RunStop('PayPal outcome unknown or evidence could not be applied');
    }
  }
  async function read(lease: string, resource: string, send: () => Promise<PayPalResult>, identity: (e: Evidence) => unknown = e => e.body.id) {
    const call = await beginPayPalCall(db, lease, 'get');
    return dispatch(lease, call, send, async evidence => {
      if (identity(evidence) !== resource) throw new Error('PayPal GET resource differs from request');
      await db.transaction(lease, async tx => finish(tx, await loadCall(tx, lease, call.call_id), 'succeeded', evidence));
      return evidence;
    });
  }
  return { dispatch, read };
}

export function checkOrder(body: Evidence['body']) {
  const units = body.purchase_units;
  if (body.intent !== 'AUTHORIZE' || !Array.isArray(units) || units.length !== 1) throw new RunStop('Order intent or purchase units differ');
  const amount = objectField(objectField(units[0]).amount);
  if (amount.currency_code !== 'USD' || amount.value !== '20.00') throw new RunStop('Order amount differs from USD 20.00');
  return body.status;
}

export async function requestApproval(db: Database, paypal: PayPalClient, calls: ReturnType<typeof kernelCalls>) {
  const { id: lease } = await createLease(db, { buyer_ref: 'rails-sandbox-runner', cap_minor: 2000n, unsettled_limit_minor: 500n });
  const call = await beginPayPalCall(db, lease, 'create_order');
  return calls.dispatch(lease, call, () => paypal.createOrder(usd(2000n), 'http://127.0.0.1:32181/approved', 'http://127.0.0.1:32181/cancelled', call.request_id), async evidence => {
    const order = resourceId.parse(evidence.body.id);
    const status = checkOrder(evidence.body);
    if (status !== 'CREATED' && status !== 'PAYER_ACTION_REQUIRED') throw new RunStop('Order was not created in an approvable state');
    const url = approvalUrl(evidence.body, order);
    await recordOrder(db, lease, call.call_id, evidence);
    return { lease, order, url };
  });
}

export async function awaitApproval(check: () => Promise<unknown>, mayPoll: () => boolean, wait: (ms: number) => Promise<void> = sleep, now = Date.now) {
  const deadline = now() + 20 * 60_000;
  let next = now() + 15_000;
  while (mayPoll() && next + 10_000 <= deadline) {
    await wait(Math.max(0, next - now()));
    if (now() + 10_000 > deadline) break;
    const status = await check();
    if (status === 'APPROVED') return true;
    if (status !== 'CREATED' && status !== 'PAYER_ACTION_REQUIRED') throw new RunStop('Unexpected order status during approval');
    next += 15_000;
  }
  return false;
}
