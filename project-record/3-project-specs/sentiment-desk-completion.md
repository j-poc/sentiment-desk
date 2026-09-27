# Sentiment Desk completion plan

Status: the local source-research workflow, isolated Compose recovery, and the
latest chart/company-binding checks pass. The documented TypeSafe alias
response is now accepted and preserved as `jev-1.13.0`; an isolated synthetic
observation passed through the live provider, SQLite, local API, and visible
detail drawer. This is not a 10/10 release: source-use/account-retention terms,
labeled classifier evaluation, and operator recovery of terminal Jev failures
remain open. The chart reliability checkpoint is on
`origin/codex/real-data-rebuild`; the current Jev compatibility work is being
checkpointed separately.

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
  live-data-first. Demo remains an explicit interface exercise.
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

1. Docker Compose builds and starts the checked-out application with synthetic
   mode off, and SQLite survives container recreation.
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
     - `NOT RUN` — a current public-source headline through Jev. Publisher
       model-use and account-retention rights remain unreviewed; the synthetic
       smoke proves integration only, not classifier accuracy or calibration.
3. A duplicate delivery does not create another Jev charge. Two independent
   source records with similar headlines remain separately attributable.
4. Missing publication or observation time is never replaced by retrieval
   time. The API and UI show source time separately from collection time.
5. Provider failure, malformed data, restart, and stale-but-successful
   delivery leave prior evidence intact and visibly degraded.
6. Desktop and narrow-screen flows let the researcher select a company, read
   the score/index, inspect the source and Jev rubric, and understand data
   health without hidden overflow or dead controls.
7. `npm test` (74 tests across 11 files), typecheck, production build, fresh
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
     current source timestamp, and stale/cache labels; never invent sentiment
     values or extend a window silently.
   - Assumption: a company with no completed Jev judgments is a supported
     state; unscored source evidence must not prevent price history or
     company navigation.
   - Hard gates: ticker control updates the company header and requests the
     matching `/series` and `/price`; no browser runtime error; empty Jev data
     produces an explicit no-score state while valid price data remains
     visible. No chart observations produces an explicit unavailable state.
   - Measure/evidence: browser click across at least two companies, matching
     API request/response and visible header, zero console errors, and chart
     state matching the returned arrays. Proxy limit: this verifies UI wiring
     and payload handling, not market-data accuracy or Jev quality.
   - Failure cases: all-null sentiment, stale but valid price history, failed
     chart request, and fewer than two drawable points.
   - Subjective copy choice: explain missing sentiment as “No Jev scores in
     this window” and retain source-age detail near the chart.
   - Current-build hard-gate results (evidence:
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

9. Every company-dependent result shown with the selected ticker stays bound
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
readiness), and 9/10 for UI/Radar. These scores are judgments, not a composite
product metric. They found strict-response validation, bounded transient
retry scheduling, shutdown, snapshot, and mobile interaction defects addressed.
The remaining terminal-failure operator-requeue gap is stated below. The
current checks directly verify:

1. Malformed Jev choice answers, invalid probabilities, and invalid token usage
   must fail closed; no default category or clamped probability may become a
   stored judgment. Keep the rubric and classifier identity unchanged.
2. Transient Jev exhaustion must have a bounded, persisted recovery path. Bad
   credentials and invalid model output must not retry forever; restart and
   recovery must not duplicate judgments or charges.
3. Scheduler shutdown must await in-flight collection before SQLite closes.
4. Radar evidence pagination must use the exact overview time and ingestion
   snapshot so page totals and groups cannot drift while the view is open.
5. The 390px company picker works with keyboard and assistive technology; the
   mention drawer traps focus, isolates the background, and restores focus on
   close.

One local operations gap remains: terminal Jev failures have no operator
requeue action. Ambiguous provider outcomes are deliberately not retried
automatically to avoid duplicate charges. Keep them quarantined until the
provider outcome has been checked; do not present this as a live-verified Jev
workflow.

An earlier isolated keyless verification had no Jev key configured, and its
offline provider-contract tests could not prove current live scoring. During
the 2026-09-27 local dashboard run, the server reported that a key was resolved
from its environment and new source rows surfaced this mismatch:
`expected jev-latest, received jev-1.13.0`. TypeSafe's current official API
reference says the alias resolves to a versioned model and that the response
reports the version that served the request
([Models](https://docs.typesafe.ai/models), [API reference](https://docs.typesafe.ai/api)).
The client currently treats that documented response as an unknown-outcome
failure and correctly avoids automatic replay. Repair and verify alias/model
provenance compatibility before claiming live Jev operation. A release-level
10/10 claim also requires labeled accuracy/calibration evaluation,
confirmation of provider 429 billing semantics, and review of source
display/model-use/retention terms.

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
  browser UI, and an earlier isolated Docker persistence smoke. Live
  source-to-real-Jev scoring stays pending when no key is supplied; the
  controlled real Jev fixture returned a valid `off_target` classification
  without exposing a key.
- [x] Freeze Phase 2 inputs and acceptance after the Phase 1 gate passed.
- [x] Build and verify Opportunity Radar over persisted judgment records.
- [x] Finish local hardening verification: 63 tests across 11 files,
  typecheck, production build, fresh browser pass, and isolated Compose
  live/recovery smoke.
- [x] Checkpoint the reviewed implementation and project records in commit
  `b9b6528` and push to `origin/codex/real-data-rebuild`.
