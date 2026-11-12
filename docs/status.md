# Status (2026-11-12 IST)

- Production (deployment 9f768e3) serves the sandbox demo at pashadhara.vercel.app. A published USD 10.00 sandbox hold is active until 15 Nov 2026 14:03 IST (measured by GET /api/showcase on 12 Nov); renewals are in [the runbook](renewal-runbook.md).
- Not deployed: a local API patch (webhook failures return 503 instead of 500, `/api/health/db`, `limit_reason` and `resets_at` on the showcase, a 777-cent seed, schedule config) and the local V3 web redesign. Tested on a throwaway database only.
- The recorded escrow run measured one USD 3.00 capture and one USD 2.41 payout. An independent PayPal GET verified the payout batch and item as SUCCESS. [Sandbox run](runs/replacement-sandbox-run.md)
- The API claims each due payout under the lease lock. Operator recovery can reconcile a known batch. A send that loses the batch ID requires operator reconciliation.
- Judge reservations come from durable delivery rows. `AI_ENABLED=false` disables judge and tool provider calls. The public showcase uses database-backed call limits and runs the kernel price check without posting a charge.
- The no-login showcase and Proof views are deployed. The database-backed rotation and metered settlement changes described in [Showcase setup](showcase.md) require an owner deploy. A verified hosted webhook row remains unconfirmed.
