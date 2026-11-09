# Rails sandbox handoff | 2026-11-09 IST

## Result

- Measured PayPal sandbox AUTHORIZE order `72X253515Y225773S` was created for USD 20.00. Computed kernel lease `4881758d-998d-41b2-acab-f58efa8f9559` is pending approval. [Approve in sandbox](https://www.sandbox.paypal.com/checkoutnow?token=72X253515Y225773S)
- Measured last order status was `PAYER_ACTION_REQUIRED` after nine 15-second GETs. The runner paused at 11 recorded dispatches, including OAuth, to reserve 14 calls. A fresh read-only check matched the ten durable order calls by ID, request ID, HTTP result, order ID, status and terms. The evidence scan found zero configured protected values. [Allowlisted PayPal JSONL](../evidence/live-20261109.jsonl)
- Owner approved the narrow kernel session-pooler compatibility fix, seeding sandbox SELLER_A and the USD 1.00 `text_stats` tool, and running escrow before void on the same hold. Role identity is checked on every checkout. The runner uses a USD 5.00 unsettled exposure limit so metering can refuse while escrow funds remain.

## Checks

- Computed API suite 55 passed, including the one-wire HTTP 421 regression outside the restricted shell. PayPal adapter suite 5 passed, judge suite 13 passed, and frozen schema suite 248 passed. API and Kernel typechecks passed.
- Fresh adversarial passes reproduced hidden HTTP 421 retries, unlogged malformed bodies, pooler URL overrides, capture proof missing invoice and final-capture checks, an unaudited MCP refusal, weak Anthropic output constraints, and a payout read that could leave the original intent sent after a failure. The runner now uses one-shot HTTPS, rejects invalid evidence and URL overrides, compares capture invoices and final-capture flags, checks durable MCP refusal, requests structured judge output, and marks unverified payout outcomes unknown. Payout waits at least 30 seconds before its first GET.
- Kernel database suites and contract race could not run because isolated PostgreSQL ports 15433 and 15435 refused connections even outside the shell restriction. OpenAPI lint could not fetch the Redocly CLI through the shell network. No new source failure was established by these attempts.

## Resume and limits

After the buyer confirms approval, use the same order. From the workspace root run `node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/sandbox-runner.ts --check-approved`. The runner checks the pending order log against the kernel, counts previous dispatches, and requires a fresh approved GET. Gate commands are `continue approval`, `continue first-capture`, `continue metering`, `continue escrow`, and `continue payout`. Run checks and an independent review at each gate. The capture audit script can independently compare measured capture reads against the journal.

A late resume uses one OAuth request and one approval GET, leaving exactly 12 dispatches for the happy path. The multi-capture proof reuses the first capture GET and obtains fresh reads for the second capture and authorization. A payout that stays pending or an extra OAuth exchange can prevent completion within the cap. The first process logged fetch dispatches before the HTTP 421 defect was found. Its exact wire count cannot be independently reconstructed from JSONL.

Authorization, the USD 1.00 capture, live multi-capture reconciliation, metered MCP refusal, both real judges, payout and void did not run. No contract deviations, sentinel use, deployment or Git activity.
