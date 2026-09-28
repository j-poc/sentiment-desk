# Provider row integrity and health disclosure — 2026-09-29

Trace ID: `TRACE-20260929-provider-row-integrity-and-health-disclosure`

Implementation checkpoint: `e86960b` (`fix(collectors): surface malformed provider data`),
pushed to `origin/codex/real-data-rebuild`.

## Request and acceptance

Continue the main Sentiment Desk build autonomously, preserve the real-data-only
product boundary, identify adjacent collector/data-health bugs, checkpoint the
work to GitHub, and keep Opportunity Radar behind Sentiment Desk readiness.

The local acceptance target was to ensure malformed provider responses cannot
masquerade as clean empty feeds or complete company coverage, retry unresolved
Finnhub history without hammering completed tickers, show missing SEC identity
mappings, validate market-chart payloads, and make degraded source state
visible in the UI. Live provider and Jev traffic stayed disabled.

## Findings and changes

- RSS, GDELT, Reddit, and Finnhub preserve raw provider row counts before
  discarding unusable rows. Mixed usable/malformed responses are recorded as
  partial; non-empty responses with no usable rows are invalid, not empty or
  successful. Delivery receipts retain the raw count and malformed-row reason.
- X validates the response row count against provider metadata and rejects
  repeated/non-advancing continuation tokens. A repeated token clears only the
  in-progress continuation; it does not move the last committed `since_id`.
- SEC validates ticker-directory and submission response structure. A configured
  company with no ticker-to-CIK mapping now gets an invalid delivery receipt,
  health failure, and warning event rather than silently disappearing from SEC
  coverage.
- Yahoo chart responses validate result/error shape and timestamp/close-array
  alignment before they can become cache entries.
- Finnhub upcoming-earnings dates are replaced atomically so absent companies
  do not retain stale dates. Historical backfill state is stored per company:
  clean results are complete; malformed or failed results receive a bounded
  retry time and survive SQLite restart.
- Delivery health now returns the most recent relevant degraded error even if
  a different company later succeeded. The Health panel shows recent coverage,
  raw provider row count, degradation detail, and configuration-off labels.

The implementation changed `server/db.ts`, `server/schedule.ts`, the RSS,
GDELT, Reddit, Finnhub, SEC, X, and Yahoo chart adapters, their relevant
regression tests, and `web/src/components/HealthPanel.tsx`.

## Data and side-effect boundary

No live RSS, GDELT, Reddit, Finnhub, SEC, X, Yahoo, or Jev request was sent for
this checkpoint. Adapter and poller tests use local injected responses. The
fresh-process startup verifier intercepted all outbound fetches before network
access.

The saved-data UI was driven in production build mode against an isolated copy
of existing source-backed local data, with external requests disabled. The
browser selected AMD and displayed its saved sentiment/price chart. It issued
loopback-only requests and had zero console errors. Screenshot:
`output/playwright/2026-09-29-final-saved-data-amd.png`. This confirms saved-data
presentation only; it is not proof of current provider delivery. Product data
remains real-source-only; synthetic rows are confined to tests and frozen local
evaluations.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 196 tests across 24 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**; production build succeeded,
  default startup served 24 configured companies with sources and Jev paused,
  retry returned 503, zero outbound fetches were attempted, all nine isolated
  source allowlist path probes passed, and a mismatched Jev/source allowlist
  stayed disabled.
- `git diff --check` — **PASS**.
- Production browser check — **PASS** for the saved-data-only AMD selection and
  chart, loopback-only requests, and zero browser console errors.
- Existing Vite main chunk advisory remains at 532.48 kB; it does not fail the
  production build.

## Remaining gates

This is a pushed local data-integrity checkpoint, not external operation,
10/10, or release readiness. The current source/account authorization and terms,
valid `SEC_USER_AGENT` contact, non-SEC publisher rights, independent blinded
real-source Jev labels and a passing frozen evaluation, historical
`legacy_unknown` model-use/billing reconciliation, and exhaustive source
coverage remain open. The local test fixtures do not satisfy real-source
quality evidence. Opportunity Radar stays downstream until the Sentiment Desk
gates pass. See `project-record/3-project-specs/live-data-etl.json` for the
current gate ledger.
