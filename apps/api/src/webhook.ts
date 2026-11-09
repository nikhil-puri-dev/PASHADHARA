import { randomUUID } from 'node:crypto';
import type { KernelPort } from './kernel-port.ts';
import type { RouteHandler } from './routes.ts';
type Gateway = {
  verifyWebhookSignature(payload: { auth_algo: string; cert_url: string; transmission_id: string; transmission_sig: string; transmission_time: string; webhook_id: string; webhook_event: unknown }, requestId: string): Promise<{body: unknown}>;
  getCapture(id: string): Promise<{body: unknown}>;
  getAuthorization(id: string): Promise<{body: unknown}>;
};
type Event = { id: string; event_type: string; resource: { id: string } };
export type WebhookDependencies = { webhookId: string; paypal: Gateway; kernel: KernelPort };

function isEvent(event: unknown): event is Partial<Event> & Pick<Event, 'id' | 'event_type'> {
  if (!event || typeof event !== 'object') return false;
  const { id, event_type } = event as Partial<Event>;
  return typeof id === 'string' && id.length > 0 && typeof event_type === 'string' && event_type.length > 0;
}

export function webhookHandler({ webhookId, paypal, kernel }: WebhookDependencies): RouteHandler {
  return async ({ body, request }) => {
    if (!isEvent(body)) return { status: 400 };
    const outcome = await receiveWebhook(body, request.headers, webhookId, paypal, kernel, randomUUID());
    return { status: outcome === 'unverified' ? 400 : 200 };
  };
}

/** A caller must return a retryable HTTP response if this throws. */
export async function receiveWebhook(event: unknown, headers: Headers, webhookId: string, paypal: Gateway, kernel: KernelPort, requestId: string): Promise<'processed' | 'duplicate' | 'unverified' | 'unsupported'> {
  if (!webhookId) throw new Error('Missing webhook configuration');
  if (!isEvent(event)) throw new TypeError('Invalid event id or type');
  const item = event;
  const names = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'] as const;
  const values = names.map(name => headers.get(name));
  let verified = false;
  if (values.every(Boolean)) {
    const result = await paypal.verifyWebhookSignature({ auth_algo: values[0]!, cert_url: values[1]!, transmission_id: values[2]!, transmission_sig: values[3]!, transmission_time: values[4]!, webhook_id: webhookId, webhook_event: event }, requestId);
    verified = (result.body as { verification_status?: string } | null)?.verification_status === 'SUCCESS';
  }
  const stored = await kernel.recordWebhook(item.id, event, verified);
  if (!verified) return 'unverified';
  if (!stored || typeof stored !== 'object') throw new Error('Missing verified webhook evidence');
  const canonical = stored as Partial<Event>;
  if (canonical.id !== item.id || typeof canonical.event_type !== 'string') throw new Error('Invalid verified webhook evidence');
  const kind = canonical.event_type.startsWith('PAYMENT.CAPTURE.') ? 'capture' : canonical.event_type.startsWith('PAYMENT.AUTHORIZATION.') ? 'authorization' : null;
  if (!kind || !canonical.resource || typeof canonical.resource.id !== 'string' || !canonical.resource.id) return 'unsupported';
  const claim = await kernel.claimWebhook(item.id);
  if (claim === 'processed') return 'duplicate';
  if (claim === 'busy') throw new Error('Verified webhook is still being processed');
  try {
    const response = kind === 'capture' ? await paypal.getCapture(canonical.resource.id) : await paypal.getAuthorization(canonical.resource.id);
    await kernel.reconcileWebhook(item.id, { kind, id: canonical.resource.id }, response.body);
    return 'processed';
  } catch (error) { await kernel.releaseWebhook(item.id); throw error; }
}
