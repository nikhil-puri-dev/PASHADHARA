import { randomUUID } from 'node:crypto';
import { PayPalError, PayPalUnknownError } from '../../../packages/paypal/src/index.ts';

export type ApiContext = { Variables: { operation: string } };
const ids = new WeakMap<Request, string>();

export function requestId(request: Request) {
  let id = ids.get(request);
  if (!id) { id = randomUUID(); ids.set(request, id); }
  return id;
}

/** Use only with fixed, application-owned messages. */
export class ApiError extends Error {
  override name = 'ApiError';
}

export function logError(request: Request, operation: string, error: unknown) {
  // Provider, database and runtime errors may embed a request or a credential in their messages.
  const safe = error instanceof ApiError ? { name: 'ApiError', message: error.message }
    : error instanceof PayPalUnknownError ? { name: 'PayPalUnknownError', message: 'PayPal request outcome unknown' }
    : error instanceof PayPalError ? { name: 'PayPalError', message: 'PayPal rejected the request' }
    : { name: error instanceof TypeError ? 'TypeError' : 'Error', message: 'Unexpected error (message withheld)' };
  console.error({ operation, requestId: requestId(request), ...safe });
}
