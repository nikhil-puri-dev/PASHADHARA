import { one, type JsonObject, type Tx } from './db.ts';

export type Operation = 'create_order' | 'authorize' | 'capture' | 'reauthorize' | 'void' | 'payout' | 'get';
export type Intent = { call_id: string; request_id: string };
export type Evidence = { http_status: number; body: JsonObject };
export type ReadEvidence = Evidence & { source: 'get' };
export type Call = {
  id: string;
  request_id: string;
  op: Operation;
  state: 'intent' | 'sent' | 'unknown' | 'succeeded' | 'failed';
  amount_minor: string | null;
};

export function intent(db: Tx, lease: string, op: Operation, request: string, amount: bigint | null) {
  return one<Intent>(db, `insert into public.paypal_calls (lease_id,op,request_id,amount_minor,state)
    values ($1,$2,$3,$4,'intent') returning id as call_id, request_id`, [lease, op, request, amount]);
}

export function loadCall(db: Tx, lease: string, id: string) {
  return one<Call>(db, 'select id,request_id,op,state,amount_minor from public.paypal_calls where lease_id=$1 and id=$2', [lease, id]);
}

export async function sent(db: Tx, lease: string, id: string) {
  return (await db.query(`update public.paypal_calls set state='sent',sent_at=clock_timestamp()
    where lease_id=$1 and id=$2 and state='intent'`, [lease, id])).rowCount === 1;
}

export async function finish(db: Tx, call: Call, state: 'succeeded' | 'failed', evidence: Evidence) {
  if (call.state !== 'sent' && call.state !== 'unknown') throw new Error('PayPal call is not awaiting a result');
  if (call.state === 'unknown' && (!('source' in evidence) || evidence.source !== 'get')) {
    throw new Error('An unknown call needs a fresh PayPal GET');
  }
  await db.query(`update public.paypal_calls set state=$2,response=$3,http_status=$4,resolved_at=clock_timestamp()
    where id=$1`, [call.id, state, JSON.stringify(evidence.body), evidence.http_status]);
}

export function isSuccess(evidence: Evidence) {
  return evidence.http_status >= 200 && evidence.http_status < 300;
}

export function stringField(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing PayPal response field');
  return value;
}

export function objectField(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing PayPal response object');
  return value as JsonObject;
}

export function paypalMinor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+\.[0-9]{2}$/.test(value)) {
    throw new Error('PayPal money must be an exact two-decimal string');
  }
  return BigInt(value.replace('.', ''));
}
