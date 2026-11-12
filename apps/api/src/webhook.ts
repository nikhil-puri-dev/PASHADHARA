import type { KernelPort } from './kernel-port.ts';
import type { RouteHandler } from './routes.ts';
import { ApiError, requestId } from './request-log.ts';
import { PayPalError } from '../../../packages/paypal/src/index.ts';
type Gateway = {
  verifyWebhookSignature(payload: { auth_algo: string; cert_url: string; transmission_id: string; transmission_sig: string; transmission_time: string; webhook_id: string; webhook_event: unknown }, requestId: string, rawEvent?: string): Promise<{body: unknown}>;
  getCapture(id: string): Promise<{body: unknown; status?: number}>;
  getAuthorization(id: string): Promise<{body: unknown; status?: number}>;
};
type Event = { id: string; event_type: string; resource: { id: string } };
export type WebhookDependencies = { webhookId: string; paypal: Gateway; kernel: KernelPort };
const captureEvents = new Set(['PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED']);
const authorizationEvents = new Set(['PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.AUTHORIZATION.EXPIRED', 'PAYMENT.AUTHORIZATION.DENIED']);
const signatureHeaders = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'] as const;
export const hasWebhookSignature = (headers: Headers) => signatureHeaders.every(name => Boolean(headers.get(name)));

function isEvent(event: unknown): event is Partial<Event> & Pick<Event, 'id' | 'event_type'> {
  if (!event || typeof event !== 'object') return false;
  const { id, event_type } = event as Partial<Event>;
  const label = /^[a-z0-9_.-]{1,128}$/i;
  return typeof id === 'string' && label.test(id) && typeof event_type === 'string' && label.test(event_type);
}

export function webhookHandler({ webhookId, paypal, kernel }: WebhookDependencies): RouteHandler {
  return async ({ body, rawBody, request }) => {
    if (!isEvent(body)) return { status: 400 };
    const outcome = await receiveWebhook(body, request.headers, webhookId, paypal, kernel, requestId(request), rawBody);
    return { status: outcome === 'unverified' ? 400 : 200 };
  };
}

/** A caller must return a retryable HTTP response if this throws. */
export async function receiveWebhook(event: unknown, headers: Headers, webhookId: string, paypal: Gateway, kernel: KernelPort, requestId: string, rawEvent?: string): Promise<'processed' | 'duplicate' | 'unverified' | 'unsupported'> {
  if (!hasWebhookSignature(headers)) return 'unverified';
  if (!webhookId) throw new ApiError('Missing webhook configuration');
  if (!isEvent(event)) throw new TypeError('Invalid event id or type');
  const item = event;
  const [auth_algo, cert_url, transmission_id, transmission_sig, transmission_time] = signatureHeaders.map(name => headers.get(name)!);
  let result: { body: unknown };
  try {
    result = await paypal.verifyWebhookSignature({
      auth_algo: auth_algo!, cert_url: cert_url!, transmission_id: transmission_id!, transmission_sig: transmission_sig!,
      transmission_time: transmission_time!, webhook_id: webhookId, webhook_event: event,
    }, requestId, rawEvent);
  } catch (error) {
    if (error instanceof PayPalError) throw new ApiError(`PayPal webhook verification rejected HTTP ${error.status}`);
    throw error;
  }
  const status = (result.body as { verification_status?: string } | null)?.verification_status;
  if (status === 'FAILURE') {
    await kernel.recordWebhook(item.id, { event_type: item.event_type }, false);
    return 'unverified';
  }
  if (status !== 'SUCCESS') throw new ApiError('PayPal signature result is inconclusive');
  const stored = await kernel.recordWebhook(item.id, event, true);
  if (!stored || typeof stored !== 'object') throw new ApiError('Missing verified webhook evidence');
  const canonical = stored as Partial<Event>;
  if (canonical.id !== item.id || typeof canonical.event_type !== 'string') throw new ApiError('Invalid verified webhook evidence');
  if (canonical.event_type === 'PAYMENT.CAPTURE.REFUNDED' || canonical.event_type === 'PAYMENT.CAPTURE.REVERSED') {
    throw new ApiError('Capture reversals require a caller-transaction kernel operation');
  }
  const kind = captureEvents.has(canonical.event_type) ? 'capture' : authorizationEvents.has(canonical.event_type) ? 'authorization' : null;
  if (!kind || !canonical.resource || typeof canonical.resource.id !== 'string' || !canonical.resource.id) return 'unsupported';
  const claim = await kernel.claimWebhook(item.id);
  if (claim === 'processed') return 'duplicate';
  if (claim === 'busy') throw new ApiError('Verified webhook is still being processed');
  try {
    const response = kind === 'capture' ? await paypal.getCapture(canonical.resource.id) : await paypal.getAuthorization(canonical.resource.id);
    await kernel.reconcileWebhook(item.id, { kind, id: canonical.resource.id }, response.body, response.status);
    return 'processed';
  } finally { await kernel.releaseWebhook(item.id); }
}
