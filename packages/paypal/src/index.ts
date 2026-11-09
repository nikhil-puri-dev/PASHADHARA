export type PayPalBody = unknown;
export type PayPalResult = { status: number; body: PayPalBody };
export type Money = { currency_code: string; value: string };
export class PayPalError extends Error {
  constructor(public status: number, public body: unknown, public issues: string[]) {
    super(`PayPal HTTP ${status}${issues.length ? `: ${issues.join(', ')}` : ''}`);
    this.name = 'PayPalError';
  }
}
export class PayPalUnknownError extends Error {
  constructor(cause: unknown) { super('PayPal request outcome unknown; reconcile before retry', { cause }); this.name = 'PayPalUnknownError'; }
}
const money = (amount: Money) => {
  if (!/^[0-9]+\.[0-9]{2}$/.test(amount.value) || !/^[A-Z]{3}$/.test(amount.currency_code)) throw new TypeError('Invalid money');
  return amount;
};
const id = (value: string) => { if (!value) throw new TypeError('Missing id'); return encodeURIComponent(value); };
const requestTimeout = 10_000;
export class PayPalClient {
  private token?: { value: string; expires: number };
  constructor(private clientId: string, private secret: string, private fetcher: typeof fetch = fetch) {
    if (!clientId || !secret) throw new TypeError('Missing sandbox credentials');
  }
  private async request(method: string, path: string, body?: object | string, requestId?: string): Promise<PayPalResult> {
    if (method !== 'GET' && !requestId) throw new TypeError('Missing request id');
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetcher(`https://api-m.sandbox.paypal.com${path}`, {
        method, signal: AbortSignal.timeout(requestTimeout),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
    } catch (cause) { throw new PayPalUnknownError(cause); }
    let text: string;
    try { text = await response.text(); } catch (cause) { throw new PayPalUnknownError(cause); }
    let data: unknown = text;
    if (!text) data = null;
    else { try { data = JSON.parse(text); } catch { /* retain exact non-JSON body */ } }
    if (response.status >= 500) throw new PayPalUnknownError({ status: response.status, body: data });
    if (!response.ok) {
      const details = (data as { details?: { issue?: unknown }[] } | null)?.details;
      throw new PayPalError(response.status, data, Array.isArray(details) ? details.flatMap(d => typeof d.issue === 'string' ? [d.issue] : []) : []);
    }
    return { status: response.status, body: data };
  }
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires) return this.token.value;
    let response: Response;
    try { response = await this.fetcher('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(requestTimeout), headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }); }
    catch (cause) { throw new PayPalUnknownError(cause); }
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!response.ok) throw new PayPalError(response.status, data, []);
    if (!data.access_token || typeof data.expires_in !== 'number') throw new Error('Invalid PayPal OAuth response');
    this.token = { value: data.access_token, expires: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
    return data.access_token;
  }
  createOrder(amount: Money, returnUrl: string, cancelUrl: string, requestId: string) { return this.request('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', purchase_units: [{ amount: money(amount) }], payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW' } } } }, requestId); }
  getOrder(orderId: string) { return this.request('GET', `/v2/checkout/orders/${id(orderId)}`); }
  authorize(orderId: string, requestId: string) { return this.request('POST', `/v2/checkout/orders/${id(orderId)}/authorize`, {}, requestId); }
  capture(authorizationId: string, amount: Money, invoiceId: string, requestId: string) { if (!invoiceId) throw new TypeError('Missing invoice id'); return this.request('POST', `/v2/payments/authorizations/${id(authorizationId)}/capture`, { amount: money(amount), final_capture: false, invoice_id: invoiceId }, requestId); }
  reauthorize(authorizationId: string, amount: Money, requestId: string) { return this.request('POST', `/v2/payments/authorizations/${id(authorizationId)}/reauthorize`, { amount: money(amount) }, requestId); }
  void(authorizationId: string, requestId: string) { return this.request('POST', `/v2/payments/authorizations/${id(authorizationId)}/void`, undefined, requestId); }
  getAuthorization(authorizationId: string) { return this.request('GET', `/v2/payments/authorizations/${id(authorizationId)}`); }
  getCapture(captureId: string) { return this.request('GET', `/v2/payments/captures/${id(captureId)}`); }
  payout(receiver: string, amount: Money, requestId: string) { if (!receiver) throw new TypeError('Missing receiver'); money(amount); return this.request('POST', '/v1/payments/payouts', { sender_batch_header: { sender_batch_id: requestId, email_subject: 'Sandbox payout' }, items: [{ recipient_type: 'EMAIL', amount: { currency: amount.currency_code, value: amount.value }, receiver, sender_item_id: requestId }] }, requestId); }
  getPayout(batchId: string) { return this.request('GET', `/v1/payments/payouts/${id(batchId)}`); }
  verifyWebhookSignature(payload: { auth_algo: string; cert_url: string; transmission_id: string; transmission_sig: string; transmission_time: string; webhook_id: string; webhook_event: unknown }, requestId: string, rawEvent?: string) {
    if (rawEvent === undefined) return this.request('POST', '/v1/notifications/verify-webhook-signature', payload, requestId);
    // The route already validates the event. Reject text that cannot be embedded as a single JSON value.
    JSON.parse(rawEvent);
    const { webhook_event, ...signature } = payload;
    return this.request('POST', '/v1/notifications/verify-webhook-signature',
      `${JSON.stringify(signature).slice(0, -1)},"webhook_event":${rawEvent}}`, requestId);
  }
}
