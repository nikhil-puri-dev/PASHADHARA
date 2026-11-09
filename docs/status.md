# Status (2026-11-09)

Hackathon deadline: Fri 2026-11-13 01:30 IST.

## Works
- Contract v0.5.1 frozen: 248 schema checks and 15 race checks pass.
- Kernel: typed money functions, stateful model, fault and race tests, judge envelope, fee planner.
- Rails: the root Vercel Services config routes `/api/*` to Hono and the rest to Next.js. The local production API bundle includes the kernel and frozen OpenAPI YAML. The public spec is at `/api/openapi.json`.
- Rails fixtures exercise expiring lease and seller tokens, admin auth, order creation and signed callbacks. A signed webhook fixture verifies the original body, reads fixture PayPal state, and commits reconciliation and the event marker together in Postgres.
- Webhook and lease creation intake cap requests at 64 KiB. Missing signature headers produce no event row. Failed verification stores event metadata only.
- Signed callbacks redirect to the web root. Cancel leaves the pending lease to age out without a PayPal call. The API stops accepting approvals at the local lease deadline.
- API 55 of 55, PayPal 5 of 5, kernel 53 of 53, and all four contract hashes passed. Both service builds and the local production API smoke test passed.
- Web: the cord design served on real paths, `check:cord` 15 of 15.
- Live sandbox: a USD 20.00 lease run end to end, see [docs/runs/replacement-sandbox-run.md](runs/replacement-sandbox-run.md).

## Not done
- The Services deployment and hosted Supabase connection still need verification. Public PayPal Sandbox approval and webhook delivery have not been exercised.
- The API still needs paid MCP metering and the remaining money endpoints. Delayed approval recovery, webhook reversals, and out-of-band voids need frozen kernel or contract changes.
- The web app reads recorded and fixture data. Its typed client still needs to preserve the `/api` base path when the UI is wired to a live lease.
- Reauthorize on day 4, capture after day 3, webhook latency and order, the 115 percent overage boundary.
- The USD 0.25 payout fee has no journal posting and is not reconciled against PayPal's transaction report.
- No test with a person, no physical phone check, no dark theme.

## Next
1. Deploy the repo as one Vercel Services project. Set `API_BASE_URL` to the public origin plus `/api`, register `/api/webhooks/paypal` in the PayPal Sandbox app, and run an approval through the public callback.
2. Wire the web app to a live lease.
3. Record the 3 minute walkthrough from the connected run.
