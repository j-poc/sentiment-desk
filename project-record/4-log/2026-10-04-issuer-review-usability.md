# Issuer review usability acceptance — 2026-10-04

## User outcome

For a selected company, an analyst can scan evidence that passes the current
issuer-identity rule, open the exact held source records in one action, and see
why each record was held. Live updates, reconnects, and pagination must preserve
the same boundary. Held observations remain saved and visible in History.

## Acceptance criteria

1. All, Bullish, Bearish, and Material filters apply issuer identity before SQL
   pagination, so weak rows neither leak into the scan nor leave short pages.
2. “Held” opens the exact weak-identity records across all retained history,
   with stable cursor pagination, status visibility, and the existing set-aside
   control.
3. Saved-evidence headlines and Just landed include only rows explicitly marked
   identity-strong on initial load, stream updates, duplicate delivery, and
   reconnect. Unknown identity metadata fails closed for those investor-facing
   previews.
4. Every row returned by the app's recent and company mention readers includes
   its computed identity result. The drawer explains that a held record may
   still concern the company and is not proof of irrelevance.
5. No saved source observations, Jev scores, Luna classifications, chart history,
   or baseline membership are rewritten in this slice. Exact source data remains
   reviewable, and the canonical database is untouched.
6. Focused regressions and the full repository suite pass; the actual saved-data
   browser journey proves direct recovery and no held headline leakage.

## Scope decision

Two independent design reviews recommend a first-class held filter on the
existing paginated endpoint instead of routing to mixed History or adding a
second API and cursor model. Read-only analysis of the isolated real-data copy
found 1,368 weak matches among 8,927 identified real rows, including 527 saved
Jev scores. Some held records explicitly concern Apple stock, iPad, and AirTag.
The current identity rule is therefore a conservative text screen, not
authoritative issuer resolution. Historical chart and baseline eligibility
changes need a separate versioned policy and false-exclusion review. This slice
keeps their stored membership and calculations intact while making their
limitation visible.

## Model-label usability correction — 2026-10-05

An independent finance-platform reviewer confirmed that the shared Material
filter combines two model outputs: a historical Jev score threshold and Luna's
categorical material flag. The filter and Jev card previously presented these
as an unqualified materiality claim. The visible filter now reads “Model
material”; selecting it shows both inclusion rules and says they are not
independently validated findings. Jev cards identify the badge as Jev, and
Luna's card label says “Model-marked material.” Query thresholds, saved rows,
history, and chart calculations are unchanged.

Observable acceptance: a selected Material filter visibly explains its Jev
threshold and Luna rule, and a Jev-flagged card names Jev before the analyst
opens the source drawer. Component regression tests cover the card label and
filter disclosure. Rendered-browser verification was pending when this section
was drafted; see the current verification below. No provider request or
canonical database write is part of this correction.

## Rendered user-path verification — 2026-10-05

Trace: `TRACE-20261005-usability-path`.

### Observable acceptance criteria

1. Selecting **Model material** visibly discloses the exact two inclusion rules and says their materiality is not independently validated.
2. **Review held matches** opens the company's held records, including records beyond the default source scan, without changing the saved source rows.
3. Opening a held row explains the identity screen's limitation and preserves attribution to the reported publisher, collector, saved-link host, and source receipt.
4. The selected-company chart can be switched between current Luna and historical Jev, and the empty Luna and stale Jev states remain visually and semantically distinct.
5. Verification uses real saved observations, disables external requests, and leaves the canonical database untouched.

### Evidence

- The env-scrubbed preview is `http://127.0.0.1:8879/`, served from the production build and a private local SQLite backup outside the repository. `/api/health` reports external requests disabled. No provider, classifier, or SEC request was made during this review; no saved application record was written.
- The Apple view shows the filter label **Model material**. Selecting it exposes: a historical Jev material score of at least 0.60 or a Luna classification marked material; neither is independently validated as a materiality finding. Jev-scored cards say **JEV MATERIAL**.
- From the default scan, **Review held matches** switches the feed to **ALL SAVED HISTORY · NEWEST FIRST** and the **Held matches** filter. It reports 160 held Apple rows. Opening “Dear Apple Stock Fans, Mark Your Calendars for October 13” displays the identity-rule explanation and preserves publisher Barchart.com, collector Google News RSS, saved link host news.google.com, and a source request receipt. The drawer says the name-only match does not prove the record is unrelated and leaves the original available in Held matches and History.
- The Historical Jev chart tab renders 245 source records across 32 15-minute buckets, states that repeats are included, uses the labeled −100 to +100 impact-point scale, and marks the latest score six days old. Luna categories state there are no saved classifications and that new classifications are blocked while external requests are disabled.
- The preview shows 1,118 source records retrieved across the configured watchlist in 24 hours, but no SEC facts or verified market price series for Apple. These unavailable inputs are explicit in the UI; no chart or fact values were fabricated.
- Focused materiality and held-feed accessibility tests: 8/8 pass. Full test suite: 640 tests across 82 files pass. Typecheck and production build pass. `git diff --check` passes.

### Limits

This proves a rendered, saved-real-data path for model-filter disclosure, held-row recovery, source attribution, and honest chart availability. It does not prove live Luna operation, current issuer discovery, source/provider rights or coverage, completeness of receipts for historical rows, a current price series, or usefulness in uncoached investor sessions. Those broader readiness gates remain open. The saved-data UI review caused no external requests and no canonical-database writes.
