# Contract v0.5 summary

Status: all V05-BRIEF acceptance items green. Completed 2026-11-07 02:01 IST. Contract remains awaiting owner and reviewer check and freeze. STOP here; no Kernel work started.

No git commands, commits, pushes, deployments, application changes or PayPal HTTP calls. No .env values read or printed. Only throwaway `postgres:15` container `pashadhara-contract-v05`, bound to 127.0.0.1:15435, was used. It was stopped and auto-removed; exact-name docker ps check returned no rows. No supabase_ containers were touched.

## Result and acceptance evidence

Computed test results from synthetic database inputs, not measured PayPal output:

| Check | v0.4 baseline | New regressions on v0.4 | Final v0.5 |
| --- | --- | --- | --- |
| pnpm contract:schema | 194 pass, 0 fail | 194 pass, 25 fail | 244 pass, 0 fail |
| pnpm contract:race | 10 pass, 0 fail | 10 pass, 3 fail | 15 pass, 0 fail |
| pnpm contract:api | Not run before edits | Not applicable | Exit 0, valid, 15 warnings |

Raw logs: [baseline schema](v05-baseline-schema.log), [baseline race](v05-baseline-race.log), [new schema failures on v0.4](v05-red-schema.log), [new race failures on v0.4](v05-red-race.log), [final schema](v05-final-schema.log), [final race](v05-final-race.log), [final API](v05-final-api.log).

The final schema suite includes a seeded legitimate-flow walk (seed 503, 24 leases), raw ledger conservation assertions, and checks that closed leases have no unpaid completed allocations. Both READ COMMITTED and REPEATABLE READ verdict races now refuse the later verdict transaction. All race writers connect as kernel_login and SET ROLE pashadhara_app; RESET ROLE returns to kernel_login, which cannot disable triggers or replace lock_lease.

API warnings are six missing tag descriptions and nine missing 4xx response declarations on existing operations. No lint errors. The warned fields were not changed. No pre-edit lint run was recorded, so a baseline warning count is not claimed.

## Changes by finding

| Finding | Resolution and passing coverage |
| --- | --- |
| F1 | Immutable capture allocations and per-ref commit consumption. A decoy job cannot return served usage. Groups contain exactly one ref_type/ref_id; commit and return cannot share a group. |
| F2 | Capture allocations sum exactly to the capture amount at commit, reference same-lease paying jobs or served calls, and decision-tied captures name only their own job. Per-ref allocations plus returns/writeoff stay within the commit and paying decision. Accrual is tied to the allocated net. Partial decisions return their unpaid reserve. Close refuses unaccrued completed net. Multi-seller job/tool batches preserve and individually assign every net cent. |
| F3 | Verdict and decision inserts lock lease then job. Exactly two distinct providers complete a round. A partial round can hold but cannot advance. Completed unanimous passes or fails cannot be overridden by an early hold. Decisions record their database-derived round; a deferred final check forbids later verdict rounds. Both isolation levels pass on real Postgres 15.19. |
| F4 | Declined/denied requires its capture call failed with stored response, or succeeded with status DECLINED/DENIED. Full writeoff is mandatory in the same transaction. Expired authorization needs the real clock or matching stored GET EXPIRED; denied needs matching stored evidence. |
| F5 | Payout call_id unique, non-null batch id unique, exact call amount at sent and response amount at success. Success requires batch_status SUCCESS and atomic full posting. Shared-call, one-cent call, mismatched response amount, reused batch and missing posting tests pass. |
| F6 | Only non-failed payouts occupy a decision. Queued cancellation allows no call or an intent/failed call. Cancelled, held-cancelled and sent-then-failed rows can be replaced. Jobs trigger sets held_at on held and clears it only on direct held to decided; held to judging retains the hold. Direct held_at writes fail. Appeal then uphold then send passes. |
| F7 | Completed captures can accrue on expired/failed leases. Capture/seller clawback debits SELLER_PAYABLE and credits SELLER_COST, capped by attributable accrued allocations and balanced per seller. Payouts freeze until covered. Clawed-back queued jobs cannot consume metered earnings. A mixed job/metered reversal preserves the unaffected source and permits a funded payout. |
| F8 | roles.sql creates kernel_login LOGIN NOSUPERUSER NOINHERIT with membership in the non-owning app role. No password in source. Provision ALTER ROLE kernel_login PASSWORD using a securely bound env value during deployment. Real login/reset/privilege tests pass. |
| F9 | Exact two-decimal amount/fee strings; no rounding of a third decimal. Both amount and fee regressions pass. |
| F10 | COMMITTED_UNSETTLED below zero raises I4 before in-flight consistency. Owner-only diagnostic regression reproduces the old misleading I17 and now gets I4. |
| Additional authorization rules | Authorizations start created. Captured requires completed/reversed captures equal to its amount. A child requires a succeeded reauthorize call on its parent's lease. Local day-4 setup widens created_at_slack only as owner; clock and successful-child tests pass. |

No Grok finding was rejected. F10 was already a fail-closed behavior; its severity remains diagnostic, with the corrected error. All other findings were implemented.

## Conservative decisions

- Capture allocations are `(capture_id, lease_id, ref_id, amount_minor)`, where ref_id is a job id or served tool call id. Null decision supports a batch across jobs, tools and sellers. No platform-remainder escape is added.
- Net is divided in ref_id order by differences of cumulative integer floors. Earnings across captures and clawbacks back to sources use the same exact-cent method. Tables store bigint amounts; SQL numeric intermediates avoid overflow and never use floating point.
- Preserve one accrual per ref. Finish every allocated capture before posting one accrual for that ref's full known net. Partial accrual, unresolved/reversed allocated captures at accrual, and new allocations after accrual are refused. This is stricter than a mere upper bound and prevents an immutable partial accrual from stranding a seller or shifting recovery attribution.
- Two providers complete each round. Unanimous fails also cannot be superseded by an early hold, following the review's conservative rule that a completed round which can release or void does not reopen.
- Job/tool and decision/tool monetary ids cannot collide on the same lease. Checks run under the lease lock.
- Every state-changing kernel transaction must lock the lease first, including job/payout updates. Then take the job lock where needed. Commit validated payout/call sent states together before dispatching HTTP. Run READ COMMITTED and retry whole transactions on 40001.

## Recorded before output

The regression tests were written and executed before schema.sql or roles.sql fixes. The relevant v0.4 output is preserved here and in full raw logs:

```
FAIL (not blocked): V05 F1 decoy job cannot return served usage
FAIL (not blocked): V05 F1 commit and return cannot share a group
FAIL (not blocked): V05 F2 capture without allocations
FAIL (not blocked): V05 F2 another seller cannot accrue uncaptured usage
FAIL (should be allowed): V05 F2 partial capture and unpaid return finish
FAIL (not blocked): V05 F3 early hold cannot advance incomplete round
FAIL (not blocked): V05 F3 early hold cannot override unanimous passes
FAIL (not blocked): V05 F4 decline requires PayPal evidence
FAIL (not blocked): V05 F4 decline requires atomic full writeoff
FAIL (not blocked): V05 F4 authorization expired needs evidence
FAIL (not blocked): V05 F4 authorization denied needs evidence
FAIL (not blocked): V05 F4 authorization captured needs evidence
FAIL (not blocked): V05 child requires succeeded reauthorize
FAIL (not blocked): V05 F5 payout call cannot be shared
FAIL (should be allowed): V05 F6 cancelled payout can be replaced
FAIL (should be allowed): V05 F6 attached failed intent can be cancelled and replaced
FAIL (should be allowed): V05 F6 upheld appeal clears held_at
FAIL (should be allowed): V05 F7 expired then accrue
FAIL (should be allowed): V05 F7 failed then accrue
FAIL (should be allowed): V05 F7 reverse then clawback
FAIL (should be allowed): V05 F8 safe login role exists
FAIL (not blocked): V05 F9 amount third decimal rejected
FAIL (not blocked): V05 F9 fee third decimal rejected
FAIL (wrong error): V05 F10 negative committed reports I4 before in-flight
  I17 violated: in-flight captures 0 exceed committed usage -100
FAIL (should be allowed): V05 F6 appeal then uphold then send
194 checks passed, 25 failed

FAIL V05 F8 actual login works 28000 role kernel_login does not exist
FAIL V05 F3 [read committed] release cannot coexist with later verdicts
  b=committed a=committed
FAIL V05 F3 [repeatable read] release cannot coexist with later verdicts
  b=committed a=committed
10 checks passed, 3 failed
```

Grok before evidence: [single-session output](v05-before-grok.log), [race output](v05-before-grok-race.log). Decisive raw lines included:

```
WORKS A a different unpaid job returns the served tool's commit, then the lease closes
WORKS B a capture with no decision spends a released job and accrual becomes impossible
WORKS G a hold after the first pass lets round 2 void both passes
WORKS J a capture is declined and written off while its call is still intent, then the lease closes
WORKS F one payout call of 1 cent and one batch id settle two payouts
RACE verdict release then round-2 fails read committed a_insert=ok b_commit=ok a_commit=ok
RACE verdict release then round-2 fails repeatable read a_insert=ok b_commit=ok a_commit=ok
```

## Independent flaw review

A fresh-context read-only reviewer was instructed to find flaws, not approve. It found direct INSERT-success payouts, queued payout sending after clawback, close counting reversed accrual toward completed captures, and accrual while another allocation was open. Reproduced the payout issues first in [review red output](v05-review-red.log): 219 pass, 2 unblocked failures. Reproduced partial/open accrual and the independently found shared ref identity in [second review red output](v05-review-red-2.log): three unblocked failures, plus the then-unfixed cash/freeze error order. Fixed all of these and reran the complete schema suite. Targeted mixed-source recovery and individual cent assertions were added as requested by that review. No reviewer correctness finding remains open.

## Earlier tests and legitimate rule changes

The earlier schema checks remain, with these deliberate setup/assertion changes:

1. Valid capture helpers and race fixtures now include allocations. Race job fixtures have paying decisions. The targeted wrong-job allocation test uses an uncaptured decision so it reaches the allocation rule rather than the old decision cap.
2. Decline tests now store decline evidence and post full writeoff atomically. The terminal-decline test uses a DECLINED body rather than a COMPLETED body.
3. Reusing a now-succeeded capture call fails I6 before its unique index; the expected error was updated. Existing child/no-reauthorize and non-created-root tests now fail I8 before uniqueness checks.
4. The old third unsure judge after two passes is no longer legal. The disagreement test now uses one pass and one unsure; explicit unanimous-pass freeze tests cover the changed rule.
5. Successful close helpers accrue completed net first.
6. Hold setup goes through the job trigger, not direct held_at writes. Direct clear/move remains refused.
7. Successful payout helpers supply exact call amount and response amount and post payout success with its ledger entries atomically.
8. The reversed-lease payout fixture includes accrual attributable to that reversal, so it tests the new covered/uncovered rule.
9. INVARIANTS.md previously claimed owner TRUNCATE protection for decisions/verdicts although only ledger had that trigger. Documentation now accurately distinguishes app privileges from owner append-only guards. It also clarifies that a failed sent call needs a stored response.

Grok scripts were adapted only mechanically: port 15432 to authorized 15435. Both were run before and after. [After single-session output](v05-after-grok.log) exits 0, but its old capture helpers omit required allocations, so affected controls and downstream cases cannot be interpreted as valid v0.5 checks. [After concurrency output](v05-after-grok-race.log) exits 1 at its unallocated capture setup, before later races. Its unchanged login probe still intentionally connects as postgres, so RESET ROLE still returns postgres there; this is not the deployed login path. Do not treat failed legacy setup as proof a later assertion was exercised. Their scenarios were ported to the passing contract tests. No semantic changes to review scripts or files under reviews/ were made.

## Operational evidence and limits

- Measured existing spike payout GET, 2026-11-06T16:18:08.363Z, includes `batch_header.amount.value` of `1.00`, with batch_status PENDING. Used that real field. This does not prove payout SUCCESS. No receiver address or secrets were copied into this summary.
- Dependencies installed successfully after sandbox pnpm store registration initially returned EPERM. A later schema command hit the same EPERM after the package version bump; authorized rerun succeeded. Local TCP tests needed the authorized sandbox override. These were environment restrictions, not test failures.
- No live sandbox HTTP call, real day-4 reauthorize, measured successful payout, production migration, Supabase deployment/password/pool setup, Kernel implementation or Rails integration was tested. They are outside this task.
- Reversal fees and money already paid to a seller remain real platform loss. Clawback cannot make payable negative or invent replacement cash; payout funding checks refuse an unfunded send. Operator recovery is not implemented by this contract.
- Em dash scan of touched text sources passed. No .env values printed. No unresolved acceptance failure remains.

## Files and handoff

Updated schema.sql, roles.sql, schema.test.mjs, concurrency.test.mjs, INVARIANTS.md, openapi.yaml and contract package version. Added install-generated pnpm lockfile. Updated Kernel/Rails briefs with v0.5 rules and STATUS.md. Kept before/after logs alongside this summary. Only mechanical port edits in the two legacy adversarial scripts. No application source changed.

Next action: owner and reviewer inspect this summary and contract, freeze v0.5, then start Kernel in a separate session. This session stops here.

Next level up: verify the deployed kernel and PayPal reconciliation, needs the owner's post-freeze Kernel/Rails task and sandbox deployment access.

Better evidence would be a measured sandbox SUCCESS payout body and an independent PayPal GET reconciliation after Kernel integration.
