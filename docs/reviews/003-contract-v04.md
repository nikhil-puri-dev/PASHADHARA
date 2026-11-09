# 003. Contract v0.4

Blockers, all as `pashadhara_app`. A served tool call is free: a return against a different unpaid job undoes its commit, and the lease closes with the buyer fully released. A capture with no decision spends a released job, the seller cannot be accrued, and the lease still closes. A hold that I11 requires after the first judge unlocks a second round that voids two passes, and two connections can commit that release and the failing round together. A capture can be declined and the whole cap written off with the PayPal call still `intent` and an empty body, and the lease closes. One payout call whose amount is 1 cent, and one batch id, settle two payouts totaling 896.

The v0.3 blockers that this run replayed are blocked. The happy path still closes. A real disagreement can be released on a later round. `precheck_failed` must be JSON `true`. The cap, accrual, payout, and return races refuse the second session. The verdict race does not.

Single-connection attacks, the ported v0.3 cases, and the two-connection races ran on Postgres 15.19 in Docker (`postgres:15`, host port 15432, trust auth, container `pashadhara-adv-v04`). The role is `NOLOGIN`, so the session connected as the throwaway superuser, applied `schema.sql` and `roles.sql`, and ran every attack after `SET ROLE pashadhara_app` (`current_user=pashadhara_app`, `session_user=postgres`). Each race connection did the same `SET ROLE` (`race_user=pashadhara_app`). Containers whose names start with `supabase` were left running. The container was stopped after the runs.

Scripts: `adversarial/contract-v04.mjs`, `adversarial/contract-concurrency-v04.mjs`.

Decisive lines:

```
WORKS  A a different unpaid job returns the served tool's commit, then the lease closes
  tool=served decoy_jobs=1 captures=0 committed=0 lease=closed
  BUYER_COMMITMENT=1000 HOLD_AVAILABLE=0 RELEASED=1000

WORKS  B a capture with no decision spends a released job and accrual becomes impossible
  capture_decision=null lease=closed auth=captured
  accrue=blocked: accrual needs a paying decision for this seller, a completed capture
  CAPTURED_GROSS=448 PAYPAL_FEES=52 RELEASED=500

WORKS  G a hold after the first pass lets round 2 void both passes
  outcome=void r1:anthropic=pass,r1:openai=pass,r2:anthropic=fail,r2:openai=fail
  reserve_returned committed=0

WORKS  J a capture is declined and written off while its call is still intent, then the lease closes
  at_decline capture=declined call=intent no_body=true
  closed lease=closed auth=expired call=failed http=null no_body=true
  succeeded_calls=0 WRITTEN_OFF=1000

WORKS  F one payout call of 1 cent and one batch id settle two payouts
  rows=2 calls=1 batches=1 paid=896 call_amount=1 call_state=succeeded
  CAPTURED_GROSS=0 SELLER_PAYABLE=0

RACE  verdict release then round-2 fails, read committed and repeatable read
  a_insert=ok b_commit=ok a_commit=ok
  decision=release:500
  verdicts=1:anthropic=pass,1:openai=pass,2:anthropic=fail,2:openai=fail

RACE  verdict parallel release vs round-2 fails
  b:commit || a:commit
  decision=release:500
  same round-2 fails stored
```

## 1. Served usage returns through a different job

### F1. A return does not have to match the commit it reverses. Blocker

**Evidence.** I17 says a return references an unpaid job and that served usage never returns. `enforce_posting_shape` checks that the `ref_id` is a job on the lease, that the amount is at most the job amount, and that the job has no `release` or `partial` decision (`schema.sql` 771-776). It does not check that this job was the commit, or that a served tool call's commit is still intact. `COMMITTED_UNSETTLED` is one balance for the whole lease.

Cap 1,000. Serve a tool at 300. Insert a second job of 300 and do not reserve it. Post `return` of 300 against that second job. The tool row stays `served`, committed is 0, captures are 0. A succeeded void call, `authorizations.status = voided`, a void posting of the restored 1,000, and the lease closes:

```
tool=served decoy_jobs=1 captures=0 committed=0 lease=closed
BUYER_COMMITMENT=1000 HOLD_AVAILABLE=0 COMMITTED_UNSETTLED=0 RELEASED=1000
```

The same cancel fits in the group the tool call uses as proof it was paid. One transaction inserts the tool's commit pair and the other job's return pair under one `group_id`, then inserts the served tool call. Commit succeeds. The budget never leaves the hold:

```
tool=served committed=0
BUYER_COMMITMENT=1000 HOLD_AVAILABLE=1000 COMMITTED_UNSETTLED=0
```

Returning the tool call id itself is refused (`I17 violated: return must reference an unpaid job reserve`). The bypass is the other job.

**Fix.** Give each commit its own balance, keyed by `ref_id`. A return may only credit that job's remaining commit. A served tool call's commit cannot be reduced by any other row. Reject a group that contains both a commit and a return.

## 2. A capture does not have to name the usage it spends

### F2. A null `decision_id` spends a released job. The seller cannot be accrued. The lease can close. Blocker

**Evidence.** `enforce_capture_insert` checks the decision only when `decision_id` is not null (`schema.sql` 510-517). Accrual to a decision requires a completed capture on that decision (`schema.sql` 761). Close does not look at unpaid sellers (`schema.sql` 924-932).

Cap 1,000. Job 500, two passes at 95, decision `release` of 500, commit of 500. Capture 500 with `decision_id` null, fee 52, response matching. Accrual of 448 to the job's decision is refused. Set the authorization to `captured` (no PayPal call is required for that status; see F6). Void the remaining hold of 500. Close:

```
capture_decision=null
accrue=blocked: I17 violated: accrual needs a paying decision for this seller, a completed capture
lease=closed auth=captured
BUYER_COMMITMENT=1000 HOLD_AVAILABLE=0 COMMITTED_UNSETTLED=0
CAPTURED_GROSS=448 PAYPAL_FEES=52 RELEASED=500
```

There is no `SELLER_PAYABLE` row. The platform keeps the 448. The same net can be handed to a different seller. After the naked capture, serve that seller's tool at 448 and accrue 448 to the tool call id:

```
attacker_payable=448 attacker_is_job_seller=false
job_accrue=blocked
CAPTURED_GROSS=448 SELLER_PAYABLE=448
```

`seller_cost` is compared to the lease's net captured, not to the capture's decision. One batch capture, which is the point of the fee curve in `evidence/RESULTS.md`, can name only one decision. Every other winning seller on that lease has no accrual path.

A partial makes the same hole smaller and also bricks the honest path. Job 500, rubric bands 5,000 bps at 60 and 10,000 at 90, passes at 70 and 80, decision `partial` of 250. Return of the unpaid 250 is refused because a paying decision exists. Capture 250 against the decision (fee 52, accrue 198) and capture the other 250 with a null decision (fee 52):

```
return=blocked naked_second=true committed=0
CAPTURED_GROSS=396 PAYPAL_FEES=104 SELLER_COST=198 SELLER_PAYABLE=198
```

The buyer was charged 500. The seller received 198. The other net 198 sits in `CAPTURED_GROSS` with no decision. If that second capture is not posted, the honest remainder cannot move: return is refused, and close is refused with committed still 250 (`I14 violated: close with hold 500, committed 250`). A partial decision cannot be finished.

**Fix.** A capture must name the job decision or the served tool call it settles, and the sum for that ref cannot exceed it. Accrual must be bounded by the net of the captures that name that same ref. After a partial, the uncaptured part of that job's commit must be returnable. Close fails while a completed capture has no matching accrual, unless the lease has an explicit platform-remainder posting the kernel cannot use to skip a seller.

## 3. The latest round is not sticky, and a missing judge opens the next one

### F3. The hold I11 requires after one judge lets round 2 void two passes. Blocker

**Evidence.** `enforce_verdict_insert` allows round `max + 1` when the number of hold decisions is at least the current max round (`schema.sql` 607-610). It does not ask whether the current round is already two passes. `enforce_decision` reads only the latest round (`schema.sql` 625-630).

Job 500, full-pay rubric. Insert `openai / pass / 95` in round 1. Insert `hold`, which is the only legal outcome while the second judge is missing. Insert `anthropic / pass / 96` in round 1. Round 1 is now a unanimous pass. Round 2 is already open because `holds >= maxr` (1 >= 1). Insert `openai / fail / 10` and `anthropic / fail / 11` in round 2. Insert `void`. The reserve returns, because a void is not a paying decision:

```
outcome=void
r1:anthropic=pass,r1:openai=pass,r2:anthropic=fail,r2:openai=fail
reserve_returned committed=0
later_release=blocked: I11 violated: two failing providers can only void
```

The same two passes, with no hold row, release 500 (`G2`, decision `ae78fbe8-604c-4d94-9b3c-b88dd2122982`). Round 2 without a hold is refused (`Verdict round 2 refused: current round is 1, a new round needs a hold first (holds 0)`). A later round after a real disagreement still releases: pass plus fail, hold, then `xai` and `google` pass in round 2, decision `3b1e7428-5d67-4ae3-aa63-39794a643165`. The re-judge path works. The bug is that the hold taken while a judge was missing still counts after that judge passes.

The same hole survives two connections, and the release does not even have to lose. Verdict insert does not call `lock_lease`. `enforce_decision` runs on insert and is not a deferred check, so a commit does not read the verdicts again. Setup as the app: job 500 reserved, `openai` pass in round 1, a hold, then `anthropic` pass in round 1. Session A inserts `release` of 500 and does not commit. Session B inserts `openai` fail and `anthropic` fail in round 2 and commits. Session A then commits. Both commits succeed, at read committed and at repeatable read:

```
a_insert=ok b_commit=ok a_commit=ok
decision=release:500
verdicts=1:anthropic=pass,1:openai=pass,2:anthropic=fail,2:openai=fail
committed=500
```

An unordered race does the same. The fails finish first and commit, then the release commits (`b:commit || a:commit`), and the stored rows are still `release:500` plus those two round-2 fails. Once the fails are already visible before the insert, the release is refused (`I11 violated: two failing providers can only void`). The rule holds only for a decision that has not been inserted yet.

**Fix.** A new round is allowed only when the previous round's own decision was `hold` and that round itself could not release or void. Once a round has two passes and nothing else, refuse later verdicts. Do not count a hold that was inserted before that round was complete. Re-run `enforce_decision` at commit, and take the lease lock on verdict insert so a decision and a later round cannot commit together.

## 4. Decline and writeoff need no PayPal evidence

### F4. The whole cap is written off while the capture call is still `intent`, and the lease closes. Blocker

**Evidence.** `capture_status_guard` checks the stored response only when the new status is `completed` (`schema.sql` 376-387). `intent → declined` is on the allow-list with no read of `paypal_calls`. `intent → failed` is allowed when `sent_at` is null (`schema.sql` 355-356), so the body stays null. `created → expired` needs no call (`schema.sql` 333-336). Close does not read `WRITTEN_OFF`.

Cap 1,000, job reserved for 1,000. Insert the capture call as `intent` and the capture as `intent`, then set the capture to `declined` in that same transaction. At that moment the call is still `intent` and the response is null. Post writeoff of 1,000 against the capture. Set the call to `failed` with `http_status` null and `response` null. Set the authorization to `expired`. Close:

```
at_decline capture=declined call=intent no_body=true
closed lease=closed auth=expired call=failed http=null no_body=true capture=declined
succeeded_calls=0
BUYER_COMMITMENT=1000 HOLD_AVAILABLE=0 COMMITTED_UNSETTLED=0 WRITTEN_OFF=1000
```

I16 holds: commitment 1,000 = written off 1,000. PayPal was not asked. The buyer's budget is gone and the seller is not payable. The same status update accepts `expired`, `denied`, and `captured` with `paypal_calls = 0` on three fresh leases (`expired=expired/calls=0 denied=denied/calls=0 captured=captured/calls=0`). A child inserted the same day, after the parent was marked `expired`, is still refused by the clock (`I8 violated: reauthorization must fall after the 3-day honor period`). The child insert does not look for a succeeded reauthorize call. This run did not wait three days, so that half was not executed.

**Fix.** `declined` and `denied` require that capture's call in `failed` with a stored response, the same way `completed` requires `succeeded`. `expired`, `denied`, and `captured` on an authorization need a matching succeeded call or a stored PayPal status. A writeoff of the full capture amount is required in the same transaction as the decline, and it is the only writeoff for that capture. Do not treat a locally failed `intent` as a PayPal decline.

## 5. One payout call is not one payout

### F5. A 1 cent payout call and one batch id mark two payouts paid, 896 cents. Blocker

**Evidence.** `payouts.call_id` is not unique (`schema.sql` 216). `payout_state_guard` checks that the call's `op` is `payout`, that the lease matches, and, on `success`, that `batch_header.payout_batch_id` equals `paypal_batch_id` (`schema.sql` 430-460). It does not read an amount. Setting `call_id` while `state` stays `queued` returns before that check (`schema.sql` 424), and `call_id` then freezes.

Two released jobs of 500, fee 52, accrued 448 each. Two queued job payouts of 448. One payout call inserted with `amount_minor = 1`. After the 30 second hold: both rows take that `call_id`, both go `sent`, the call succeeds with `batch_header.payout_batch_id = BATCH-SHARED` and no amount, both go `success` with that batch id, both are posted:

```
rows=2 calls=1 batches=1 paid=896 call_amount=1 call_state=succeeded
BUYER_COMMITMENT=5000 CAPTURED_GROSS=0 PAYPAL_FEES=104 SELLER_COST=896 SELLER_PAYABLE=0
```

The books disbursed 896. The only PayPal payout call on the lease was for 1 cent.

**Fix.** `UNIQUE (call_id)` on `payouts`. The call's `amount_minor` and the amount in the stored response must equal the payout row. Success and the ledger posting are one transaction. Reject a second row that copies a batch id already stored.

## 6. Legitimate flows that cannot finish

These are not extra theft. Each one is a path the contract describes, and v0.4 leaves it with no next step. All of them ran as `pashadhara_app`.

### F6. A cancelled job payout cannot be replaced. An appealed payout cannot be sent. A call that fails first bricks the row. Major

**Evidence.** `one_payout_per_decision` indexes every non-null `decision_id`, including `failed` (`schema.sql` 222). The accrual sum ignores `failed` (`schema.sql` 679-680), so the money looks free, and the unique index still rejects the new row.

Cancel a queued job payout of 448 with no call. The second job payout hits `one_payout_per_decision`. A metered payout of that accrual is refused because the accrual's `ref_id` is a decision, not a tool call:

```
cancelled=failed
retry=blocked: duplicate key value violates unique constraint "one_payout_per_decision"
metered=blocked: I13 violated: metered payouts 0 + 448 exceed seller accrual 0
SELLER_PAYABLE=448
```

Attach an `intent` payout call, then set that call to `failed` with a null body (legal, it was never sent). The payout stays queued. `sent` is refused because the call is not `sent` or `succeeded`. `queued → failed` is refused because a call is attached. `call_id` cannot be cleared. A replacement is refused because the queued row still consumes the accrual:

```
call=failed no_body=true
sent=blocked: payout is sent only with its PayPal payout call
cancel=blocked: a payout with a PayPal call is not cancelled
detach=blocked: Column payouts.call_id is frozen once set
retry=blocked: job payouts 448 + 448 exceed seller accrual
```

Appeal is the same trap with a clock. After `delivered → judging → decided → held`, `held_at` is set and cannot be cleared. Moving the job back to `judging` then `decided` does not clear it. Return of the released job is refused. After `release_at` (`due=true`) the send is still refused:

```
held_at=true clear=blocked: Column payouts.held_at is frozen once set
job_back_to=decided return=blocked
E after the hold window: due=true held_at=true
sent=blocked: I13 violated: payout is held or its release time has not arrived
```

`openapi.yaml` `appealJob` says the database holds every unsent payout. It does not say the hold is permanent or that a failed payout cannot be sent again.

Appeal does not block the cancel. After the job is `held` (`held_at=true`), `queued → failed` with a null `call_id` succeeds. The replacement then hits the unique index, so the seller still cannot be paid:

```
cancel=ok row=failed held_at=true
retry=23505 duplicate key value violates unique constraint "one_payout_per_decision"
```

A payout that reaches PayPal and then fails is the same trap. After the 31 second hold the row goes `sent` with its own payout call, the call goes `failed` with a stored response (`body=true`), and the payout goes `failed`. The second job payout is refused. The accrual sum ignores `failed`, and the index does not:

```
sent=ok failed=ok row=failed call=failed body=true
retry=23505 duplicate key value violates unique constraint "one_payout_per_decision"
```

**Fix.** The unique index should cover payouts that are still in flight (`queued`, `sent`, `success`, `unknown`), not `failed`. `queued → failed` remains the cancel, and a later payout for that decision is a new row. A call that fails from `intent` must detach, or the payout must be allowed to `failed` and replaced. `held_at` clears when the job leaves `held`, or the appeal posts a compensating decision the seller can be paid from. Do not freeze `call_id` until the call is `sent`.

### F7. Expiring the lease, or reversing the capture, strands the seller. Major

**Evidence.** An `expired` or `failed` lease accepts `void`, `return`, `writeoff`, `payout`, and `reversal` only (`schema.sql` 730). It cannot become `active` again (`schema.sql` 911-914). There is no clawback shape. A payout insert still requires a `completed` capture (`schema.sql` 690-691).

Meter 300, capture 300 fee 52 (net 248), set the lease to `expired`, then accrue:

```
state=expired
accrue=blocked: Posting accrue refused while lease is expired
back=blocked: Lease state expired to active is not allowed
CAPTURED_GROSS=248 PAYPAL_FEES=52
```

No payable row. The 248 cannot be accrued later, and close is the only forward transition, which also refuses accrual.

The reversal case starts from a legal paid job: capture 500, fee 52, accrue 448. Same transaction: `completed → reversed` and a reversal posting of 500. A new payout is refused. A one-sided debit of `SELLER_PAYABLE` is refused. Balances:

```
new_payout=blocked: payout without a completed capture
clawback_leg=blocked: payout posting needs a successful payout
CAPTURED_GROSS=-52 PAYPAL_FEES=52 SELLER_COST=448 SELLER_PAYABLE=448 CHARGEBACK_LOSS=500
```

Cash is negative by the fee. The seller is still payable 448. Nothing in the posting table can reduce that payable except a successful payout, and the payout is now illegal. `INVARIANTS.md` says an operator resolves a reversal. No operator transition exists.

**Fix.** Accrue is legal on `expired` and `failed` when the capture already completed, and on `closed` until the seller is accrued or an explicit remainder is posted. Add a `clawback` shape that debits `SELLER_PAYABLE` up to the accrual of the reversed capture, in the same transaction as the reversal. Until that posting exists, do not leave `SELLER_PAYABLE` above the cash that can still be paid.

### F8. The application role cannot be the connection role. Major

**Evidence.** `roles.sql` line 8 creates `pashadhara_app` as `NOLOGIN`. A second connection to `postgres://pashadhara_app@127.0.0.1:15432/postgres` failed with `28000 role "pashadhara_app" is not permitted to log in`. `roles.sql` tells the kernel to use a pooled connection string for this role. That string cannot log in. On the session that applied the schema as `postgres` and then `SET ROLE pashadhara_app`:

```
login=28000 role "pashadhara_app" is not permitted to log in
after_reset=postgres session=postgres
```

`RESET ROLE` is not denied while `current_user` is `pashadhara_app`. On the session that applied the schema it returns to the owner:

```
BROKEN-CONTROL  app reset role  did not throw, current_user=postgres
```

`roles.sql` does not create a login member. This run created one on the throwaway cluster only: `kernel_login` `LOGIN NOSUPERUSER NOINHERIT`, `GRANT pashadhara_app TO kernel_login`. That role can connect. `SET ROLE pashadhara_app` then `RESET ROLE` returns to `kernel_login`, not to `postgres` (`after=kernel_login/kernel_login`). It has no `USAGE` on `public`. `ALTER TABLE public.captures DISABLE TRIGGER` and `CREATE OR REPLACE FUNCTION lock_lease` both return `42501 permission denied for schema public`. The unqualified name in the race script returned `42P01 relation "captures" does not exist`, which is the same missing privilege. The app itself cannot replace `lock_lease` (`42501 permission denied for schema public`, `current_user=pashadhara_app`).

**Fix.** Do not connect as the owner and then `SET ROLE`. Create `kernel_login` `NOINHERIT NOSUPERUSER LOGIN` in `roles.sql`, `GRANT pashadhara_app TO kernel_login`, and connect as `kernel_login`. The kernel runs `SET ROLE pashadhara_app`. `RESET ROLE` then returns to `kernel_login`, which cannot disable triggers or replace `lock_lease`. `ALTER ROLE pashadhara_app LOGIN` leaves the owner path in place if any pool still connects as the owner.

## 7. What v0.3 no longer breaks, and what the deferred checks do

Blocked as `pashadhara_app` in this run:

| v0.3 attack | Result |
| --- | --- |
| Capture 1,001 on a cap of 1,000 | I1, captures 0 + 1001 exceed cap 1000 |
| `reversed` then `declined` | terminal status |
| Second in-flight capture | `one_money_call_in_flight` |
| Accrue to a seller with no job and no tool call | I17, accrual needs a paying decision for this seller |
| Fee posted as 0 when the response says 0.59 | I17, response fee 59 |
| Two captures share one call | `captures_call_id_key` |
| Rewrite a succeeded response | `paypal_calls.response` is frozen once set |
| `honor_until` 400 days out, or `created_at` 10 days back | I8, created_at must be within 00:01:00 of the clock |
| `precheck_failed: false` voids one unsure | I11, must hold |
| `precheck_failed: "true"` (a string) voids with zero judges | I11, must hold |
| Rubric that pays a worse score more | rubric rejected |
| Rewrite payout amount | permission denied for table payouts |
| Create a temp table, update `kernel_settings`, disable the cap trigger | permission denied, or must be owner |
| Authorize 1 cent and set the lease active | I16, authorize posting 1 must equal cap 1000 |
| `sent` call to `failed` with a null response | I7 |
| `deliveries` set to 1,000,000 | deliveries can only increase by one |
| Update `tools.price_minor` | permission denied |
| Void posting with no void call | I17 |
| Close while the authorization is live | I14, live authorizations 1 |
| Day-0 child after a real reauthorize call | I8, 3-day honor period |
| Completed capture regressed to `declined` | terminal status |

`SET CONSTRAINTS ledger_commit_checks IMMEDIATE` rejects the first leg of a commit (`I2 violated: group ... unbalanced, debits 100 credits 0`). It fails closed. It does not bypass the check. A completed capture cannot commit in its own transaction without the posting (`I17 violated: completed captures (100 / fee 52) differ from capture postings (0 / fee 0)`). Completion and the posting have to be one transaction, after the HTTP call has returned. That order works: the control lease closed with net accrued 348 (`lease=closed`, `SELLER_PAYABLE=348`, `RELEASED=600`).

Boolean `precheck_failed: true` with zero verdicts still voids (decision `32e5f10b-de2f-4238-a9a0-6d2d4aecdca4`). That is the documented pre-check path.

### F9. A fee string of `0.001` is stored as fee 0, and the seller is accrued the gross. Minor

**Evidence.** `capture_status_guard` does `round(numeric * 100)`. The response fee `0.001` rounds to 0. `fee_minor = 0` matches. Accrual of the full 300 is accepted. `seller_cost` is compared to net captured, and the net is the gross when the fee rounded to 0:

```
stored_fee_text=0.001 fee_minor=0
CAPTURED_GROSS=300 SELLER_COST=300 SELLER_PAYABLE=300
```

PayPal's logged fees are two decimal places (`evidence/RESULTS.md`: 0.56, 0.59, 0.52). A value with a third decimal is not a measured PayPal fee. The hole is the rounding, and it moves less than one cent of a real fee into the seller's payable. It is the same function that correctly rejected a response of `0.59` paired with `fee_minor = 0`.

**Fix.** Require the fee and amount strings to match `^[0-9]+\.[0-9]{2}$`, and set `fee_minor` from that text with no `round` of a longer fraction. Reject a third decimal instead of booking it as 0.

## 8. Two connections

Every race connection was `pashadhara_app` (`race_user=pashadhara_app`, `session=postgres`). Each commit referenced its own job. Each completed capture carried a succeeded call whose stored amount and fee matched the row. Fee on those raced completions was `0.00`.

| Race | Result |
| --- | --- |
| Intent 600+600, read committed | One commits. The other hits `one_money_call_in_flight`. `counted=600` |
| Intent 600+600, repeatable read, and mixed | `40001 could not serialize access due to concurrent update`. `captures=1` |
| Completed 600+600, repeatable read | `40001`. One capture, `committed=400` |
| Ledger 800+800, read committed | I18, committed 1600 exceeds limit 1000. `committed` stays 800 |
| Ledger 800+800, repeatable read | `40001`. `committed=800` |
| Exposure 400+400 on limit 500, read committed | I18, 800 exceeds 500. `committed` stays 400 |
| Exposure 400+400, repeatable read | `40001`. `committed=400` |
| Accrual 200+200 on net captured 200, read committed | I13, seller accrual 400 exceeds net captured 200. `seller_cost` stays 200 |
| Accrual 200+200, repeatable read | `40001`. `seller_cost=200` |
| Metered payout 200+200, read committed | I13, metered payouts 200 + 200 exceed accrual 200. `payouts=1/200` |
| Metered payout 200+200, repeatable read | `40001`. `payouts=1/200` |
| Return 500+500 on one commit of 500, read committed | Second commit aborted. `committed` stays 0 |
| Return 500+500, repeatable read | `40001`. `committed=0` |
| Release versus round-2 fails | Both commit. See F3 |

### F10. A double return aborts, and the error says in-flight captures exceeded a negative balance. Minor

**Evidence.** One return of the single 500 commit lands. That is F1: the ref is a different unpaid job. The second session sees both returns at its commit and aborts. `check_lease_consistency` runs on the hold leg and compares in-flight captures to committed (`schema.sql` 837) before the committed leg can raise I4. Zero in-flight is greater than a committed balance of -500, so the message is I17:

```
b:commit || a:23514 I17 violated: in-flight captures 0 exceed committed usage -500
committed=0
```

The books do not go negative. The message hides the balance check.

**Fix.** Raise I4 as soon as `COMMITTED_UNSETTLED` would go below zero, and compare in-flight captures only after that. A failed double return should say the balance went below zero.

### Not an application attack

With `lock_lease` replaced by a `SELECT`, the owner repeated the repeatable-read ledger race. Both commits landed: `a:commit || b:commit`, `committed=1600` on a limit of 1000. The row update inside `lock_lease` is what turns that race into `40001` for the app. The app cannot replace the function (`42501 permission denied for schema public`).

The owner disabled `captures_insert` and `captures_commit_checks`. The app then inserted an intent capture of 100000 on a cap of 100 (`counted=100000`). The app cannot disable those triggers (section 7). These two results need the owner. They are not ranked.

## Top five

1. **F1, blocker.** A return against a different unpaid job undoes a served tool call. The tool stays `served`, captures stay 0, and the lease closes with `RELEASED=1000`. The same return can sit in the tool call's own commit group, so `COMMITTED_UNSETTLED` never moves (`HOLD_AVAILABLE=1000`). Two sessions cannot both return that one commit: the second aborts and `committed` stays 0 (F10).
2. **F4, blocker.** A capture is declined while its call is still `intent` with a null body. Writeoff of 1,000, a local `failed` with no response, `authorizations.status = expired` with no PayPal call, and the lease closes. `WRITTEN_OFF=1000`, `succeeded_calls=0`.
3. **F3, blocker.** I11's required hold after the first pass unlocks round 2. Sequentially, round 2 fails void the two passes and the reserve returns (`committed=0`). On two connections the release and the failing round both commit, at read committed and at repeatable read (`decision=release:500`, round 2 `openai=fail` and `anthropic=fail`, `committed=500`). Without the early hold, the same passes release.
4. **F2, blocker.** A capture with `decision_id` null spends a released job of 500. Accrual is refused, the lease closes, and `CAPTURED_GROSS=448` has no seller payable. A different seller's tool call of 448 takes that net (`attacker_payable=448`). A partial of 250 cannot return the other 250, and without a second naked capture the lease cannot close (`committed=250`).
5. **F5, blocker.** Two payouts of 448 share one payout call whose `amount_minor` is 1 and one batch id `BATCH-SHARED`. Both post. `paid=896`, `CAPTURED_GROSS=0`, `SELLER_PAYABLE=0`.

F6 and F7 are the flows v0.4 made impossible. A cancelled payout, an appealed payout, and a payout that reached `sent` and then failed all leave the decision occupied (`one_payout_per_decision`), so the seller cannot be paid again. Expiry or reversal strands the seller (`CAPTURED_GROSS=248` with no accrual, or `SELLER_PAYABLE=448` against `CAPTURED_GROSS=-52`).

Not tried: waiting three real days so the app can insert a child authorization after the honor period (a same-day child is still refused, and this run did not change `created_at_slack`), and a live sandbox PayPal HTTP call. Capture bodies in these scripts are fixture JSON with two-decimal amounts. PGlite was not used. Postgres 15.19 was the only server.
