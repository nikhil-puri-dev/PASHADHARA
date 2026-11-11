# Submission checklist

- Review the working tree for secrets and account data. Commit and push the approved files.
- Run the showcase seed against the target sandbox database. Approve and activate the hold, then set `SHOWCASE_LEASE_ID` in the API deployment. [Showcase setup](showcase.md)
- Make the GitHub repository public and confirm GitHub detects MIT.
- After deployment, open the showcase in a clean browser. Confirm `GET /api/health` and `GET /api/showcase` return HTTP 200 and the latter reads the seeded lease from hosted Supabase. Run the agent and check the same tool-call row in `/proof` and Supabase. Use a sandbox action that sends a webhook and verify a matching `webhook_events` row with `signature_verified=true` and `processed_at` populated.
