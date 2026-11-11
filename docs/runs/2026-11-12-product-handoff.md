# Product handoff, 12 November 2026

Goal: make the sandbox pilot financially exact, legible across live, fixture and simulation states, and practical for an operator integrating an MCP agent.

Decisions: the lease record is the authority for balances; the showcase returns one repeatable-read snapshot. A fallback without a traceable raw run is a fixture. PayPal capture is separate from a committed tool call. Public previews do not lock the lease. Reads do not dispatch payouts; an admin-only POST queues recovery.

Done locally: homepage and lease state handling, expired and unreachable fallbacks, escrow rule and evidence labels, developer quickstart, mobile layout, API authorization, public refusal handling, contract v0.5.2, regression tests. Existing uncommitted work was preserved. No commit, push or deploy was made.

Evidence: `evidence/ui-20261112/` has final browser screenshots and a sanitized read-only sandbox balance. `apps/web/scripts/check-states.mjs` tests four states at 1365, 390 and 360 pixels, private balance after capture, and a live-to-closed-to-fixture transition. API suite: 72 pass, 1 skipped because loopback TCP is blocked in the normal shell. The built API smoke test, web build, existing browser flow check, proof replay and proof manifest check passed.

Remaining: the served API contract is v0.5.0, while this checkout is v0.5.2. The local web build is on port 3123; port 3122 still serves the earlier app and proxies the deployed API. Hosted settlement, close and several other contract operations return 503. Public preview now has a per-instance bound but no distributed rate limit. The observed served 3-cent call has no established origin. No new paid sandbox call, PayPal capture, payout or real-money operation was made during this work.

Next action: review the diff and evidence, then deploy the new web and API together only when authorized. After deployment, read `/api/openapi.json` and verify v0.5.2, exercise the read-only states, and run an explicitly authorized sandbox money-path test with raw PayPal responses.
