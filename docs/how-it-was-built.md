# How it was built

Nikhil Puri built PASHADHARA solo, directing several AI models in separate lanes that each owned one part of the repo.

| Lane | Owns |
|---|---|
| Contract | `packages/contract`: schema, invariants, OpenAPI. Other lanes filed requests instead of editing it. |
| Kernel | `packages/kernel`, `supabase/`: journal, state machines, judge envelope |
| Rails | `packages/paypal`, `apps/api`: PayPal adapter, webhooks, gateway |
| Experience | `apps/web`, `design/`: the cord design and the app |
| Adversary | `docs/reviews/`: a different model that attacked the contract and never edited source |

Habits that shaped the code:
- The adversary broke contract v0.2 and v0.3 before v0.5.1 was frozen. Every finding is a regression test (see `docs/reviews/` and `docs/contract-v0.5.1-acceptance.md`).
- No lane reviewed its own work. Reviews were by a fresh model or by screenshots and browser measurements.
- Each live PayPal run was capped in calls and spend, logged with raw responses, and checked against the kernel journal by an independent read (`docs/runs/`).
- Earlier design prototypes (v1 to v4) were dropped. `docs/reviews/design-audit-v4.md` audits prototype v4, which is no longer in this repo. The shipped design is `design/cord`.
