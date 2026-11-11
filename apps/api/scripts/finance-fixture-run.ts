import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import * as kernel from '../../../packages/kernel/src/index.ts';
import { createAuth, issueToken } from '../src/auth.ts';
import { createMcp, registeredTools } from '../src/mcp.ts';
import { kernelMeter, resultStore } from '../src/meter.ts';
import { financeTools } from '../src/finance-fixtures.ts';
import { seedFinance } from './finance-seed.ts';

// Fixed loopback address and test database: never point fixture PayPal responses at a real database.
const fixtureDb = process.env.FIXTURE_DATABASE ?? 'live_finance_1113';
if (!/^live_finance_[a-z0-9_]+$/.test(fixtureDb)) throw new Error('FIXTURE_DATABASE must match live_finance_[a-z0-9_]+');
const db = new kernel.Database(`postgres://kernel_login@127.0.0.1:15434/${fixtureDb}`);
const secret = randomUUID() + randomUUID();
let server: ReturnType<typeof serve> | undefined;
try {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  await seedFinance(db, 'fixture-finance@example.test');
  const configuredCap = Number(process.env.FIXTURE_BUDGET_CENTS ?? '6');
  if (!Number.isSafeInteger(configuredCap) || configuredCap < 1 || configuredCap > 100) throw new Error('FIXTURE_BUDGET_CENTS must be an integer from 1 to 100');
  const cap = BigInt(configuredCap);
  const lease = (await kernel.createLease(db, { buyer_ref: 'fixture-finance-investigation', cap_minor: cap, unsettled_limit_minor: cap })).id;
  const order = await kernel.beginPayPalCall(db, lease, 'create_order');
  await kernel.markCallSent(db, lease, order.call_id);
  const orderId = await kernel.recordOrder(db, lease, order.call_id, { http_status: 201, body: { id: `FIXTURE-${randomUUID()}` } });
  const call = await kernel.beginPayPalCall(db, lease, 'authorize');
  await kernel.markCallSent(db, lease, call.call_id);
  const now = Date.now();
  const resource = { id: `FIXTURE-${randomUUID()}`, status: 'CREATED', amount: { currency_code: 'USD', value: `${cap / 100n}.${String(cap % 100n).padStart(2, '0')}` }, create_time: new Date(now).toISOString(), expiration_time: new Date(now + 29 * 86_400_000).toISOString() };
  await kernel.recordAuthorization(db, lease, call.call_id, { http_status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [resource] } }] } });
  const auth = createAuth(db, secret, '');
  const app = createMcp(kernelMeter(db, undefined, resultStore(db)), auth.resolveMcpLease, registeredTools(db, financeTools.map(t => t.name)), financeTools);
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local gateway address');
  console.log(JSON.stringify({ event: 'fixture_setup', provenance: 'fixture', lease_id: lease, cap_cents: configuredCap, note: 'Synthetic authorization and payment evidence, not PayPal responses.' }));
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./finance-agent.ts', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')], { stdio: 'inherit', env: { ...process.env, MCP_URL: `http://127.0.0.1:${address.port}/mcp`, INVESTIGATION_BUDGET_CENTS: String(configuredCap), LEASE_TOKEN: issueToken(secret, 'lease', lease) } });
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 1)); });
  process.exitCode = code;
} finally { server?.close(); await db.end(); }


