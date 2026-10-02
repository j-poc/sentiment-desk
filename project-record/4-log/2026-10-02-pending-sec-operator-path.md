# Pending SEC operator path and UI checkpoint

## Outcome

Repaired the real-source pending-SEC path so an operator can distinguish recent
retrieval from the selected source-time window, locate the older unscored filing,
inspect its linked source documents, and reach the current classifier gate. The
work responds to the user’s request to repair confusing source counts and make
the Sentiment Desk build more complete. The changed surface is the watchlist,
saved-evidence empty state, SEC mention drawer, and Sources & operations handoff.

## Observable acceptance

- A 24-hour company count says records were retrieved in 24 hours. An empty
  selected window says it is empty by source time and explains that recent
  retrieval may be outside that window.
- The empty window preserves “Open full mention feed” and separately offers
  “Open unscored history” when recent retrieval exists. The latter opens all
  saved unscored history without changing the source-time window.
- A pending SEC drawer puts judgment state, source-input state, accession,
  selected document, parent 8-K, Item 2.02 linkage, and dated source clocks
  before a collapsed excerpt. Dates include year and local timezone. The full
  excerpt remains keyboard accessible.
- The pending state has a direct action to the classifier’s Sources &
  operations readiness view.
- No score, source record, or price series is fabricated to fill the empty chart.

## Implementation and evidence

At 390x844 in the Codex in-app browser at `http://127.0.0.1:8797/`, the isolated
saved-data preview contained one real AMD SEC pending input from the prior
bounded parent-filing/Exhibit 99.1 acquisition. The app reported one source
record retrieved in 24 hours and no saved record by source time in the 7-day
window. Both feed actions remained available. The unscored-history route showed
the real filing. The drawer linked the exact selected Exhibit 99.1, its parent
8-K and the Item 2.02 excerpt, and distinguished the August 4 filing from the
October 2 retrieval. The 358.8px drawer fit within the 390px document without
horizontal overflow. Enter expanded the excerpt; Escape closed the drawer and
returned focus to its source row. “See why judgment is pending” closed the
drawer, opened Sources & operations, and focused its disclosure summary. That
view showed external requests disabled and the OpenAI account-use flag missing.
No external provider or model request was made during this UI check.

The integrated full suite passed 490 tests before the final copy-only change
from “retrieved/24h” to “retrieved in 24h”; the exact final copy was covered by
18 focused tests. `npm run typecheck`, `npm run build`, `git diff --check`, and
JSON validation passed on the final source. The production build retains the
existing Vite warning for a JavaScript chunk larger than 500 kB. Current ETL
verification status belongs to the machine-written, source-bound
`live-data-etl-evidence.json`; consult that receipt rather than inferring a
pass from this narrative.

Independent bounded review scored the repaired UI path 9.2/10 for usability
and the investor/operator task 9.2/10. Those are agent reviews, not customer
validation or model-quality measures. Whole-build review found no additional
code-local blocker in this slice and returned FAIL for the complete product:
there is no actual Luna output or usage reconciliation, the reference sets do
not contain negative cases needed by the declared three-class targets, and
sustained scale and investor value remain unverified.

## Git checkpoint

The reviewed implementation is in public repository
`https://github.com/j-poc/sentiment-desk`, branch `codex/real-data-rebuild`,
source commit `1191c2066d370de1a38e8256e839377c673d178a`. GitHub readback matched
the pushed branch at that commit. Repository visibility, access, deployment,
merge, and licensing were not changed. Runtime databases, source payloads,
credentials, screenshots, dependencies, and build output were excluded.

## Limits and unblockers

This checkpoint does not complete Sentiment Desk. The real saved AMD filing is
still pending, the local preview has no scored chart points for it, and Luna
dispatch remains blocked by the disabled request switch and missing OpenAI
account-use configuration. No API key was read or used. Full operational
acceptance still requires a bounded authorized Luna run with persisted outputs
and usage reconciliation, plus independent reference coverage for all three
sentiment classes. Opportunity Radar remains disabled. Product value and
sustained scale are not established.

Reproduce the deterministic checks with `npm test`, `npm run typecheck`, and
`npm run build`. Reproduce the documented real-source persistence checks with
the exact commands in `project-record/3-project-specs/live-data-etl.json`;
their runtime proof is maintained in the separate gate receipt.
