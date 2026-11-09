# 002. Contract v0.3

The v0.2 blockers that `schema.test.mjs` and `concurrency.test.mjs` now assert are blocked. The application role those tests do not use cannot commit a capture or a balanced ledger group. The grant that would let it move money also lets a `search_path` shadow insert a 5,000-cent intent capture on a 1,000-cent cap. With the triggers left on, replacing `lock_lease` with a `SELECT` makes two repeatable-read completed captures of 600 both commit (sum 1,200) and leaves `COMMITTED_UNSETTLED` at -200. Several sequences balance and are still the wrong payment: a stranger is accrued the whole capture, a fee of 0 pays the gross, a reversed capture stays payable, and a payout that already has a PayPal batch id can be marked failed and queued again as metered.

Single-connection attacks ran on PGlite (PostgreSQL 17.5, wasm, `@electric-sql/pglite` 0.3.14). Two-connection attacks ran on Postgres 15.19 in Docker (`postgres:15`, host port 15432, trust auth, container `pashadhara-adv` removed after the run). Containers whose names start with `supabase` were left running. PGlite is one backend, so it cannot wait on its own row lock.

Scripts: `adversarial/contract-v03.mjs`, `adversarial/contract-concurrency-v03.mjs`. The v0.2 scripts were not rewritten.

Decisive lines:

```
HOLDS  V02 B1 reversed then declined frees the cap
  Capture status reversed to declined is not allowed. declined, denied and reversed are terminal.
HOLDS  V02 B3 rewrite payout amount seller and state
  Immutable column payouts.seller_id changed
HOLDS  V02 B2 void the books then complete the capture and close
  I17 violated: in-flight captures 1000 exceed committed usage 0

WORKS  N9 app role cannot commit a capture or a ledger row
  balanced-ledger=permission denied for function check_lease_consistency
  capture=permission denied for function check_lease_consistency captures_left=0
WORKS  N8 search_path shadow inserts a capture past the cap
  capture=21b8304e-7f6a-40b1-bd28-a09f5639c6c5 search_path=pg_catalog public_sum=5000 public_cap=1000
WORKS  N8b app role, after the missing EXECUTE grant, search_path still beats the cap
  capture=03dfa5e1-ee80-4f04-b924-4a0d6018658a public_sum=5000 cap=1000

RACE  V02 repeatable-read completed 600+600
  a:commit || b:40001 could not serialize access due to concurrent update
  captures=1 sum=600 counted=600 committed=400
RACE  NOOP lock repeatable-read completed 600+600
  b:commit || a:commit
  captures=2 sum=1200 counted=1200 committed=-200

WORKS  N1 one unsure voids when derived_from merely contains precheck_failed
  unsure-false=VOIDED one-fail-false=VOIDED unsure-true=VOIDED no-judges-false=VOIDED; one-pass-with-key=blocked
WORKS  N3 accrue and pay a seller who has no job and no tool call
  jobs=0 tool_calls=0 payout=134c1246-... receiver=stranger@x.com
  SELLER_PAYABLE=300
WORKS  N5 payout with a PayPal batch id is failed and the accrual is paid again as metered
  job_state=held second_job_payout=blocked
  rows=job:failed:batch=BATCH-REAL:held=true metered:queued:batch=null:held=false
```

## 1. The role that is supposed to move money cannot, and the fix loses the cap

### F1. `pashadhara_app` has no EXECUTE on the check the triggers call. Blocker

**Evidence.** `roles.sql` revokes every function from `PUBLIC` and grants `EXECUTE` only on `lock_lease(uuid)`. The trigger functions are `SECURITY INVOKER` (`proconfig` unset: `definer=false search_path=unset` for `check_lease_consistency`, `ledger_deferred_check`, `captures_deferred_check`, and the rest).

As `pashadhara_app`, a balanced two-leg commit of 1 cent:

```
balanced-ledger=permission denied for function check_lease_consistency
capture=permission denied for function check_lease_consistency captures_left=0
```

The same denial on two Postgres connections, after each session created `pg_temp.lock_lease` and set `search_path` to `pg_temp, public`:

```
RACE  app search_path shadows lock_lease, repeatable-read intent 600+600
  a:42501 permission denied for function check_lease_consistency
  || b:42501 permission denied for function check_lease_consistency
  captures=0 sum=0
```

The trigger function itself starts. A one-legged insert in an earlier draft of this script failed inside `ledger_deferred_check` with I2, before the inner `perform check_lease_consistency`. The 152 schema checks insert a lease, which has no deferred check, and never commit a capture or a ledger group as this role. `INVARIANTS.md` says the kernel must connect as `pashadhara_app`. That connection cannot record a capture or a commit.

**Fix.** `GRANT EXECUTE` on every trigger function and on `check_lease_consistency(uuid)` to `pashadhara_app`. Do that in the same migration as F2. A grant alone makes the next finding the application's own power.

### F2. Unqualified names in the triggers follow `search_path`. A temp table is the cap. Blocker

**Evidence.** Fresh PGlite, superuser. Temp copies of `leases` and `authorizations` with `cap_minor` and `amount_minor` set to 5,000,000. An empty temp `captures` with only the columns the sums read. `SET search_path = pg_temp, public` and `DISCARD PLANS`. One transaction inserts `public.paypal_calls` and `public.captures` of 5,000 as `intent`, then `UPDATE pg_temp.leases SET cap_minor = 1000` before commit. The insert trigger and the deferred check both read the temp tables. After `RESET search_path`, schema-qualified reads:

```
search_path=pg_catalog public_sum=5000 public_cap=1000
capture=21b8304e-7f6a-40b1-bd28-a09f5639c6c5
```

The same shadow after `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pashadhara_app` inside that database only (`roles.sql` was not edited), then `SET ROLE pashadhara_app`:

```
public_sum=5000 cap=1000
capture=03dfa5e1-ee80-4f04-b924-4a0d6018658a
```

`check_lease_consistency` re-sums the cap. That re-sum reads the shadow too, so running it again is not a fix while the names stay unqualified. `INVARIANTS.md` does not list this. It lists owner bypass of triggers, which is a different path (F10).

**Fix.** In every function body, schema-qualify tables and functions (`public.leases`, `public.captures`, `public.lock_lease`). Add `SET search_path = pg_catalog` to each function. Reject `search_path` values that contain `pg_temp` at the kernel entrypoint as a second belt. Add this session to the schema tests: a temp `leases` with a larger cap must still raise I1.

## 2. Sequences that balance and pay the wrong amount

These committed as the table owner. The application role cannot run them until F1 is granted. After that grant they are ordinary inserts.

### F3. Accrual and metered payout ignore who did the work. A reversed capture stays payable. A fee of 0 pays the gross. Blocker

**Evidence.** Cap 1,000. One completed capture of 300, fee 0, posted. A second seller, inserted with `payout_hold_seconds = 30`, has no jobs and no tool calls. Accrue all 300 to that seller and insert a metered payout with `release_at = now() + 30 seconds`:

```
jobs=0 tool_calls=0 payout=134c1246-5e61-4fed-8cee-f799d2c2428c receiver=stranger@x.com
BUYER_COMMITMENT=1000 HOLD_AVAILABLE=700 COMMITTED_UNSETTLED=0
CAPTURED_GROSS=300 SELLER_COST=300 SELLER_PAYABLE=300
```

I13's job branch checks the job's seller and a completed capture. The accrue posting and the metered branch do not. Seller accrual is the sum of `SELLER_PAYABLE` credits for that seller. `check_lease_consistency` compares `SELLER_COST` to net captured on the lease, so any seller can take the whole net.

Same shape with the fee left at 0 and no fee legs. The group balances. The measured fee on a 300-cent ($3.00) capture is 59 cents (`evidence/RESULTS.md`, three captures, fee 0.59 on 3.00). The books hand that 59 cents to the seller:

```
fee_minor=0 (measured fee on 300 cents is 59)
SELLER_COST=300 SELLER_PAYABLE=300
```

The schema and the contract tests allow `fee_minor = 0`. This is a balanced book that is financially wrong, not a check the tests forgot to reject.

Third sequence. Capture 200 completed and posted, then `status = reversed`, with no reversal posting. Accrue 200 and queue a metered payout. A second capture of 100 is reversed and gets a reversal posting of 1 cent. I17's reversal arm is `amount_minor > capture.amount_minor` (`schema.sql` around the reversal branch of `enforce_posting_shape`). Equality is not required, and a reversed row needs no reversal posting at all. I17's deferred sum still matches, because a reversed capture counts in the capture sum and the original capture posting is still there:

```
payout_on_reversed=bf9207b7-4894-49f3-994d-09afe526a2ea
chargeback_booked=1 against_reversed_captures=300
CAPTURED_GROSS=299 SELLER_COST=200 SELLER_PAYABLE=200 CHARGEBACK_LOSS=1
counted=300 rows=2
```

`INVARIANTS.md` says a negative `CAPTURED_GROSS` is the real platform loss after the seller was paid. Here the seller is still payable 200, the payout is queued, and `CHARGEBACK_LOSS` shows 1. The payout was not moved to `sent`. That needs about 31 seconds after `release_at`, and this run did not sleep.

**Fix.** Accrue only to the seller on the job or the tool call that the capture settles, and only up to that decision or price. Metered payouts use the same identity. Require a reversal posting equal to the capture amount in the same transaction as `completed → reversed`, and cancel or reduce payouts that are still `queued` against that capture. Reject `fee_minor = 0` on a `completed` capture, or require the fee legs to equal a kernel-computed fee the model cannot choose. Keep the amount computation in the kernel.

### F4. A payout with a real batch id can be failed, and the same accrual is queued again. `jobs.state = held` does nothing. Blocker

**Evidence.** Job of 300, rubric band 10,000 bps, two passes at 95, decision release of 300, completed capture tied to that decision, accrue, job payout queued. Then `jobs.state = 'held'`. One update sets `held_at = now()` and `paypal_batch_id = 'BATCH-REAL'` (both null-to-value, so the freeze-once guard allows them). Then `queued → failed`. `payout_state_guard` allows that transition with no `response` and no `paypal_calls` row. `held_at` is checked only on the way to `sent`. A second job payout hits `one_payout_per_decision`, which still counts the failed row. A metered payout of the same 300 inserts, because the accrual sum ignores `state = 'failed'`:

```
job_state=held
second_job_payout=blocked:duplicate key value violates unique constraint "one_payout_per_decision"
metered=245032c8-4324-4b3d-bccd-bcdd88b388e5
rows=job:failed:batch=BATCH-REAL:held=true metered:queued:batch=null:held=false
```

`POST /v1/jobs/{jobId}/appeal` says "Blocks the payout and moves the job to held." No trigger reads `jobs.state` when a payout changes state.

A second insert stored `receiver_email = thief@x.com`. The insert trigger overwrote it to `seller@x.com`. That part of v0.2 holds. The row was then `queued → failed` with zero payout `paypal_calls`, and a replacement metered payout inserted:

```
inserted_email_became=seller@x.com payout_calls=0 replacement=df61ca6b-d0d5-481c-8132-b1ae63ada668
```

`success` with a null `paypal_batch_id` was not tested. The hold floor is 30 seconds, and this run did not wait.

Two sessions racing metered payouts of 200 against an accrual of 200, with the real `lock_lease`, did hold: the second raised `I13 violated: payouts 200 + 200 exceed seller accrual 200`, one payout row left. The hole is the state machine after insert, not the insert race.

**Fix.** `queued → failed` requires a `paypal_calls` row for that payout in `failed` or `unknown` with a stored response, or a newer `get`. A row that has `paypal_batch_id` set cannot become `failed` until that GET says the batch failed. Keep failed job payouts inside `one_payout_per_decision`, and make the accrual sum count them until a reversal of the accrual is posted. `jobs.state = 'held'` sets `payouts.held_at` if it is still null, and `held_at` blocks `failed` as well as `sent`.

## 3. Decision derivation

### F5. The pre-check void is a key-existence test. The rubric can pay a worse score more. A disagreement can never be decided. Blocker

**Evidence.** `enforce_decision` returns immediately when `new.outcome = 'void' and new.derived_from ? 'precheck_failed' and passes = 0`. The `?` operator is "key present", not "value is true". It ignores `unsure` and `fails`. The comment above the function says a failed pre-check voids, and anything else holds.

On PGlite, amount 500, normal rubric:

```
unsure-false=VOIDED
one-fail-false=VOIDED
unsure-true=VOIDED
no-judges-false=VOIDED
one-pass-with-key=blocked
```

Zero judges, one `unsure`, or one `fail` all void when the key is present and the value is false. Two passes are not overridden by the key. The contract tests use `{precheck_failed: true}` with zero judges, and they check that the key does not override two passes. They do not insert the key with value false beside a fail or an unsure.

Rubric `[{min_score:0, pay_bps:10000},{min_score:90, pay_bps:0}]`. `validate_rubric` accepts it. The band query is `min_score <= score order by min_score desc limit 1`, so a score of 60 selects 10,000 bps and a score of 95 selects 0:

```
score-60 release-500; score-95 void-required
```

A worse score pays the whole job. A high score is forced to void.

Pass plus fail, decision `hold`, then two more passes (`xai`, `google`):

```
passes=3 release=blocked void=blocked
```

The only legal outcome left is another `hold`. The reserve was not returned in this case. A buyer `return` of that reserve was not asserted.

**Fix.** Treat `precheck_failed` as boolean true, and require zero verdict rows. Any other mix with `passes < 2` or any `fail` or `unsure` can only `hold`. Require the rubric's `pay_bps` to be non-increasing as `min_score` rises, and reject duplicate `min_score` values. After a `hold`, a later pair of passes from providers that have not failed must be allowed to release the derived amount. Do not leave three passes stuck.

## 4. Timestamps the caller writes

### F6. `honor_until` of 400 days commits. A child dated in the future satisfies the 3-day gap at wall-clock zero. Blocker

**Evidence.** Root inserted with `created_at = now() - 10 days`, `honor_until` and `expires_at` at `now() + 400 days`, amount equal to the cap. Authorize, activate, commit 1,000:

```
backdated=true long_honor=true commit=ok
auth=e9ee53d3-c8ca-47a5-8b1f-7479b027bea2
```

`honor_until` is frozen after insert. The lie is the insert. I18 then trusts that column against `now()`, so the 400-day window is live.

Child with `created_at = parent.created_at + 3 days` (that instant is still in the future) and `honor_until` 400 days out, then a grandchild the same way:

```
child_future=true claimed_gap_s=259200 wall_clock_gap_s=0 grandchild_future=true
```

I8 compares the child's `created_at` to `parent.created_at + 3 days` and `parent.expires_at`. It does not compare either timestamp to `now()`. A check of the form `honor_until <= created_at + 3 days` is not enough while `created_at` can sit in the future.

The day-0 child that uses `now()`, and a voided authorization put back to `created`, are blocked:

```
HOLDS  V02 M2 day-0 child using now() and voided auth resurrected
  Authorization status voided to created is not allowed
```

PayPal's measured text, already in `AGENTS.md`, says reauthorization is only allowed once from day 4 to day 29. The schema hard-codes 3 days and allows a chain (`one_child_per_parent`, no depth limit). `openapi.yaml` `reauthorizeLease` says "Allowed from day 4" and drops "once". `guaranteed_now` is described as "True only while the live authorization is inside its 3-day honor period," while the column that feeds it can be inserted 400 days out.

**Fix.** Set `created_at` from `clock_timestamp()` inside the insert trigger, or reject `created_at > now()`. Reject `honor_until > created_at + interval '3 days'` and `expires_at > created_at + interval '29 days'`. Compare `now()` to the parent's `created_at` before accepting a child. Allow one child per root, not one child per node, until a logged day-4 reauthorize says a second one works. Quote "only allowed once" next to that constraint. Do not treat the 3-day number as a measured PayPal success.

### F7. An authorize posting of 1 cent, then `state = active`, poisons the lease. Major

**Evidence.** I16's equality "authorize posting must equal cap" runs only when the lease is `active` or `closed`. The activation update does not re-run it.

```
state=active later_commit=blocked:I16 violated: authorize posting 1 must equal cap 1000 on a live lease
BUYER_COMMITMENT=1 HOLD_AVAILABLE=1
```

This is not a cap bypass. Every later money write fails closed. The v0.2 version of this left a 1,000-cent capture row beside a 1-cent authorize. That capture insert is now blocked. The stuck active lease remains.

**Fix.** Run the same equality inside the lease-state trigger on the transition to `active`.

## 5. `lock_lease` under mixed isolation and under the owner

The shipped function is `UPDATE leases SET state = state`. With that function, on Postgres 15.19, the v0.2 races and the new ones hold:

```
RACE  V02 read-committed intent 600+600
  a:commit || b:23505 duplicate key value violates unique constraint "one_money_call_in_flight"
  captures=1 sum=600 counted=600 committed=1000
RACE  V02 repeatable-read intent 600+600
  a:commit || b:40001 could not serialize access due to concurrent update
  captures=1 sum=600
RACE  mixed RC then RR intent 600+600
  a:commit || b:40001 could not serialize access due to concurrent update
  captures=1 sum=600
RACE  V02 repeatable-read completed 600+600
  a:commit || b:40001 ...
  captures=1 sum=600 counted=600 committed=400
RACE  V02 read-committed ledger 800+800
  b:commit || a:23514 I18 violated: committed unsettled 1600 exceeds the exposure limit 1000
  committed=800
RACE  V02 repeatable-read ledger 800+800
  b:commit || a:40001 ...
  committed=800
RACE  exposure 400+400 on limit 500
  a:commit || b:23514 I18 violated: committed unsettled 800 exceeds the exposure limit 500
  committed=400
RACE  repeatable-read exposure 400+400 on limit 500
  a:commit || b:40001 ...
  committed=400
RACE  accrual 200+200 on net 200
  a:commit || b:23514 I13 violated: seller accrual 400 exceeds net captured 200
RACE  payout 200+200 on accrual 200
  a:commit || b:23514 I13 violated: payouts 200 + 200 exceed seller accrual 200
  payouts=1/200
```

No `40P01` in this run. The v0.2 read-committed ledger deadlock did not reproduce once `lock_lease` updates the row before the foreign-key key-share.

### F8. A `lock_lease` that only reads lets repeatable read commit past the cap and drive `COMMITTED_UNSETTLED` negative. Major

**Evidence.** `CREATE OR REPLACE FUNCTION lock_lease` as `SELECT state FROM leases`. Grants stay. Triggers stay enabled. Intent races still stop, because each intent capture leaves a `paypal_calls` row in `intent` and `one_money_call_in_flight` is one such row per lease:

```
RACE  NOOP lock repeatable-read intent 600+600
  b:commit || a:23505 duplicate key value violates unique constraint "one_money_call_in_flight"
  captures=1 sum=600
RACE  NOOP lock read-committed intent 600+600
  b:commit || a:23505 ... one_money_call_in_flight
  captures=1 sum=600
```

The completed race updates each call to `succeeded` before commit, so the partial index no longer covers it. I1 runs only on capture insert. Under repeatable read each deferred I17 and I4 sees its own snapshot:

```
RACE  NOOP lock repeatable-read completed 600+600
  b:commit || a:commit
  captures=2 sum=1200 counted=1200 committed=-200
```

`COMMITTED_UNSETTLED` started at 1,000. Each transaction credited 600 and saw a non-negative balance. Both committed. The account is -200. I4 did not fire. The real function was restored after this case (`CREATE OR REPLACE` with the `UPDATE`). Mixed isolation was not repeated with the no-op function.

This is the table owner, the same class as F10. `INVARIANTS.md` already says an owner can bypass every trigger. It does not say that a function which still runs, and merely fails to update the row, is enough to commit 1,200 and a negative balance. The eight race checks call the shipped function only.

The application-role attempt to shadow `lock_lease` with `pg_temp.lock_lease` died on F1 (`42501`) before the shadow could matter.

**Fix.** Keep the real `UPDATE` in `lock_lease`, and add a deferred check that re-sums counted captures against `cap_minor` at commit under a lock that conflicts across isolation levels. The unique in-flight index is what saved the intent race. It does not cover a call that has already moved to `succeeded`. Pin `search_path` so the owner-level function replace is the remaining bypass, and keep the kernel off the owner role. Add the no-op-function race next to the eight existing races so a future edit that turns the update into a select fails CI.

## 6. Capture and call linkage

### F9. Two completed captures share one call that is still `intent`. The app can rewrite a succeeded response. Major

**Evidence.** One `paypal_calls` row left in `intent`. Two captures, 200 and 100, completed and posted against that `call_id`. `captures.call_id` is not unique. I17 compares capture rows to capture postings and does not read `paypal_calls.state`:

```
call_state_after_two_completions=intent captures_on_that_call=2
counted=300 rows=2
```

As `pashadhara_app`, after a real settle, `UPDATE paypal_calls SET response = ..., http_status = 500` on a `succeeded` row. `response` is in the column grant and is not in `forbid_column_change` (that guard freezes `lease_id`, `op`, `request_id`, `amount_minor`, `created_at`):

```
state=succeeded http=500 response={"id": "EVIL", "status": "REFUNDED"}
```

**Fix.** `UNIQUE (call_id)` on `captures`. Completing a capture requires its call in `succeeded`, and that transition freezes `response` and `http_status`. Drop `response` from the application `UPDATE` grant. A correction is a new `paypal_calls` row with `op = 'get'`.

## 7. Close, return, and writeoff

### F10. The lease can close while the authorization is still `created`. A served tool call can be returned. A writeoff needs no declined capture. Major

**Evidence.** Void posting of the whole hold, no void `paypal_calls` row, then close. I14 checks hold, committed, unresolved calls, and in-flight captures. It does not read `authorizations`:

```
lease=closed auth=created void_calls=0
BUYER_COMMITMENT=1000 HOLD_AVAILABLE=0 RELEASED=1000
```

Tool price 25, commit and a `served` tool call, then a `return` of the 25. The return is not tied to `tool_calls`:

```
tool_call=served
HOLD_AVAILABLE=1000 COMMITTED_UNSETTLED=0
```

Commit 300, writeoff 300 with `captures = 0`, void the remaining 700, close:

```
captures=0 lease=closed
RELEASED=700 WRITTEN_OFF=300
```

`INVARIANTS.md` already says the database cannot tell a served usage from an unserved one, and that writeoff is for a declined or denied capture. These three sequences show the book will still accept the wrong one.

**Fix.** Close fails while a live authorization is `created` or `partially_captured` unless a void `paypal_calls` row for it is `succeeded`. A `return` fails when a `served` tool call's commit group is the one being reversed, unless the tool call is marked returned in the same transaction. A `writeoff` requires a `declined` or `denied` capture of the same amount that has not already been written off.

## 8. Column grants that are wider than the state machine

### F11. The app can set `tools.price_minor` to 999,999 and `webhook_events.deliveries` to 1,000,000. Major for the price, minor for the counter

**Evidence.** As `pashadhara_app`:

```
price_update=ok price_now=999999
job_state=ok now=settled
delete=permission denied for table ledger_entries
cap=permission denied for table leases
deliveries=ok now=1000000
disable=must be owner of table captures
```

`jobs.state` is the appeal bypass in F4. `DELETE`, `TRUNCATE`, and `DISABLE TRIGGER` stay denied. No row-level security was created. This run did not `SELECT` another seller's email as the app. `GRANT SELECT ON ALL TABLES` is what makes that read possible. It was not executed here.

The v0.2 updates that rewrote `payouts.seller_id`, `webhook_events.resource`, `authorizations.honor_until`, `captures.fee_minor` after it was set, and a completed capture back to `declined`, all hold. See the blocked list below.

**Fix.** Remove `price_minor` from the application grant. A price change is a new `tools` row. Allow `deliveries` to increase by 1 only. Freeze `processed_at` once set.

## 9. What v0.2 attacks do now

Blocked on PGlite, each with the error from this run:

| v0.2 attack | Result |
| --- | --- |
| Capture 1,001 on a cap of 1,000 | I1, captures 0 + 1001 exceed cap 1000 |
| `reversed` then `declined`, then a second full capture | terminal status |
| Three in-flight captures | `one_money_call_in_flight` |
| Void the books, then complete the capture and close | I17, in-flight 1000 exceeds committed 0 |
| Capture posting with no capture row | I17, posting has no completed capture |
| Served tool call with no ledger group | served call needs a commit of exactly its price |
| Metered payout of 100,000,000 with no accrual | I13, payouts exceed accrual 0 |
| Rewrite payout amount, seller, and state | immutable `payouts.seller_id` |
| Rewrite webhook resource and signature | immutable `webhook_events.resource` |
| Release 500 when the rubric pays 0 | I10, outcome must be void |
| Delete a fail verdict | I3, verdicts is append-only |
| Move `honor_until` | immutable column |
| Commit through exposure limit 0 | I18 |
| Day-0 child using `now()`, and voided auth back to `created` | status `voided` to `created` is not allowed |
| `sent` call to `failed` with a null response | I7 |
| Post fee 0 against a capture fee of 59 | I17, fees 59 differ from postings 0 |
| Replace payout email, shorten the hold, rewrite fee after it is set | identity immutable, hold can only increase, `fee_minor` frozen once set |
| App regresses a completed capture to `declined` | terminal status |

Blocked on Postgres 15 with the shipped `lock_lease`: repeatable-read captures of 600 + 600 (sum stays 600, second session `40001`), mixed read-committed then repeatable-read (same), both ledger races of 800 + 800 (committed stays 800, no deadlock), exposure 400 + 400 on a limit of 500, accrual 200 + 200, payout 200 + 200.

Still work:

- F2 and F8. The cap falls to a temp table, and to a `lock_lease` that only reads, under repeatable read, for captures that complete inside the race transaction.
- F3 and F4. The payout row can no longer be rewritten to another seller or another amount. It can be failed with no PayPal call and replaced by a metered payout. The seller who is paid need not have a job.
- F5. The amount is derived. The early return and the rubric order are not.
- F6. `honor_until` can no longer be moved. It can be inserted 400 days out, and a child can claim a 3-day gap with `created_at` in the future.
- F7. The 1-cent authorize no longer sits beside a 1,000-cent capture. It sits under an active lease that rejects every later write.
- F9 and F10. I17 matches amounts when both sides are written. It does not require the call to have succeeded, a reversal to equal the capture, or the authorization to be voided before close.
- F11 and the owner path in F12. Column grants and trigger disable.

### F12. The owner can still disable the cap trigger and truncate. Minor, already documented

**Evidence.** `DISABLE TRIGGER captures_insert` and `captures_commit_checks`, insert an intent capture of 100,000 on a cap of 100, `DISABLE TRIGGER USER` on `ledger_entries`, truncate:

```
over_cap_capture=100000 truncate_left=0
```

Same result on Postgres 15: `RACE owner disables cap trigger` reported `captures=1 sum=100000 counted=100000`. `INVARIANTS.md` already says a table owner bypasses every trigger. The application role was refused `DISABLE TRIGGER` (`must be owner of table captures`). This is not a new hole. It is still true, and the kernel must not connect as that owner.

## 10. PayPal claims that still sit ahead of the log

`AGENTS.md` already moved the honor-period guarantee, the payout `SUCCESS` timing, the 100% reading of `MAX_CAPTURE_AMOUNT_EXCEEDED`, and "expires after 29 days" to the right evidence class. Those four sentences are not re-filed.

What the contract still says beyond the log:

- `openapi.yaml` reauthorize summary: "Allowed from day 4." The spike body says "only allowed once from Day 4 to Day 29." F6 inserted a child and a grandchild at wall-clock gap 0 by writing `created_at`.
- `guaranteed_now`: "inside its 3-day honor period." F6 committed against `honor_until` 400 days ahead. The column is frozen afterwards, so the window is whatever the insert wrote.
- `createSeller` has `payout_hold_seconds` minimum 0. The sellers check constraint rejects below 30. A client that follows the OpenAPI will be rejected by the database. The other direction, a hold of 30 seconds, is what this run used. The spike never showed a dispute arriving inside or after that window.
- Appeal "Blocks the payout" has no effect on `payouts`, measured in F4.

No new PayPal call was made in this session. The fee of 59 cents on 300 cents is the existing measured point, used only as the comparison for the fee-0 book.

## Top five

1. **F1 and F2, blocker.** `pashadhara_app` cannot commit a capture or a balanced ledger row (`permission denied for function check_lease_consistency`, `captures_left=0`). After the missing `EXECUTE` grant, a temp `leases` and an empty temp `captures` let that role insert an intent capture of 5,000 on a public cap of 1,000. The owner can do the shadow today. The 152 checks never commit money as this role and never set `search_path`.
2. **F3 and F4, blocker.** A seller with no job and no tool call is accrued 300 and queued a payout (`receiver=stranger@x.com`). Fee 0 pays the gross against a measured fee of 59. A reversed capture of 300 stays payable, and a 1-cent reversal is enough (`CHARGEBACK_LOSS=1`). A job payout with `paypal_batch_id=BATCH-REAL` is marked `failed` while `jobs.state=held`, and the same accrual is queued again as metered.
3. **F6, blocker.** A root with `honor_until` 400 days out accepts a commit of the whole cap. A child and a grandchild with `created_at` set to the parent's `created_at` plus 3 days succeed at wall-clock gap 0 (`claimed_gap_s=259200`). PayPal's logged sentence says once, from day 4 to day 29.
4. **F5, blocker.** `derived_from` containing `precheck_failed: false` voids one unsure, one fail, or zero judges. A rubric that pays 10,000 bps from score 0 and 0 bps from score 90 releases 500 for a score of 60 and forces a void at 95. Three passes after a disagreement can neither release nor void.
5. **F8, major.** With the shipped `lock_lease`, every ported race holds, including mixed isolation, and the old ledger deadlock did not recur. Replacing the function body with a `SELECT` lets two repeatable-read completed captures of 600 both commit: `sum=1200`, `committed=-200`. Intent races still stop on `one_money_call_in_flight`.

The run that would have made this sharper: sleep 31 seconds and move the failed-then-reissued payout to `sent` and `success` with a null batch id, and repeat the completed 600 + 600 race as `pashadhara_app` after the `EXECUTE` grant with `pg_temp.lock_lease` first on the path.
