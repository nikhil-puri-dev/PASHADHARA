import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as k from '../src/index.ts';
import { active, admin, commit, completed, db, ledger, seed, toolId, usd } from './fixtures.ts';

const application = 'kernel-caller-race-fixture';
const other = new k.Database(`postgres://kernel_login@127.0.0.1:15433/postgres?application_name=${application}`);
beforeAll(seed);
afterAll(async () => { await other.end(); await db.end(); await admin.end(); });

const callWrite = /update public\.paypal_calls set state=\$2/;
const captureWrite = /update public\.captures set (status|paypal_capture_id)=/;
const authWrite = /update public\.authorizations a?\s*set status/;
const ledgerWrite = /insert into public\.ledger_entries/;
const claim = /from public\.webhook_events[\s\S]+for update/;
const marker = /update public\.webhook_events set processed_at/;
const nonceLock = /select pg_advisory_xact_lock/;
const nonceCheck = /split_part\(idempotency_key/;
const nonceWrite = /insert into public\.tool_calls/;

type Fault = { after: RegExp | 'lease'; run: (tx: PoolClient) => Promise<void> };

function intercept(tx: PoolClient, fault: Fault | undefined): PoolClient {
  if (!fault) return tx;
  return new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== 'query') return Reflect.get(target, key, receiver);
      return async (sql: string, params?: unknown[]) => {
        const result = await target.query(sql, params);
        if (fault.after instanceof RegExp && fault.after.test(sql)) await fault.run(target);
        return result;
      };
    },
  });
}

const abort = (after: Fault['after']): Fault => ({
  after, run: async tx => { await tx.query('select 1/0'); },
});

const terminate = (after: Fault['after']): Fault => ({
  after,
  run: async tx => {
    const { rows: [row] } = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    tx.once('error', () => {});
    await admin.query('select pg_terminate_backend($1)', [row!.pid]);
    await tx.query('select 1');
  },
});

async function caller<T>(client: k.Database, lease: string, fault: Fault | undefined, work: (tx: PoolClient) => Promise<T>) {
  return client.transaction(lease, async tx => {
    const { rows: [identity] } = await tx.query(`select session_user,current_user,
      current_setting('transaction_isolation') as isolation`);
    expect(identity).toEqual({ session_user: 'kernel_login', current_user: 'pashadhara_app', isolation: 'read committed' });
    if (fault?.after === 'lease') await fault.run(tx);
    return work(intercept(tx, fault));
  });
}

type Webhook = {
  lease: string; event: string; callId: string; evidence: k.ReadEvidence;
  apply: typeof k.resolveUnknownInTransaction;
};

function processWebhook(client: k.Database, item: Webhook, fault?: Fault) {
  return caller(client, item.lease, fault, async tx => {
    const event = await tx.query(`select processed_at from public.webhook_events
      where id=$1 and signature_verified for update`, [item.event]);
    if (!event.rows[0] || event.rows[0].processed_at !== null) return false;
    await item.apply(tx, item.lease, item.callId, item.evidence);
    await tx.query(`update public.webhook_events set processed_at=clock_timestamp()
      where id=$1 and signature_verified`, [item.event]);
    return true;
  });
}

async function enqueue(event: string, type: string, resourceId: string, verified = true) {
  await k.recordWebhookEvent(db, {
    id: event, event_type: type, resource: { id: resourceId }, signature_verified: verified,
  });
}

async function captureEvent(): Promise<Webhook & { auth: string; capture: string }> {
  const { lease, auth } = await active();
  const usage = await commit(lease, 300n);
  const capture = await k.beginCapture(db, lease, { authorization_id: auth,
    allocations: [{ ref_id: usage.id!, amount_minor: 300n }] });
  await k.markCallSent(db, lease, capture.call_id);
  await k.markUnknown(db, lease, capture.call_id);
  const event = randomUUID();
  const remoteId = randomUUID();
  const final = completed(remoteId, 300n, 59n);
  await enqueue(event, 'PAYMENT.CAPTURE.COMPLETED', randomUUID(), false);
  await enqueue(event, 'PAYMENT.CAPTURE.COMPLETED', remoteId);
  return {
    lease, auth, capture: capture.capture_id, event, callId: capture.call_id,
    evidence: { ...final, source: 'get', body: { ...final.body, invoice_id: capture.invoice_id } },
    apply: k.resolveUnknownInTransaction,
  };
}

async function authorizationEvent(): Promise<Webhook & { auth: string }> {
  const { lease, auth, paypalAuth } = await active();
  const read = await k.beginPayPalCall(db, lease, 'get');
  await k.markCallSent(db, lease, read.call_id);
  const event = randomUUID();
  await enqueue(event, 'PAYMENT.AUTHORIZATION.EXPIRED', paypalAuth);
  return { lease, auth, event, callId: read.call_id, apply: k.recordAuthorizationReadInTransaction,
    evidence: { source: 'get', http_status: 200, body: { id: paypalAuth, status: 'EXPIRED' } } };
}

async function webhookState(item: Webhook & { auth: string }) {
  return (await admin.query(`select p.state as call, a.status as authorization, l.state as lease, p.response,
    c.status as capture, c.paypal_capture_id, w.processed_at,
    (select count(*)::int from public.ledger_entries e
      where e.lease_id=l.id and e.ref_type='capture' and e.account='CAPTURED_GROSS' and e.direction='D') as captures
    from public.paypal_calls p join public.leases l on l.id=p.lease_id
    join public.authorizations a on a.id=$2
    left join public.captures c on c.call_id=p.id
    join public.webhook_events w on w.id=$3 and w.signature_verified
    where p.id=$1`, [item.callId, item.auth, item.event])).rows[0]!;
}

const captureAbort = [
  ['lease lock', 'lease'], ['verified claim', claim], ['call write', callWrite],
  ['capture write', captureWrite], ['journal write', ledgerWrite],
  ['authorization write', authWrite], ['processed marker', marker],
] as const;
test.each(captureAbort)('fixture capture webhook abort after %s is retryable', async (_label, boundary) => {
  const item = await captureEvent();
  const before = await webhookState(item);
  await expect(processWebhook(db, item, abort(boundary))).rejects.toMatchObject({ code: '22012' });
  expect(await webhookState(item)).toEqual(before);
  expect(await processWebhook(other, item)).toBe(true);
  const after = await webhookState(item);
  expect(after).toMatchObject({ call: 'succeeded', authorization: 'partially_captured', capture: 'completed',
    captures: 1, processed_at: expect.any(Date) });
  expect(await processWebhook(db, item)).toBe(false);
  expect(await webhookState(item)).toEqual(after);
  expect(await ledger(item.lease)).toMatchObject({ COMMITTED_UNSETTLED: 0n, CAPTURED_GROSS: 241n, PAYPAL_FEES: 59n });
});

const authAbort = [
  ['lease lock', 'lease'], ['verified claim', claim], ['call write', callWrite],
  ['authorization write', authWrite], ['lease write', /update public\.leases set state=\$2/], ['processed marker', marker],
] as const;
test.each(authAbort)('fixture authorization webhook abort after %s is retryable', async (_label, boundary) => {
  const item = await authorizationEvent();
  const before = await webhookState(item);
  await expect(processWebhook(db, item, abort(boundary))).rejects.toMatchObject({ code: '22012' });
  expect(await webhookState(item)).toEqual(before);
  expect(await processWebhook(other, item)).toBe(true);
  const after = await webhookState(item);
  expect(after).toMatchObject({ call: 'succeeded', authorization: 'expired', lease: 'expired',
    captures: 0, processed_at: expect.any(Date) });
  expect(await processWebhook(db, item)).toBe(false);
  expect(await webhookState(item)).toEqual(after);
});

test('fixture nonterminal or misbound GET leaves the verified webhook retryable', async () => {
  const item = await captureEvent();
  const before = await webhookState(item);
  const pending = { ...item.evidence, body: { ...item.evidence.body, status: 'PENDING', amount: usd(300n) } };
  await expect(processWebhook(db, { ...item, evidence: pending }, abort(captureWrite))).rejects.toThrow('no terminal');
  await expect(processWebhook(db, { ...item, evidence: {
    ...item.evidence, body: { ...item.evidence.body, invoice_id: randomUUID() },
  } })).rejects.toThrow('invoice');
  const unrelated = await captureEvent();
  const unrelatedBefore = await webhookState(unrelated);
  await expect(processWebhook(db, { ...item, callId: unrelated.callId })).rejects.toThrow('Kernel record not found');
  expect(await webhookState(unrelated)).toEqual(unrelatedBefore);
  expect(await webhookState(item)).toEqual(before);
  expect(await processWebhook(other, item)).toBe(true);
});

test('fixture connection termination after webhook marker rolls back reconciliation and claim', async () => {
  const item = await captureEvent();
  const before = await webhookState(item);
  await expect(processWebhook(db, item, terminate(marker))).rejects.toThrow();
  expect(await webhookState(item)).toEqual(before);
  expect(await processWebhook(other, item)).toBe(true);
  expect(await webhookState(item)).toMatchObject({ processed_at: expect.any(Date), captures: 1 });
});

function invocationKey(nonce: string, tool: string, input: string) {
  return nonce + ':' + createHash('sha256').update(tool + '\0' + input).digest('hex');
}

function bindUsage(client: k.Database, lease: string, nonce: string, input: string, fault?: Fault) {
  const tool = toolId(300n);
  const key = invocationKey(nonce, tool, input);
  return caller(client, lease, fault, async tx => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [lease + ':' + nonce]);
    const conflict = await tx.query(`select id from public.tool_calls where lease_id=$1
      and split_part(idempotency_key,':',1)=$2 and idempotency_key<>$3`, [lease, nonce, key]);
    if (conflict.rowCount) throw new Error('Nonce already bound to a different input');
    return k.commitUsageInTransaction(tx, lease, { kind: 'tool', tool_id: tool, idempotency_key: key });
  });
}

async function usageState(lease: string) {
  return (await admin.query(`select
    (select count(*)::int from public.tool_calls where lease_id=$1) as tools,
    (select count(*)::int from public.ledger_entries where lease_id=$1 and ref_type='commit'
      and account='COMMITTED_UNSETTLED') as charges,
    (select coalesce(sum(amount_minor),0)::text from public.ledger_entries where lease_id=$1
      and ref_type='commit' and account='COMMITTED_UNSETTLED') as total`, [lease])).rows[0];
}

const usageAbort = [
  ['lease lock', 'lease'], ['nonce lock', nonceLock], ['nonce check', nonceCheck],
  ['journal write', ledgerWrite], ['nonce write', nonceWrite],
] as const;
test.each(usageAbort)('fixture paid invocation abort after %s releases the charge and binding', async (_label, boundary) => {
  const { lease } = await active();
  const nonce = randomUUID();
  await expect(bindUsage(db, lease, nonce, 'input', abort(boundary))).rejects.toMatchObject({ code: '22012' });
  expect(await usageState(lease)).toEqual({ tools: 0, charges: 0, total: '0' });
  const retry = await bindUsage(other, lease, nonce, 'input');
  expect(retry).toMatchObject({ status: 'served', amount_minor: 300n, replayed: false });
  expect(await bindUsage(db, lease, nonce, 'input')).toEqual({ ...retry, replayed: true });
  await expect(bindUsage(db, lease, nonce, 'different')).rejects.toThrow('different input');
  expect(await usageState(lease)).toEqual({ tools: 1, charges: 1, total: '300' });
});

test('fixture connection termination after nonce insert rolls back charge and releases binding', async () => {
  const { lease } = await active();
  const nonce = randomUUID();
  await expect(bindUsage(db, lease, nonce, 'abandoned', terminate(nonceWrite))).rejects.toThrow();
  expect(await usageState(lease)).toEqual({ tools: 0, charges: 0, total: '0' });
  expect(await bindUsage(other, lease, nonce, 'recovered')).toMatchObject({ status: 'served', replayed: false });
  expect(await usageState(lease)).toEqual({ tools: 1, charges: 1, total: '300' });
});

test('fixture committed charge with a lost response can serve the deterministic result on retry', async () => {
  const { lease } = await active();
  const nonce = randomUUID();
  const input = 'fixture';
  const abandoned = await bindUsage(db, lease, nonce, input);
  expect(abandoned.status).toBe('served');
  // The first worker stops after commit, before calling the tool.
  const retry = await bindUsage(other, lease, nonce, input);
  expect(retry).toEqual({ ...abandoned, replayed: true });
  const toolResult = retry.status === 'served' ? Buffer.byteLength(input) : null;
  expect(toolResult).toBe(7);
  expect(await usageState(lease)).toEqual({ tools: 1, charges: 1, total: '300' });
});

function retryOnce(after: RegExp) {
  let hits = 0;
  const fault: Fault = { after, run: async tx => {
    if (++hits === 1) await tx.query("do $$ begin raise exception 'fixture retry' using errcode='40001'; end $$");
  } };
  return { fault, attempts: () => hits };
}

test('fixture 40001 after processed marker retries the whole webhook transaction', async () => {
  const item = await captureEvent();
  const { fault, attempts } = retryOnce(marker);
  expect(await processWebhook(db, item, fault)).toBe(true);
  expect(attempts()).toBe(2);
  expect(await webhookState(item)).toMatchObject({ processed_at: expect.any(Date), captures: 1 });
});

test('fixture 40001 after nonce insert retries the whole paid invocation', async () => {
  const { lease } = await active();
  const { fault, attempts } = retryOnce(nonceWrite);
  expect(await bindUsage(db, lease, randomUUID(), 'input', fault)).toMatchObject({ status: 'served', replayed: false });
  expect(attempts()).toBe(2);
  expect(await usageState(lease)).toEqual({ tools: 1, charges: 1, total: '300' });
});

async function race<T>(after: RegExp, first: (fault: Fault) => Promise<T>, second: () => Promise<T>) {
  let signalHeld!: () => void;
  let release!: () => void;
  const held = new Promise<void>(resolve => { signalHeld = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const a = first({ after, run: async () => { signalHeld(); await released; } });
  let b: Promise<T> | undefined;
  try {
    await Promise.race([held, a]);
    b = second();
    // A conflicting nonce can reject as soon as the first caller releases its lease lock.
    void b.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 40 && !blocked; attempt++) {
      const waiting = await admin.query(`select 1 from pg_stat_activity
        where application_name=$1 and wait_event_type='Lock' and query like '%public.lock_lease%'`, [application]);
      blocked = waiting.rowCount === 1;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
  } finally {
    release();
    // Drain both transactions even if the lock observation failed.
    await Promise.allSettled(b ? [a, b] : [a]);
  }
  return [a, b!] as const;
}

test('fixture concurrent verified webhook callers process once and ignore the unverified row', async () => {
  const item = await captureEvent();
  const attempts = await race(marker, fault => processWebhook(db, item, fault), () => processWebhook(other, item));
  expect(await Promise.all(attempts)).toEqual([true, false]);
  expect(await webhookState(item)).toMatchObject({ processed_at: expect.any(Date), captures: 1 });
  const unverified = await admin.query('select processed_at from public.webhook_events where id=$1 and not signature_verified', [item.event]);
  expect(unverified.rows[0]).toEqual({ processed_at: null });
});

test('fixture concurrent identical paid callers share one charge and the same recovery record', async () => {
  const { lease } = await active();
  const nonce = randomUUID();
  const attempts = await race(nonceWrite, fault => bindUsage(db, lease, nonce, 'input', fault),
    () => bindUsage(other, lease, nonce, 'input'));
  const [first, second] = await Promise.all(attempts);
  expect(first).toMatchObject({ status: 'served', replayed: false });
  expect(second).toEqual({ ...first, replayed: true });
  expect(await usageState(lease)).toEqual({ tools: 1, charges: 1, total: '300' });
});

test('fixture concurrent conflicting paid callers cannot bind the same nonce twice', async () => {
  const { lease } = await active();
  const nonce = randomUUID();
  const attempts = await race(nonceWrite, fault => bindUsage(db, lease, nonce, 'first', fault),
    () => bindUsage(other, lease, nonce, 'second'));
  await expect(attempts[0]).resolves.toMatchObject({ status: 'served', replayed: false });
  await expect(attempts[1]).rejects.toThrow('different input');
  expect(await usageState(lease)).toEqual({ tools: 1, charges: 1, total: '300' });
});
