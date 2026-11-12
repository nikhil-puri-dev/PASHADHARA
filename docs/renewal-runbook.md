# Keep the sandbox demo live through 15 Dec 2026

The public page reads the newest published sandbox lease on each request. A new order can be approved and activated before the current hold's 72-hour honor window ends, so there is no gap. This runbook creates no order by itself. The owner must approve each PayPal sandbox order in chat before `create`, then click its PayPal sandbox buyer approval link.

PayPal documents a 3-day honor period and a 29-day authorization period. Reauthorization starts a new honor period only after the old one ends. PayPal's [honor-period guide](https://developer.paypal.com/payment-methods/auth-honor/) describes multiple reauthorizations, while its [extension guide](https://developer.paypal.com/checkout/extend-authorization/) says to reauthorize each authorization only once. The frozen contract and kernel permit one child per root and no reauthorization before day 4. That cannot guarantee continuous coverage at the 72-hour boundary, so use overlapping fresh orders for the public demo. Reauthorization remains an operator recovery path after a missed renewal, subject to a PayPal GET first if an earlier attempt is unknown.

## Read-only check

```bash
bash apps/api/scripts/demo-alive.sh
curl --fail-with-body https://pashadhara.vercel.app/api/health/db
```

The first command exits 0 only if the published hold has more than 12 hours left. The second proves the API can read Postgres. Check that `/api/showcase` has a new `read_at`, `state` active or expiring, `remaining_calls` above zero, and `limit_reason: null`. A 200 from `/api/health` alone does not prove database access.

## Owner renewal steps

1. In chat, approve a **USD 7.77 PayPal sandbox order**. This is a hold, not a capture. Prepare an untracked env file outside the repo with `DATABASE_URL` for hosted `kernel_login`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `LEASE_TOKEN_SECRET`, `SELLER_A_EMAIL`, and `API_BASE_URL=https://pashadhara.vercel.app/api`. Never print the file or its values.
2. From the repo root, run `node --env-file=PATH --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/showcase-seed.mts create`. Save the printed lease ID privately. The seed requests `cap_minor=777` and `unsettled_limit_minor=777`.
3. Open the printed URL as the PayPal **sandbox buyer** and approve. Then run `node --env-file=PATH --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/scripts/showcase-seed.mts activate LEASE_ID`.
4. Run both read-only checks above. Verify the published lease ID, 777-cent cap and exposure limit, fresh `read_at`, and a new `honor_until` about 72 hours ahead. A 777-cent price preview should return 200 and 778 should return 402 `cap_reached` on an untouched hold. Those previews make no model or PayPal call.

The current hold's measured `honor_until` is **15 Nov 2026 14:03 IST**. To keep coverage with time for a failed approval, target these IST activation times, each 60 hours apart: **14 Nov 20:00; 17 Nov 08:00; 19 Nov 20:00; 22 Nov 08:00; 24 Nov 20:00; 27 Nov 08:00; 29 Nov 20:00; 2 Dec 08:00; 4 Dec 20:00; 7 Dec 08:00; 9 Dec 20:00; 12 Dec 08:00; 14 Dec 20:00**. Verify the actual new honor deadline every time. If approval is delayed, renew immediately while the prior hold still has at least 12 hours left. This schedule covers the full 15 Dec UTC judging day.

## Scheduled maintenance

`vercel.json` prepares two [Vercel Schedules path targets](https://vercel.com/docs/schedules/configuration) through the existing Services API rewrite, both every 15 minutes. `GET /api/health/db` is read-only. `POST /api/internal/settlement/sweep` can capture metered commitments and reconcile unknown capture or void calls. It must not run without explicit owner approval for those PayPal operations. Do not set `CRON_SECRET` until that approval is given. With the secret absent, the sweep returns 401. Once approved, set a random `CRON_SECRET` of at least 16 characters in Vercel Production, then **redeploy**: Vercel stores the secret with each deployment's schedules when that deployment becomes current, so editing the variable alone changes nothing. Inspect the schedule's first result and the journal. Keep `ADMIN_KEY` private for owner-only manual calls.

Checked on 12 Nov (docs, the published `vercel.json` schema, and tests): `schedules` entries with `path` and `requestMethod` GET or POST are valid and pass the published schema; 15 minutes is the shortest interval Hobby allows; Vercel sends `Authorization: Bearer <CRON_SECRET>` only when the secret was set at deploy time; schedules run on the production deployment only. Vercel Schedules is a public beta, and that path targets work behind a Services rewrite is documented only by inference, so the first deploy must be followed by a look at the project's Schedules page. If the deploy fails on `schedules`, delete that block from `vercel.json` and redeploy; nothing else depends on it. `apps/api/test/schedules.integration.mts` shows the sweep returns 401 with no secret, a short secret, or a wrong one, and `/api/health/db` returns only `status`, `database` and `read_at` (503 with no detail if Postgres is down).

Vercel [documents path targets and `CRON_SECRET`](https://vercel.com/docs/schedules/handle-runs). A successful schedule response proves invocation, but a capture is proved only by a matching PayPal GET and journal row. The sweep is idempotent under the lease lock. If a capture was sent but has no known provider ID, it polls the order and matching invoice; if no unique match exists, it leaves the call unknown. Do not resend a mutation to discover the outcome. If a void result was lost, use a fresh authorization GET before resolving. An unknown reauthorization has no safe automatic correlation and needs operator review. A payout with no batch ID also needs operator review.

## Webhook setup and proof

Production logs on 12 Nov show `PayPalError` during signature postback, but the provider status and registered ID were not logged by the deployed build. In the PayPal sandbox app dashboard, confirm the webhook URL is `https://pashadhara.vercel.app/api/webhooks/paypal` and copy **that registration's ID** into Vercel Production `PAYPAL_WEBHOOK_ID`. Redeploy after a correction. The new build logs a fixed reason and PayPal HTTP status without credentials. A missing ID or rejected verification returns retryable 503; a PayPal `FAILURE` verdict returns 400; a verified event is recorded and reconciled once. Check Vercel logs by `X-Request-Id` and `webhook_events` for `signature_verified=true` and non-null `processed_at`.

For a real end-to-end delivery, use a sandbox event from an owner-approved order, or resend an existing real sandbox event from PayPal's Webhook Events dashboard, then check PayPal's delivery status and the database marker. The [PayPal simulator](https://developer.paypal.com/api/rest/webhooks/simulator/) cannot be verified by this app's postback verification method, so it only proves network delivery, not a successful signature or reconciliation. Its special mock ID `WEBHOOK_ID` must not replace the registered ID.

## If the page shows ended or unavailable

`ended` means the old journal remains visible but spending is off. `remaining_calls=0` has a `limit_reason` of `per_ip`, `daily`, `lifetime`, or `ended`; `resets_at` is the next UTC midnight for the first two. A `lifetime` limit needs an owner budget decision and a redeploy. A database liveness failure requires checking Vercel API runtime logs and hosted Postgres before changing the hold. Do not silently show fixture numbers as a live balance.
