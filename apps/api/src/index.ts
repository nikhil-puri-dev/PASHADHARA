import { readFileSync } from 'node:fs';
import { waitUntil } from '@vercel/functions';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { Database } from '../../../packages/kernel/src/db.ts';
import { PayPalClient } from '../../../packages/paypal/src/index.ts';
import { createApp } from './app.ts';
import { approvalFlow, callbackBase } from './approval.ts';
import { createAuth, issueToken } from './auth.ts';
import { readHandlers } from './read-handlers.ts';
import { kernelMeter, resultStore } from './meter.ts';
import { summariseTool } from './summarise.ts';
import { financeTools } from './finance-fixtures.ts';
import { escrowFlow } from './escrow.ts';
import { showcaseRoutes } from './showcase.ts';
import { settlementFlow } from './settlement.ts';
import { timingSafeEqual, createHash } from 'node:crypto';
import { escrowJudges } from './judges.ts';
import { API_BASE_PATH, type Contract } from './routes.ts';
import { webhookStore } from './webhook-store.ts';
import { ApiError, logError, requestId, type ApiContext } from './request-log.ts';

declare const __PASHADHARA_OPENAPI_YAML__: string | undefined;

const app = new Hono<ApiContext>().basePath(API_BASE_PATH);
let api: ReturnType<typeof createApp> | undefined;
let contract: Contract | undefined;
const loadContract = () => contract ??= parse(
  (typeof __PASHADHARA_OPENAPI_YAML__ === 'string' && __PASHADHARA_OPENAPI_YAML__)
    || readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8'),
) as Contract;

app.get('/health', c => c.json({ status: 'ok' }));
app.get('/openapi.json', (c, next) => {
  if (!process.env.DATABASE_URL || [...(process.env.LEASE_TOKEN_SECRET ?? '')].length < 32
    || [...(process.env.ADMIN_KEY ?? '')].length < 32) {
    return c.json({ ...loadContract(), paths: {}, servers: [{ url: API_BASE_PATH }] });
  }
  return next();
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
    const { OPENAI_API_KEY: openai, ANTHROPIC_API_KEY: anthropic, AI_SPEND_LIMIT_USD: spendLimit } = process.env;
    const budget = Math.floor(Number(spendLimit) * 100 * 0.8);
    const aiEnabled = process.env.AI_ENABLED !== 'false';
    const escrow = paypal ? escrowFlow({
      db, paypal, waitUntil, budgetCents: Number.isSafeInteger(budget) && budget > 0 ? BigInt(budget) : 0n,
      judges: aiEnabled && openai && anthropic ? escrowJudges({ openai, anthropic }) : undefined,
    }) : undefined;
    const approval = paypal && baseUrl ? approvalFlow(db, paypal, baseUrl, secret, readHandlers(db).getLease!) : undefined;
    const tool = summariseTool({ apiKey: aiEnabled ? anthropic : undefined, limitUsd: Number(spendLimit) });
    const settlement = paypal && settlementFlow(db, paypal, readHandlers(db).getLease!);
    api = createApp({
      contract: loadContract(), db, ...createAuth(db, secret, admin),
      publishImplementedContract: true,
      mcpAllowedOrigins: baseUrl ? [new URL(callbackBase(baseUrl)).origin] : [],
      meter: kernelMeter(db, undefined, resultStore(db)),
      tools: [tool, ...financeTools],
      webhook: paypal && webhookId ? { webhookId, paypal, kernel: webhookStore(db) } : undefined,
      handlers: {
        ...settlement?.handlers,
        ...(escrow && { recoverPayouts: async input => {
          escrow.sweep(input.params.leaseId!);
          return { status: 202, body: { status: 'queued' } };
        } }),
        ...(approval && { createLease: approval.create, authorizeLease: approval.authorize }),
        ...(escrow && { createJob: escrow.createJob, getJob: escrow.getJob, deliverJob: escrow.deliverJob }),
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
    if (settlement) api.post('/internal/settlement/sweep', async c => {
      const digest = (value: string) => createHash('sha256').update(value).digest();
      if (!timingSafeEqual(digest(c.req.header('Authorization') ?? ''), digest(`Bearer ${admin}`))) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const results = await settlement.sweep();
      return c.json({ provenance: 'computed', results });
    });
    api.route('/', showcaseRoutes(
      db, null, secret, tool, Number.isSafeInteger(budget) && budget > 0 ? Math.floor(budget / 5) : 0,
    ));
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
