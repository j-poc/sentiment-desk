# Sentiment Desk completion plan

Status (2026-09-29): X and Reddit pagination now resume from persisted,
query-matched cursors; X commits its `since_id` only after a complete page
chain. GDELT requests up to 250 articles and reports raw-cap saturation as
partial even when malformed rows are discarded. Finnhub earnings/calendar and
Yahoo index receipts no longer distort company news/quote health; Yahoo index
warning/recovery transitions persist atomically across restarts. Code was
pushed to `origin/codex/real-data-rebuild` at `485490d`. Verification passed
175 tests across 24 files, typecheck, production build, and fresh-process
default/per-collector request probes with network interception. Independent
read-only reviewers confirmed the scoped pagination, cap-reporting, and health
findings are closed. The chart/UI evidence below is a saved-data-only browser
run against an isolated database copy; this checkpoint does not establish live
collection, provider/model rights, account authority, or real-source Jev
quality. See
`project-record/4-log/2026-09-29-feed-pagination-and-health-isolation.md`.

Saved-data UI verification snapshot (2026-09-28): the isolated production-build
smoke remains valid: its backup database contained 2,281 real source-backed observations, zero
simulation observations, and 2,281 pending judgments with Jev disabled; the
browser selected Adobe and drew its real Yahoo 7D chart. That smoke does not
establish the provenance of the separate default local database. A read-only
aggregate audit of that database found migrated `legacy_unknown` observations
with saved Jev judgments. The explicit simulation markers were absent, but
unknown provenance is not proof of real source data. The latest code now
rejects new observations or deliveries without a known collector, quarantines
legacy unknown rows from research reads, Jev dispatch/retry, source health,
aggregates, and Radar, and preserves their saved non-demo usage estimates in
the usage summary. Historical rows remain untouched.

The prior process audit later found neither port 8787 nor the earlier 8794
smoke server listening. To verify the current UI without restarting collectors,
the app now supports `EXTERNAL_REQUESTS_ENABLED=false`: it skips SEC lookup,
all collectors and Jev, serves saved price history from SQLite, and marks the
UI as “SAVED DATA ONLY”. A production build ran against an isolated SQLite
backup of the real local database. A server-side guard recorded zero external
fetch attempts; browser resource inspection found no origin outside localhost.
The API returned 24 companies and 100 AAPL records from identified collectors,
with no `legacy_unknown` or simulation rows in that result; 7D chart history
returned 2,853 saved points. Playwright selected Adobe, confirmed the company
heading changed, and showed both sentiment and price lines. A later named
Playwright session confirmed the 24H local-store chart and opened a saved failed
judgment: the drawer explained that retries are unavailable while requests are
paused and exposed no retry action. That browser issued only loopback GETs; its
console had zero errors. At 390×844 the earlier browser check measured both
document and body widths at 390px. Screenshots are kept locally in
`output/playwright/2026-09-28-offline-adobe-chart.png`,
`output/playwright/2026-09-28-offline-drawer-chart.png`, and the earlier
`2026-09-28-offline-saved-data-mobile.png`.

The application now also defaults to saved-data-only mode when
`EXTERNAL_REQUESTS_ENABLED` is absent. The repeatable
`npm run verify:offline-startup` check starts the production server in a fresh
temporary directory with every provider credential present but unused, reads
health and company endpoints, confirms Jev retry is unavailable, and blocks
and counts outbound `fetch` calls. The latest run served all 24 configured
companies, showed every source/quote/Jev health counter disabled, returned 503
for the retry attempt, and observed zero outbound fetches. Its empty temporary
database contains no sample observations; it uses only the configured company
universe.

The same verifier now launches nine additional isolated app processes, one for
each source collector, with the global switch on and only that collector in the
source allowlist. It checks the matching delivery/health state and expected
request path while a preload intercepts global `fetch` before network access.
The Yahoo quote and chart routes are verified separately. All nine probes
passed without external network access or Jev credentials. These checks prove
request gates and routing; they do not establish source rights or provider
response correctness.

Live requests now require two separate controls: the global
`EXTERNAL_REQUESTS_ENABLED=true` switch and a non-empty
`EXTERNAL_SOURCE_COLLECTORS` allowlist. Yahoo quote and chart requests are
separate entries, and RSS polling schedules only the allowed feed collectors.
The Jev forwarding allowlist remains separate. This permits a later SEC-only
collection/evaluation path without starting publisher feeds or Yahoo market
requests whose endpoint-specific rights remain open.

The prior offline UI checkpoint passed 156 tests across 24 files; typecheck and
production build passed, with the existing Vite chunk-size advisory. The
failed-row drawer now hides retry controls until both external requests and Jev
are enabled, and its health-state helper has direct regression coverage. An
independent read-only review found no actionable defect. The original database
still has migrated `legacy_unknown` rows whose provider and model-use history
are unaudited; the latest code filters them from research views. Generated
examples remain isolated to tests and frozen evaluations; they are not product
data or real-source model-quality evidence. This is not a 10/10 release:
non-SEC publisher rights, TypeSafe account/telemetry/billing terms, exhaustive
source coverage, legacy provider-use reconciliation, and real-source
classifier quality remain open. The offline smoke proves the saved-data UI,
not live collection or real-source Jev quality. Evidence:
`project-record/4-log/2026-09-28-real-data-only-runtime.md`,
`project-record/4-log/2026-09-28-sentiment-desk-readiness-continuation.md`, and
`project-record/4-log/2026-09-28-legacy-source-quarantine.md`. Offline runtime
evidence is recorded in
`project-record/4-log/2026-09-28-offline-saved-data-runtime.md`; the evaluator
gates and their limits are recorded in
`project-record/4-log/2026-09-28-jev-evaluator-hardening.md`.

## Durable goal state (2026-09-29)

The native ultragoal remains `active`. The latest code checkpoint is pushed to
`origin/codex/real-data-rebuild` at `485490d`. X and Reddit pages persist
query-matched continuations; X commits the newest post ID only after its page
chain drains. GDELT preserves raw result counts and marks cap saturation
partial, including when malformed rows are discarded. Finnhub company-news
health excludes earnings/calendar receipts, and Yahoo index quote failures do
not degrade company quote health. Index warning/recovery events transition
atomically with their persisted markers. The checkpoint passed 175 tests
across 24 files, typecheck, production build, the fresh-process offline startup
verifier, all nine guarded collector path probes, and a positive-budget
mismatched-source Jev probe. Follow-up independent read-only reviews confirmed
the scoped pagination, raw-cap, and quote-health findings are closed.

The loopback UI at `127.0.0.1:8794` remains in saved-data-only mode on an
isolated copy of the local database. The same-day browser pass selected Adobe
and rendered the persisted sentiment/price chart and source-health panel. It
made only loopback requests; the browser console had zero errors. The copy had
no `demo_simulation` observations, and `legacy_unknown` rows are excluded from
research reads. This proves saved-data presentation, not current provider
delivery or Jev quality.

The saved-data chart/UI screenshot remains available at
`output/playwright/2026-09-29-real-saved-data-adobe-chart.png`; it is an
isolated-copy browser run and makes no claim about current provider delivery.
The goal remains incomplete and must not be reported as 10/10. No new source
or Jev requests were sent. Remaining gates are account-owner confirmation of
TypeSafe use/telemetry/retention/rejected-request billing and an approved
request/cost ceiling; a valid SEC contact in `SEC_USER_AGENT`; rights for each
non-SEC publisher source; independent blinded real-source labels and a passed
frozen Jev evaluation; audit of historical `legacy_unknown` provider/model
use and billing; and exhaustive source-coverage review. Opportunity Radar
expansion remains downstream until these Sentiment Desk gates pass. See the
dated verification trace for the exact evidence and next actions.

## Prior durable goal state (2026-09-28)

The native ultragoal remains `active`. The saved-data-only UI, retry-gating,
and explicit external-request opt-in checkpoints are pushed to
`origin/codex/real-data-rebuild`; the latest implementation checkpoint is
`549ad800174bbb221c17bb3b6b8b33456d503ee0` (`feat(config): require per-source
request allowlist`). A fresh-process verifier proves the absent-variable
saved-data default makes no external requests, then checks each of the nine
individual source allowlists behind a global-fetch interceptor. Local
implementation and verification are recorded as complete for this iteration.
The active attention state is
`awaiting_authority`: the authorized TypeSafe account owner and applicable
source-rights owners must establish permitted use, retention, telemetry,
billing, and an approved request/cost ceiling; a valid SEC User-Agent contact
and independent human reviewers are also required. This goal will not issue
new source/model requests while those facts are absent. A later read-only
aggregate audit found legacy unknown-source rows with saved Jev judgments in
the default local database; their original payloads and billing history remain
unreviewed and they do not count as controlled quality evidence. Resume with
the real, rights-cleared SEC cohort and blinded labels only after those gates
and the available budget are documented. Then execute the frozen real-source
evaluator, verify the live pending-to-scored UI path, and re-evaluate the
remaining coverage/release gates. The exhaustive source-coverage review and
historical TypeSafe usage reconciliation are still open. Opportunity Radar
stays downstream until Sentiment Desk passes its operational gates.

The offline UI runtime is available on `127.0.0.1:8794` against a temporary
backup of the local database, with all external requests disabled. It is a
saved-data inspection session, not a live collector or Jev runtime. Failed-row
retry actions are hidden until health confirms both Jev and external requests
are enabled. The original database was not changed. This checkpoint passes
156 tests across 24 files, typecheck, production build, the fresh-process
saved-data startup check, all nine guarded collector-startup probes, the named
loopback-only browser check, and independent read-only reviews of retry and
source gates.

Fresh application launches now default to saved-data-only mode. The Compose
configuration follows the same default, and live provider traffic requires
`EXTERNAL_REQUESTS_ENABLED=true`; the live Compose smoke script opts in because
its purpose is to verify public-source delivery. Source permissions, account
authorization, spending, and independent real-source labels remain separate
gates before that opt-in is appropriate.

## User and outcome

The user is a single researcher running a private local desk. They select a
company, inspect source items and Jev judgments, then decide what to investigate.
Phase 1 makes that workflow durable, source-attributed, time-honest, and
operational in the local application. Phase 2 adds an inspectable, narrowly
scoped comparison on that persisted evidence.

Jev remains the authority for the sentiment and event category of every
company-related source item. Deterministic application code owns source
identity, freshness, score post-rules, and later cross-item calculations.
Opportunity hypotheses, value-chain links, and counter-evidence remain separate
from Jev's per-item sentiment and event-type judgments. The first Radar release
does not generate opportunity hypotheses or value-chain links.

## Phase 1: make Sentiment Desk operational

- Keep the product local, single-user, read-only toward markets, and
  live-data-first. The application runtime has no demo or synthetic-data mode.
- Retain the existing public news, GDELT, SEC, quote, and optional Finnhub,
  Reddit, and X paths. Add configurable RSS/Atom feeds only if needed to make
  the live research workflow useful without arbitrary page scraping.
- Store one source-attributed record per company-related item. Exact replays
  are idempotent; separate publishers are not erased by title similarity.
- Keep source publication/filing time, provider observation time, retrieval
  time, and local ingestion time distinct. Missing source time stays unknown.
- Distinguish successful delivery from the age and completeness of the data
  delivered. Surface stale, delayed, unknown, and failed states through the
  same API/UI the researcher uses.
- Preserve Jev's fixed current rubric, model, cost, latency, and fail-closed
  behavior. Missing keys leave items pending. A storage migration must not
  requeue older scores or create historical model charges.
- Keep raw source bodies only where the source contract allows it. Record the
  strongest permitted response/item provenance and say whether replay uses raw
  input or only normalized local records.
- Verify real local collection, Jev behavior, dashboard operation, restart
  persistence, Docker build/run, and desktop/mobile rendering before Phase 2.
  A 2026-09-28 hardening pass also verified acknowledged failed-judgment retry
  and stale SSE/snapshot recovery at desktop and 390px widths. The ten-case
  synthetic evaluation and source/account rights gates remain separate and
  are not release evidence.

## Phase 2: Opportunity Radar on the operational base

- Compare current and prior equal-duration company evidence windows using the
  event taxonomy already assigned by Jev. Group exact-normalized headline
  copies and show each source row; this is not event identity or narrative
  clustering.
- Use Jev's item judgments as the sentiment inputs. Keep source records and
  event identities separate so syndicated copies do not count as independent
  publishers, and preserve opposing evidence.
- Keep direction disagreements, timestamps, source identity, and feed coverage
  visible. Do not represent category volume, source count, or sentiment as proof
  of alpha, causation, or investment merit.
- Keep later social, search, app-store, hiring, market-structure, and
  value-chain inputs out until supported data contracts, rights, and protected
  evaluations exist.
- Do not scrape App Store reviews, YouTube/podcasts, search trends, or arbitrary
  sites where a supported API, rights policy, and usable credentials are
  absent. Never present a missing feed as evidence of no activity.

## Shared boundaries

- Source code stays public without a LICENSE file, as the user chose. The
  README must state that repository visibility does not grant reuse or
  redistribution rights.
- The application remains local and single-user. No hosting, purchase,
  provider enrollment, publication, PR, or external message is authorized.
- The currently authorized GitHub checkpoint is the existing branch
  `codex/real-data-rebuild`.
- Do not use the Citrini, Meridian, or Porch container profiles. Use a new
  task-specific Docker profile for verification if one is needed.

## Phase 1 acceptance criteria and evidence

1. Docker Compose builds and starts the checked-out application with real
   source collectors, and SQLite survives container recreation.
2. Keyless public collectors deliver real observations through the local API.
   With Jev disabled, those observations remain pending; with Jev configured,
   one valid judgment follows the unchanged rubric and appears in the drawer.

   - Model identity hard gate: send the configured alias unchanged. For
     `jev-latest` or `jev-preview`, accept only a successful response whose
     `model` is a canonical versioned Jev ID (`jev-<major>.<minor>.<patch>`);
     retain that returned ID as the persisted judgment engine. When a
     versioned model ID is configured, require exact response equality.
     Continue rejecting malformed IDs, unrelated models, invalid answers,
     probabilities, or usage, and never automatically resubmit an
     outcome-unknown request.
   - Evidence: unit fixtures must prove alias request/response compatibility,
     exact pinning, unrelated/malformed response rejection, and one request
     per judgment. HTTP 429 and TypeSafe's documented HTTP 529 overload
     rejection must use the existing bounded persisted retry path; generic
     5xx and transport failures remain outcome-unknown. A permitted
     new-observation smoke must prove successful provider response, persisted
     resolved-model provenance, and visible judgment without replaying
     existing outcome-unknown rows.
   - Current repair gates (2026-09-27; evidence:
     `project-record/4-log/2026-09-27-jev-alias-version-compatibility.md`):
     - `PASS` — alias, pinned version, malformed/wrong model, 429/529 retry,
       generic 5xx/transport failure, and persistence fixtures; `npm test`
       passes 74 tests across 11 files.
     - `PASS` — one live TypeSafe request on a newly inserted synthetic
       observation resolved `jev-latest` to `jev-1.13.0`; a temporary SQLite
       row retained that model and rubric, the local API returned it, and the
       browser drawer displayed the score and exact resolved model.
     - `PASS` — the isolated smoke used a temporary database and made no
       public-source requests; no existing failed/outcome-unknown row was
       loaded or replayed.
     - `NOT RUN` — a controlled, rights-reviewed public-source-to-Jev
       evaluation with labeled quality review. An older loopback runtime later
       reported many failed Jev attempts, but its submitted payloads and
       provider usage were not audited; see the 2026-09-28 runtime follow-up.
       SEC's public-filing reuse basis is now documented, but SEC_USER_AGENT
       is not configured and TypeSafe account authorization, telemetry,
       retention, and permitted-use terms remain unreviewed. The synthetic
       smoke proves integration only, not classifier accuracy or calibration.
3. A duplicate delivery does not create another Jev charge. Two independent
   source records with similar headlines remain separately attributable.
4. Missing publication or observation time is never replaced by retrieval
   time. The API and UI show source time separately from collection time.
   - Current source-time regression (2026-09-28): Reddit `created_utc` is
     optional in the provider response; an absent or invalid value remains
     `null` through poller ingestion rather than becoming Unix epoch zero.
5. Provider failure, malformed data, restart, and stale-but-successful
   delivery leave prior evidence intact and visibly degraded.
   - Current-source finding (2026-09-28): GDELT returned plain-text content
     for some HTTP-200 requests and HTTP 429 for others. The adapter must
     reject non-JSON bodies without turning them into article records, report
     a bounded error, and preserve prior source evidence. Regression tests
     cover non-JSON bodies, provider rate limits, and valid ArticleList JSON.
   - Current result: `PASS` — GDELT non-JSON input is rejected with a bounded
     error, HTTP 429 remains a rate-limit failure, and valid ArticleList JSON
     normalizes. The current live source state shows HTTP 429; no post-fix live
     HTTP-200 non-JSON response was observed.
   - Cooldown result (2026-09-28): `PASS` — the poller stops the current
     company sweep on its first HTTP 429, persists a source-wide retry time,
     honors `Retry-After`, applies bounded exponential fallback, skips without
     emitting fake deliveries, and resumes cleanly after expiry. Tests cover
     restart persistence, corrupt cooldown state, recovery, and reset after
     success. See `tests/gdelt-poller.test.ts` and
     `project-record/4-log/2026-09-28-sentiment-desk-readiness-continuation.md`.
   - Cross-collector rate-limit result (2026-09-28): `PASS` — RSS, Yahoo
     quote/chart, SEC, Finnhub, Reddit, and X preserve provider reset guidance,
     stop the affected sweep, and persist a bounded source-wide cooldown.
     Yahoo quote/chart 429s are not retried inside the request; identical
     simultaneous chart misses share one in-flight request. Default RSS and
     quote cadence and RSS concurrency were reduced, with provider request
     starts paced. Tests use mocked responses and do not call providers. See
     `project-record/4-log/2026-09-28-sentiment-desk-readiness-continuation.md`.
   - SEC text-integrity result (2026-09-28): `PASS` — when an EDGAR filing has
     no primary-document URL or its document cannot be fetched, no
     metadata-derived fallback sentence is sent to Jev. The filing is omitted
     from scoring, the delivery is recorded as `partial` with a generic
     explanation, and the regular poll can retry. A poller-level regression
     proves both missing-text cases create no Jev inputs while an actual
     fetched excerpt still enters the normal pipeline.
   - Additional hard gate: a GDELT HTTP 429 stops the current company sweep,
     persists one source-wide next-attempt time across process restarts,
     honors a valid `Retry-After` value, and otherwise uses bounded exponential
     cooldown no shorter than the configured poll interval. Cooldown skips do
     not create empty/success deliveries or article rows. A successful resumed
     request clears the consecutive-failure state. Deterministic tests must
     prove sweep termination, bounded growth, restart persistence, cooldown
     expiry, successful recovery, and continued operation of unrelated
     collectors.
6. Desktop and narrow-screen flows let the researcher select a company, read
   the score/index, inspect the source and Jev rubric, and understand data
   health without hidden overflow or dead controls.
7. `npm test` (123 tests across 21 files), typecheck, production build, fresh
   keyless local start, 390px and 1280px browser passes, accessible mention
   drawer interaction, SSE shutdown, and isolated Docker persistence smoke
   pass. The source-data contract records what these checks prove and what
   remains unavailable.
8. Selecting a ticker from the tape, watchlist, or movers updates the selected
   company and its chart without blanking the app. With no completed Jev
   judgments, the UI shows price-only history and states that sentiment is
   unavailable; with no valid chart data, it shows a clear empty state. Verify
   multiple tickers in the running browser and inspect runtime errors and the
   resulting company/chart request.

   - User/job: the local researcher selects a company and inspects its recent
     sentiment and price history.
   - Constraint: preserve the selected time window, exact company identity,
     provider timestamps, and stale/cache labels; never invent sentiment or
     price observations, carry a quote into a later time bucket, or extend a
     window silently.
   - Assumption: a company with no completed Jev judgments is a supported
     state; unscored source evidence must not prevent price history or
     company navigation.
   - Hard gates: ticker control updates the company header and requests the
     matching `/series` and `/price`; the price API rejects a ticker that does
     not belong to the requested company; no previous company's chart remains
     visible under the new header while loading; no browser runtime error;
     empty Jev data
     produces an explicit no-score state while valid price data remains
     visible. The price API returns only real provider observations whose
     source timestamps fall inside the selected window, unchanged and in
     order. A stale-only response has no drawable values but retains its real
     latest-source timestamp for the stale label. No chart observations
     produces an explicit unavailable state.
   - Measure/evidence: browser click across at least two companies, matching
     API request/response and visible header, a negative mismatched-ticker API
     request, zero console errors, and chart state matching the returned source
     observations. Proxy limit: this verifies UI wiring and payload handling,
     not market-data accuracy or Jev quality.
   - Failure cases: all-null sentiment, stale but valid price history, stale
     observations outside the selected window, failed chart request, and
     fewer than two drawable points.
   - Subjective copy choice: explain missing sentiment as “No Jev scores in
     this window” and retain source-age detail near the chart.
   - Subjective interaction choice: when the selected window contains no
     source price observation but an older real quote exists, keep the range
     unchanged and offer an explicit action to view 7D history.
   - Prior-build hard-gate results (evidence:
     `project-record/4-log/2026-09-27-stock-chart-selection-fix.md`):
     - `PASS` — ADBE→NVDA selection returned matching 200 `/series` and
       `/price` responses and displayed NVDA on the latest built asset.
     - `PASS` — all-null sentiment with 97 valid NVDA price observations
       rendered the price line, explicit no-score state, source-age label, and
       zero runtime/console errors on a fresh browser reload.
     - `PASS` — empty history, one-point history, 503 price failure, and
       recovery each showed the expected state; recovery returned 200 from the
       local API.
     - `PASS` — a 390px viewport had no horizontal overflow.
   - Boundary: the deliberate failure and empty-history cases use Playwright
     response overrides to exercise UI recovery; normal selection and recovery
     use the live local API. This does not verify price accuracy or live Jev
     scoring.

   - Newly discovered issue and current pass (2026-09-28; evidence:
     `project-record/4-log/2026-09-28-real-data-only-runtime.md`):
     - `PASS` — the old price endpoint repeated 97 Friday-close values in a
       weekend 24-hour window. The corrected API returns only source-timestamped
       observations inside the requested window and preserves the actual
       out-of-window source timestamp as metadata.
     - `PASS` — on the fresh real-source run, ADBE 24H returned zero points
       with latest source time 2026-09-25 20:00 UTC; the browser showed an
       honest empty state and an explicit “View 7D source history” action.
     - `PASS` — selecting that action and selecting ADBE updated the window
       and company. ADBE 7D returned 67 source points, 67 distinct prices,
       spanning 2026-09-21 13:30 UTC through 2026-09-25 20:00:01 UTC; the
       browser drew the matching Yahoo series and showed “No Jev scores in
       this window.”
     - `PASS` — a mismatched AAPL ticker on Adobe's company ID returned HTTP
       409; no previous company's line remained under the new company header.
     - `PASS` — fresh browser console had no errors or warnings.

9. The application runtime admits and displays only source-collected company
   observations and provider-origin Jev judgments. No synthetic generator or
   simulated judge is available to the app. Legacy simulation rows remain
   preserved in SQLite but are excluded from consumer APIs, aggregates,
   retry scheduling, and usage. Real source items without an authorized Jev
   judgment remain pending with their provenance and timing intact.
   - User/job: the researcher investigates actual, attributable observations
     without fabricated stories, fabricated sentiment, or synthetic counts.
   - Hard gates: the application has no demo/synthetic runtime or UI mode;
     ingestion rejects the reserved simulation collector; persisted legacy
     simulation rows cannot enter the tape, company views, Radar, counts,
     automatic or operator retry path, or provider usage; test fixtures never
     leave isolated test databases; the live UI displays real source URLs and
     quote provenance.
   - Evidence: focused database/API regression tests, live API readback from a
     fresh isolated database with Jev and optional credentials explicitly
     disabled, and browser selection of ADBE with Yahoo quote/chart provenance
     and real RSS/SEC mention rows; no runtime errors.
   - Proxy limit: this proves origin/provenance boundaries for the tested
     path. It does not resolve source/model-use rights, data completeness,
     quote accuracy, or Jev classification quality.
   - Current result: `PASS` — the post-restart isolated database held 1,361
     real observations (1,119 Google News RSS, 241 Yahoo Finance RSS, and 1
     SEC EDGAR), zero simulation observations, zero simulated judgments, and
     1,361 pending source-backed judgments. ADBE API rows retained real URLs;
     browser rows showed “awaiting judgment.” Jev was disabled with zero
     health failures and zero usage. See
     `project-record/4-log/2026-09-28-real-data-only-runtime.md`.

10. Every company-dependent result shown with the selected ticker stays bound
   to that company's identity and relevant window. Selecting a new company or
   window must not leave the prior company's outcome summary or mention cards
   under the new header while data loads or after a request fails. Cached data
   may appear only under its matching company/window; failed reads must be
   labeled rather than presented as an empty result.

   - User/job: the researcher moves between companies and trusts that the
     visible mentions and forward-reaction panel belong to the selected name.
   - Constraint: preserve per-company and per-window identity through pending,
     success, failure, and out-of-order response states; retain the existing
     per-company outcome refresh throttle without blocking a new company.
   - Assumption: a matching result cached for the same company/window may be
     shown while its refresh is pending; another company's result may not.
   - Hard gates: after switching between two tickers, mentions and outcome
     results match the selected company; a deliberately delayed earlier
     response cannot replace current content; failed and pending mention reads
     have distinct, truthful UI states.
   - Measure/evidence: click two tickers in the live local browser, inspect
     matching `/mentions` and `/reactions` API responses and visible labels,
     then delay an earlier response and verify it cannot change the active
     company's content. Proxy limit: proves client selection/data binding, not
     correctness of the reaction calculations or source completeness.
   - Failure cases: delayed prior-company response, a recent cached result
     followed by a company/window change, and mention request failure.
   - Subjective copy choice: pending/failure copy should explain missing data
     without implying that the company has no evidence.
   - Current-build hard-gate results (evidence:
     `project-record/4-log/2026-09-27-stock-chart-selection-fix.md`):
     - `PASS` — NVIDIA `/mentions` returned only `companyId=nvidia`,
       `/reactions` identified ticker NVDA, and the visible outcome heading
       matched NVDA.
     - `PASS` — changing 24H→6H requested NVDA `/reactions?hours=6` and kept
       the outcome heading bound to NVDA.
     - `PASS` — delayed Adobe `/mentions` and `/reactions` responses did not
       replace NVIDIA content; a delayed Adobe series carrying a distinctive
       0.99 sentinel also left the NVDA no-score chart unchanged.
     - `PASS` — a controlled mentions 503 showed the failure state, then a
       retry through the live local API returned 200 and cleared the failure.

11. A newly retrieved quote is never presented as current when its exchange
    observation time is materially old or unknown.
    - User/job: the researcher compares companies using prices with visible
      timing and provenance.
    - Constraint: retrieval time and exchange observation time remain
      separate; a successful network fetch does not refresh an older market
      observation.
    - Assumption: with quotes polled every 45 seconds, an observation older
      than 15 minutes is visibly aged; a missing observation timestamp is
      visibly unknown.
    - Hard gates: aged or unknown quotes show source age or unknown timing in
      the ticker tape, watchlist, and selected-company header. A cached delivery
      retains both its last retrieval age and its original source time.
    - Measure/evidence: fresh-start browser with actual provider data, selected
      company state, the quote API payload and UI labels. `quote-age.test.ts`
      verifies the 15-minute boundary and unknown-time copy. Proxy limit: the
      age label does not prove the provider's market-price accuracy or rights.
    - Current result: `PASS` — the live API returned an exchange observation
      at 2026-09-25 20:00:01 UTC and a retrieval on 2026-09-28; the rebuilt
      browser visibly showed “source 2d ago” for ADBE in ticker tape, watchlist,
      and selected-company header.

12. With no configured Jev key, newly collected real observations stay
    pending without a failed judgment, a fabricated default score, or repeated
    health failures. The desk still reports that scoring is disabled and
    source delivery continues independently.
    - User/job: the researcher can collect real evidence before configuring
      Jev, without confusing unavailable scoring with rejected or failed work.
    - Constraint: an absent scoring engine must never make a provider request,
      update a score-attempt status, or increment Jev failure counters.
    - Hard gates: real collector rows remain `pending` with no score/error;
      explicit disabled status remains visible; Jev request and usage counts
      stay zero; repeated delivery does not generate scoring attempts.
    - Measure/evidence: null-judge unit/API regression plus live keyless
      browser/API readback and health snapshot after a clean backend restart.
      Proxy limit: proves only the unconfigured-engine path, not Jev model
      quality or provider access rights.
    - Failure case: fresh pending items repeatedly cycle through a failed state
      or appear as Jev errors while the engine is disabled.
    - Current result: `PASS` — after the fix, the post-restart source database
      held 1,361 pending real judgments, Jev health was disabled with 0
      successes, 0 failures, and no last error, usage was zero, and real source
      deliveries continued. The null-judge regression verifies there is no
      score attempt or synthetic fallback. See
      `project-record/4-log/2026-09-28-real-data-only-runtime.md`.

13. A configured Jev credential alone never authorizes forwarding every stored
    publisher item. The runtime fails closed unless the operator explicitly
    configures an allowed collector set and a finite request budget; new
    observations, pending drains, retries, and recovery paths all enforce the
    same admission policy. The default allowlist is empty. No pending backlog
    drains on startup or by timer while no collector is admitted. Budget
    exhaustion leaves source evidence pending and visible, without fabricated
    failures. A source-specific admission setting is an operator assertion,
    not proof of legal rights; record the exact source basis and account-use
    authorization separately before a real-source Jev quality run.
    - Current source finding (2026-09-28): the SEC Webmaster FAQ states that
      public EDGAR filing content is free to access and reuse, and SEC website
      policy permits copying/further distribution without SEC permission.
      SEC fair access caps traffic at 10 requests/second across machines; the
      app paces one process at 8 starts/second. `SEC_USER_AGENT` is not
      configured in this checkout, so live SEC collection remains off. Google
      News RSS, Yahoo endpoints/publisher snippets, GDELT-linked publisher
      text, and optional X/Reddit/Finnhub content remain unapproved for Jev
      forwarding. TypeSafe's current MCA permits broad perpetual use of
      derived telemetry, including classifications, consumes credits per
      submitted input, and restricts using its service/output to develop a
      similar or competing service. The account owner must confirm that the
      intended app use, telemetry terms, and rejected-request billing are
      acceptable. Details are recorded in
      `project-record/3-project-specs/live-data-etl.json`.
    - Current result: `NOT RUN` — no real source content was sent to Jev.
      Real-source label quality, TypeSafe account authorization, telemetry
      acceptability, retention and billing, SEC User-Agent configuration, and
      non-SEC source rights remain unverified.
    - Admission implementation result (2026-09-28): `PASS` — Jev dispatch is
      off by default and requires a key, explicit collector allowlist, and
      finite per-UTC-day request/body-byte caps. A SQLite transaction claims
      the eligible real row and reserves its budget atomically; duplicate or
      hidden rows cannot spend budget. Retry, scheduled drain, and ingestion
      use the same admission rules. Hard maxima are 100 attempts and 400,000
      serialized input bytes per day. Tests cover default-off behavior,
      allowlist enforcement, concurrent claims, restart persistence, corrupt
      counters, and exhausted budgets. This implementation does not clear
      source rights or account authorization and no real source was sent.

### Real-source Jev evaluation contract (prepared; blocked before execution)

This is the frozen evaluation design for determining whether Jev's existing
per-item labels are reliable enough for the desk. Synthetic fixtures do not
enter this evaluation and cannot satisfy any of its gates.

- **Scope:** The first cohort is actual public SEC EDGAR filing observations
  from `sec_edgar`, limited to content covered by the documented EDGAR reuse
  policy and the application’s actual normalized Jev input. It evaluates
  company-specific `sentiment` and `event_type`, plus the existing `about` and
  `investor_relevant` inclusion boundaries. The result does not generalize to
  Google/Yahoo/GDELT publisher text, social feeds, other media, market impact,
  or investment performance. Add another source only after its exact rights
  and retention/model-processing path are documented and cleared.
- **Pre-run gates:** No source text is sent until the authorized account owner
  confirms the current TypeSafe agreement, permitted Sentiment Desk use,
  telemetry, retention, account limits/auto-refill, and rejected-request
  billing; any ambiguous similar/competing-product restriction is resolved.
  Configure a descriptive SEC User-Agent and keep the evaluation allowlist to
  `sec_edgar`. Confirm a request and spending ceiling against the account's
  current pricing/settings. The application's request/byte maxima are safety
  limits, not spending authorization. Keep label creation local; do not send
  source text to a second model or hosted grader.
- **Population and sampling:** Freeze a timestamped snapshot of eligible,
  source-backed SEC observations with source IDs, accession numbers, company,
  filing type, separate filing and acceptance times, collector/parser version,
  excerpt digest, and SHA-256 of the exact normalized Jev request body
  (`{model,state,questions}`). Deduplicate to the filing/company unit, group
  related observations by accession and issuer for sampling and uncertainty
  estimates, and document exclusions before model output is visible. Preserve
  provenance for every eligible filing plus the eligible and selected counts
  for each filing-type/calendar-quarter stratum. The evaluator verifies a
  deterministic SHA-256 rank sample within every declared stratum, using the
  frozen seed and no Jev scores. Run a blinded label-only pilot to estimate prevalence and
  reviewer disagreement. Then calculate the final sample size from the frozen
  decision, observed prevalence/variance, issuer-level dependence, class
  coverage, and the approved cost ceiling. Target 95% interval half-widths of
  at most 5 percentage points for overall exact agreement and 10 points for
  each class the release claim covers. Freeze sample IDs, random seed, rubric
  hash, analysis code, thresholds, and budget before any Jev output is opened.
  If the available corpus or budget cannot meet those precision targets, report
  the affected claims as `UNVERIFIED`, not as a pass. The blinded pilot may be
  included only if it follows the same sampling and labeling protocol.
- **Independent labels:** Two independent qualified human reviewers label
  each selected item while blind to Jev output. They use the fixed product
  rubric and the source material permitted for this study to label company
  relevance, investor relevance, directional business implication, and
  dominant event type. Do not use Jev or another model as a reviewer. Preserve
  both raw labels and short evidence-grounded rationales; adjudicate
  disagreements without deleting either original label. Report
  pre-adjudication reviewer agreement so weak or ambiguous ground truth is
  visible. Attach each label to the observation ID, accession, source URL,
  company, item/excerpt digest, exact request-body digest, separate filing and
  acceptance times, production `strictAbout` identity decision, labeler, and
  adjudication record.
- **Measures:** For sentiment and event type, report the complete confusion
  matrices, per-class precision/recall/F1, macro-F1, exact agreement, and
  comparison with a source-cohort majority baseline. Estimate intervals with
  resampling clustered by issuer/filing rather than treating syndicated or
  same-filing items as independent. For `about` and `investor_relevant`, report
  false-inclusion and false-exclusion rates at the unchanged production
  cutoffs, per item: `about >= 0.50` and `investor_relevant >= 0.35`, or
  `about >= 0.80` and `investor_relevant >= 0.50` for the strict ambiguous-
  identity path. For sentiment probabilities, report multiclass Brier score and
  reliability by confidence band; call calibration `UNVERIFIED` if support is
  too sparse. Report eligible-item completion, all terminal failures and
  unknown outcomes, request count, provider-reported tokens, latency, estimated
  cost, and the exact model/rubric/code/data digests. Provider token estimates
  are not an invoice. No aggregate may conceal a weak class or a missing
  source/time slice.
- **Decision rule:** Pass the scoped cohort only when both primary tasks have
  macro-F1 of at least 0.80 with a cluster-aware 95% lower confidence bound of
  at least 0.70; every claimed class has at least 0.70 precision and recall
  point estimates and enough support to meet its interval-width target; the
  cohort has at least 30 issuer clusters and each claimed class appears across
  at least 10 issuer clusters; and performance exceeds the majority baseline with a confidence interval that
  excludes no improvement. `about` and `investor_relevant` must each achieve
  at least 0.90 precision at the current production cutoff, with recall and
  class support reported. Any unrepresented class, failed privacy/rights gate,
  unexplained missing case, model/rubric mismatch, duplicate request, or
  unknown-outcome request without provider-usage reconciliation fails the
  release gate. Calibration is a separate claim and must not be called
  verified from accuracy alone. These thresholds evaluate a research-triage
  label, not a trading signal.
- **Stop and reporting:** Stop on unexpected data egress, a rights/account
  ambiguity, budget exhaustion, repeated provider errors, model/rubric drift,
  or an outcome-unknown request. Do not automatically replay unknown outcomes.
  Store a redacted, access-limited report in the project record with the frozen
  manifest digest and per-case terminal status; do not commit source excerpts,
  credentials, or account identifiers. A passing EDGAR cohort is a scoped
  result, not general Jev certification or completion of other source rights,
  coverage, or historical usage gates.
- **Current state:** `BLOCKED` — this design is prepared, but no real source
  text has been sent to Jev and no independent real-source labels exist.
  Current blockers and evidence are tracked in
  `project-record/3-project-specs/live-data-etl.json`.

### Offline evaluator implementation (2026-09-28)

`npm run evaluate:jev-labels -- --labels <local-json>` produces a blinded,
label-only pilot report. Add `--run <local-json>` only for a frozen `stage=final`
label set. The CLI reads local JSON only and makes no network, source, database,
or model calls. Its strict schemas reject raw source text and unrecognized
fields. A final run must join the exact label-artifact digest, sorted
provenance-manifest digest, rubric SHA, frozen code revision, item IDs, each
exact request-body digest, and analyzed model-run artifact digest. The label
set carries and hashes the complete provenance-only eligible population frame,
the sampling window, and per-stratum
counts; parsing checks that selected labels are a deterministic seeded sample
from that frame and cover every declared eligible filing-type/time stratum.
The manifest binds SEC CIK/accession/URL, filing and acceptance times,
collector/parser versions, excerpt digest, exact request digest, and the row's
strict-identity setting. The tool reports two-reviewer agreement before
adjudication, class prevalence, complete confusion matrices, missing outputs as misses, boundary precision and
recall, provider usage, costs as estimates, latency, and a per-case terminal
status ledger without copying rationales or source excerpts into the report.

Final labels must freeze an account-owner budget attestation before the sample
freeze: a maximum request count, maximum estimated USD cost, exact input/output
unit rates, approval time, and a digest of the approval record. The run must
match those rates; missing token usage leaves cost compliance `UNVERIFIED`, and
request or estimated-cost overruns fail. The local tool can validate the
attestation's shape and timing but cannot verify the underlying account-owner
approval or provider invoice. Each sampled observation permits at most one
submitted Jev request, so a second call after a response or rejection is
rejected during input validation.

The model-run digest identifies the exact analyzed JSON but does not
authenticate a TypeSafe receipt or independently verify the caller-supplied
scores and token counts. Preserve separately auditable provider records before
treating a classifier `PASS` as evidence about live Jev performance.

`about` and `investor_relevant` report the mixed-cohort results for context,
but the standard and strict-identity paths each have their own precision gate.
Each path needs at least 10 positive human labels across 10 issuer clusters;
otherwise that path stays `UNVERIFIED`. This prevents a strong standard-path
aggregate from hiding errors on ambiguous identities.

The final report uses 2,000 deterministic percentile-bootstrap replicates,
resampling issuer CIK clusters. Overall agreement needs a 95% interval no wider
than 0.10; class precision and recall intervals need widths no wider than
0.20. The 30-issuer overall and 10-issuer-per-class floors prevent degenerate
bootstrap samples from being presented as verified precision. The frame is a
provenance artifact, not proof that upstream SEC collection was complete; that
limit remains explicit in the report. The tool does
not auto-select a final sample size from the pilot: the issuer design effect,
eligible class coverage, account-owner-approved request/cost ceiling, and
available corpus must be documented and frozen before model output is opened.
Calibration remains descriptive because no calibrated-probability acceptance
threshold has been frozen. Even a scoped classifier `PASS` cannot clear rights,
account, retention, billing, User-Agent, source-coverage, or release gates.

## Phase 2 acceptance criteria

The first-release contract is frozen before implementation in
`opportunity-radar-acceptance.md`. It defines the current/prior windows,
publisher/headline proxies, every evidence field, missing-time behavior,
coverage status, hard gates, measures, scenarios, and subjective review points.
The implementation uses persisted Jev judgments and makes no second model
call. The contract's test, API, type, build, browser, and final isolated Compose
recovery gates passed.

## Independent readiness review and hardening gates

Three read-only reviewers completed a fresh pass after hardening. Their
separate qualitative ratings were 8.5/10 for source operations and overall
scoped readiness, 8.5/10 for local Jev implementation (7/10 for release
readiness), and 9/10 for UI/Radar. A later fresh-context Jev review rated
release readiness 7/10 after confirming the alias and synthetic integration
path; it kept real-source rights/retention and representative classifier
quality open. These are qualitative judgments, not a composite score or proof
of quality. The current checks directly verify:

1. Malformed Jev choice answers, invalid probabilities, and invalid token usage
   must fail closed; no default category or clamped probability may become a
   stored judgment. Keep the rubric and classifier identity unchanged.
2. Transient Jev exhaustion must have a bounded, persisted recovery path. Honor
   a valid provider `Retry-After` delay when present and otherwise use
   exponential backoff. Bad credentials and invalid model output must not
   retry forever; restart and recovery must not duplicate judgments or charges.
3. Scheduler shutdown must await in-flight collection before SQLite closes.
4. Radar evidence pagination must use the exact overview time and ingestion
   snapshot so page totals and groups cannot drift while the view is open.
5. The 390px company picker works with keyboard and assistive technology; the
   mention drawer traps focus, isolates the background, and restores focus on
   close.

The baseline issue on 2026-09-27 was an alias/version mismatch:
`jev-latest` was sent unchanged, TypeSafe returned `jev-1.13.0`, and the old
client rejected it. That repair is complete: the resolved model is persisted
and the isolated provider→SQLite→API→browser path passed. See
`project-record/4-log/2026-09-27-jev-alias-version-compatibility.md` for the
current evidence. This historical mismatch is not an open bug.

The remaining local operations gap is terminal-failure recovery. A failed
judgment must expose an operator-controlled retry that makes a new request only
after a clear acknowledgement that provider usage may be charged. An
outcome-unknown request is never automatically replayed; the UI must tell the
operator to check provider usage before authorizing another attempt. A duplicate
submission must not queue two requests. Do not retry corrupt stored judgments.

The live synthetic Jev integration smoke proves protocol compatibility and
storage/UI wiring only. A frozen, fictional case set will probe obvious
sentiment/event categories and the existing namesake/sector/consumer boundaries.
Retain every case result and report the exact resolved model, rubric hash,
case-set digest, code revision, usage, cost, latency, and failure state. These
synthetic cases are a sanity check, not representative real-source labels,
accuracy/calibration evidence, or an investment-quality claim. No real
publisher text is to be sent to Jev until its source rights and the account's
retention terms are reviewed. Release readiness also remains gated on provider
billing semantics and those source/account terms.

## 2026-09-28 continuation acceptance

### User, workflow, and constraints

The local researcher opens a failed mention, understands whether the provider
may have processed it, then decides whether to send one new Jev request. Jev
remains the only authority for per-item sentiment and event category. Keep the
rubric, post-rules, market-read-only behavior, no-license decision, and existing
source evidence unchanged. The evaluator uses only fictional synthetic items
in temporary SQLite and never reads or modifies `data/desk.db`.

### Hard gates

1. A retry is available only for a failed, non-corrupt judgment. It requires an
   explicit operator confirmation that each submitted Jev input consumes
   provider credits and a new request may consume another; for an
   earlier request that did not produce a saved score, the confirmation also
   requires a provider-usage review because 429/529 billing semantics are not
   documented. No UI or server path automatically retries an outcome-unknown
   request.
2. The server performs a single atomic failed→pending transition. Duplicate or
   stale retry requests cannot queue another call; retrying, scoring, scored,
   off-target, and corrupt rows cannot be requeued.
3. The normal persisted pipeline performs the authorized retry. Its resolved
   response model and rubric provenance remain visible. Provider rejection,
   unknown outcome, and recovery remain distinct after the request.
4. The frozen synthetic evaluation runs through the actual Jev client and
   persisted pipeline on a fresh temporary database. No case is silently
   skipped or replaced. It records per-case output and terminal status, exact
   response model, rubric SHA, source/case digest, code revision/dirty state,
   request count, tokens, estimated cost, latency, and errors without secrets.
5. Evaluation cases are all fictional and human-labeled before the first model
   result is read. They cover seven unambiguous in-scope directional/event
   cases plus three boundary cases: an ambiguous namesake, a sector-level item
   mentioning the company only in passing, and non-investor consumer coverage.
   Pass the synthetic sanity check only if all seven clear cases match both
   expected sentiment and event type, both out-of-scope cases score `about <
   0.5`, and the consumer item scores `investor_relevant < 0.5`. Report every
   label and boundary result separately. This ten-case synthetic pilot is not
   a production classifier-accuracy or calibration gate.
6. `npm test`, typecheck, production build, and the browser retry workflow pass;
   browser checks cover desktop, confirmation/cancel behavior, and
   outcome-unknown quarantine; the separate API tests cover duplicate
   submission and rejected-request recovery. Keep the retry panel within the
   viewport at 390px.

### Objective measures and limits

- Hard-gate completion is independent per item; one failed recovery or case
  cannot be hidden by an aggregate score.
- Report exact sentiment/event matches on the seven clear cases and separate
  pass/fail on the three boundary cases. The pilot informs whether a gross
  rubric or serving defect is present; its small synthetic sample cannot
  support claims about production accuracy, calibration, alpha, or real-world
  value.
- Record end-to-end latency and cost for the complete per-case run, including
  bounded retries. Do not rerun unknown-outcome failures.

### Representative failure/recovery cases

- An SSE judgment update for an already-loaded mention replaces the matching
  item in the tape, company list, and open drawer without changing other
  companies' rows.
- Retry confirmation cancelled: zero calls and the original failure remains.
- Two retry submissions race: at most one persisted transition and one new
  provider call.
- A prior unknown-outcome failure: no automatic resubmission; a new request can
  start only after the explicit usage-check acknowledgement.
- Any submitted request that ends without a saved score, including an explicit
  429/529 rejection, requires provider-usage review before a deliberate manual
  retry while billing semantics remain unverified.
- A new explicit 429/529 rejection: existing bounded retry semantics remain;
  terminal state and next operator action stay visible.
- A manually accepted retry that reaches the byte budget before dispatch stays
  pending and emits that persisted state to the desk's event listeners; no
  provider call is made for the over-budget input.
- A valid `Retry-After` delay: the persisted retry is not scheduled earlier
  than the provider's requested time; absent or malformed headers fall back to
  bounded exponential backoff.
- A company mentions response captured before a new Jev SSE event but returned
  afterward cannot replace the newer event in the company list.
- An initial tape snapshot captured before a new Jev SSE event but returned
  afterward cannot replace the newer event in the tape.
- Invalid output or malformed persisted judgment: score is withheld and a
  corrupt row has no retry control.
- Off-target/namesake and sector-only synthetic items remain separate from
  unambiguous sentiment/event cases; do not hide them in the aggregate.

### Subjective review point

Keep retry language calm and explicit in the current dark desk design. Show the
source and failure reason next to the control; make the charge warning clear
before the operator authorizes a new request.

### 2026-09-28 continuation gate status

- `PASS` — focused route/pipeline tests prove missing acknowledgement does not
  send a request, unknown and rejected submitted attempts require usage review,
  a successful acknowledged retry persists Jev's returned model, concurrent
  requests admit one retry, and scored/corrupt rows cannot be requeued.
- `PASS` — valid integer and HTTP-date `Retry-After` values are parsed;
  malformed values fall back to exponential backoff, and the persisted retry
  is not scheduled early.
- `PASS` — an isolated SQLite/API regression reproduces a manual retry whose
  exact serialized input no longer fits the remaining byte budget. The row
  stays pending, no additional Jev call is sent, and the SSE stream receives
  the persisted pending state so an open drawer does not retain its old failed
  view. A registered Hub listener receives the exact mention payload.
- `PASS` — loopback browser workflow used a temporary SQLite database and an
  in-process synthetic judge. Cancel left the failed item intact; after the
  two required acknowledgements, one request changed it to scored. The open
  drawer, company list, and tape showed the SSE judgment. Both a company-list
  response and the initial tape response captured before the SSE update were
  delayed for two minutes; after each stale snapshot arrived, the new score
  remained visible. A separate local API read returned HTTP 200 with the
  persisted `scored` judgment and `synthetic-jev-fixture` label. No external
  Jev call or real-source text was used in this browser check.
- `PASS` — 82 unit/API tests across 12 files, typecheck, and production build.
- `PASS` — Playwright browser at 390×844 opened the retry confirmation and
  completed one synthetic retry. The drawer fit within the viewport, document
  width remained 390px with no horizontal overflow, both acknowledgements
  gated Send, the resulting score appeared in the open detail drawer, and the
  console reported zero errors or warnings. The accepted local retry endpoint
  returned HTTP 202. Temporary SQLite and an in-process fictional judge only.
- `PASS — synthetic sanity only` — all ten frozen fictional cases reached a
  terminal state in ten requests. All seven clear direction/event labels and
  all three boundary thresholds passed; returned model was `jev-1.13.0` with
  the frozen rubric hash. The ledger is
  `project-record/4-log/2026-09-28-jev-synthetic-sanity.json`; this is not
  production accuracy, calibration, alpha, or release-readiness evidence.
- `OPEN` — non-SEC publisher rights for retention/display/model processing,
  TypeSafe account authorization/telemetry/retention and rejected-request
  billing semantics, configured SEC User-Agent, and representative
  real-source Jev quality are external release gates.

## Grounded architecture

The current flow is `server/schedule.ts` pollers -> `Pipeline.ingest` and
`Pipeline.scoreOne` in `server/pipeline.ts` -> SQLite in `server/db.ts` -> the
read-only API/SSE in `server/app.ts` -> `web/src/App.tsx` and its evidence
components. `server/rubric.ts` owns Jev's fixed contract. `server/scoring.ts`
validates that judgment and owns deterministic impact, weight, event strength,
exclusion, and index math.

At the starting baseline, the `mentions` row coupled source item and score,
cross-source titles were destructively merged, missing source times could be
filled locally, and startup could re-score completed judgments. The implemented
observation/judgment ledger, persisted delivery receipts, and read-only
compatibility projection remove those failure modes. The source design is
documented in `sentiment-desk-phase1-architecture.md`; Radar is a separate
Phase 2 consumer.

## Work phases

- [x] Read project records and compare them with current branch/code.
- [x] Trace source collection, Jev persistence/API, and dashboard workflow.
- [x] Confirm the user's phase order and Jev authority.
- [x] Compare the ledger and mention-row architecture options; choose the
  smallest Phase 1 design that keeps each source item attributable.
- [x] Fix item identity and time semantics; preserve score history without
  automatic rescore.
- [x] Record provider deliveries and expose delivery/freshness state.
- [x] Add meaningful regression tests and update README/project records.
- [x] Verify local keyless live data, Jev fixture behavior, desktop/mobile
  browser UI, and isolated Docker persistence. A later permitted synthetic
  provider smoke resolved `jev-latest` to `jev-1.13.0` and verified persistence
  and rendering; public-source-to-Jev remains unrun pending source/account
  rights review.
- [x] Freeze Phase 2 inputs and acceptance after the Phase 1 gate passed.
- [x] Build and verify Opportunity Radar over persisted judgment records.
- [x] Finish local hardening verification: 74 tests across 11 files,
  typecheck, production build, fresh browser pass, and isolated Compose
  live/recovery smoke.
- [x] Checkpoint the earlier Phase 1/2 reviewed implementation (`b9b6528`).
- [x] Checkpoint later chart reliability and Jev alias repairs
  (`a685c2a`, `4996759`) with evidence updates (`c4004cb`, `c636736`) to
  `origin/codex/real-data-rebuild`.
- [x] Add and verify acknowledged operator retry for failed judgments, while
  keeping outcome-unknown requests out of automatic retry; require usage review
  for submitted failures while rejected-request billing is unresolved.
- [x] Freeze ten human-labeled fictional Jev cases and a per-case isolated
  pipeline runner.
- [x] Run and record the ten-case synthetic Jev pilot; report every case
  without promoting it to real-source quality evidence.
- [x] Add saved-data-only production mode, verify stock selection and the
  sentiment/price chart against persisted records, and suppress failed-row Jev
  retry actions until external requests and Jev are confirmed enabled.
- [x] Record 156 passing tests, typecheck, production build, named browser
  network evidence, an independent retry-gating review, fresh-process
  saved-data-only startup proof, and the source-specific request allowlist.
