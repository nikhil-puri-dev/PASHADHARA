/** Local interop fixture only. Uses a fresh throwaway database on port 15433. */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createMcp, registeredTools, toyTools } from '../src/mcp.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';

const database = process.env.MCP_TEST_DATABASE;
if (!database || !/^mcp_[a-z0-9_]+$/.test(database)) throw new Error('Set a fresh MCP_TEST_DATABASE on throwaway Postgres 15433.');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15433/${database}`);
const seller = await db.transaction(null, async tx => (await tx.query<{ id: string }>("insert into public.sellers(name,paypal_email,payout_hold_seconds) values ('Fixture','fixture@example.test',60) returning id")).rows[0]!.id);
await db.transaction(null, tx => tx.query("insert into public.tools(id,name,description,price_minor,seller_id,active) values ('text_stats','Text stats','Count text',2,$1,true)", [seller]));
// Cap in cents (default 3). The bearer token is random per run and written to MCP_TOKEN_FILE (never printed).
const cap = BigInt(process.env.MCP_FIXTURE_CAP ?? '3');
const tokenFile = process.env.MCP_TOKEN_FILE;
if (!tokenFile) throw new Error('Set MCP_TOKEN_FILE to a new private path for the fixture bearer token.');
const token = randomBytes(24).toString('hex');
writeFileSync(tokenFile, token, { flag: 'wx', mode: 0o600 });
const lease = (await kernel.createLease(db, { buyer_ref: 'mcp-interop-fixture', cap_minor: cap, unsettled_limit_minor: cap })).id;
const order = await kernel.beginPayPalCall(db, lease, 'create_order');
await kernel.markCallSent(db, lease, order.call_id);
const orderId = await kernel.recordOrder(db, lease, order.call_id, { http_status: 201, body: { id: randomUUID() } });
const authorization = await kernel.beginPayPalCall(db, lease, 'authorize');
await kernel.markCallSent(db, lease, authorization.call_id);
const now = Date.now();
await kernel.recordAuthorization(db, lease, authorization.call_id, { http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: randomUUID(), status: 'CREATED', amount: { currency_code: 'USD', value: `${cap / 100n}.${String(cap % 100n).padStart(2, '0')}` }, create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86400_000).toISOString() }] } }] } });
const app = createMcp(kernelMeter(db, undefined, resultStore(db)), async request => request.headers.get('authorization') === `Bearer ${token}` ? lease : null, registeredTools(db, ['text_stats']), toyTools.filter(tool => tool.name === 'text_stats'));
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 15339 }, () => console.log('Fixture MCP server listening on 127.0.0.1:15339. Token file written.'));
