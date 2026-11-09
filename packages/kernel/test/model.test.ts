import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as k from '../src/index.ts';
import { active, admin, authorization, commit, completed, db, declined, ledger, seed, voided } from './fixtures.ts';

beforeAll(seed);
afterAll(async () => { await db.end(); await admin.end(); });

const operations = ['commit', 'commit', 'begin', 'begin', 'complete', 'fail', 'reauthorize', 'void', 'close'] as const;
const runs = 1000;
const propertySeed = 50501;

test('fixture lease model agrees with journal and state after every generated step', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(300n, 700n, 1000n),
    fc.boolean(),
    fc.array(fc.tuple(fc.constantFrom(...operations), fc.constantFrom(100n, 300n, 700n)), { minLength: 4, maxLength: 10 }),
    async (cap, aged, steps) => {
      const exposure = cap > 300n ? cap - 100n : cap;
      const initial = await active(cap, exposure, aged ? 4 : 0);
      const { lease } = initial;
      let auth = initial.auth;
      let honor = !aged;
      let live = true;
      let hold: bigint = cap;
      let committed = 0n;
      let gross = 0n;
      let writtenOff = 0n;
      let released = 0n;
      let closed = false;
      let pending: Awaited<ReturnType<typeof k.beginCapture>> | undefined;
      const unsettled = new Map<string, bigint>();
      const captured = new Set<string>();
      let pendingRef = '';

      for (const [operation, price] of steps) {
        if (operation === 'commit') {
          const expected = !honor || !live || closed ? 'refused_window' :
            price > hold ? 'refused_cap' : price + committed > exposure ? 'refused_exposure' : 'served';
          const result = await commit(lease, price);
          expect(result.status).toBe(expected);
          if (expected === 'served') {
            committed += price;
            hold -= price;
            unsettled.set(result.id!, price);
          }
        } else if (operation === 'begin' && live && !closed && unsettled.size) {
          const [ref, amount] = unsettled.entries().next().value!;
          const action = k.beginCapture(db, lease, { authorization_id: auth, allocations: [{ ref_id: ref, amount_minor: amount }] });
          if (pending) {
            await expect(action).rejects.toMatchObject({ code: '23505' });
          } else {
            pending = await action;
            pendingRef = ref;
            await k.markCallSent(db, lease, pending.call_id);
          }
        } else if ((operation === 'complete' || operation === 'fail') && pending) {
          const amount = pending.amount_minor;
          if (operation === 'complete') {
            await k.completeCapture(db, lease, pending.capture_id, completed(randomUUID(), amount));
            gross += amount;
            captured.add(pendingRef);
            if (gross === cap) live = false;
          } else {
            await k.failCapture(db, lease, pending.capture_id, declined(randomUUID(), amount));
            writtenOff += amount;
          }
          committed -= amount;
          unsettled.delete(pendingRef);
          pending = undefined;
        } else if (operation === 'reauthorize' && live && !closed) {
          const action = k.beginReauthorize(db, lease);
          if (honor || pending) {
            await expect(action).rejects.toThrow();
          } else {
            const call = await action;
            expect(call.amount_minor).toBe(cap - gross);
            await k.markCallSent(db, lease, call.call_id);
            auth = (await k.completeReauthorize(db, lease, call.call_id,
              { http_status: 201, body: authorization(cap - gross) })).id;
            honor = true;
          }
        } else if (operation === 'void' && live && !closed) {
          const action = k.beginVoid(db, lease);
          if (committed > 0n) {
            await expect(action).rejects.toThrow('commitments');
          } else {
            const call = await action;
            await k.markCallSent(db, lease, call.call_id);
            await k.completeVoid(db, lease, call.call_id, voided);
            released = hold;
            hold = 0n;
            live = false;
          }
        } else if (operation === 'close') {
          if (live || committed > 0n || hold > 0n || pending) {
            await expect(k.closeLease(db, lease)).rejects.toThrow('I14');
          } else {
            if (!closed) for (const ref of captured) await k.accrueSeller(db, lease, ref);
            await k.closeLease(db, lease);
            closed = true;
          }
        }

        const accounts = await ledger(lease);
        expect(accounts.BUYER_COMMITMENT).toBe(cap);
        expect(accounts.HOLD_AVAILABLE ?? 0n).toBe(hold);
        expect(accounts.COMMITTED_UNSETTLED ?? 0n).toBe(committed);
        expect(accounts.CAPTURED_GROSS ?? 0n).toBe(gross);
        expect(accounts.WRITTEN_OFF ?? 0n).toBe(writtenOff);
        expect(accounts.RELEASED ?? 0n).toBe(released);
        expect(hold + committed + gross + writtenOff + released).toBe(cap);
        const persisted = (await admin.query(`select l.state,
          (select a.id from public.authorizations a where a.lease_id=l.id and a.status in ('created','partially_captured')) as live,
          (select c.id from public.captures c where c.lease_id=l.id and c.status in ('intent','pending','unknown')) as inflight
          from public.leases l where l.id=$1`, [lease])).rows[0];
        expect(persisted).toEqual({ state: closed ? 'closed' : 'active', live: live ? auth : null, inflight: pending?.capture_id ?? null });
      }
    },
  ), { numRuns: runs, seed: propertySeed });
  console.log(`computed: ${runs} stateful property and database model runs passed (fixture seed ${propertySeed})`);
}, 360_000);
