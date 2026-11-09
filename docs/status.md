# Status (2026-11-09)

Hackathon deadline: Fri 2026-11-13 01:30 IST.

## Works
- Contract v0.5.1 frozen: 248 schema checks and 15 race checks pass.
- Kernel: typed money functions, stateful model, fault and race tests, judge envelope, fee planner.
- Rails: PayPal adapter and API handlers with fixtures. API tests 55 of 55.
- Web: the cord design served on real paths, `check:cord` 15 of 15.
- Live sandbox: a USD 20.00 lease run end to end, see [docs/runs/replacement-sandbox-run.md](runs/replacement-sandbox-run.md).

## Not done
- No deployed API or public URL. The approval callback and webhook delivery are untested live.
- The web app reads recorded and fixture data, not a live lease.
- Reauthorize on day 4, capture after day 3, webhook latency and order, the 115 percent overage boundary.
- The USD 0.25 payout fee has no journal posting and is not reconciled against PayPal's transaction report.
- No test with a person, no physical phone check, no dark theme.

## Next
1. Deploy the API (Vercel and Supabase), set the webhook, run an approval through the public callback.
2. Wire the web app to a live lease.
3. Record the 3 minute walkthrough from the connected run.
