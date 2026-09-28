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
to `false`, and rejects malformed values.
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
- Checkpoint `1647a1102236cebb5579e30debcab7271f408e7b` was pushed to
  `origin/codex/real-data-rebuild`; screenshot artifacts remain local.
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

## Follow-up audit and record refresh — 2026-09-28

- A fresh readiness review raised a possible Jev daily-cap default mismatch.
  Code inspection verified `100` and `400_000` are validation maxima passed
  into `boundedNonNegativeInt`, not fallbacks: an absent environment value
  resolves to zero, and dispatch requires both limits to be positive. Added a
  config regression for missing values, bounded values, and invalid limits;
  no runtime cap behavior changed and no Jev request was made.
- Corrected stale acceptance evidence that said the active process predated
  the quarantine patch. The current record now points to the later controlled
  offline run and keeps provenance status partial because the default database
  still has legacy rows with unknown origin and model-use history. Wording now
  accurately identifies the test DB as an isolated SQLite backup copy.
- Current `/api/health` readback from the loopback offline process reported
  `externalRequestsEnabled=false`, Jev disabled with zero successes/failures,
  and source/quote pollers disabled. The network guard log remained empty.
- Verification after the regression and record edits: **151 tests passed
  across 24 files**, `npm run typecheck`, `npm run build`, JSON parsing, and
  `git diff --check` passed. Vite retained its existing 531.60 kB chunk-size
  advisory. No source, model, or external provider request was made.

## Current source and account terms check — 2026-09-28

- Current SEC primary pages confirm public EDGAR filing content is free to
  access and reuse, SEC site content may be copied/further distributed subject
  to stated exceptions, and EDGAR access expects a declared User-Agent with a
  maximum rate of 10 requests/second. This supports a narrowly scoped SEC-only
  real-source evaluation once the app has a descriptive contact User-Agent;
  none is configured now.
- The official TypeSafe MCA currently published as of 2026-09-23 says each
  submitted input consumes a credit, permits perpetual telemetry processing
  including hashes, summary statistics, and classifications, and places
  responsibility for input rights on the customer. Its similar/competing
  product restriction and the active account's accepted order, settings,
  retention, billing, and refill configuration still need account-owner
  review. No source text was sent to TypeSafe.
- Yahoo terms reviewed do not establish the exact rights for the app's
  RSS/quote/chart endpoints. Google publisher documentation does not address
  this app's storage or model-forwarding rights for publisher content. These
  feeds remain excluded from Jev quality work until exact permission is
  documented. Direct URLs are recorded in
  `project-record/3-project-specs/live-data-etl.json`.

## Explicit opt-in for external requests — 2026-09-28

- Changed the absent `EXTERNAL_REQUESTS_ENABLED` default to `false`. The
  TypeScript config test and a clean-working-directory config import both
  verify the default. A read-only code-path review confirmed this disables
  CIK/source/quote/Jev polling, leaves the judge null, rejects Jev retry as
  unavailable, and serves saved chart points from SQLite.
- Compose now passes the same `false` default and allows an explicit shell or
  `.env` opt-in. The dedicated live Compose smoke script sets `true` because
  its purpose is a keyless real-source check; it now states that it performs
  public-source HTTP reads and was not executed while rights are unresolved.
  README startup instructions and `.env.example` describe the paused default.
- Verification: **151 tests passed across 24 files**, typecheck, production
  build, `docker compose config -q`, `sh -n scripts/verify-live-compose.sh`,
  JSON parsing, and `git diff --check` passed. The existing Vite chunk-size
  advisory remains. The existing loopback process remains in offline mode and
  its network-guard log stayed empty; no provider/model requests were made.

## Fresh-process default-mode verifier — 2026-09-28

- Added `npm run verify:offline-startup`, which builds the production app and
  launches it from a fresh temporary working directory with a temporary SQLite
  database. The process environment deliberately omits
  `EXTERNAL_REQUESTS_ENABLED`, contains placeholder credentials for every
  provider, and supplies positive Jev limits and a valid-shaped SEC User-Agent
  to prove that credentials alone do not activate traffic.
- The verifier reads the actual health and configured-company endpoints,
  checks every source/quote/Jev health counter remains disabled, confirms a
  Jev retry request returns 503, and installs a child-process `fetch` guard
  that blocks/logs non-loopback requests. No source observations or synthetic
  company records are inserted; only the configured company universe is
  loaded into the empty temporary database.
- `npm run verify:offline-startup` passed: all 24 configured companies loaded,
  the saved-data-only health state held, the retry returned 503, and the guard
  recorded zero external fetch attempts. The check shut down cleanly and
  removed its temporary database and guard files. It validates the app's
  current `fetch`-based provider paths; it does not grant source rights or
  establish live delivery or Jev quality.
- Final verification after integration: **151 tests passed across 24 files**,
  `npm run typecheck`, `npm run verify:offline-startup` (including production
  build), `docker compose config -q`, shell syntax check, JSON parse, and
  `git diff --check` all passed. Vite reported its existing 531.60 kB chunk
  advisory. No live source, market-data, or Jev request was made.

## Per-source request allowlist and credential-read isolation — 2026-09-28

- Added `EXTERNAL_SOURCE_COLLECTORS`, a separate empty-by-default allowlist.
  Live source requests now require both this allowlist and
  `EXTERNAL_REQUESTS_ENABLED=true`; Google and Yahoo RSS are filtered
  independently, and Yahoo quote and chart requests use separate allowlist
  entries. Delivery health reports disabled collectors honestly. Jev input
  admission remains controlled separately by `TYPESAFE_ALLOWED_COLLECTORS`.
- This enables the planned narrow SEC-only path without starting unverified
  publisher feeds or Yahoo quote/chart endpoints. It does not establish those
  feeds' rights or clear the SEC/TypeSafe approval gates. The live Compose
  smoke names its required collector allowlist but was not executed.
- Independent review of the offline verifier found that config eagerly read
  `~/.newsjack/.env` even when `TYPESAFE_API_KEY` was explicitly set. Key
  resolution is now lazy; unit coverage proves the fallback reader is not
  called for either non-empty or explicitly empty env values. The verifier
  supplies a placeholder key and runs from a fresh cwd, so it cannot read the
  developer fallback credential file.
- Tightened verifier cleanup so setup failures also remove temporary state,
  and a child that misses graceful shutdown is killed before cleanup. Added
  focused tests for collector-list validation, one-feed RSS scheduling, and
  independent market quote/chart gates.
- Final verification after the changes: **156 tests passed across 24 files**,
  typecheck, `npm run verify:offline-startup` including the production build,
  Compose validation, shell syntax, JSON parsing, and `git diff --check` passed.
  The verifier's guard saw zero external fetches. No provider/model requests
  were made; the existing Vite 531.60 kB advisory remains.
- The offline verifier now also starts one fresh isolated process for each of
  the nine real source collectors with only that collector allowlisted. It
  checks the collector's expected external URL shape, confirms every other
  source's delivery gate remains disabled, and checks the matching health
  counter where one exists. A preload replaces global `fetch` before the app
  imports and throws before any network access; the only local requests are
  loopback health and the explicit Yahoo chart route. Yahoo quote and chart
  paths are distinguished by their interval/range parameters. Each process
  uses a temporary SQLite file, one company copied from the configured real
  watchlist, blank Jev credentials/allowlist, and placeholder source
  credentials. All nine probes passed. This verifies request gating and
  routing only, not live source contracts, authorization, data quality, or
  Jev performance.
- A fresh independent reviewer reran the production build and complete offline
  verifier, including all nine isolated source probes, and reported no
  actionable defect. The review independently confirmed the README, Compose,
  and smoke-script defaults are consistent. Its conclusion remains bounded to
  these guarded fetch paths and does not clear live data or release gates.
