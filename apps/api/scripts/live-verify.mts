/** Independent check: read a capture and a payout batch straight from PayPal and compare with the journal. Env: CAPTURE_ID, BATCH_ID, plus the sandbox credentials. */
import { PayPalClient } from '../../../packages/paypal/src/index.ts';
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, CAPTURE_ID: capture, BATCH_ID: batch } = process.env;
if (!id || !secret || !capture || !batch) { console.error('credentials, CAPTURE_ID and BATCH_ID are required'); process.exit(1); }
const paypal = new PayPalClient(id, secret);
const c: any = (await paypal.getCapture(capture)).body;
const p: any = (await paypal.getPayout(batch)).body;
console.log(JSON.stringify({ measured: true,
  capture: { id: c.id, status: c.status, amount: c.amount?.value, fee: c.seller_receivable_breakdown?.paypal_fee?.value, net: c.seller_receivable_breakdown?.net_amount?.value },
  payout: { batch: p.batch_header?.payout_batch_id, status: p.batch_header?.batch_status, amount: p.batch_header?.amount?.value, items: (p.items ?? []).map((i: any) => i.transaction_status) } }));
