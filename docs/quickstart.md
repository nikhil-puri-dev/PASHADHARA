# Developer quickstart

PASHADHARA currently runs as an operator-provisioned **PayPal sandbox pilot**. The hosted signup is an interactive simulation. No public account or production payment flow is offered. In this source build, the operator holds `ADMIN_KEY`; an agent receives only a lease-scoped token. Deploy and verify this build's API contract before sending the provisioning request to a hosted origin.

## 1. Provision and approve

An operator calls `POST $PASHADHARA_API/v1/leases` with `Authorization: Bearer <ADMIN_KEY>` after setting `PASHADHARA_API` to the verified sandbox deployment's API base. Use JSON such as:

```json
{"buyer_ref":"my-agent","cap_minor":2000,"unsettled_limit_minor":1000}
```

The response contains `lease_id`, `lease_token` and a PayPal sandbox `approve_url`. Treat both credentials as secrets. The buyer opens the approval URL. The signed return callback attempts authorization. If it cannot finish, call `POST /api/v1/leases/{leaseId}/authorize` with the lease token after approval. A redirect alone does not prove authorization.

For an existing lease, an operator who controls the signing secret can write a new scoped token to a new private file without printing it:

```powershell
# Set LEASE_TOKEN_SECRET in the operator's environment first, without displaying it.
pnpm --filter @pashadhara/api exec tsx scripts/mcp-issue-token.mts <lease-uuid> <private-new-file>
```

Restrict access to the destination directory before running this command. On Windows, set an appropriate directory ACL; Unix file mode alone does not enforce Windows ACLs. Deliver the token privately. The script does not create a lease, verify that it is active, or approve a PayPal hold.

## 2. Verify the boundary

Read `GET /api/v1/leases/{leaseId}` using the lease token. Continue only when `state` is `active` and `guaranteed_now` is `true`. `balances.hold_available` is uncommitted cents, `balances.committed_unsettled` is served usage awaiting capture, and `balances.total_captured` is gross PayPal captures recorded by the kernel. `GET /api/v1/leases/{leaseId}/journal` exposes the immutable posting sequence. A journal read is computed from the database, not a fresh PayPal GET.

## 3. Connect an MCP client

Configure Streamable HTTP with the deployment's `/api/mcp` URL and the header `Authorization: Bearer <lease_token>`. The operator gives you the token (section 1). The server is not an OAuth authorization server, so clients that only offer an OAuth flow cannot connect.

**What a client sends for a paid call.** Two arguments: `text` and `idempotency_key`. The key is a fresh random UUID, nothing else. The server binds it to the tool and the text itself, so no client has to compute a hash.

- New request: send a new UUID.
- Lost answer or timeout: resend the same UUID with the same text. If the first call was charged, the retry is free and returns the stored result (`receipt.replayed: true`, `charged_minor: 0`). A stored replay needs no provider.
- Same UUID with different text, or another tool: refused with `idempotency_conflict`, nothing charged. Send a new UUID.
- No key, or a key that is not a UUID: refused before anything is charged, with a message that says what to send.
- The older form `<UUID>:<SHA-256 hex of tool name, NUL byte, text>` still works and means the same request as the bare UUID. A legacy key must also start with a UUID.

A cap, exposure or window refusal includes the price, the remaining amount and the next action. A refused call stays refused on retry.

**Free affordability check.** The tool `check_budget` takes `{ "tool": "<tool name>" }` and returns the price, `affordable`, a `status` and `remaining_minor` for the lease in the bearer token. It posts nothing, calls no provider and cannot read another lease. It allows 20 calls per lease per minute per server instance, then returns `rate_limited`. It is advice: the kernel decides again at the paid call.

**What was tested** (local fixture server on throwaway Postgres, synthetic authorization, no PayPal, no hosted database; token not recorded). The official TypeScript SDK, MCP Inspector CLI and Claude Code 2.1.322 with `claude-haiku-5-5` each listed the tools and made a paid call with a bare UUID. The SDK and Inspector also retried the same UUID for a free replay. Details and the model's mistakes are in the [interop record](runs/mcp-interop-2026-11-12.md). The server tests cover same-UUID conflict, parallel calls with one UUID charging once, lease isolation and replay with the provider unavailable.

**What was not tested:** a public deployed endpoint, a real PayPal lease, MCP Inspector UI, Claude Desktop, Cursor, VS Code, ChatGPT connectors, the 2026-07-28 MCP revision, and any OAuth flow. The rate limit is per server instance, not global.

Smoke script (discovery; setting the last two variables also makes a paid call that may charge the lease, with a fresh UUID each run, so do not use it to retry an uncertain call):

```powershell
$env:MCP_URL = 'https://your-verified-sandbox.example/api/mcp'
$env:LEASE_TOKEN = Get-Content -Raw -LiteralPath '<private-token-file>'
pnpm --filter @pashadhara/api exec tsx scripts/mcp-smoke.mts
$env:MCP_TOOL = 'summarise'
$env:MCP_TEXT = 'A short text to summarise.'
pnpm --filter @pashadhara/api exec tsx scripts/mcp-smoke.mts
```

Tool names and prices come from discovery and the deployment's active registry. Avoid logging the token or saving it in shared client configuration.

The kernel checks and reserves the price in a locked transaction before tool execution. Successful usage is committed to the journal only after the tool succeeds, before its result is served. PayPal capture is a later, separate settlement operation. A failed provider request rolls the journal commitment back, though the provider may have processed the request. The public showcase's `/api/showcase/try` is a non-posting preview for the showcase lease, not an integration endpoint for arbitrary leases. Several operations in the OpenAPI contract are reserved and return 503 in the hosted deployment. Due payout recovery is an operator-only POST, not an effect of a lease or job read.

The [API contract](../packages/contract/openapi.yaml) lists the read and administrative operations. The [invariants](../packages/contract/INVARIANTS.md) define the money rules and their limits.
