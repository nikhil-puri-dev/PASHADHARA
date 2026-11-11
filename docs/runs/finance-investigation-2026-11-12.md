# Finance investigation run, 12 November 2026

The finance tool data are synthetic fixtures. The model calls were real. The recorded sandbox run used an actual buyer-approved six-cent PayPal sandbox authorization, then metered fixture evidence against the local kernel. It did not capture or pay out the authorization.

The model first requested a seven-cent bundle. The kernel refused it at the cap, with no journal posting. The model then selected three two-cent lookups. The model's final answer hit its output limit, so a separate recovery request reconstructs the available evidence from the trace; that request cannot buy tools. See the recovery output for the actual result and its limitations.

Evidence:
- `evidence/finance-paypal-sandbox-20261112.jsonl`: model decisions, refusal, receipt-bearing tool results, and truncated final turn.
- `evidence/finance-paypal-proof-20261112.json`: independently fetched PayPal authorization fields and the matching local journal snapshot. The PayPal response is allowlisted, not a full raw response.
- `evidence/finance-paypal-resume-20261112.jsonl`: separate reconstruction and review queue if recovery completed.
- `evidence/finance-fixture-20261112.jsonl`: an earlier real-model run with a synthetic authorization. It is not PayPal output.

To reproduce the model/gateway path without PayPal, use an isolated Postgres 15 instance on `127.0.0.1:15434`, initialize a **new** `live_finance_1112` database with `packages/contract/schema.sql` and `packages/contract/roles.sql`, and supply `ANTHROPIC_API_KEY`. This fixed database name is reserved for fixtures: never point it at a real or shared database. From `apps/api`, run `node --import tsx scripts/finance-fixture-run.ts`. Optionally set `FIXTURE_BUDGET_CENTS` to an integer from 1 through 100. The run creates fixture authorization records and incurs real model-provider charges. Model choices and refusals are nondeterministic.

The official MCP SDK client is tested, not every client or deployment. Model-provider costs are excluded from the comparison. Four fixture pairs are not a general performance evaluation. The sandbox authorization is a payment hold, not regulated escrow.


The recovery model mentioned PAY-A, PAY-B and PAY-C in its rationales but omitted them from the citation arrays. The original recovery trace is retained unchanged. `evidence/finance-paypal-derived-20261112.jsonl` adds only those explicitly mentioned, purchased IDs to their matching citations and reruns the stricter identifier check. It is a computed correction, not model output. This check cannot establish the truth of arbitrary prose. The corrected result matches the fixed-purchase baseline on this dataset; no economic advantage is established. Comparison budget was checked against the six-cent kernel authorization in the separate proof, rather than inferred from the harness environment variable.

## Update after the audit (12 November 2026, later)

What changed in code, all tested with a scripted model and the real kernel, MCP server and SDK client (no spend):
- The truncation had one root cause: the final answer was free text with a 4000 token cap, so a verbose answer was cut off. The agent now ends by calling a `submit_findings` tool with a strict schema (enum pairs and classes, short rationale), allows 8000 then 16000 output tokens per turn, discards a truncated turn without executing anything from it, and returns an invalid submission to the model as a tool error so it can fix citations itself. No reconstruction step remains. `finance-resume.ts` and `finance-derive.ts` are retired.
- Paid-result replay: a served result is stored in the same transaction as the charge (`apps/api/sql/tool_results.sql`, `resultStore` in `meter.ts`). Retrying with the same idempotency key returns the stored result with `receipt.replayed: true` and `charged_minor: 0`, calls no provider, and writes no new journal rows. A refused key stays refused. Without the table applied, the old behaviour (idempotency_conflict) remains.
- Judging recovery: a job that was delivered but never decided (the process died or judging threw) resumes when the seller resubmits the same text (`deliverJob`). Not covered: a job held after one provider failed (no round 2), a crash between decision and capture, and a lost PayPal capture or payout response before it is recorded. The deliverable text is still not stored, so recovery needs the seller to resend it.
- MCP: an unauthenticated `tools/call` now returns HTTP 401 with `WWW-Authenticate`. GET and DELETE on `/mcp` return 405 (the server is stateless).
- Evaluation: 12 pairs, withheld labels, four baselines, held-out split. See `finance-eval-2026-11-12.md`.

The 4-pair statements above describe the earlier recorded runs and still hold for them. The earlier PayPal-backed trace is NOT a run of the new agent. Until the new agent runs once against a sandbox authorization there is no uninterrupted real-model finance run on record, and the submission should say so. The old reproduction database name (`live_finance_1112`) is replaced by `FIXTURE_DATABASE` (default `live_finance_1113`). Create it with `bash apps/api/scripts/live-db.sh live_finance_1113`, which also applies the replay table. The bundle now costs 20 cents, so rebuild the database rather than reusing the old one.

Known remaining limits: the AI spend guard is in memory per process; the finance run's model cost is an estimate; one blind model labeler is not independent human labeling; the hosted deployment is the older build with no finance tools and no replay table.
