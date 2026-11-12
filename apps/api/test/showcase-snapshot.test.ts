import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../../packages/kernel/src/db.ts';
import { showcaseRoutes } from '../src/showcase.ts';
import { commitUsageInTransaction, previewUsage } from '../../../packages/kernel/src/usage.ts';

test('the public live showcase returns one repeatable-read journal snapshot', async () => {
  const lease = '11111111-1111-4111-8111-111111111111';
  let transactions = 0;
  const isolations: unknown[] = [];
  const db = {
    transaction: async (_lease: string | null, work: (tx: unknown) => Promise<unknown>, isolation?: string) => {
      transactions++;
      isolations.push(isolation);
      const tx = { query: async (sql: string) => {
        if (sql.includes('transaction_timestamp()')) return { rows: [{ read_at: new Date('2026-11-12T12:00:00Z') }] };
        if (sql.includes('from public.leases l where')) return { rows: [{ id: lease, state: 'active', cap_minor: '200', unsettled_limit_minor: '100', guaranteed_now: true, authorizations: [{ status: 'created', amount_minor: '200', honor_until: '2026-11-15T12:00:00Z' }], balances: { hold_available: '197', committed_unsettled: '3', total_captured: '0' } }] };
        if (sql.includes('from public.ledger_entries where')) return { rows: [] };
        if (sql.includes('from public.tool_calls t')) return { rows: [] };
        if (sql.includes('from public.captures where')) return { rows: [] };
        if (sql.includes('select count(*)::int as total')) return { rows: [{ total: 0, daily: 0, ip: 0 }] };
        throw new Error(`Unexpected query: ${sql.slice(0, 50)}`);
      } };
      return work(tx);
    },
  } as unknown as Database;
  const tool = { name: 'summarise', description: 'fixture', admit: () => null };
  const response = await showcaseRoutes(db, lease, 'fixture secret', tool, 2).request('http://localhost/showcase');
  assert.equal(response.status, 200);
  assert.equal(transactions, 1);
  assert.deepEqual(isolations, ['repeatable read']);
  const body = await response.json();
  assert.equal(body.lease.balances.hold_available, 197);
  assert.equal(body.read_at, '2026-11-12T12:00:00.000Z');
});

test('the public price preview never locks the live lease', async () => {
  const lease = '11111111-1111-4111-8111-111111111111';
  const calls: unknown[][] = [];
  const db = { transaction: async (...args: unknown[]) => {
    calls.push(args.slice(0, 1).concat(args[2]));
    return (args[1] as (tx: unknown) => Promise<unknown>)({ query: async (sql: string) => ({ rows: [sql.includes('from public.leases l')
      ? { state: 'active', unsettled_limit_minor: '100', within_window: true, voiding: false }
      : { hold: '97', committed: '3' }] }) });
  } } as unknown as Database;
  const result = await previewUsage(db, lease, 1n);
  assert.equal(result.status, 'served');
  assert.deepEqual(calls, [[null, 'repeatable read']]);
});

test('a denied public run does not lock, admit a model, or write a call', async () => {
  const lease = '11111111-1111-4111-8111-111111111111';
  const statements: string[] = [];
  let admitted = 0;
  const db = { transaction: async (_lease: string | null, work: (tx: unknown) => Promise<unknown>, isolation?: string) => {
    assert.equal(_lease, null);
    assert.equal(isolation, 'repeatable read');
    return work({ query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('from public.tools')) return { rows: [{ active: true, price_minor: '3' }] };
      if (sql.includes('from public.leases l')) return { rows: [{ state: 'active', unsettled_limit_minor: '100', within_window: true, voiding: false }] };
      if (sql.includes('from public.ledger_entries')) return { rows: [{ hold: '0', committed: '0' }] };
      throw new Error(`Unexpected query: ${sql}`);
    } });
  } } as unknown as Database;
  const tool = { name: 'summarise', description: 'fixture', admit: () => { admitted++; return null; } };
  const response = await showcaseRoutes(db, lease, 'fixture secret', tool, 2).request('http://localhost/showcase/run', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 402);
  assert.equal((await response.json()).reason, 'cap_reached');
  assert.equal(admitted, 0);
  assert.equal(statements.some(sql => /insert|advisory|tool_calls/i.test(sql)), false);
});

test('a cap closed between preflight and commit leaves no public refusal row', async () => {
  const statements: string[] = [];
  const tx = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes('from public.tool_calls')) return { rows: [] };
    if (sql.includes('from public.tools')) return { rows: [{ active: true, price_minor: '3' }] };
    if (sql.includes('from public.leases l')) return { rows: [{ state: 'active', unsettled_limit_minor: '100', within_window: true, voiding: false }] };
    if (sql.includes('from public.ledger_entries')) return { rows: [{ hold: '0', committed: '0' }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await commitUsageInTransaction(tx as never, '11111111-1111-4111-8111-111111111111',
    { kind: 'tool', tool_id: 'summarise', idempotency_key: 'showcase:fixture' }, { recordRefusal: false });
  assert.equal(result.status, 'refused_cap');
  assert.equal(result.id, null);
  assert.equal(statements.some(sql => /insert/i.test(sql)), false);
});

test('public price previews stop at a per-instance request bound before touching the database', async () => {
  const lease = '11111111-1111-4111-8111-111111111111';
  let reads = 0;
  const db = { transaction: async (_lease: string | null, work: (tx: unknown) => Promise<unknown>) => {
    reads++;
    return work({ query: async (sql: string) => ({ rows: [sql.includes('from public.leases l')
      ? { state: 'active', unsettled_limit_minor: '100', within_window: true, voiding: false }
      : { hold: '97', committed: '3' }] }) });
  } } as unknown as Database;
  const app = showcaseRoutes(db, lease, 'fixture secret', { name: 'summarise', description: 'fixture', admit: () => null }, 2);
  for (let i = 0; i < 20; i++) assert.equal((await app.request('http://localhost/showcase/try?price_minor=1', { method: 'POST' })).status, 200);
  assert.equal((await app.request('http://localhost/showcase/try?price_minor=1', { method: 'POST' })).status, 429);
  assert.equal(reads, 20);
});
