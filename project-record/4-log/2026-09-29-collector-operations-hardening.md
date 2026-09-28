# Collector operations and health hardening — 2026-09-29

Trace ID: `TRACE-20260929-collector-operations-hardening`

## Request and acceptance

Continue the Sentiment Desk build autonomously, preserve real-data-only runtime
behavior, check related operational defects, show the working UI, and push a
regular checkpoint to `origin/codex/real-data-rebuild`. The local acceptance
was: Jev cannot receive a collector unless both the Jev and active source
allowlists admit it; transient SEC directory failures do not block API
startup and recover into company polls; global and duplicate receipts do not
inflate per-company source coverage; every collector has truthful visible
health; all external test requests stay behind a pre-network guard.

## Build and method

Checkpoint: `4fe03a2b2ca6df7e77dd0aa658c4d2b55882f61e` on
`codex/real-data-rebuild`, pushed to GitHub. Changed `README.md`,
`scripts/verify-offline-startup.ts`, `server/collector-policy.ts`,
`server/db.ts`, `server/health.ts`, `server/index.ts`, `server/schedule.ts`,
`tests/config.test.ts`, `tests/db.test.ts`, `tests/gdelt-poller.test.ts`,
`tests/pipeline.test.ts`, `tests/provider-pollers.test.ts`,
`web/src/components/HealthPanel.tsx`, and `web/src/lib/api.ts`.

- Jev's effective collector set is the intersection of its configured source
  permissions and the active external-source allowlist. The same `Pipeline`
  set gates startup drains, periodic drains, new ingests, and manual retry.
- SEC ticker-directory bootstrap now runs after the HTTP server starts. A
  transient failure is persisted and health-visible; the SEC scheduler retries
  on its normal cadence. A recovered map starts the per-company filings poller.
- SEC global directory receipts have `companyId=null` and are excluded from
  company coverage. Coverage now counts distinct companies with recent
  successful or empty receipts, so repeating one company's poll cannot make
  the whole watchlist appear covered.
- GDELT has a separate health counter and UI row instead of being folded into
  RSS status.
- Added recovery and coverage regressions plus a fresh-process Jev/source
  mismatch probe. The mismatch process has an API key, positive daily request
  and byte limits, a Jev allowlist containing Google News, and an external
  allowlist containing only SEC. Jev health must remain disabled, isolating
  the intersection as the gate under test.

## Data lineage and side effects

No source-provider or Jev request was sent. The offline startup verifier uses
temporary databases and a `fetch` guard that rejects provider requests before
they leave the machine. Unit tests use temporary/in-memory databases and
injected resolver/fetch results; those fixtures are test-only and do not enter
the live application.

The same-day UI inspection used an isolated SQLite backup at
`data/ui-check-20260929/desk.db`, not the original database. The copy contained
2,876 Finnhub, 4,349 Google News RSS, 3 SEC EDGAR, and 581 Yahoo Finance RSS
observations; 4,700 `legacy_unknown` observations were quarantined from
research reads; there were zero `demo_simulation` observations and 69,316
saved price points. The visible panel selected Adobe and drew saved sentiment
and price history. This is historical local data, not a current provider
response. The browser made only loopback requests and reported no console
errors. Screenshot artifacts remain local and are not part of the Git commit:

- `output/playwright/2026-09-29-real-saved-data-adobe-chart.png`
- `output/playwright/2026-09-29-real-saved-data-health.png`

## Verification

- `npm test -- --reporter=dot` — **PASS**, 160 tests across 24 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**. A fresh default process served
  all 24 configured companies with sources and Jev paused, returned 503 for
  manual retry, and attempted zero outbound fetches. Nine isolated source
  processes activated only their own guarded request path. An additional
  positive-budget Jev/source mismatch stayed disabled; all attempted external
  fetches were intercepted before network access.
- `npm run build` (run by `verify:offline-startup`) — **PASS**. Vite retains
  its existing 531.79 kB main-chunk advisory.
- `git diff --check` — **PASS**.
- Independent follow-up reviews confirmed the SEC retry regression reaches a
  company-level receipt and the coverage test counts distinct companies. The
  Jev probe review caught an initial zero-budget confound; positive finite
  limits were added, then the mismatch probe was re-reviewed with no remaining
  false-pass concern.
- Remote readback confirmed
  `refs/heads/codex/real-data-rebuild` equals
  `4fe03a2b2ca6df7e77dd0aa658c4d2b55882f61e`.

## Limits and next gate

This checkpoint completes local hardening only. It is not full operational or
10/10 readiness. `EXTERNAL_REQUESTS_ENABLED` stayed off in the UI session, and
the verification requests were blocked before network access. No real-source
Jev run or independent real-source label set exists. The authorized TypeSafe
account owner must confirm permitted use, telemetry, retention, rejected
request billing and settings, and an approved request/cost ceiling. The
operator must provide a valid SEC contact for `SEC_USER_AGENT`; non-SEC
publisher rights, historical `legacy_unknown` provider/model usage and
billing, and exhaustive source coverage remain open. Opportunity Radar stays
downstream until Sentiment Desk passes its operational gates.
