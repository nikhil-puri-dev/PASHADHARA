# PASHADHARA

One PayPal authorization hold is an AI agent's spending budget. The buyer approves once. A gateway meters paid tools against that hold. Escrowed jobs are judged by two AI providers, and the database, not the model, computes the payout. Built for the PayPal AI Hackathon.

PayPal has no agent wallet. The honest guarantee is a 72 hour lease, then best effort. We say so in the product.

## What is real and what is not

Every number in the product and in these docs carries one label.

| Label | Meaning |
|---|---|
| measured | A PayPal sandbox response in `evidence/` shows it |
| computed | Our code derived it from measured data |
| fixture | Test data, never shown as PayPal output |

Measured in the PayPal sandbox: authorize then 12 partial captures on one authorization, per capture fees (about 0.49 + 3.49%), a void, a USD 2.41 payout reaching SUCCESS, and a full USD 20.00 lease closed with USD 11.00 released and zero unresolved intents ([run report](docs/runs/replacement-sandbox-run.md)).

Not proven: reauthorization on day 4, capture after day 3, webhook latency and order, the 115 percent overage boundary. The web app is still wired to recorded and fixture data, not a live deployment. Sandbox only, never live credentials.

Account and contact fields in `evidence/*.jsonl` are replaced with `[masked]`. Everything else is as PayPal returned it. `node evidence/mask-log.mjs <raw> <masked>` makes a masked copy.

## How it is built

```
apps/api          Hono API, MCP gateway, webhooks, reconcile
apps/web          Next.js app: the cord design (lease, escrow, settle, proof)
packages/contract SQL schema, invariants I1 to I18, OpenAPI 0.5.1 (frozen)
packages/kernel   Money journal, state machines, judge envelope, fee planner
packages/paypal   PayPal adapter
supabase          Migrations
design/cord       Source of truth for the web design
evidence          Sandbox logs (masked), spike scripts, motion measurements
docs              Reviews, run reports, build notes
```

Rules the code holds itself to are in [AGENTS.md](AGENTS.md). In short: money is `bigint` cents, no model ever chooses an amount, an unknown PayPal result is read back before any retry, and webhooks are verified, deduplicated and re-read.

## Run it

Needs Node 20 or newer and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm test
```

The kernel suites need a throwaway Postgres 15 with the schema loaded:

```bash
docker run -d --name pashadhara-test -p 127.0.0.1:15433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:15
# then apply supabase/migrations/0001_init.sql and packages/contract/roles.sql as postgres
```

Other checks:

```bash
pnpm contract:schema                       # 248 schema checks, about 35 seconds
pnpm contract:race                         # Docker Postgres race checks
pnpm --filter @pashadhara/web typecheck
pnpm --filter @pashadhara/web replay:proof # replays 12 logged captures and a void through the kernel
pnpm --filter @pashadhara/web build && pnpm --filter @pashadhara/web check:cord
```

Contract file hashes: `cd packages/contract && sha256sum -c ../../docs/contract-v0.5.1.sha256`.

To use real sandbox calls, copy `.env.example` to `.env` and add your own sandbox keys.

## License

MIT, see [LICENSE](LICENSE).
