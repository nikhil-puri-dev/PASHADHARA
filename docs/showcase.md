# Showcase setup

The owner runs this against the target sandbox database. The seed creates one PayPal sandbox order and requires one buyer approval. Use a dedicated lease because its allowlisted journal, tool calls and captures are public.

1. Set the seed environment in a local, untracked file. The required names are `DATABASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `LEASE_TOKEN_SECRET`, `API_BASE_URL` and `SELLER_A_EMAIL`. The seed accepts the same kernel database role as the API. Use a sandbox seller and credentials.
2. From the repo root, run the create command. Open the printed PayPal sandbox URL as the sandbox buyer. Copy the lease ID. Keep the link and all credentials out of Git.
3. Run the activate command using that lease ID. If the return URL is unreachable, activation still checks the order directly with PayPal. Computed seed settings are USD 10.00 for the authorization and USD 7.00 for unsettled exposure.
4. Set `SHOWCASE_LEASE_ID` to the activated lease in the API environment. Live runs require `ANTHROPIC_API_KEY`, `AI_SPEND_LIMIT_USD` and `AI_ENABLED=true`. Escrow additionally requires `OPENAI_API_KEY`. The API also needs `ADMIN_KEY`, the sandbox keys, `DATABASE_URL`, `API_BASE_URL` and `LEASE_TOKEN_SECRET`. Set `PAYPAL_WEBHOOK_ID` for signed webhook verification and `FAULTS_ENABLED=false` on the deployment.

```bash
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/showcase-seed.mts create
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/showcase-seed.mts activate LEASE_ID
```

## Keeping the live demo open during judging

A PayPal authorization is honored for a documented 72 hours. After that the gateway refuses paid calls on the lease by design, and the site falls back on its own: the lease page shows the journal marked ended, and the decision desk switches to a browser simulation that is labelled as one. Nothing breaks, but nothing live can be spent.

To bring the live demo back, repeat steps 2 to 4 with a fresh hold: run `create`, approve the order as the sandbox buyer, run `activate`, then set `SHOWCASE_LEASE_ID` to the new lease in the API environment and redeploy the same commit. No code changes. One approval covers three days, so five approvals (for example 30 Nov, 3, 6, 9 and 12 Dec) cover a 1 to 15 December judging window. Earlier leases stay in the database and their rows stay readable.

The fixed Haiku prompt costs a computed 3 cents from the hold. The public daily limits are computed 12 successful runs globally and 2 per IP per UTC day. The lifetime limit reserves a computed 5 cents of model budget per run against 80 percent of `AI_SPEND_LIMIT_USD`. The kernel writes commitment rows inside a lease-locked transaction before calling the provider; it commits that transaction only after a completed provider result. A failure rolls back the commitment, though the provider may still have processed the request. Each new authorization has a documented 72-hour honor period. Open `/proof` to inspect the available raw row fields. A price probe uses the kernel and makes no journal posting. It is limited to 20 requests per minute per IP within each API instance; a distributed edge or shared-store limit is still needed for stronger abuse resistance.
