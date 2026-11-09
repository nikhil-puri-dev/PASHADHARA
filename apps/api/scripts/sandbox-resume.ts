import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Database } from '../../../packages/kernel/src/index.ts';
import { checkOrder, RunStop } from './sandbox-approval.ts';
import { LIMIT, resourceId } from './sandbox-evidence.ts';
import { objectField } from '../../../packages/kernel/src/calls.ts';

const row = z.object({
  call: z.number().int().positive(), op: z.enum(['oauth', 'create_order', 'get_order', 'authorize']),
  lease: z.string().uuid().optional(), call_id: z.string().uuid().optional(), request_id: z.string().uuid().optional(),
  event: z.enum(['dispatch', 'response']), http_status: z.union([z.number().int().min(200).max(299), z.literal(422)]).optional(),
  body: z.unknown().optional(), body_rejected: z.never().optional(),
});

function approvalRejection(body: unknown) {
  const error = objectField(body);
  const details = error.details;
  return error.name === 'UNPROCESSABLE_ENTITY' && Array.isArray(details) && details.length === 1 &&
    objectField(details[0]).issue === 'ORDER_NOT_APPROVED';
}

export function pausedApproval(log: string) {
  const entries = log.trim().split('\n').map(line => row.parse(JSON.parse(line)));
  if (entries.length < 6 || entries.length % 2 !== 0 || entries.length > LIMIT * 2) throw new RunStop('Approval evidence has incomplete calls');
  const expected = ['oauth', 'create_order'];
  const calls = [];
  const ids = new Set<string>();
  const requests = new Set<string>();
  let lease: string | undefined;
  let order: string | undefined;
  let status: unknown;
  let rejected = false;
  let rereadToken = false;
  for (let i = 0; i < entries.length; i += 2) {
    const [dispatch, response] = entries.slice(i, i + 2);
    const op = expected[i / 2] ?? (status === 'APPROVED' ? 'authorize' : rejected && !rereadToken ? 'oauth' : 'get_order');
    if (dispatch.call !== i / 2 + 1 || response.call !== dispatch.call || dispatch.event !== 'dispatch' || response.event !== 'response' ||
      dispatch.op !== op || response.op !== op || !response.http_status || dispatch.lease !== response.lease ||
      dispatch.call_id !== response.call_id || dispatch.request_id !== response.request_id) throw new RunStop('Approval call evidence does not pair');
    if (op === 'oauth') {
      if (response.http_status === 422 || dispatch.lease || dispatch.call_id || dispatch.request_id) throw new RunStop('Unexpected OAuth history');
      if (rejected) rereadToken = true;
      continue;
    }
    const body = objectField(response.body);
    if (op === 'authorize') {
      if (rejected || response.http_status !== 422 || !approvalRejection(body)) throw new RunStop('Authorization outcome prevents recovery');
      rejected = true;
      status = undefined;
    } else {
      if (response.http_status === 422) throw new RunStop('Order evidence was rejected');
      status = checkOrder(body);
      if (status !== 'CREATED' && status !== 'PAYER_ACTION_REQUIRED' && !(op === 'get_order' && !rejected && status === 'APPROVED')) {
        throw new RunStop('Approval pause had an unexpected order state');
      }
      lease ??= dispatch.lease;
      order ??= resourceId.parse(body.id);
      if (order !== body.id) throw new RunStop('Approval history names a different order');
    }
    if (!lease || dispatch.lease !== lease || !dispatch.call_id || !dispatch.request_id) throw new RunStop('Approval history names a different resource');
    if (ids.has(dispatch.call_id) || requests.has(dispatch.request_id)) throw new RunStop('Approval call identifiers repeat');
    ids.add(dispatch.call_id);
    requests.add(dispatch.request_id);
    calls.push({ ...dispatch, http_status: response.http_status, body });
  }
  if (!lease || !order || (status !== 'CREATED' && status !== 'PAYER_ACTION_REQUIRED')) throw new RunStop('Approval pause had an unexpected order state');
  return { lease, order, calls, used: entries.length / 2, rejected };
}

export async function resumeApproval(db: Database, file: URL) {
  const paused = pausedApproval(readFileSync(file, 'utf8'));
  await db.transaction(null, async tx => {
    const lease = await tx.query(`select 1 from public.leases l where id=$1 and paypal_order_id=$2 and buyer_ref='rails-sandbox-runner'
      and state='pending_approval' and cap_minor=2000 and unsettled_limit_minor=500
      and not exists(select 1 from public.authorizations a where a.lease_id=l.id)`, [paused.lease, paused.order]);
    const rows = await tx.query('select id,request_id,op,state,http_status,response from public.paypal_calls where lease_id=$1', [paused.lease]);
    if (lease.rowCount !== 1 || rows.rows.length !== paused.calls.length || paused.calls.some(call => !rows.rows.some(saved =>
      saved.id === call.call_id && saved.request_id === call.request_id && saved.op === (call.op === 'get_order' ? 'get' : call.op) &&
      saved.http_status === call.http_status && (call.op === 'authorize'
        ? saved.state === 'failed' && approvalRejection(saved.response)
        : saved.state === 'succeeded' && objectField(saved.response).id === call.body.id &&
          checkOrder(objectField(saved.response)) === call.body.status)))) throw new RunStop('Kernel approval history differs from evidence');
  });
  return paused;
}
