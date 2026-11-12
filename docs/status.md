# Status (2026-11-12 IST)

- Local web only, not deployed: `/` is now the V3 landing (oxblood night, thurible, "Held, not watched") and `/demo` has Budget, Try a call, Settle and Connect. The old spending check moved to `/check`. Production is unchanged.
- The recorded escrow run measured one USD 3.00 capture and one USD 2.41 payout. An independent PayPal GET verified the payout batch and item as SUCCESS. [Sandbox run](runs/replacement-sandbox-run.md)
- The API claims each due payout under the lease lock. Operator recovery can reconcile a known batch. A send that loses the batch ID requires operator reconciliation.
- Judge reservations come from durable delivery rows. `AI_ENABLED=false` disables judge and tool provider calls. The public showcase uses database-backed call limits and runs the kernel price check without posting a charge.
- The no-login showcase and Proof views are deployed. The database-backed rotation and metered settlement changes described in [Showcase setup](showcase.md) require an owner deploy. A verified hosted webhook row remains unconfirmed.
