// Retired 2026-11-12: reconstruction from a truncated trace is no longer part of the pipeline. finance-agent.ts ends in one validated submit_findings call
// (truncation is retried in place, invalid citations go back to the model). The earlier reconstruction evidence files are kept as history.
throw new Error('Retired. Run scripts/finance-fixture-run.ts or scripts/finance-agent.ts.');
