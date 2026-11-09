> Note: this audits prototype v4, which was superseded by `design/cord` and removed from this repo. Screenshots it cites are not included.

# Design audit, prototype v4

Verdict first: ship v4 as the build base. Do not record from it until flaws 1 to 4 below are fixed. The capture route is clean of lab chrome and overlays, but the 3-minute walk shows a budget that does not add up, a proof that cannot fail, and provenance labels too small to read on video.

Audited 2026-11-07 against `docs/design/prototype-v4/index.html#/capture/...` in Chromium (Playwright, `playwright-core` from the ANABIO folder, not the prototype's own `tools/`). Sizes 1440x900 and 390x844 (phone emulation, touch on), light and dark. 20 capture routes x 4 combinations = 80 full-page frames plus interaction frames, all in `reviews/v4-shots/`. I did not use `docs/design/prototype-v4/CHECK.md` as evidence. I re-ran `tools/validate.py` once because the task asked me to check fixtures against OpenAPI.

Method note: the v3 audit footer says 14 PASS, 52 FAIL, 9 N/A. Its own table has 13 PASS, 55 FAIL, 7 N/A. I use the table.

## Top 10 remaining flaws, ranked by score damage

### 1. The walk does not add up as one budget (Impact, Technical, Presentation)

Rule: R66 and R65 in spirit (a simulated result must not read as one continuous truth), plus goal 8.

Where: capture walk, lease then settle then Escrow then Payout. Frames `walk-03-lease.png`, `walk-07-receipt.png`, `walk-08-lease-after-settle.png`, `walk-09-jobs.png`, `walk-10-jobs-held.png`.

Evidence:
- The lease cap is $20.00 with $14.50 metered. The receipt then says "Total captured $14.50, Available $5.50".
- The next screen reserves $15.00 in escrow (and $12.00 on the held job). That cannot fit in the $5.50 left. The only disclosure is an 11px eyebrow, "JOB ESCROW / SEPARATE LEASE EXAMPLE". Fixture data confirms the jobs and payouts belong to another lease (`data.payouts.decided.lease_id` is `1d32fa99...`, the live lease is `cbbaf44b...`).
- After confirming settlement, "Back to lease snapshot" shows the unchanged lease: Committed $5.50, Captured $9.00 (`walk-08`). The receipt and the lease contradict each other.

Fix: one lease through the whole walk. Make the escrow job draw from the same $20.00 cap (for example cap $20.00, $9.00 captured, job escrow $5.50) so every figure on screen sums. Make the lease route read the settled state after the receipt (Committed $0.00, Captured $14.50), or remove the back link from the capture build.

### 2. The contract's differentiators have no screen (Innovation, Technical)

Rule: R49 (built for its user) and R45 (level 4 shows what the product does). Project rule: the difference is lifecycle depth, real day-4 reauthorize, database-enforced rules, at-least-once webhooks.

Where: whole prototype.

Evidence: across all 80 captured frames the live text never contains `reauthor`, `day 4`, `renew`, `duplicate`, `unknown` or `honor`. The word `webhook` appears twice, both in one sentence. `data.events` holds `webhook.received`, two `webhook.duplicate` and `webhook.polled` rows and they are never rendered. The v3 routes for lineage, sentinel, closed and renewed leases were deleted. Escrow has no screen of its own, only a line "Reserved in escrow $15.00" on the judged payout page. The first step of the story (buyer approves in PayPal) is reachable only from Lease options and is not on the demo path.

Fix: one frame per idea, not per fixture. A lease-lifecycle rail on the lease screen (approved, day 3 honor window, day 4 reauthorize, expiry) using real timestamps. A webhook strip on Proof showing three deliveries of one event id collapsing to one ledger row. An escrow row that shows reserved, released and returned.

### 3. Proof cannot fail, and the demo's diff breaks (Technical, Innovation)

Rule: R66, R15.

Where: `#/capture/proof`, `#/capture/proof/difference`. Frames `walk-12-proof-capture-record.png`, `walk-13-proof-diff.png`.

Evidence:
- The left column is a sample ledger built from the same recorded response, so "Fields match" is true by construction. The Proof lines match the raw log: I checked all 13 ids, amounts, fees and statuses against `evidence/spike2-log.jsonl` and they match, so the right column is honest. The left column proves nothing.
- "Show difference" is a UI subtraction of one cent (`amount - 1n` in `comparison()`), not a ledger that disagrees.
- Selecting record 2 (capture 8KK17784DB464635E) and pressing "Show difference" resets the picker to record 1 (authorization 3JR45593UX474005K, $19.99 versus $20.00). The record the narrator just chose disappears on camera.

Fix: until a connected run exists, build the left column by replaying the 13 logged events through the kernel's own posting functions (a different code path from the fixture) and diff by mutating one posting, not by arithmetic in the view. Keep the selected record in the route (`proof/difference/<index>`). Label the page "sample ledger" and keep it out of the word "reconcile" until it reads real PayPal.

### 4. Provenance labels are 9 to 10px and repeat on every tick (Presentation, Design)

Rule: R10 (chips on everything), R74 (the default is the loudest mark), and goal 8.

Where: every route. Selector `.source`.

Evidence: computed font size of `.source` is 10px at 1440 and 9px at 390. Text nodes under 11px: 110 at 1440, 154 at 390. Contrast is fine (minimum 5.05 light, 6.22 dark), size is not. The story chart carries 9 `fixture` tags (three y ticks, three x ticks, caption, unit, snapshot). The lease screen carries 14. A 1080p YouTube frame downscaled to a phone makes the one word that keeps us honest unreadable.

Fix: label once per figure group at 12px or larger, in the caption ("Lease activity, fixture"), and let tick labels inherit it. Keep per-number tags only where kinds mix (fee band, Proof columns). Keep the literal rule: no number loses its label.

### 5. Five status screens are one card, and half of every frame is empty (Design)

Rule: R69, R75, goal 7.

Where: `lease/pending`, `lease/loading`, `lease/error`, `payout/late`, `payout/failed`. Also `payout`, `proof`, `journal`, `jobs`, `approve`.

Evidence: all five use `.state-frame` with the same anatomy: glyph, eyebrow, 78px headline, one sentence, content, one button. They differ in wash and left rule only. The card sits at about 860x410 px in the top-left of a 1440x900 frame, leaving the right 30% and the bottom 55% blank (`lease-pending-1440-light.png`, `payout-late-1440-light.png`). At 1440x900, 12 of 18 routes end before 70% of the viewport height.

Fix: give each state its own object. Pending: the lease chart with the hold line dashed and no spend. Loading: the lease layout as skeleton at the real positions. Failed: the amount struck against the sandbox response status. Late: a timeline with the missed deadline marked. Put content on the left edge and the object on the right so the frame is composed.

### 6. Journal is a wall of identical rows after page 1 (Design, Technical)

Rule: R71, R22.

Where: `#/capture/journal`, `journal/2`, `journal/3`, `journal/4`.

Evidence: page 1 is four "Tool call" rows. Pages 2 to 4 hold eight near-identical "Accrue / Seller cost" rows at the same second (19:17:16 UTC, $0.90, $0.45, $1.80 repeated). The hold, the $9.00 capture and its fee sit on pages 4 to 6 (`journal-2` to `journal-6` text dump). "Every movement" is the heading, and the demo ends on this page showing four tool calls.

Fix: fold the eight accruals under the capture that caused them (one row: "Capture $9.00, fee $0.80, 8 seller accruals", expandable). Open on the hold, the capture and the fee, newest last. Add a running balance column, hard right.

### 7. The held verdict prints $0.00 and links to the wrong job (Impact, Technical)

Rule: R64 spirit, INVARIANTS I11 (disagreement holds, it does not void).

Where: `#/capture/jobs/held`. Frame `jobs-held-1440-light.png`.

Evidence: "Disagreement holds the payout." then "$0.00 fixture". Escrow of $12.00 is still reserved (I11), so $0.00 reads as void. The primary button "See agreement" goes to `jobs` (the $15.00 pass and pass job), not an agreement of this job. `derived_from.next_round: 2` exists in the fixture and is not shown.

Fix: replace the amount with "$12.00 held in escrow" and "Round 2 next". Replace "See agreement" with an action that matches the contract (re-judge, or buyer cancels the reserve).

### 8. Prototype vocabulary survives in the capture route (Presentation)

Rule: goal 2, R8.

Where: chrome is gone (no lab, no theme toggle, no footer, no fixed or sticky elements, none of `prototype`, `simulated`, `scenario` in 20 routes). Affordance labels remain.

Evidence (live text): "SEPARATE LEASE EXAMPLE" (jobs, jobs/held, payout), "View expiry example", "Review hold approval" (Lease options), "See late example" (payout), "Show matching example" and "Show difference" (proof), "Back to lease snapshot", "sample ledger" (proof).

Fix: in a capture build, rename to the action a buyer would take or drop the link. The story should be driven by the primary button only.

### 9. Chart legend and expired chart read wrong (Design)

Rule: R16, R24, R72.

Where: `lease`, `lease/expired`, story plate.

Evidence: captions match axes on all four chart routes (see goal 4), so the v3 flaw is fixed. The legend label is wrong: the hatch is cumulative metered usage and tops out at $14.50, while the balance beside it says "Committed $5.50". The visible hatch band above the solid is the unsettled $5.50, but nothing says so. On expired the axis is 0 to 696 h and all activity sits in the first 1.4% of the width, so the plot reads as one solid block (`lease-expired-1440-light.png`).

Fix: legend "Metered, cumulative" and label the band above the solid "Unsettled $5.50" directly on the plot. For the 29-day view, draw a rail with a zoomed inset of hours 0 to 10.

### 10. Landing stops at level 2 plus, and nav shows two active items (Design)

Rule: R41, R43, R54, R55, R34, goal 10.

Where: `#/capture/story`, header on every route.

Evidence: stacked hero, serif display plus sans UI, ruled ground, green threaded to chart and fee band, one reveal. No zoom, bento or operable element (R41). No logo row, badge, or social proof (R43, R54). CTA gap clears 2x, edges do not darken (R55). Nav: "Proof" is permanently green and bold, so on Lease two items look active (underlined Lease plus green Proof). Phone nav targets are 32x34 px.

Fix: make the chart the operable object: hover or drag a cursor on the plot to show the tool call at that moment (names exist in `data.events`). Add a heavy closing band. One nav state only (underline), and put Proof on the right as a separate link. Raise phone targets to 44px height.

## Goal check (the 10 v4 goals)

| # | Goal | Result | Evidence |
|---|---|---|---|
| 1 | Live text has lease, escrow, judged, payout, reconcile | PASS | `story-1440-light.png`, `story-390-light.png`. Flow strip: Hold, Lease, Escrow, Judged payout, Reconcile and proof. Strip bottom at y about 588 (1440) and about 600 (390), inside the fold. |
| 2 | No prototype chrome in capture | PARTIAL | Chrome PASS (no lab, toggle, footer, fixed elements). Vocabulary FAIL, flaw 8. |
| 3 | No overlay covers a money figure | PASS | Opened confirm, Lease options menu, reasoning, journal row, at both sizes. 0 overlaps, 0 `dialog`, 0 fixed or sticky. `lease-options-open-*.png`, `settle-typed-*.png`. |
| 4 | Chart captions match axes | PASS | Story and lease: "elapsed hours 0 to 10 h", ticks 0, 5, 10 h, y $0, $10, $20. Expired: "0 to 696 h", ticks 0, 348, 696. Legend meaning is flaw 9. |
| 5 | Pass and Fail differ by more than color | PASS | Check or cross glyph, the word, a red wash on the Fail panel, and a red rule under the decision (`jobs-held-1440-light.png`). |
| 6 | Expired, pending, failed, late distinct | PASS | Distinct headline, glyph, wash and rail (`lease-expired`, `lease-pending`, `lease-error`, `payout-late`, `payout-failed`). Expired is the only one with a chart. Shared template is flaw 5. |
| 7 | No shared layout template | FAIL | Five `.state-frame` screens, flaw 5. Story, lease, jobs, proof, journal do differ from each other. |
| 8 | Every number labeled on the line | PASS | My scan of 80 frames: 0 visible digit text outside `.amount`/`.datum`, 0 of those without a `.source`. Caveats: 9 to 10px (flaw 4). "$0.52 measured per capture" is true only for the 12 $1.00 captures. |
| 9 | No screen over 3 viewport heights at 390x844 | PASS | Tallest is story at 1,375 px (1.63x). Next is lease/settle at 1,233. No horizontal overflow on any of the 80 frames. |
| 10 | Landing reaches level 3 or 4 | FAIL | Flaw 10. |

## Rule table, v3 versus v4

CHECK column is what `CHECK.md` claims. A "disagree" in the last column means CHECK says PASS and I say FAIL. Shots are in `reviews/v4-shots/`.

| R | v3 | v4 | CHECK | Evidence |
|---|---|---|---|---|
| R1 | PASS | PASS | PASS | No emoji in any frame. Glyphs (check, cross, roman II) are type, not an icon set. |
| R2 | PASS | PASS | PASS | Paper, ink, green. Red and amber only on states. |
| R3 | FAIL | PASS | PASS | Fail score and wash are red, Pass is ink (`jobs-held-1440-light.png`). |
| R4 | FAIL | PASS | PASS | Lease is chart-led, Jobs is two panels, Proof is a table, Journal a timeline. |
| R5 | N/A | N/A | PASS | No sidebar. |
| R6 | FAIL | PASS | PASS | Brand and links start at x=160. |
| R7 | PASS | PASS | PASS | No avatars. |
| R8 | FAIL | PASS | PASS | No lab, toggle or footer in capture. Lab only at `#/lab`, no link to it. |
| R9 | PASS | PASS | PASS | One primary, one secondary, Lease options disclosure. |
| R10 | FAIL | FAIL | PASS | 14 `fixture` tags on lease, 9 on the story chart (`lease-1440-light.png`). Disagree. |
| R11 | FAIL | FAIL | FAIL | Approve is a full page with an in-flow confirm. Accepted trade, not fixed. |
| R12 | FAIL | PASS | PASS | Loading shows a skeleton and no figure (0 `.source`). |
| R13 | PASS | PASS | PASS | Chart plus 3 balances. |
| R14 | N/A | N/A | PASS | No pricing. |
| R15 | PASS | PASS | PASS | Picker and diff exist. Selection resets on diff (flaw 3). |
| R16 | FAIL | PASS | PASS | Cumulative steps, elapsed hours and USD. Legend wording is flaw 9. |
| R17 | PASS | PASS | PASS | Hero graphic is the lease trace. |
| R18 | FAIL | PASS | PASS | Story is 1,406 px (1.56 screens): hero, flow, chart, fee band, close. |
| R19 | FAIL | PASS | PASS | Journal tags and right-aligned amounts at both sizes (`journal-390-light.png`). |
| R20 | FAIL | PASS | PASS | Long seller is truncated with `title` (`payout-failed-1440-light.png`). |
| R21 | FAIL | N/A | PASS | No inactive rows rendered. |
| R22 | FAIL | PASS | PASS | Dated timeline with expandable postings. |
| R23 | FAIL | PASS | PASS | Fail red, late amber, failed red. Providers have no identity mark, minor. |
| R24 | FAIL | PASS | PASS | Active chart opens at activity scale. Expired is compressed (flaw 9). |
| R25 | FAIL | PASS | PASS | Lease options is a disclosure. Its contents are flaw 8. |
| R26 | FAIL | PASS | PASS | Primary first, confirm in flow. |
| R27 | FAIL | PASS | PASS | Flow strip is in the first fold at both sizes. |
| R28 | FAIL | PASS | PASS | Reasoning and journal rows expand. Copy record ID present; clipboard behavior not tested. |
| R29 | FAIL | FAIL | PASS | "Committed", "Ledger hold", "Unsettled at expiry", "Initial window" have no tooltip or definition. `title` only on truncated seller and journal ref. Disagree. |
| R30 | FAIL | PASS | PASS | Stacked hero. |
| R31 | PASS | PASS | PASS | No stock imagery. |
| R32 | PASS | PASS | PASS | Square corners throughout. |
| R33 | PASS | PASS | PASS | H1 100.8px Newsreader on story. |
| R34 | FAIL | FAIL | PASS | "Proof" always green and bold, so two items look active (`lease-1440-light.png`). Disagree. |
| R35 | PASS | PASS | PASS | One green, used on primary buttons and chart. |
| R36 | FAIL | PASS | PASS | `document.getAnimations()` shows `trace` 0.52s on load. Quality not watched. |
| R37 | FAIL | PASS | PASS | Stacked hero with full-width plot. |
| R38 | PASS | PASS | PASS | "One PayPal hold. An AI spending lease." |
| R39 | FAIL | PASS | PASS | Both CTAs say "See the lease". |
| R40 | FAIL | PASS | PASS | Ruled hero to tinted fee band to plain close. |
| R41 | FAIL | FAIL | FAIL | No operable element on the landing. |
| R42 | FAIL | PASS | PASS | Serif display against muted sans lede. |
| R43 | FAIL | FAIL | PASS | No badge, logo row or proof. CHECK fails R54 for the same absence. Disagree. |
| R44 | FAIL | PASS | PASS | Chart draw and fee reveal exist (`reveal` class added on scroll). Feel not judged. |
| R45 | FAIL | PASS | PASS | Plot shows hold, metered and captured as separate series. |
| R46 | FAIL | PASS | PASS | "Give your agent a spending cap. See what it spends and why it pays." |
| R47 | FAIL | PASS | PASS | Green in plot, fee band, button. |
| R48 | FAIL | PASS | PASS | Hero and chart fill the first fold, fee band starts below it. Motion detail not watched. |
| R49 | FAIL | PASS | PASS | Ledger ground and serif read as finance. Hero chart is still anonymous, no tool call drawn. Weak pass. |
| R50 | FAIL | PASS | PASS | Data graphic plus ruled ground. Weak pass. |
| R51 | PASS | PASS | PASS | One promise heading. |
| R52 | FAIL | PASS | PASS | Warm paper and dark ruled ink (`story-1440-dark.png`). |
| R53 | FAIL | PASS | PASS | Computed fonts: Newsreader for h1 and h2, Archivo for UI. Ledger mark. |
| R54 | FAIL | FAIL | FAIL | No audience, adoption or testimonial. |
| R55 | FAIL | FAIL | FAIL | Edges do not darken around the type. |
| R56 | FAIL | PASS | PASS | Ruled hero to tinted band. |
| R57 | FAIL | PASS | PASS | Same left-to-right reveal on chart and fees. Not watched. |
| R58 | N/A | N/A | PASS | No control with two meanings. |
| R59 | N/A | N/A | PASS | No submenu. |
| R60 | FAIL | N/A | PASS | No tooltips exist to time. The gap is R29. |
| R61 | N/A | N/A | PASS | No hover sidebar. |
| R62 | N/A | N/A | PASS | No drag. |
| R63 | N/A | N/A | PASS | No reversible edit. |
| R64 | FAIL | PASS | PASS | Confirm is in flow. `5.50` stays disabled, `$5.5` shows "4 of 5 matched", `$5.50` enables (`settle-typed-1440.png`). |
| R65 | FAIL | PASS | PASS | Loading has no figure. Queued payout shows deadline and stage (`payout-1440-light.png`). |
| R66 | FAIL | PASS | PASS | 0 unlabeled numbers in 80 frames. 13 of 13 Proof ids match the raw log. Proof left column is circular (flaw 3). |
| R67 | FAIL | PASS | PASS | Progress bar and "n of 5 matched". Release is a normal button, not a hold-to-confirm. |
| R68 | FAIL | PASS | PASS | Journal and balances align right at 390. Proof columns are left-aligned values, an exception. |
| R69 | FAIL | FAIL | PASS | 12 of 18 routes end before 70% of 900 px. Disagree. |
| R70 | FAIL | PASS | PASS | Header rule ends at the content edge (x 160 to 1280). |
| R71 | FAIL | FAIL | PASS | Journal pages 2 to 4 are repeated Accrue rows. Disagree. |
| R72 | FAIL | PASS | PASS | Flow strip replaces the paragraph. |
| R73 | FAIL | PASS | PASS | Every glyph has adjacent text. |
| R74 | FAIL | PASS | PASS | Red and amber mark the exceptions. One green primary per screen. Labels still default, see R10. |
| R75 | FAIL | FAIL | PASS | Five status screens, approve and the confirm are tinted cards with a left rule. Disagree. |

Result counts, mine: 55 PASS, 11 FAIL, 9 N/A. v3 table: 13 PASS, 55 FAIL, 7 N/A. CHECK claims 71 PASS, 4 FAIL.

Where CHECK.md says PASS and I say FAIL: R10, R29, R34, R43, R69, R71, R75 (7 rules). CHECK's own four FAILs (R11, R41, R54, R55) I agree with.

Regressions against v3 passes: none among the 13 v3 PASS rules. Coverage regression: the v3 lineage, sentinel, closed, renewed and lab routes were removed (flaw 2).

## Hunt for new damage

- Console and network: 0 page errors, 0 console errors or warnings, 0 failed requests across 80 route loads and the interaction runs at both sizes.
- Overflow: `scrollWidth` equals `clientWidth` on all 80 frames.
- Routes: `#/capture/nonsense`, `#/capture/lab`, `#/capture`, `#/` all silently render the story. `lease/foo` renders the lease. `journal/99` clamps to page 6 and `journal/abc` or `-1` renders page 1. No 404 or empty state exists. Benign for a prototype, wrong for a build base.
- Empty states: none exist and none can be reached (journal, proof and lease are always full). Not tested because there is no route to test.
- Reduced motion: `prefers-reduced-motion: reduce` gives 0 running animations and no `trace` animation. PASS.
- Theme: `?theme=dark#/capture/story` sets dark (`rgb(27, 33, 26)` ground). Dark checked visually at 390 on story, lease, expired, held, late, proof diff, journal, approve review, settle, failed, and at 1440 on story.
- Touch targets at 390: nav links 32x34 and 40x34 px, buttons 42 px high. Above the WCAG 2.2 24 px minimum, below 44.
- Contrast: minimum measured 5.05 (light) and 6.22 (dark) over every text node on 15 routes at both sizes. Matches CHECK. Font size is the problem, not contrast.
- Fixtures versus OpenAPI: `packages/contract/openapi.yaml` sha256 matches `docs/handoff/contract-v0.5.1.sha256` for all four files. I ran `tools/validate.py`: Lease 4, Authorization 3, LeaseEvent 21, LedgerEntry 48, Job 3, Verdict 6, Decision 3, Payout 2, Proof 1 all pass. Drift: the YAML `info.version` still reads 0.5.0 (Contract lane). Coverage is 9 groups, down from the 15 the v3 STATUS claimed, because the screens that used the others were deleted. The validator is the author's, so this shows the fixtures fit the schema, not that the schema check is independent.
- Decision math: the decided job pays floor(1500 x 7000 / 10000) = 1050, which is what I10 requires. The ledger fixture balances (debits 5,240 equal credits 5,240, 0 unbalanced groups). Metered 1,450 minus captured 900 equals committed 550, as shown.
- Fees: $6.24 is 12 x $0.52 and $0.91 is 0.49 + 3.49% of $12.00. Both match the raw log and the model. Labeled computed.
- The expired lease is the live lease with the state flipped. `chart()` reads `data.events` and the live `t0` for both, so the "expired" example has the same balances and events. Not wrong, but it is one lease aged, not a second one.
- `Back to lease snapshot` and the receipt contradict (flaw 1).

## The 3-minute capture, frame by frame

I walked the author's script path in a real browser at 1440x900 (`walk-01` to `walk-14`, sheet in `walk-sheet.png`). I could not decode the author's `demo.webm` (Playwright's bundled ffmpeg has no VP8 decoder), so I did not watch their recording.

| Frame | What a viewer sees | Embarrassing? |
|---|---|---|
| walk-01 story top | Headline, flow strip, chart. Ruled lines run behind the headline. | No. Best frame. |
| walk-02 fees | $6.24, $0.91, $5.33, labeled computed, with "$0.52 measured" in the sentence above. | No. The 9px tags are hard to read. |
| walk-03 lease | $20.00 cap, chart, balances, buttons. Bottom 15% empty. | Minor. |
| walk-04 to 06 settle | Confirm in flow, "4 of 5 matched", progress bar. Money stays visible. | No. |
| walk-07 receipt | "Total captured $14.50, Available $5.50". Content in a 390 px column, two thirds of the frame blank. | Minor. |
| walk-08 back to lease | Still Committed $5.50, Captured $9.00. | Yes (flaw 1). Not on the author's click path, but the button is on screen. |
| walk-09 jobs | Escrow $15.00 after the lease has $5.50 left. Eyebrow says "separate lease example". | Yes (flaw 1). |
| walk-10 held | "$0.00" under "Disagreement holds the payout". | Yes (flaw 7). |
| walk-11 to 12 proof | Match table, record picked. | No, but the match is circular (flaw 3). |
| walk-13 diff | Picker snapped back to the authorization after the narrator chose a capture. | Yes (flaw 3). |
| walk-14 journal | Four "Tool call" rows. The demo ends here. | Anticlimax (flaw 6). |

Not on the path at all: buyer approval, expired, pending, failed and late states, webhook handling, reauthorize. The script length is 180 s for a 180 s limit, with no margin. Narration does not exist yet.

## Scores

From this page and its capture, not the repo. Change is against v3 (4, 3, 5, 4, 3).

| Criterion | v4 | Change | Reason |
|---|---|---|---|
| Design | 6 / 10 | +2 | Two real faces, ruled ledger ground, a dark mode that is its own ground, distinct Pass and Fail, no overlay. Held back by one card template for five states, half-empty frames, ambiguous nav, 9px labels, no level 3. |
| Presentation | 6 / 10 | +3 | Capture has no lab, toggle or footer, and the first fold carries all five ideas. Held back by the budget that does not add up, a diff that resets, "example" strings, labels unreadable at video size, a journal ending, and no narration. |
| Innovation | 5 / 10 | 0 | The mechanism is now stated in one strip. The page still shows none of the lifecycle, reauthorize or webhook ideas that make the project different, and the held verdict misstates a hold as $0.00. |
| Potential impact | 5 / 10 | +1 | $6.24 versus $0.91 per $12.00 gives a concrete, labeled saving. One example, no buyer or seller consequence, and the escrow and lease figures do not share one budget. |
| Technological implementation | 4 / 10 | +1 | From this surface only. 13 of 13 Proof records match the raw sandbox log, fixtures validate against the frozen OpenAPI, and the ledger balances. Everything shown is fixture, proof is circular, the settle step does not change state, and nothing shows PayPal or the kernel running. |

## Verdict

Ship v4 as the build base for `apps/web`. It is a better base than v3 on every measurable rule and loses nothing that v3 passed. The fix list that must land before anything is recorded: flaws 1, 3, 4 and 8 (all small, view-level changes). Flaws 2, 5, 6, 7, 9 and 10 can be fixed during the build, since they need the real data and routes.

## What I did not verify

- Motion quality. I confirmed the animation exists and reduced motion disables it. I did not watch `trace` or the fee reveal play.
- The author's `demo.webm`. I could not decode it, so I did not confirm its 179.88 s length or its frames. My walk is a re-run of the same click path.
- A physical phone, Safari, Firefox, and a real YouTube downscale. 390x844 is Chromium emulation.
- Dark mode at 1440 on routes other than story. Dark metrics (contrast, overflow, errors) were measured on all routes. Visual review was on the frames listed above.
- Clipboard copy of the record id (`file://` may block it).
- Unfamiliar-viewer comprehension. The 10-second test needs a person. I only confirmed the five words are in the first fold.
- Contrast inside the SVG hatch pattern.
- The empty states, because no route reaches one.
- Any kernel, API or PayPal behavior. This is a design audit only.

## Next level up

A timed first-impression test with one person who has never seen PASHADHARA, on the capture route, no narration, 10 seconds. Needs one willing viewer and a screen recording.

Data that would have made this better: a connected sandbox run with a kernel ledger replayed from `evidence/spike2-log.jsonl`, so Proof compares two independent sources.
