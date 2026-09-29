# Source provenance usage and saved-data UI clarity — 2026-09-29

Trace ID: `TRACE-20260929-source-provenance-usage-ui-clarity`

Implementation checkpoint: `c00d61e` (`fix(ui): align saved-data status and usage labels`),
pushed to `origin/codex/real-data-rebuild`.

## Request and acceptance

Continue the main Sentiment Desk build, keep every displayed research record
real and source-attributed, inspect adjacent UI/data bugs, checkpoint the work
to GitHub, and keep Opportunity Radar behind Desk readiness. The preview and
verification must not send source text or requests to a provider or Jev.

## Findings and changes

- `Desk.usageSince` now uses the same real-source filter as research aggregates.
  `legacy_unknown`, `demo_simulation`, and `demo-sim` judgments remain in the
  historical database for audit, but cannot inflate current operational token
  and estimated-cost totals. A migrated-database regression confirms legacy
  usage is excluded and a newly scored identified-source observation is
  included.
- The header and Health panel label counts as source-identified usage and state
  that the input-cost figure is an estimate, not an invoice. Header and footer
  identify local app/SSE connectivity separately from source collection
  status, which is shown in Desk Health.
- The Top Movers empty state was misleading when current sentiment scores were
  present but there was no prior sentiment window. API readback showed all 24
  configured companies had a current `index` and `delta: null`; the selected
  company also showed `-- vs trailing 24h`. The new message says current scores
  are available and the prior 24-hour comparison is not.

## Data and side-effect boundary

The production preview at `http://127.0.0.1:8795/` runs against an isolated copy
of saved local data. `EXTERNAL_REQUESTS_ENABLED=false`; all source collectors
and Jev are paused, credentials and source allowlists are empty, and all
browser requests remain on loopback. The copy is not the default database.

The browser readback showed 24 configured companies, AMD selected with 166
saved mentions, its saved sentiment and Yahoo price chart, 3,165
source-identified judgments for the current UTC day, and an estimated input
cost of $0.293. The amount reflects saved historical judgments and is not an
invoice or evidence of requests made in this run. The chart and records are
persisted provider-backed observations; test/evaluation fixtures remain
separate and are not shown as product data. The refreshed preview screenshot
was inspected in the Codex UI; no screenshot file was added to the repository.

No provider or Jev request was sent for this checkpoint. The app's
“APP CONNECTED” status means its local event stream is connected; it does not
mean any source collector is live. Health showed source collection paused.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 196 tests across 24 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**; production build succeeded,
  fresh default startup served 24 companies with sources and Jev paused, retry
  returned 503, zero outbound fetches were attempted, all nine isolated source
  allowlist probes passed, and a mismatched Jev/source allowlist stayed off.
- `git diff --cached --check` — **PASS** before the implementation commit.
- Production browser check — **PASS** for selecting AMD, rendering its
  source-backed sentiment/price chart and mentions, showing the clarified
  Top Movers state, and disclosing saved-data-only mode.
- `git push origin codex/real-data-rebuild` — **PASS**, checkpoint `c00d61e`.
- Vite reported its existing 532.81 kB main-chunk advisory; the build passed.

## Remaining gates

This is a local implementation and saved-data UI checkpoint, not live
operation, 10/10, or release readiness. Still open: authorized TypeSafe account
owner approval and review of applicable use, telemetry, retention,
rejected-request billing, and a request/cost ceiling; a valid
`SEC_USER_AGENT` contact; rights for each non-SEC publisher source; independent
blinded real-source Jev labels and a passing frozen evaluation; reconciliation
of historical `legacy_unknown` provider/model use and billing; and exhaustive
source coverage. The original legacy rows remain untouched and quarantined;
their source and billing lineage is not established by the filter. Opportunity
Radar remains downstream until the Sentiment Desk gates pass. See
`project-record/3-project-specs/live-data-etl.json` for the current gate ledger.
