import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import type { Intent } from '../../../packages/kernel/src/index.ts';
import { oneShotFetch } from './one-shot-fetch.ts';

export const LIMIT = 25;
const origin = 'https://api-m.sandbox.paypal.com';
export const resourceId = z.string().regex(/^[A-Z0-9]{8,32}$/);
const code = z.string().regex(/^[A-Z][A-Z_0-9]{0,79}$/);
const timestamp = z.string().datetime({ offset: true });
const value = z.string().regex(/^\d{1,15}\.\d{2}$/);
const money = z.object({ value: value.optional(), currency_code: z.literal('USD').optional(), currency: z.literal('USD').optional() });
const resource = z.object({
  id: resourceId.optional(), status: code.optional(), amount: money.optional(),
  create_time: timestamp.optional(), update_time: timestamp.optional(), expiration_time: timestamp.optional(),
  invoice_id: z.string().uuid().optional(), final_capture: z.boolean().optional(),
  seller_receivable_breakdown: z.object({ gross_amount: money.optional(), paypal_fee: money.optional(), net_amount: money.optional() }).optional(),
});
const bodySchema = resource.extend({
  intent: z.literal('AUTHORIZE').optional(), name: code.optional(), debug_id: z.string().regex(/^[a-f0-9]{8,32}$/i).optional(),
  details: z.array(z.object({ issue: code })).max(20).optional(),
  purchase_units: z.array(z.object({
    amount: money.optional(),
    payments: z.object({ authorizations: z.array(resource).max(25).optional(), captures: z.array(resource).max(25).optional() }).optional(),
  })).max(1).optional(),
  batch_header: z.object({
    payout_batch_id: resourceId.optional(), batch_status: code.optional(), amount: money.optional(), fees: money.optional(),
    sender_batch_header: z.object({ sender_batch_id: z.string().uuid() }).optional(),
  }).optional(),
  items: z.array(z.object({
    payout_item_id: resourceId.optional(), payout_batch_id: resourceId.optional(), transaction_status: code.optional(),
    payout_item: z.object({ amount: money.optional(), sender_item_id: z.string().uuid().optional() }).optional(),
  })).max(1).optional(),
});

export function approvalUrl(body: unknown, order: string): string {
  const id = resourceId.parse(order);
  const links = z.object({ links: z.array(z.unknown()).max(20) }).parse(body).links;
  const expected = 'https://www.sandbox.paypal.com/checkoutnow?token=' + id;
  for (const link of links) {
    const candidate = z.object({ rel: z.enum(['approve', 'payer-action']), href: z.literal(expected) }).safeParse(link);
    if (candidate.success) return expected;
  }
  throw new Error('Missing verified sandbox approval link');
}

function operation(method: string | undefined, path: string): string {
  if (method === 'POST') {
    if (path === '/v1/oauth2/token') return 'oauth';
    if (path === '/v2/checkout/orders') return 'create_order';
    if (path === '/v1/payments/payouts') return 'payout';
    if (/^\/v2\/checkout\/orders\/[A-Z0-9]{8,32}\/authorize$/.test(path)) return 'authorize';
    if (/^\/v2\/payments\/authorizations\/[A-Z0-9]{8,32}\/(capture|void)$/.test(path)) return path.endsWith('/void') ? 'void' : 'capture';
  }
  if (method === 'GET') {
    if (/^\/v2\/checkout\/orders\/[A-Z0-9]{8,32}$/.test(path)) return 'get_order';
    if (/^\/v2\/payments\/authorizations\/[A-Z0-9]{8,32}$/.test(path)) return 'get_authorization';
    if (/^\/v2\/payments\/captures\/[A-Z0-9]{8,32}$/.test(path)) return 'get_capture';
    if (/^\/v1\/payments\/payouts\/[A-Z0-9]{8,32}$/.test(path)) return 'get_payout';
  }
  throw new Error('Disallowed PayPal operation');
}

export function evidenceTransport(file: string | URL, baseFetch: typeof fetch = oneShotFetch, forbidden: readonly string[] = [], used = 0) {
  if (!Number.isInteger(used) || used < 0 || used > LIMIT) throw new Error('Invalid PayPal call count');
  let stopped = false;
  let active: { lease: string; call_id: string; request_id: string } | undefined;
  async function withIntent<T>(lease: string, intent: Intent, work: () => Promise<T>) {
    if (active || stopped) throw new Error('PayPal transport already active or stopped');
    active = { lease: z.string().uuid().parse(lease), call_id: z.string().uuid().parse(intent.call_id), request_id: z.string().uuid().parse(intent.request_id) };
    try { return await work(); } finally { active = undefined; }
  }
  function log(row: object) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...row });
    if (forbidden.some(secret => secret.length > 0 && line.includes(secret))) {
      throw new Error('Evidence contains a protected value');
    }
    appendFileSync(file, line + '\n', { flush: true });
  }
  const send: typeof fetch = async (input, init) => {
    if (stopped || used >= LIMIT || !active) throw new Error('PayPal transport stopped, unbound or at its call limit');
    const url = new URL(String(input));
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw new Error('Disallowed PayPal URL');
    const op = operation(init?.method, url.pathname);
    const call = ++used;
    const context = op === 'oauth' ? { call, op } : { call, op, ...active };
    try {
      log({ provenance: 'computed', event: 'dispatch', ...context });
      const response = await baseFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const raw = await response.text();
      let body: unknown;
      let invalid = false;
      if (op !== 'oauth' && raw) {
        try { body = bodySchema.parse(JSON.parse(raw)); } catch { invalid = true; }
      }
      if (!raw && response.ok && !(op === 'void' && response.status === 204)) invalid = true;
      log({ provenance: 'measured', event: 'response', ...context, http_status: response.status, ...(body === undefined ? {} : { body }), ...(invalid ? { body_rejected: true } : {}) });
      if (invalid || response.status === 421 || (response.status >= 300 && response.status < 400) ||
        response.status >= 500 || (op === 'oauth' && !response.ok)) throw new Error('PayPal response stopped dispatch');
      return new Response(raw || null, { status: response.status, headers: response.headers });
    } catch (error) {
      stopped = true;
      log({ provenance: 'computed', event: 'transport_stopped', ...context });
      throw error;
    }
  };
  return { send, withIntent, remaining: () => LIMIT - used, stop: () => { stopped = true; } };
}
