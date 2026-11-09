import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSettlementSchedule } from '../src/scheduler.ts';
import type { SettlementState } from '../../../packages/kernel/src/settlement.ts';

const state: SettlementState = { capturable_minor: 100n, committed_unsettled_minor: 100n, unsettled_limit_minor: 1000n, fee_target_bps: 100n, exposure_trigger_bps: 9000n, honor_until: new Date('2026-11-08T00:00:00Z'), now: new Date('2026-11-07T00:00:00Z'), closing: false };

test('scheduler dispatches only plans selected by the real kernel planner', async () => {
  const calls: unknown[] = [];
  const results = await runSettlementSchedule([{ leaseId: 'wait', state }, { leaseId: 'close', state: { ...state, closing: true } }], async (lease, plan) => { calls.push({ lease, plan }); });
  assert.deepEqual(results, [{ leaseId: 'wait', planned: false, dispatched: false }, { leaseId: 'close', planned: true, dispatched: true }]);
  assert.deepEqual(calls, [{ lease: 'close', plan: { amount_minor: 100n, reason: 'closing' } }]);
});

test('scheduler continues after a per-lease execution failure', async () => {
  const results = await runSettlementSchedule([{ leaseId: 'bad', state: { ...state, closing: true } }, { leaseId: 'good', state: { ...state, closing: true } }], async lease => { if (lease === 'bad') throw Error('fixture'); });
  assert.equal(results[0].dispatched, false); assert.equal(results[1].dispatched, true);
});
