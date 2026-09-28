# Offline saved-data runtime and browser proof — 2026-09-28

Trace ID: `TRACE-20260928-offline-saved-data-runtime`

## Purpose

The Sentiment Desk review needed a real connected UI pass after the provenance
quarantine, but the normal process starts feed pollers and can dispatch Jev.
Source permissions and account authority are still unresolved. The offline
mode makes the product inspectable without sending provider/model requests or
using generated content.

## Implementation

- `EXTERNAL_REQUESTS_ENABLED` is strictly parsed as `true` or `false`, defaults
to `true`, and rejects malformed values.
- With the setting `false`, startup skips the SEC ticker lookup, Jev dispatch
and retry poller, quote poller, and all source pollers. Manual scoring remains
unavailable. Market price requests read persisted SQLite points only and are
marked `local_store`.
- API health, feed health, header, status bar, and the Desk view identify the
  saved-data-only state. README documents the setting.
- A failed-item drawer exposes the retry flow only after health confirms both
  external requests and Jev are enabled. Unknown health, offline mode, or
  disabled Jev shows a plain reason and no retry/request control. The derived
  state is a discriminated union in `web/src/lib/retryAvailability.ts`.
- Changes are in `server/config.ts`, `server/index.ts`, `server/market.ts`,
  `server/health.ts`, `server/app.ts`, `web/src/App.tsx`,
  `web/src/components/{Header,HealthPanel,SourceCoverageDisclosure,StatusBar}.tsx`,
  `web/src/components/MentionDrawer.tsx`, `web/src/lib/{api,retryAvailability}.ts`,
  and `tests/{config,market,mention-drawer}.test.ts`.

## Verification

- `npm test -- --reporter=dot` — **150 passed across 24 files**.
- `npm run typecheck` — passed.
- `npm run build` — passed; Vite retains its existing ~531 kB main-chunk
advisory.
- `git diff --check` — passed.
- An isolated SQLite backup copy of `data/desk.db` was served from
`/private/tmp/sentiment-desk-offline-zXvxwj/desk.db`; the original file was
not modified. The current API returned 24 companies. AAPL's first 100 visible
mentions used the identified collectors `finnhub`, `google_news_rss`, and
`yahoo_finance_rss`; none was `legacy_unknown`, `demo_simulation`, or
`demo-sim`. The 7D AAPL price endpoint returned 2,853 persisted points and
`delivery=local_store`.
- A Node fetch guard rejected and logged any non-loopback URL. Its log had
  **zero entries** after server startup, API GET checks, browser reload, stock
  selection, failed-item detail, and chart loading. A named Playwright browser
  session recorded only loopback `GET` requests, including the saved price and
  sentiment series; browser console errors: **zero**. No POST, source fetch,
  model call, or retry action was made.
- Playwright selected Adobe and verified the `Adobe` company heading, saved
  sentiment/price chart, and local-store source-age label. Opening a saved
  failed row showed the offline retry explanation and no “Retry Jev” or “Send
  new Jev request” control. At 390×844, the earlier mobile pass measured
  `documentWidth=390` and `bodyWidth=390`.
- UI screenshots are local-only:
  - `output/playwright/2026-09-28-offline-adobe-chart.png`
  - `output/playwright/2026-09-28-offline-drawer-chart.png`
  - `output/playwright/2026-09-28-offline-saved-data-mobile.png`
- Independent read-only review confirmed the helper and App-to-drawer wiring
  fail closed for unknown/offline/disabled states and preserve the existing
  acknowledged retry flow when Jev is enabled; its focused test and typecheck
  both passed.

## Data and limits

The original local DB aggregate contained 4,700 migrated `legacy_unknown`
observations with saved judgments and no explicit simulation marker. Their
original collector, payload, TypeSafe-use, and billing history remain unknown.
The latest code quarantines them from visible research and scoring surfaces;
they remain preserved in the DB. The identified-collector rows are authentic
saved records, but collector identity alone does not establish publisher/model
rights. This smoke proves the offline saved-data UI and selected price chart;
it does not verify current live-source delivery, Jev real-source accuracy or
calibration, source permissions, account authorization, historical billing,
or 10/10/release readiness. Keep all new external requests disabled until the
recorded rights, account, budget, and independent-label gates are resolved.

The temporary server remains on `127.0.0.1:8794` with
`EXTERNAL_REQUESTS_ENABLED=false`, bound to loopback and using the isolated
copy above. It does not update or serve from the original local database.
