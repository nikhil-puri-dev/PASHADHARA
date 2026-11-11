import { Database } from '../../../packages/kernel/src/db.ts';
import { PayPalClient } from '../../../packages/paypal/src/index.ts';
import { approvalFlow } from '../src/approval.ts';
import { isUuid } from '../src/auth.ts';
import { readHandlers } from '../src/read-handlers.ts';
import { seedFinance } from './finance-seed.ts';

// Creates (or activates) one PayPal SANDBOX hold with a small cap for the finance agent, on a throwaway local database only.
// The cap is the budget the kernel enforces. Nothing is captured or paid out by this script.
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, LEASE_TOKEN_SECRET, SELLER_A_EMAIL } = process.env;
const database = process.env.FINANCE_SANDBOX_DATABASE ?? '';
if (!/^live_finance_[a-z0-9_]+$/.test(database)) throw new Error('Set FINANCE_SANDBOX_DATABASE to a throwaway live_finance_* database on port 15434.');
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !LEASE_TOKEN_SECRET || !SELLER_A_EMAIL) throw new Error('Missing PayPal sandbox or lease secret configuration.');
const [action, leaseId] = process.argv.slice(2);
const cap = Number(process.env.FINANCE_CAP_CENTS ?? '16');
if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100) throw new Error('FINANCE_CAP_CENTS must be 1 to 100.');
if (action !== 'create' && !(action === 'activate' && leaseId && isUuid(leaseId))) throw new Error('Use create or activate LEASE_ID.');
const db = new Database(`postgres://kernel_login@127.0.0.1:15434/${database}`);
try {
  const flow = approvalFlow(db, new PayPalClient(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET), 'http://127.0.0.1:3300/api', LEASE_TOKEN_SECRET, readHandlers(db).getLease!);
  const input = { request: new Request('http://localhost'), principal: null, query: {}, params: { leaseId: leaseId ?? '' } };
  if (action === 'create') {
    await seedFinance(db, SELLER_A_EMAIL);
    const created = await flow.create({ ...input, body: { buyer_ref: 'finance-sandbox-run', cap_minor: cap, unsettled_limit_minor: cap } });
    if (created.status !== 201) throw new Error(`Sandbox order creation failed (HTTP ${created.status}).`);
    const body = created.body as { lease_id: string; approve_url: string };
    console.log(JSON.stringify({ http: created.status, lease_id: body.lease_id, approve_url: body.approve_url, cap_cents: cap }));
  } else {
    const activated = await flow.authorize({ ...input, body: undefined });
    if (activated.status !== 200) throw new Error(`Sandbox approval is not confirmed (HTTP ${activated.status}).`);
    console.log(JSON.stringify({ http: activated.status, lease_id: leaseId }));
  }
} finally { await db.end(); }
