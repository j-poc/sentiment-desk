# Reaction-window freshness and denominator correction — 2026-09-29

Trace ID: `TRACE-20260929-reaction-window-freshness`

Implementation checkpoint: `76b46c2` (`fix(scoring): require mature reaction windows`),
pushed to `origin/codex/real-data-rebuild`, after `2a0f199`.

## Request and acceptance

Continue the main Sentiment Desk build; investigate related chart/outcome issues
after company selection and chart rendering were reported broken. Keep the
application on real source data only. Preserve Jev as the per-item classifier,
do not expand Opportunity Radar, and push a reviewable checkpoint. Acceptance
for this slice: stale prices cannot be reported as observed reactions; horizon
sample counts and hit-rate denominator agree; selecting a company changes its
chart; the dashboard describes saved-data and exploratory evidence accurately.

## Finding and changes

Read-only review of the local saved-data API found 2,164 scored item reactions
in the 168-hour window, including 1,263 displayed as exact 0.00%. Reconstructing
the selected price points showed that 1,424 items had at least one endpoint
more than five minutes from its target. The prior calculation carried forward
old prices, including prices across closed-market gaps, and counted them as
reactions. In a fresh-endpoint subset only four items were exact zero. This was
a measurement defect, not a finding about the classifier.

The backend now requires baseline and terminal prices to be within five minutes
of their target timestamps, rejects invalid windows/prices, requires the
baseline to be at or after publication, and returns no outcome until the
requested horizon has matured as of one captured endpoint time. Precision is
retained before display rounding. Reaction summaries report independent
30-minute and four-hour sample counts; four-hour-only items cannot enter the
30-minute hit-rate denominator. Pipeline memory summaries use the matching
30-minute denominator. The company query returns the complete eligible window
of source-identified, publisher-timed scored items with non-null impact; the
API computes aggregates over all items and returns only the eight highest-score
measured examples with `measuredEventCount`. The outcome panel states its
baseline/freshness/maturity rules and discloses example truncation. The
watchlist-wide panel calls its rank correlation exploratory and item-level,
and discloses that syndicated stories and repeated issuers are not adjusted.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 208 tests across 27 files. Added
  regressions for the complete-window aggregate beyond 200 rows, post-event
  baseline, stale baseline and terminal prices, valid zero return, 30-minute
  and four-hour maturity boundaries, and four-hour-only observations excluded
  from the 30-minute hit-rate denominator.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**. Production assets built; all
  sources and Jev remained paused; retry was rejected; no outbound fetches were
  observed; all nine source allowlist probes and the mismatched allowlist case
  passed.
- Independent readiness review confirmed the maturity boundary, source filter,
  complete-window aggregation, example-count disclosure, and per-horizon
  denominators; no adjacent issue remained.
- `git diff --check` and JSON parsing of `live-data-etl.json` — **PASS**.
- Saved-data-only production preview `http://127.0.0.1:8795/` used the isolated
  SQLite copy `/private/tmp/sentiment-desk-ui.3L27Be/desk.db` with
  `EXTERNAL_REQUESTS_ENABLED=false`; Jev and source collectors were disabled.
  Clicking the visible AMD selection changed the company heading, mentions,
  outcome summary, and sentiment/price chart. The chart was visible in the
  browser screenshot. The rendered outcome summary showed `30m n=41`,
  `4h n=7`, and `hit 37%`, and disclosed `top 8 of 41 measured items`.
  Ten chart canvases were rendered. Browser console errors: **0**.
- In the saved dataset, the 120-hour watchlist response included 2,732 scored
  items, of which 736 had timely 30-minute prices. Item-level rank IC was
  `0.032`; it is descriptive and unclustered, not classifier evaluation,
  causality, or predictive evidence.
- No provider or Jev request was sent. No demo or synthetic product data was
  added. Synthetic values used in unit tests remain test-only.

The preview confirms local behavior over previously saved observations only;
the displayed source rows were about six hours old. It does not prove current
provider delivery, source rights, Jev quality, or investment usefulness. The
build continues to emit its existing Vite main-chunk size advisory. No demo or
synthetic product records were inserted; unit tests use isolated synthetic
fixtures only.

## Remaining Sentiment Desk gates

The goal remains active and incomplete. Source collection and Jev stay paused
until an authorized TypeSafe account owner confirms permitted product use,
telemetry/retention, rejected-request billing, account controls, and an
approved request/cost ceiling; a contact-bearing `SEC_USER_AGENT` is
configured; non-SEC source rights are established; two independent reviewers
label real provenance-backed cases; and the frozen real-source Jev evaluation
passes. Historical `legacy_unknown` provider/model-use and billing lineage and
exhaustive source coverage also remain unresolved. Opportunity Radar remains
downstream.
