import {
  accrueSeller, beginCapture, commitUsage, completeCapture, failCapture, markCallSent, markUnknown,
  queuePayout, recordJudgment, recordPendingCapture, recordRejectedCall, runJudges, SpendGuard,
  beginPayPalCall, type Acceptance, type Database, type Evidence,
} from '../../../packages/kernel/src/index.ts';
import { finish, loadCall, objectField, stringField } from '../../../packages/kernel/src/calls.ts';
import { claimDuePayout, reconcileSentPayout } from '../../../packages/kernel/src/payout.ts';
import { PayPalError, type PayPalClient } from '../../../packages/paypal/src/index.ts';
import type { RouteHandler } from './routes.ts';
import { deliverableHash } from '../../../packages/kernel/judge/index.ts';
import { ApiError, logError } from './request-log.ts';

type Judges = Parameters<typeof runJudges>[0]['providers'];
type Gateway = Pick<PayPalClient, 'capture' | 'payout' | 'getPayout'>;
type Wait = (ms: number) => Promise<void>;
const usd = (cents: bigint) => ({ currency_code: 'USD', value: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` });
const problem = (status: number, title: string) => ({ status, body: { type: 'about:blank', status, title } });
const DEFAULT_MAX_BYTES = 4096;
const reasons = { refused_cap: 'cap_reached', refused_exposure: 'exposure_limit', refused_window: 'window_ended', refused_inactive: 'lease_not_active' } as const;
const safe = (value: string) => Number.isSafeInteger(Number(value)) ? Number(value) : (() => { throw new Error('Database integer exceeds API safe range'); })();

type JobRow = { id: string; lease_id: string; seller_id: string; amount_minor: string; state: string; rubric: unknown; deliverable_hash: string | null; acceptance: Acceptance };

/**
 * Escrow routes from the frozen contract (createJob, getJob, deliverJob). The two judges only propose a verdict.
 * The kernel maps it to an amount with the buyer's rubric, then this module captures and queues the seller payout.
 * `judges` is undefined when the model keys are missing: delivery then fails closed before anything is recorded.
 */
export function escrowFlow(options: { db: Database; paypal: Gateway; judges: Judges | undefined; budgetCents: bigint; wait?: Wait; pollMs?: number; polls?: number; waitUntil?: (work: Promise<unknown>) => void }) {
  const { db, paypal } = options;
  const wait: Wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jobCost = options.judges?.reduce((sum, judge) => sum + judge.max_cost_minor, 0n) ?? 0n;
  const background = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    const tracked = work.catch(error => { logError(new Request('http://localhost/jobs'), 'escrowBackground', error); });
    background.add(tracked);
    options.waitUntil?.(tracked);
    void tracked.finally(() => background.delete(tracked));
  };

  async function readJob(id: string) {
    return db.transaction(null, async tx => {
      const job = (await tx.query<JobRow>('select id,lease_id,seller_id,amount_minor,state,rubric,deliverable_hash,acceptance from public.jobs where id=$1', [id])).rows[0];
      if (!job) return null;
      const verdicts = await tx.query<{ judge_provider: string; model: string; verdict: string; score: number; reasons: string[] }>(
        `select judge_provider,model,verdict,score,reasons from public.verdicts where job_id=$1
         and round=(select max(round) from public.verdicts where job_id=$1) order by judge_provider`, [id]);
      const decision = (await tx.query<{ id: string; round: number; outcome: string; amount_minor: string; derived_from: unknown }>(
        'select id,round,outcome,amount_minor,derived_from from public.decisions where job_id=$1 order by round desc, created_at desc limit 1', [id])).rows[0];
      return {
        id: job.id, lease_id: job.lease_id, seller_id: job.seller_id, amount_minor: safe(job.amount_minor), state: job.state, rubric: job.rubric,
        deliverable_hash: job.deliverable_hash, verdicts: verdicts.rows,
        decision: decision ? { ...decision, amount_minor: safe(decision.amount_minor) } : null,
      };
    });
  }

  const createJob: RouteHandler = async ({ body }) => {
    const input = body as { lease_id: string; seller_id: string; amount_minor: number; rubric: { min_score: number; pay_bps: number }[]; acceptance?: Record<string, unknown> };
    const accept = { ...(input.acceptance ?? {}) } as Acceptance & Record<string, unknown>;
    // The contract declares only 201 and 402 for createJob, so an invalid request fails as a logged 500. See docs/requests/004.
    if (accept.test_command_id !== undefined) throw new ApiError('No acceptance commands are allow-listed');
    if (accept.max_bytes === undefined) accept.max_bytes = DEFAULT_MAX_BYTES;
    if (accept.content_type === undefined) accept.content_type = 'text/plain';
    if (typeof accept.criteria === 'string' && accept.criteria.length > 2000) throw new ApiError('criteria exceeds 2000 characters');
    const usage = await commitUsage(db, input.lease_id, { kind: 'job', seller_id: input.seller_id, amount_minor: BigInt(input.amount_minor), rubric: input.rubric, acceptance: accept as never });
    if (usage.status !== 'served' || !usage.id) {
      const hold = (await db.transaction(null, tx => tx.query<{ hold: string }>(
        `select coalesce(sum(case direction when 'D' then amount_minor else -amount_minor end),0)::text as hold
         from public.ledger_entries where lease_id=$1 and account='HOLD_AVAILABLE'`, [input.lease_id]))).rows[0]!.hold;
      return { status: 402, body: { ok: false, reason: reasons[usage.status as keyof typeof reasons], price_minor: input.amount_minor, remaining_minor: safe(hold), lease_id: input.lease_id } };
    }
    return { status: 201, body: await readJob(usage.id) };
  };

  const getJob: RouteHandler = async ({ params }) => {
    const job = await readJob(params.jobId!);
    return job ? { status: 200, body: job } : problem(404, 'Job not found');
  };

  const deliverJob: RouteHandler = async ({ params, body }) => {
    if (!options.judges) return problem(409, 'Judging is unavailable');
    const text = (body as { deliverable: string }).deliverable;
    const job = await db.transaction(null, async tx => (await tx.query<JobRow>('select id,lease_id,seller_id,amount_minor,state,rubric,deliverable_hash,acceptance from public.jobs where id=$1', [params.jobId])).rows[0]);
    if (!job) return problem(404, 'Job not found');
    const limit = Number((job.acceptance as { max_bytes?: number }).max_bytes ?? DEFAULT_MAX_BYTES);
    if (Buffer.byteLength(text, 'utf8') > limit) return problem(409, 'Deliverable exceeds the job byte limit');
    // One atomic claim under the lease lock: only the request that moves open to delivered starts judging.
    const rejected = await db.transaction(job.lease_id, async tx => {
      // A delivery hash is committed before provider calls and survives failed providers and restarts.
      await tx.query('select pg_advisory_xact_lock(234171, 3)');
      const { rows: [usage] } = await tx.query<{ total: string; lease: string }>(`
        select count(*) as total, count(*) filter (where lease_id=$1) as lease
        from public.jobs where deliverable_hash is not null`, [job.lease_id]);
      if (jobCost * (BigInt(usage!.total) + 1n) > options.budgetCents || BigInt(usage!.lease) >= 3n) {
        return 'Judge budget exhausted';
      }
      const claim = await tx.query("update public.jobs set state='delivered',deliverable_hash=$2 where id=$1 and state='open'",
        [job.id, deliverableHash(text)]);
      return claim.rowCount === 1 ? null : 'Job is not open for delivery';
    });
    if (rejected) return problem(409, rejected);
    track(finishJob(job, text));
    return { status: 202, body: await readJob(job.id) };
  };

  /** Judge, let the kernel decide, capture the decided amount, queue the payout, then send it after the hold. */
  async function finishJob(job: JobRow, text: string) {
    const acceptance = job.acceptance;
    const judgment = await runJudges({ job_id: job.id, deliverable: { text, content_type: acceptance.content_type ?? 'text/plain' }, acceptance, providers: options.judges!, guard: new SpendGuard(jobCost) });
    const decision = await recordJudgment(db, job.lease_id, job.id, 1, judgment);
    if (!['release', 'partial'].includes(decision.outcome) || decision.amount_minor <= 0n) return;
    if (!await captureDecision(job.lease_id, job.id, decision.id, decision.amount_minor)) return;
    const earned = await accrueSeller(db, job.lease_id, decision.id);
    const payout = await queuePayout(db, job.lease_id, { ...earned, source: 'job', decision_id: decision.id });
    await wait(Math.max(0, payout.release_at.getTime() - Date.now()) + 1000);
    await sendQueuedPayout(job.lease_id, payout.id);
  }

  async function captureDecision(lease: string, job: string, decision: string, amount: bigint) {
    const auth = (await db.transaction(lease, tx => tx.query<{ id: string; paypal_authorization_id: string }>(
      "select id,paypal_authorization_id from public.authorizations where lease_id=$1 and status in ('created','partially_captured')", [lease]))).rows[0];
    if (!auth) throw new Error('No live authorization to capture from');
    const call = await beginCapture(db, lease, { authorization_id: auth.id, allocations: [{ ref_id: job, amount_minor: amount }], decision_id: decision });
    if (!await markCallSent(db, lease, call.call_id)) throw new Error('Capture intent was not claimed');
    let status: number; let responseBody: unknown;
    try {
      const result = await paypal.capture(auth.paypal_authorization_id, usd(call.amount_minor), call.invoice_id, call.request_id);
      status = result.status; responseBody = result.body;
    } catch (error) {
      if (error instanceof PayPalError && error.status === 422) { status = error.status; responseBody = error.body; }
      else {
        if (error instanceof PayPalError) {
          try { await recordRejectedCall(db, lease, call.call_id, { http_status: error.status, body: objectField(error.body) }); return false; } catch { /* fall through to unknown */ }
        }
        await markUnknown(db, lease, call.call_id);
        throw error;
      }
    }
    const evidence: Evidence = { http_status: status, body: objectField(responseBody) };
    if (evidence.body.status === 'PENDING') { await recordPendingCapture(db, lease, call.capture_id, evidence); return false; }
    if (status === 422 || ['DECLINED', 'DENIED'].includes(String(evidence.body.status))) { await failCapture(db, lease, call.capture_id, evidence); return false; }
    await completeCapture(db, lease, call.capture_id, evidence);
    return true;
  }

  /** Also callable from a scheduled sweep: sends one queued payout whose hold has passed. */
  async function sendQueuedPayout(lease: string, payoutId: string) {
    const sent = await claimDuePayout(db, lease, payoutId);
    if (!sent) return;
    let batch: string;
    try {
      const result = await paypal.payout(sent.receiver_email, usd(sent.amount_minor), sent.request_id);
      batch = stringField(objectField(objectField(result.body).batch_header).payout_batch_id);
    } catch (error) {
      if (error instanceof PayPalError) {
        try { await recordRejectedCall(db, lease, sent.call_id, { http_status: error.status, body: objectField(error.body) }); return; } catch { /* unknown below */ }
      }
      await markUnknown(db, lease, sent.call_id);
      throw error;
    }
    // Record the first GET separately. The payout call's evidence is frozen once written.
    if (await readPayout(lease, sent.call_id, batch, true)) return;
    for (let i = 0; i < (options.polls ?? 8); i++) {
      await wait(options.pollMs ?? 15_000);
      if (await readPayout(lease, sent.call_id, batch)) return;
    }
  }

  async function readPayout(lease: string, callId: string, batch: string, record = false) {
    const get = record ? await beginPayPalCall(db, lease, 'get') : null;
    if (get) await markCallSent(db, lease, get.call_id);
    const read = await paypal.getPayout(batch);
    const body = objectField(read.body);
    const header = objectField(body.batch_header);
    if (header.payout_batch_id !== batch) throw new Error('PayPal GET resource differs from request');
    if (get) {
      await db.transaction(lease, async tx => finish(tx, await loadCall(tx, lease, get.call_id), 'succeeded', { http_status: read.status, body }));
    }
    if (header.batch_status === 'PENDING' || header.batch_status === 'PROCESSING') return false;
    await reconcileSentPayout(db, lease, callId, { http_status: read.status, body, source: 'get' });
    return true;
  }

  function sweep(lease: string) {
    track((async () => {
      const { rows } = await db.transaction(null, tx => tx.query<{ id: string; call_id: string; batch: string | null }>(`
        select p.id,p.call_id,r.batch from public.payouts p
        left join public.paypal_calls c on c.id=p.call_id
        left join lateral (
          select g.response #>> '{batch_header,payout_batch_id}' as batch from public.paypal_calls g
          where g.lease_id=p.lease_id and g.op='get' and g.state='succeeded'
            and g.response #>> '{batch_header,sender_batch_header,sender_batch_id}'=c.request_id::text
          order by g.created_at desc limit 1
        ) r on p.state='sent'
        where p.lease_id=$1 and ((p.state='queued' and p.held_at is null and p.release_at<=now())
          or (p.state='sent' and c.state='sent' and r.batch is not null))
        order by p.release_at limit 10`, [lease]));
      const results = await Promise.allSettled(rows.map(row => row.batch
        ? readPayout(lease, row.call_id, row.batch)
        : sendQueuedPayout(lease, row.id)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    })());
  }

  return { createJob, getJob, deliverJob, sweep, sendQueuedPayout, drain: async () => { while (background.size) await Promise.all([...background]); } };
}
