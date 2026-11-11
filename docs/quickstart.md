# Developer quickstart

PASHADHARA currently runs as an operator-provisioned **PayPal sandbox pilot**. The hosted signup is an interactive simulation. No public account or production payment flow is offered. In this source build, the operator holds `ADMIN_KEY`; an agent receives only a lease-scoped token. Deploy and verify this build's API contract before sending the provisioning request to a hosted origin.

## 1. Provision and approve

An operator calls `POST $PASHADHARA_API/v1/leases` with `Authorization: Bearer <ADMIN_KEY>` after setting `PASHADHARA_API` to the verified sandbox deployment's API base. Use JSON such as:

```json
{"buyer_ref":"my-agent","cap_minor":2000,"unsettled_limit_minor":1000}
```

The response contains `lease_id`, `lease_token` and a PayPal sandbox `approve_url`. Treat both credentials as secrets. The buyer opens the approval URL. The signed return callback attempts authorization. If it cannot finish, call `POST /api/v1/leases/{leaseId}/authorize` with the lease token after approval. A redirect alone does not prove authorization.

## 2. Verify the boundary

Read `GET /api/v1/leases/{leaseId}` using the lease token. Continue only when `state` is `active` and `guaranteed_now` is `true`. `balances.hold_available` is uncommitted cents, `balances.committed_unsettled` is served usage awaiting capture, and `balances.total_captured` is gross PayPal captures recorded by the kernel. `GET /api/v1/leases/{leaseId}/journal` exposes the immutable posting sequence. A journal read is computed from the database, not a fresh PayPal GET.

## 3. Connect an MCP client

Configure a Streamable HTTP MCP client for `https://pashadhara.vercel.app/api/mcp` with `Authorization: Bearer <lease_token>`. The hosted paid tool is `summarise` at a database-set 3 cents per call. It accepts `text` and `idempotency_key`. Form the key as `<new UUID>:<SHA-256 hex of UTF-8 tool name, NUL byte, UTF-8 text>`. Reuse that key only when retrying the exact same invocation. The MCP result contains a structured refusal when the cap, exposure limit or honor window blocks a call. Do not retry a timed-out paid call with a new key until you have checked the journal.

The kernel checks and reserves the price in a locked transaction before tool execution. Successful usage is committed to the journal only after the tool succeeds, before its result is served. PayPal capture is a later, separate settlement operation. A failed provider request rolls the journal commitment back, though the provider may have processed the request. The public showcase's `/api/showcase/try` is a non-posting preview for the showcase lease, not an integration endpoint for arbitrary leases. Several operations in the OpenAPI contract are reserved and return 503 in the hosted deployment. Due payout recovery is an operator-only POST, not an effect of a lease or job read.

The [API contract](../packages/contract/openapi.yaml) lists the read and administrative operations. The [invariants](../packages/contract/INVARIANTS.md) define the money rules and their limits.
