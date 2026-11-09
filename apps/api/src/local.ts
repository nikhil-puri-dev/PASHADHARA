import { serve } from '@hono/node-server';
import app from './index.ts';

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3000) }, address => {
  console.log(`PASHADHARA API listening on http://127.0.0.1:${address.port}`);
});
