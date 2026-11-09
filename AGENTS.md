# PASHADHARA: rules for anyone changing this code

PASHADHARA gives an AI agent a spending budget backed by one PayPal authorization hold. A gateway meters paid tools against the hold, a deterministic kernel enforces every money rule, and two AI judges propose verdicts on escrowed jobs.

Read first: `packages/contract/INVARIANTS.md`, then `packages/contract/schema.sql`, then `packages/contract/openapi.yaml`.

## Truth rules
1. Sandbox only. Never use live PayPal credentials. Never commit a secret. `.env` stays local.
2. Nothing simulated is shown as PayPal output. Every number or event in UI or docs is labelled `measured`, `computed` or `fixture`.
3. Money is `bigint` minor units (USD cents). No floats. No model emits or chooses an amount. The kernel computes every amount.
4. AI proposes, kernel disposes. A model outputs a verdict from a fixed enum and a score. The kernel maps it to an amount using a rubric the buyer set before the job.
5. Unknown beats guess. If a PayPal call times out, the state is `unknown`. Read PayPal (GET) before any retry.
6. Webhooks are at least once and unordered. Verify the signature, dedupe by event id, and re-read PayPal state by API.
7. Report what you did not test. Do not claim done without a passing check.

## Stack
TypeScript strict, pnpm workspaces. Postgres on Supabase (money paths use a direct Postgres client). `apps/api`: Hono, Node runtime, MCP over Streamable HTTP. `apps/web`: Next.js. Tests: Vitest, fast-check, node:test, pglite and a throwaway Postgres 15.

## Layout
| Path | Notes |
|---|---|
| `packages/contract` | Frozen at v0.5.1. Change it only with a new version and new hashes in `docs/contract-v0.5.1.sha256`. |
| `packages/kernel`, `supabase/` | Journal, state machines, lock, judge envelope. |
| `packages/paypal`, `apps/api` | PayPal adapter, webhooks, reconcile, MCP gateway, paid tools. |
| `apps/web`, `design/cord` | UI. Change `design/cord/index.html` first, then re-port. |
| `evidence/`, `docs/reviews/` | Sandbox logs, spike scripts, attack scripts and review reports. |

## Definition of done
A test or run that fails without the change and passes with it. For money paths: a property or fault-injection test, plus one real sandbox run logged with raw responses.

## PayPal facts
Measured, computed and unverified facts are listed in `evidence/RESULTS.md` (a 2026-11-06 snapshot). Later runs are in `evidence/live-*.jsonl` and `docs/runs/`.
