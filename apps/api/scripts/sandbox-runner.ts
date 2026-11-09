import { createInterface } from 'node:readline';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Database, beginPayPalCall, recordAuthorization, beginCapture, completeCapture, failCapture, recordPendingCapture,
  accrueSeller, commitUsage, recordDelivery, recordJudgment, runJudges, queuePayout, beginPayout, sendPayout, completePayout,
  beginVoid, completeVoid, closeLease, markUnknown,
} from '../../../packages/kernel/src/index.ts';
import { objectField } from '../../../packages/kernel/src/calls.ts';
import { balances } from '../../../packages/kernel/src/journal.ts';
import { PayPalClient, PayPalError } from '../../../packages/paypal/src/index.ts';
import { compareJournal, type Resource } from '../src/compare-journal.ts';
import { awaitApproval, checkOrder, kernelCalls, requestApproval, RunStop, usd } from './sandbox-approval.ts';
import { evidenceTransport, resourceId } from './sandbox-evidence.ts';
import { sandboxSeller, scriptMeter } from './sandbox-meter.ts';
import { judgeBudget, realJudges } from './sandbox-judges.ts';
import { resumeApproval } from './sandbox-resume.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new RunStop('Missing required sandbox configuration');
  return value;
};
const phase = (message: string) => console.log('computed: ' + message);

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--check-approved');
  const replacement = args.includes('--replacement');
  if (args.length !== Number(resume) + Number(replacement)) throw new RunStop('Unrecognized sandbox runner arguments');
  if (process.env.PAYPAL_ENV !== 'sandbox') throw new RunStop('Sandbox mode is required');
  const connection = required('DATABASE_URL');
  const client = required('PAYPAL_CLIENT_ID');
  const secret = required('PAYPAL_CLIENT_SECRET');
  const email = required('SELLER_A_EMAIL');
  const judges = realJudges(required('OPENAI_API_KEY'), required('ANTHROPIC_API_KEY'));
  const forbidden = Object.entries(process.env)
    .filter(([name, value]) => /(?:KEY|SECRET|TOKEN|EMAIL|DATABASE_URL|DATABASE_ADMIN_URL|PAYPAL_CLIENT_ID|PASSWORD)/i.test(name) && value)
    .map(([, value]) => value!);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  const day = ['year', 'month', 'day'].map(part => date.find(field => field.type === part)?.value).join('');
  const file = new URL('../../../evidence/live-' + day + (replacement ? '-replacement' : '') + '.jsonl', import.meta.url);
  const lock = new URL(file.href + '.lock');
  const db = new Database(connection);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const commands = input[Symbol.asyncIterator]();
  async function gate(stage: string) {
    phase(stage + ' complete. Waiting for stage verification.');
    if ((await commands.next()).value !== 'continue ' + stage) throw new RunStop('Stage verification stopped');
  }
  let locked = false;
  try {
    closeSync(openSync(lock, 'wx', 0o600));
    locked = true;
    await db.transaction(null, tx => tx.query('select 1 from public.leases limit 1'));
    const paused = resume ? await resumeApproval(db, file) : null;
    if (!paused) closeSync(openSync(file, 'wx', 0o600));
    const transport = evidenceTransport(file, undefined, forbidden, paused?.used);
    const paypal = new PayPalClient(client, secret, transport.send);
    const calls = kernelCalls(db, transport.stop, transport.withIntent);
    const seller = await sandboxSeller(db, email);
    const approval = paused ?? await requestApproval(db, paypal, calls);
    const { lease, order } = approval;
    if ('url' in approval) {
      if (forbidden.some(value => approval.url.includes(value))) throw new RunStop('Approval URL contains protected configuration');
      console.log('measured: approve ' + approval.url);
    }
    console.log('computed: lease ' + lease);
    async function readApproval() {
      const evidence = await calls.read(lease, order, () => paypal.getOrder(order));
      const status = checkOrder(evidence.body);
      if (paused?.rejected && status === 'APPROVED') {
        const { payer, payment_source } = evidence.body;
        const payerId = payer ? objectField(payer).payer_id : undefined;
        const wallet = payment_source ? objectField(payment_source).paypal : undefined;
        const accountId = wallet ? objectField(wallet).account_id : undefined;
        if (![payerId, accountId].some(value => typeof value === 'string' && value.length)) {
          throw new RunStop('Reapproval lacked PayPal payer evidence');
        }
      }
      return status;
    }
    const approved = paused
      ? transport.remaining() >= 14 && await readApproval() === 'APPROVED'
      : await awaitApproval(readApproval, () => transport.remaining() > 14);
    if (!approved) throw new RunStop('Approval polling reached the time or reserved-call limit');
    await gate('approval');

    const authCall = await beginPayPalCall(db, lease, 'authorize');
    const auth = await calls.dispatch(lease, authCall, () => paypal.authorize(order, authCall.request_id), async evidence => {
      const units = evidence.body.purchase_units;
      const unit = objectField(Array.isArray(units) ? units[0] : undefined);
      const authorizations = objectField(unit.payments).authorizations;
      const id = resourceId.parse(objectField(Array.isArray(authorizations) ? authorizations[0] : undefined).id);
      const saved = await recordAuthorization(db, lease, authCall.call_id, evidence);
      return { id: saved.id, paypal: id };
    });
    const tool = scriptMeter(db, lease);
    const initial = await tool('PASHADHARA sandbox initial capture');
    if (!initial || initial.amount_minor !== 100n) throw new RunStop('Initial capture needs exactly 100 committed cents');

    async function capture(allocations: readonly { ref_id: string; amount_minor: bigint }[], decision?: string) {
      const call = await beginCapture(db, lease, { authorization_id: auth.id, allocations, decision_id: decision });
      const result = await calls.dispatch(lease, call, async () => {
        try { return await paypal.capture(auth.paypal, usd(call.amount_minor), call.invoice_id, call.request_id); }
        catch (error) {
          if (error instanceof PayPalError && error.status === 422) return { status: error.status, body: error.body };
          throw error;
        }
      }, async evidence => {
        if (evidence.body.status === 'PENDING') {
          await recordPendingCapture(db, lease, call.capture_id, evidence);
          return null;
        }
        if (evidence.http_status === 422 || ['DECLINED', 'DENIED'].includes(String(evidence.body.status))) {
          await failCapture(db, lease, call.capture_id, evidence);
          return null;
        }
        const id = resourceId.parse(evidence.body.id);
        if (evidence.body.final_capture !== false) throw new RunStop('PayPal did not confirm a partial capture');
        await completeCapture(db, lease, call.capture_id, evidence);
        return id;
      });
      if (!result) throw new RunStop('Capture did not complete');
      return result;
    }
    const verifiedCaptures = new Map<string, Resource>();
    async function prove(ids: readonly string[]) {
      const a = await calls.read(lease, auth.paypal, () => paypal.getAuthorization(auth.paypal));
      const captures: Resource[] = [];
      for (const id of ids) {
        const verified = verifiedCaptures.get(id) ?? (await calls.read(lease, id, () => paypal.getCapture(id))).body as Resource;
        verifiedCaptures.set(id, verified);
        captures.push(verified);
      }
      const lines = await compareJournal(db, lease, a.body as Resource, captures, 'measured');
      console.log(JSON.stringify(lines));
      if (lines.some(line => !line.match)) throw new RunStop('PayPal GET disagrees with journal');
    }
    const first = await capture([initial]);
    await prove([first]);
    await accrueSeller(db, lease, initial.ref_id);
    await gate('first-capture');

    const batch: NonNullable<Awaited<ReturnType<typeof tool>>>[] = [];
    for (let n = 0; n <= 5; n++) {
      const served = await tool('PASHADHARA metered sandbox call ' + n);
      if (!served) break;
      batch.push(served);
    }
    if (batch.length !== 5) throw new RunStop('MCP exposure refusal did not arrive at the expected charge count');
    phase('MCP served five calls and refused one at the unsettled exposure limit');
    const second = await capture(batch);
    await prove([first, second]);
    for (const line of batch) await accrueSeller(db, lease, line.ref_id);
    await gate('metering');

    const text = '2 + 2 = 4';
    const acceptance = { max_bytes: 64, content_type: 'text/plain', criteria: 'Pass if the deliverable correctly states that two plus two equals four. Score 100 when it does.' };
    const job = await commitUsage(db, lease, { kind: 'job', seller_id: seller, amount_minor: 300n, rubric: [{ min_score: 0, pay_bps: 10000 }], acceptance });
    if (!job.id || job.status !== 'served') throw new RunStop('Kernel refused the escrow reserve');
    await recordDelivery(db, lease, job.id, text);
    const judgment = await runJudges({ job_id: job.id, deliverable: { text, content_type: 'text/plain' }, acceptance, providers: judges, guard: judgeBudget() });
    const decision = await recordJudgment(db, lease, job.id, 1, judgment);
    if (judgment.verdicts.length !== 2 || decision.outcome !== 'release' || decision.amount_minor !== 300n) throw new RunStop('Escrow lacked a unanimous paying decision');
    phase('Two real judges recorded a unanimous paying decision');
    await capture([{ ref_id: job.id, amount_minor: decision.amount_minor }], decision.id);
    const earned = await accrueSeller(db, lease, decision.id);
    if (earned.seller_id !== seller || earned.amount_minor <= 0n || earned.amount_minor > 300n) throw new RunStop('Escrow seller or net amount invalid');
    const payout = await queuePayout(db, lease, { ...earned, source: 'job', decision_id: decision.id });
    await gate('escrow');

    await sleep(Math.max(0, payout.release_at.getTime() - Date.now()) + 1000);
    await beginPayout(db, lease, payout.id);
    const sent = await sendPayout(db, lease, payout.id);
    if (!sent) throw new RunStop('Kernel did not release the payout');
    const batchId = await calls.dispatch(lease, sent, async () => {
      if (sent.receiver_email !== email || sent.amount_minor !== earned.amount_minor) throw new RunStop('Payout receiver or amount changed');
      return paypal.payout(sent.receiver_email, usd(sent.amount_minor), sent.request_id);
    }, async evidence => resourceId.parse(objectField(evidence.body.batch_header).payout_batch_id), true);
    let paid = false;
    for (let i = 0; i < 5 && transport.remaining() > 2; i++) {
      await sleep(i === 0 ? 30_000 : 15_000);
      try {
        const read = await calls.read(lease, batchId, () => paypal.getPayout(batchId), e => objectField(e.body.batch_header).payout_batch_id);
        const status = objectField(read.body.batch_header).batch_status;
        if (status === 'PENDING' || status === 'PROCESSING') continue;
        await completePayout(db, lease, sent.call_id, { ...read, source: 'get' });
      } catch {
        transport.stop();
        await markUnknown(db, lease, sent.call_id);
        throw new RunStop('Payout outcome could not be verified');
      }
      const result = await db.transaction(null, tx => tx.query("select 1 from public.payouts where id=$1 and state='success'", [payout.id]));
      paid = result.rowCount === 1;
      break;
    }
    if (!paid) throw new RunStop('Payout did not reach verified success in the remaining call budget');
    await gate('payout');

    const voidCall = await beginVoid(db, lease);
    await calls.dispatch(lease, voidCall, () => paypal.void(auth.paypal, voidCall.request_id), e => completeVoid(db, lease, voidCall.call_id, e));
    const voidRead = await calls.read(lease, auth.paypal, () => paypal.getAuthorization(auth.paypal));
    const available = await db.transaction(null, tx => balances(tx, lease));
    if (voidRead.body.status !== 'VOIDED' || available.hold !== 0n || available.committed !== 0n) throw new RunStop('Void evidence or journal balance did not match');
    await closeLease(db, lease);
    phase('Void matched PayPal GET and journal. Lease closed. PayPal calls used: ' + (25 - transport.remaining()));
  } finally {
    input.close();
    try { await db.end(); } finally { if (locked) unlinkSync(lock); }
  }
}

main().catch(error => {
  console.error(error instanceof RunStop ? 'computed: ' + error.message : 'computed: Sandbox runner stopped at a local or provider error');
  process.exitCode = 1;
});
