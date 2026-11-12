# MCP interoperability, 12 November 2026

All results are local fixtures, not PayPal responses. Server: the real kernel and gateway source, a fresh throwaway Postgres 15 database on localhost:15433, a synthetic 8-cent authorization and an active 2-cent `text_stats` tool, started by `apps/api/scripts/mcp-fixture-server.mts` with a random bearer token written to a private file. No PayPal calls, no hosted database, no paid provider. The token is not recorded anywhere in the repo.

## Before (what a stock client had to send)

The key had to be `<UUID>:<SHA-256 of tool name, NUL, text>`. A stock model cannot compute SHA-256, so an outside agent could not use the live server naturally. An earlier experiment that accepted no key at all was withdrawn after review found a lost response plus retry could charge twice. Earlier client runs (SDK, Inspector, Claude Code 2.1.322) used that withdrawn path and are not evidence for the current source.

## After (final source)

A client sends `text` and a bare UUID as `idempotency_key`. The server appends the digest. The kernel meter refuses, under the lease lock and before any admission or posting, a UUID already bound to a different tool or text.

| Client | What it did | Result |
|---|---|---|
| Official TypeScript SDK (`scripts/mcp-sdk-check.mts`) | listed tools, `check_budget`, paid call with bare UUID, same UUID and text again, same UUID with other text, call with no key | listed `text_stats` (price 2, not read-only) and `check_budget` (read-only); preflight said affordable, remaining 8; paid call charged 2, remaining 6; retry replayed, charged 0; other text refused `idempotency_conflict` with a message; no key refused with the instruction to send a random UUID |
| MCP Inspector CLI (latest at test time) | `tools/list`, paid call with a bare UUID, same call again | schemas, annotations and price shown; charged 2; retry `replayed: true`, charged 0 |
| Claude Code 2.1.322, `claude-haiku-5-5`, plain task "count words in two strings", no mention of keys | called `text_stats` twice | both served at 2 cents. The model made up two fresh UUIDs unaided. Reported cost USD 0.0047 |

Independent check (Postgres, not client output): after SDK 1 call, Inspector 1 call and Claude Code 2 calls the lease had 4 `tool_calls` rows, all served at 2, 4 distinct UUIDs, and 8 cents committed in the ledger (4 commit groups, one per call). The replays and refusals added no rows.

## Model behaviour worth knowing

- First Claude Code run, descriptions still carried a literal example UUID: the model copied the example and changed the last digits (`...9b01`, `...9b02`). It worked, but anchors models on one value, and a verbatim copy would have been refused as a conflict. The example was removed from the descriptions and error text (now a format hint and "never copy an example"); the second run used unrelated UUIDs. One sample each, not a rate.
- In both runs the model passed the client-prefixed name `mcp__fix__text_stats` as the `tool` argument of `check_budget` on its first try. The server refused it with the list of real names and the model retried correctly. The argument description now says to use the plain name. Not re-run after that wording change.
- In both runs the model contrasted the harness's own dollar budget with the lease balance and said which it trusted. Its prose was right about the lease, but that was a model choice; trust the receipts.
- Claude Code spend for the two runs: USD 0.0145 reported, under the USD 0.05 allowance.

## Limits

Not tested: a public deployed endpoint, a real lease, MCP Inspector UI, Claude Desktop, Cursor, VS Code, ChatGPT connectors, the 2026-07-28 MCP revision. The server is not an OAuth authorization server. Stock-client support beyond the three clients above is not claimed.
