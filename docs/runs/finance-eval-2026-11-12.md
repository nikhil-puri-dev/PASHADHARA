# Finance evaluation design (12 November 2026)

What this measures: whether the agent, given invoice pairs and a limited evidence budget, buys evidence sensibly and reaches correct, properly cited calls, compared with plain deterministic programs on the same data, prices and budget.

Data: 12 synthetic pairs (`apps/api/src/finance-fixtures.ts`). A to D are the development set. E to L were written afterwards and are held out. They include re-keyed duplicates (F, H, K), a reversed payment (E), recurring invoices (G), look-alike suppliers that are different entities (I), a prompt-injection string in a supplier name (J), and a pending payment that leaves the case undecidable (L, the correct answer is abstain).

Labels: `apps/api/src/finance-labels.ts`, never imported by the agent, the tools or any prompt. The author wrote the labels first. A separate Haiku subagent then saw only the records and payment evidence, no labels, and labelled all 12. Agreement: 12 of 12 (measured, 2026-11-12). Limits: the labeler is a model, not a person, and the fixture evidence text states its conclusion plainly, so this checks consistency, not difficulty. These are synthetic cases, not customer data.

Baselines (computed by `baselines()` in `finance-evaluation.ts`, local computation). Correct out of 12 at each evidence budget in cents:

| Budget | exact_invoice | fuzzy_invoice | fixed_purchase_in_input_order | triage_then_buy |
|---:|---:|---:|---:|---:|
| 0 | 4 | 5 | 1 | 3 |
| 6 | 4 | 5 | 4 | 6 |
| 12 | 4 | 5 | 7 | 9 |
| 16 | 4 | 5 | 9 | 10 |
| 24 | 4 | 5 | 12 | 10 |

A lookup costs 2 cents and the all-pairs bundle 20 cents. The heuristic baselines never spend. An agent can beat triage_then_buy only by noticing unflagged duplicates (F, K) cheaply. A tie is a valid outcome and no savings claim is made from a tie.

Metrics in the `run_summary` event of `scripts/finance-agent.ts`: correct, true and false positives, missed duplicates, abstentions, unsupported citations (dev and held-out split), evidence cents from kernel receipts, model tokens, estimated model cost (Haiku 4.5 rates, because the Haiku 5.5 rate card is unverified) and wall-clock time.

Not done: a real-model run of this 12-pair set. No model or PayPal spend was authorized in this session. The recorded 4-pair evidence files are history from the earlier harness, which ended at max_tokens and needed reconstruction.
