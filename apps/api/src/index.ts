import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { parse } from 'yaml';
import { Database } from '../../../packages/kernel/src/db.ts';
import { createApp } from './app.ts';
import type { Contract } from './routes.ts';

const app = new Hono();
let api: ReturnType<typeof createApp> | undefined;

app.get('/health', c => c.json({ status: 'ok' }));
app.all('*', c => {
  const connection = process.env.DATABASE_URL;
  if (!connection) return c.json({ status: 'unavailable' }, 503);
  api ??= createApp({
    contract: parse(readFileSync(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8')) as Contract,
    db: new Database(connection),
    authenticate: async () => null,
    resolveMcpLease: async () => null,
  });
  return api.fetch(c.req.raw);
});
app.onError((_error, c) => c.json({ status: 'unavailable' }, 503));

export default app;
