# Showcase setup

The owner runs this against the target sandbox database. The seed creates one PayPal sandbox order and requires one buyer approval. Use a dedicated lease because its allowlisted journal, tool calls and captures are public.

1. Apply [showcase.sql](../apps/api/sql/showcase.sql) once as the database owner, after the contract schema and roles. Set the seed environment in a local, untracked file: `DATABASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `LEASE_TOKEN_SECRET`, `API_BASE_URL` and `SELLER_A_EMAIL`. The seed accepts the same kernel database role as the API. Use a sandbox seller and credentials.
2. From the repo root, run the create command. Open the printed PayPal sandbox URL as the sandbox buyer. Copy the lease ID. Keep the link and all credentials out of Git.
3. Run the activate command using that lease ID. It checks the order directly with PayPal even if the return URL is unreachable. Activation publishes the registered lease while its honor window is active. Computed seed settings are USD 7.77 for both the authorization cap and unsettled exposure. A request for 778 cents is refused before a provider call on an untouched hold.
4. Live runs require `ANTHROPIC_API_KEY`, `AI_SPEND_LIMIT_USD` and `AI_ENABLED=true`. Escrow additionally requires `OPENAI_API_KEY`. The API also needs `ADMIN_KEY`, the sandbox keys, `DATABASE_URL`, `API_BASE_URL` and `LEASE_TOKEN_SECRET`. Set `PAYPAL_WEBHOOK_ID` for signed webhook verification and `FAULTS_ENABLED=false` on the deployment. Lease selection does not use `SHOWCASE_LEASE_ID`.

```bash
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/showcase-seed.mts create
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/showcase-seed.mts activate LEASE_ID
```

## Keeping the live demo open during judging

A PayPal authorization has a documented 72-hour honor period. `GET /api/showcase` returns the newest published lease, its computed state (`active`, `expiring` inside 24 hours, or `ended`), the honor boundary, and the Postgres journal timestamp as `read_at`. An ended hold cannot spend. If a journal exists, the UI shows it as historical. Without a successful read, there are no balance figures.

Renew by running `create`, approving the printed sandbox URL, and running `activate LEASE_ID`. This creates a PayPal sandbox order, so get explicit owner approval in chat first. No environment or deployment change is needed. Refresh `/api/showcase` and confirm the new lease ID and state. Follow [the full renewal calendar](renewal-runbook.md) from 14 Nov through 14 Dec, checking `honor_until` after each activation. Earlier leases stay in Postgres. The global model allowance does not reset on rotation.

`vercel.json` prepares a 15-minute schedule for `/api/internal/settlement/sweep` and a read-only database liveness schedule. The sweep can send PayPal captures and must not be enabled until the owner explicitly approves those calls in chat. Once approved, set `CRON_SECRET` in Vercel Production and inspect the first result. For an owner-only manual smoke check from a shell with the admin key already exported:

```bash
curl --fail-with-body --request POST \
  --header "Authorization: Bearer $ADMIN_KEY" \
  https://pashadhara.vercel.app/api/internal/settlement/sweep
```

The sweep plans metered batches at a computed 80% of the unsettled limit, at a computed fee ratio of 10% or less, or within four hours of the honor boundary. It also polls unresolved capture and void calls. A successful scheduler HTTP response alone does not prove capture: inspect the result and the sandbox journal. A capture with no recoverable PayPal ID remains unknown. Inspect the signed webhook, PayPal order or merchant record before attempting any recovery. Lost reauthorization responses require operator review because the existing kernel cannot correlate an unknown replacement to the original intent.

For an owned lease, `POST /api/v1/leases/{leaseId}/settle` forces a metered batch. `POST /api/v1/leases/{leaseId}/close` settles eligible usage and voids the unused remainder once commitments are clear. Keep the lease token private; a successful void revokes it. Old public leases are retained and are not automatically voided when a new one is published.

The fixed Haiku prompt costs a computed 3 cents from the hold. The public daily limits are 24 successful runs globally and 2 per IP per UTC day. The lifetime limit is `floor(AI_SPEND_LIMIT_USD x 100 x 0.8)` served runs, counted in Postgres under the lease lock. At the file's estimate rates one run reserves at most 1,190 micro-USD (about 0.12 cent), so the lifetime cap alone bounds model spend near 10 percent of the limit; the per-process spend guard (80 percent of the limit) is only a backstop and is not reached first. A run that fails after the provider was called is not counted as served, so only that guard bounds it. The model's actual rate card remains unverified, so the owner must watch real provider usage. `remaining_calls=0` includes `limit_reason` and, for daily or per-IP limits, `resets_at`. The kernel writes commitment rows inside a lease-locked transaction before calling the provider; it commits only after a completed provider result. A failure rolls back the commitment, though the provider may still have processed the request. Each new authorization has a documented 72-hour honor period. Open `/proof` to inspect the available raw row fields. A price probe uses the kernel and makes no journal posting. It is limited to 20 requests per minute per IP within each API instance; a distributed edge or shared-store limit is still needed for stronger abuse resistance.
