import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { Database } from '../../../packages/kernel/src/db.ts';
import { PayPalClient } from '../../../packages/paypal/src/index.ts';
import { createApp } from './app.ts';
import { approvalFlow } from './approval.ts';
import { createAuth, issueToken } from './auth.ts';
import { readHandlers } from './read-handlers.ts';
import { API_BASE_PATH, type Contract } from './routes.ts';
import { webhookStore } from './webhook-store.ts';
import { ApiError, logError, requestId, type ApiContext } from './request-log.ts';

const app = new Hono<ApiContext>().basePath(API_BASE_PATH);
let api: ReturnType<typeof createApp> | undefined;
let contract: Contract | undefined;
const loadContract = () => contract ??= parse(
  readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8'),
) as Contract;

app.get('/health', c => c.json({ status: 'ok' }));
app.get('/openapi.json', c => {
  c.set('operation', 'openapi');
  return c.json({ ...loadContract(), servers: [{ url: API_BASE_PATH }] });
});
app.all('*', async c => {
  c.set('operation', 'initializeApi');
  const id = requestId(c.req.raw);
  c.header('X-Request-Id', id);
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new ApiError('DATABASE_URL is required');
  if (!api) {
    const {
      LEASE_TOKEN_SECRET: secret = '', ADMIN_KEY: admin = '', API_BASE_URL: baseUrl = '',
      PAYPAL_CLIENT_ID: client, PAYPAL_CLIENT_SECRET: clientSecret, PAYPAL_WEBHOOK_ID: webhookId,
    } = process.env;
    if ([...secret].length < 32) throw new ApiError('LEASE_TOKEN_SECRET must be at least 32 characters');
    if ([...admin].length < 32) throw new ApiError('ADMIN_KEY must be at least 32 characters');
    const db = new Database(connection);
    const paypal = client && clientSecret ? new PayPalClient(client, clientSecret) : undefined;
    const approval = paypal && baseUrl ? approvalFlow(db, paypal, baseUrl, secret, readHandlers(db).getLease!) : undefined;
    api = createApp({
      contract: loadContract(), db, ...createAuth(db, secret, admin),
      webhook: paypal && webhookId ? { webhookId, paypal, kernel: webhookStore(db) } : undefined,
      handlers: {
        ...(approval && { createLease: approval.create, authorizeLease: approval.authorize }),
        createSeller: async ({ body }) => {
          const seller = body as { name: string; paypal_email: string; payout_hold_seconds?: number };
          const saved = await db.transaction(null, async tx => (await tx.query<{ id: string }>(
            `insert into public.sellers(name,paypal_email,payout_hold_seconds) values ($1,$2,$3)
             returning id,name,paypal_email,payout_hold_seconds`,
            [seller.name, seller.paypal_email, seller.payout_hold_seconds ?? 60],
          )).rows[0]!);
          return { status: 201, body: { ...saved, seller_key: issueToken(secret, 'seller', saved.id) } };
        },
      },
    });
    if (approval) api.route('/', approval.callbacks);
    else api.get('/paypal/:action/:leaseId', c => c.json({ status: 'unavailable' }, 503));
  }
  const response = await api.fetch(c.req.raw);
  response.headers.set('X-Request-Id', id);
  return response;
});
app.onError((error, c) => {
  logError(c.req.raw, c.get('operation') ?? 'apiEntry', error);
  return c.json({ status: 'unavailable' }, 503);
});

export default app;
