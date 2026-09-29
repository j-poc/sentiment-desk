# Sentiment comparison empty states and watchlist sorting — 2026-09-29

Trace ID: `TRACE-20260929-sentiment-comparison-empty-states`

Implementation checkpoint: `cc493be` (`fix(ui): handle missing sentiment comparisons`),
pushed to `origin/codex/real-data-rebuild`.

## Request and acceptance

Continue the main Sentiment Desk build and check adjacent UI failure states.
Keep every product record real and source-attributed, preserve Jev as the
per-item classifier, exercise company selection and its chart in the visible
app, checkpoint to the existing GitHub branch, and keep Opportunity Radar
behind Desk readiness. Do not send source or Jev requests.

## Findings and changes

- Top Movers used one empty-state sentence whether the watchlist had no scored
  companies or had scores but no prior comparison window. It now states those
  two cases separately.
- The watchlist's movement sort accepted missing deltas as sentinel values,
  which produced a misleading `Δ MOVE` control and unspecified ordering when a
  comparison window did not exist. The sort now falls back to alphabetical
  order and disables the control with an explanation when all deltas are null.
- When some deltas exist, companies with comparisons sort by absolute movement;
  missing comparisons go last, with ticker order resolving ties. The ordering
  helper is covered for all-null and mixed-comparison snapshots.
- No example or synthetic records were added to the app or preview database.
  Fictional snapshots exist only in isolated test cases.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 199 tests across 26 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS** on the exact tree; production
  build succeeded, requests stayed disabled, retry returned 503, no outbound
  fetch was attempted, all nine isolated source allowlist probes passed, and
  mismatched Jev/source allowlists stayed disabled.
- `git diff --check` and JSON parsing of `live-data-etl.json` — **PASS**.
- Production browser at `http://127.0.0.1:8795/` — **PASS**. It used the
  isolated `/private/tmp/sentiment-desk-ui.3L27Be/desk.db` copy, with
  `EXTERNAL_REQUESTS_ENABLED=false` and Jev disabled. Clicking AMD in the
  watchlist selected AMD, showed 166 saved mentions, and rendered the saved
  sentiment and price chart. All 24 company deltas were null; the disabled
  `A-Z` button explained that no prior comparison was available. Top Movers
  correctly said current scores existed but lacked a prior 24-hour comparison.
  The screen showed 3,257 mentions across the 24-company watchlist, source data
  about six hours old, zero source-identified judgments today, and `$0`
  estimated input cost for the new UTC day. Browser console errors: **0**.
- An earlier preview snapshot showed 3,165 source-identified judgments and
  `$0.293` estimated input cost. That is a historical snapshot, not the current
  UTC-day count and not an invoice.
- Independent readiness review found no remaining defect in the changed sort
  or empty-state branches. The reviewer confirmed that local UI evidence does
  not clear the external rights, authority, historical-use, or classifier
  quality gates.
- Vite emitted the existing 533.22 kB main-chunk advisory; the build passed.

## Remaining gates

This is a pushed local implementation checkpoint, not a fully operational or
10/10 Desk. Source collection and Jev remain paused. Still open: authorized
TypeSafe account-owner review of applicable use, telemetry, retention,
rejected-request billing, and an approved request/cost ceiling; a valid
`SEC_USER_AGENT`; rights for non-SEC publishers; independent blinded
real-source Jev labels and a passing frozen evaluation; reconciliation of
historical `legacy_unknown` provider/model use and billing; and exhaustive
source coverage. The local database copy does not resolve those matters.
Opportunity Radar remains downstream until Sentiment Desk passes those gates.
