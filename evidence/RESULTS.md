# PayPal sandbox spike results (2026-11-06, corrected after review 001)

Raw responses: `spike-log.jsonl` (spike 1), `spike2-log.jsonl` (spike 2). Sentinels: `sentinels.json`.
Three labels. **Measured** means a line in a log shows it. **Computed** means our arithmetic on measured values. **Unverified** means no log line shows it.

## Measured (a log line shows it)
- Authorize order, then 2 partial captures with final_capture=false on one authorization: both succeeded. Authorization status after each: PARTIALLY_CAPTURED. (spike-log.jsonl steps 4 to 7)
- 12 captures of $1.00 on one $20 authorization: all 12 returned COMPLETED. No capture-count limit appeared at 12. (spike2-log.jsonl)
- Fee per capture: $2.00 -> $0.56, $3.00 -> $0.59, $1.00 -> $0.52. Twelve $1 captures: $6.24 in fees, 52% of $12.
- Capture of $20 when $12 of a $20 authorization was already captured: 422 MAX_CAPTURE_AMOUNT_EXCEEDED. PayPal's body says: "The default overage limit is 115%, which allows the sum of all captures to be up to 115% of the order amount." That test asked for 160% of the order. A capture of remaining plus one cent, and one landing on 115%, were NOT run.
- Void after partial captures: 200, status VOIDED. Capture after void: 422 AUTHORIZATION_VOIDED.
- Reauthorize on day 0: 422 REAUTHORIZATION_TOO_SOON. PayPal's description: "A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization."
- `expiration_time` on a new authorization is 29 days after creation (a field value, not an observed expiry).
- Payout of $1.00: HTTP 201, batch_status PENDING. A GET about 5 seconds later (logged): still PENDING, item PENDING.
- `PayPal-Mock-Response` with {"mock_application_codes":"INSTRUMENT_DECLINED"} on capture: HTTP 403, empty body.

## Computed
- Fee model 0.49 + 3.49%, a three-point fit. One $12 capture would cost about $0.91 (not measured).

## Unverified (no log line)
- Payout reaching SUCCESS. One later GET printed SUCCESS in a command that was not logged. Treat it as unproven until re-measured with a logged GET.
- PayPal's guarantee of funds inside the 3-day honor period, and capture behavior after day 3. This is documentation, not a measurement.
- Whether reauthorization is repeatable. The error text says once. PayPal's docs describe repeated reauthorization.
- Webhook latency and ordering.
- Authorization actually entering EXPIRED at day 29.
- Why the mock-response header returned 403.

## Sentinels (real day-4 reauthorization test)
- A (untouched): authorization 8X4614360K939835H, created 2026-11-06T16:17:16Z
- B (partly captured $2): authorization 94D74698WW229864M, created 2026-11-06T16:17:18Z
- Honor period ends about 2026-11-09 16:17Z (21:47 IST). Day 4 starts about 2026-11-10 16:17Z (21:47 IST).
- On Nov 10 evening IST: GET both sentinels first and log them. Then try reauthorize on each, log raw responses. If refused, retry Nov 11 morning. After a success, try a second reauthorize on the new id.
- While day 4 is open, also run one capture of remaining plus one cent and one capture landing on 115% of the order, on a fresh authorization. These two turn the overage sentence from PayPal's text into a measurement.
