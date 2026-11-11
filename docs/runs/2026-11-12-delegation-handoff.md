# Delegated authority handoff, 12 November 2026

Goal: reposition the flagship demo as a credible $5,000 business-agent delegation without misrepresenting PayPal evidence.

Decisions: `/delegation` is an interactive browser fixture. Fixed quotes and bigint cents drive cap, per-request and exposure checks before simulated execution. Accepted requests add paired fixture journal entries; refusals add only a decision-trail row. The existing $2 live sandbox lease and dated $20 PayPal proof remain separate and unchanged. A PayPal authorization does not directly pay arbitrary merchants.

Done: homepage points to the $5,000 fixture first; the smaller live lease is a separate section. The new workspace shows remaining authority, spend decisions, journal inspection, and reset with responsive layouts. Existing unrelated uncommitted work was preserved. No commit, push or deploy.

Evidence: `node --experimental-strip-types apps/web/scripts/check-delegation.mjs` passed cap, per-request, exposure and conservation checks. Production `next build` and `check:cord` passed. Existing Postgres showcase/MCP parity tests passed 5/5 against the throwaway database; API showcase snapshot tests passed 5/5. PayPal proof replay passed 26 groups, 12 captures and one void. Browser inspection confirmed refusal makes no posting, $420 admission updates the balance and paired journal, and 390 px layout has no horizontal overflow. Screenshots are in `evidence/ui-20261112/delegation-*-final.png`.

Limit: the $5,000 flow does not create a PayPal hold or run a provider. A separate kernel suite did not complete because its default Postgres port was unavailable; a retry against the gateway test database stalled and was stopped. No new PayPal sandbox money operation was run.

Next action: review the local result and deploy only on explicit instruction. The next product step would connect a priced business task to a real sandbox lease and capture its raw responses for proof.
