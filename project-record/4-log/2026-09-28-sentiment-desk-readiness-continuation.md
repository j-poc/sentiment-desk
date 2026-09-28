# Sentiment Desk readiness continuation — 2026-09-28

## Goal and scope

Continue the active Sentiment Desk completion goal on
`codex/real-data-rebuild`. Preserve Jev as the per-item sentiment/event judge,
keep Opportunity Radar downstream of the existing persisted evidence, and
checkpoint reviewed work to `origin/codex/real-data-rebuild`. No license,
hosting, provider enrollment, publication, or PR was added.

## Findings

- The drawer had no operator path to recover a terminal failed judgment.
- An existing mention's later SSE judgment was discarded from tape and company
  state; the drawer also kept its prior object. A company mentions response
  or initial tape response started before the SSE event could return later and
  overwrite the newer row.
- TypeSafe documents `Retry-After` support in its SDK guidance. The persisted
  client honored only the app's exponential delay.
- TypeSafe says submitted inputs consume credits, but the reviewed material did
  not establish whether HTTP 429/529 submissions consume them. Any submitted
  request without a saved score therefore requires a provider-usage review
  before a deliberate manual retry.
- The source-rights review is recorded in
  `project-record/3-project-specs/live-data-etl.json`. Publisher permissions
  for stored/displayed snippets and external model processing, applicability
  of Yahoo API terms to the exact endpoints, SEC text-use policy, optional-feed
  plan rights, TypeSafe retention configuration, and rejected-request billing
  remain open. The controlled synthetic smoke and frozen pilot used fictional
  inputs only. A separate legacy process was later found with 3,339 Jev
  failures; its historical request payloads and provider usage were not
  inspected, so their contents and billing outcome are unknown. See
  `2026-09-28-legacy-runtime-and-demo-preview.md`.

## Changes

- Added `POST /api/mentions/:id/retry` with strict confirmation, atomic
  failed-to-pending transition, one accepted request under a race, and guards
  against retrying non-failed/corrupt/scored rows.
- Persisted a flag requiring usage review whenever a submitted provider
  request ends without a saved judgment. Interrupted in-flight migrations now
  fail closed and require the same review.
- Added an accessible, two-acknowledgement retry panel to the drawer. Unknown
  or otherwise unscored provider attempts require a usage check; all retries
  disclose the possibility of additional credits. Cancel leaves the item
  failed and makes no request.
- Added `Retry-After` delta-seconds and HTTP-date parsing; the saved delay is
  the greater of the provider delay and existing bounded exponential backoff.
- SSE events now replace matching rows in tape, cached company lists, and an
  open drawer. A later HTTP response preserves any SSE event that arrived
  after that request began. The streamed-item map is bounded to 500 IDs.
- Froze ten fictional labeled cases in `scripts/jev-sanity-cases.json` and
  added `npm run verify:jev-sanity`; each case uses its own temporary SQLite
  database and the actual Jev client/pipeline. No model result has been read
  yet. The runner records all cases and limits cost claims to provider-reported
  tokens.
- Added `npm run verify:retry-browser`, an isolated loopback workflow using a
  fictional item and an in-process fake judge; it never opens `data/desk.db` or
  sends a request to TypeSafe.

## Test-first and verification evidence

- Initial focused tests failed as expected: operator retry returned 404 before
  the route existed, while `Retry-After` was not parsed or persisted. After
  implementation the focused retry/Jev/pipeline tests passed.
- On a fresh loopback app, the browser showed the prior provider failure and
  both acknowledgements, kept Send disabled until both were checked, and
  preserved the failed status after Cancel. After authorization, one synthetic
  request persisted a positive/product score and the open drawer updated from
  SSE. The visible app then showed the same judgment in the company card and
  tape.
- For the stale-response race, the first company mentions response captured
  the failed state and was held for 120 seconds. The retry then produced a
  newer scored SSE event. After the delayed response completed, the company
  card still displayed the SSE score. A direct read of the local mentions API
  returned HTTP 200 with `status=scored`,
  `model=synthetic-jev-fixture`, and `usageCheckRequired=false`.
- These browser data and model labels are synthetic; the app ran with one
  temporary SQLite database and an in-process fake judge, with no external
  Jev or market-data requests.
- A second race pass delayed both the initial `/api/tape` response and company
  mentions snapshot by 120 seconds. Each older failed snapshot returned after
  the SSE judgment; the corresponding tape/company card still showed the
  scored event. The fixture runner completed graceful shutdown and reported
  `PASS`, one fake call, and final status `scored`.
- At 390×844, Playwright showed the retry panel inside the viewport with no
  horizontal document overflow (`innerWidth=390`, `scrollWidth=390`). Send
  remained disabled until both acknowledgements were checked; the one local
  retry returned HTTP 202 and the drawer rendered the synthetic positive /
  product result. The browser recorded zero console errors or warnings. The
  run used the fictional item, temporary SQLite, and an in-process judge.
- `Retry-After` tests cover integer seconds, HTTP-date, malformed headers, and
  persistence of a not-early retry time. Route/pipeline tests cover unknown
  outcomes, rejected provider inputs, missing acknowledgement, duplicate
  submissions, stored recovery, and non-retryable scored items.
- `npm test -- --reporter=dot` passed 82 tests across 12 files; typecheck and
  production build passed. Vite emitted only the existing main-chunk-size
  advisory.
- The exact 390px retry-panel browser workflow passed as described above.

## Evaluation and handoff

The ten-case run is separate from the browser fixture. Before dispatch, the
frozen input file had 10 cases and SHA-256
`733669851a6890f2d748a833b29727fe6c9264c3ce3e49ef0672f94507ac8a97`. Source
code was checkpointed at `2f70bb1f8e48db1acbab0f77c82df1538bf402a7`; a
documentation-only dispatch checkpoint `f523e51ac12b85493d8f95e22f41c972c5a24586`
was pushed before the run. The evaluation used that exact revision with no
tracked source changes. A prior one-request synthetic provider smoke and the
fictional retry browser workflow are the end-to-end smoke evidence; no
publisher text is in scope.

Stop conditions: the pipeline may automatically retry only explicit HTTP
429/529 rejection within its bounded three-attempt policy; it does not replay
transport, generic 5xx, malformed-output, or model-mismatch unknown outcomes.
Each case has an eight-minute terminal budget. The runner stops dispatching
after three errors with the same HTTP status and writes the fixed ten-case
denominator, including cases not run after that stop. If interrupted, inspect
the report and provider usage before any new dispatch; never silently restart
or replay a case whose prior outcome is unknown. Record the per-case ledger,
request count, resolved model, rubric SHA, case digest, code revision/dirty
state, reported tokens, estimated cost, latency, and terminal state.

Do not represent this small pilot as classifier accuracy/calibration, alpha,
or release-readiness evidence.

### Jev synthetic sanity result

`npm run verify:jev-sanity` completed as run
`jev-sanity-2026-09-27T23-46-51-479Z`. The saved per-case ledger is
`project-record/4-log/2026-09-28-jev-synthetic-sanity.json`.

- `PASS_SYNTHETIC_SANITY_ONLY` — all ten cases were terminal with ten requests;
  no automatic or repeated request was needed.
- The seven clear cases matched both expected sentiment and event type (7/7).
  The namesake and sector-only cases each passed `about < 0.5`; the consumer
  trivia case passed `investor_relevant < 0.5` (3/3 boundaries).
- Each successful response identified `jev-1.13.0` and rubric SHA
  `a88fad772230c65f38104cf5934dc7b81e4201b8fcc4ee2876f63d7eeb830c7e`.
  The case-file digest matched the frozen SHA above; the report identifies
code revision `f523e51ac12b85493d8f95e22f41c972c5a24586`, with no tracked
source changes. This describes the frozen synthetic pilot only; a separate
legacy process was later discovered and its submitted payloads were not
audited.
- Provider-reported usage was 19,253 input and 3,835 output tokens. At the
  configured input rate the estimated input cost is USD 0.000808626; this is
  not an invoice or confirmation of provider billing. Successful responses
  took 234–370 ms.
- All data were fictional and isolated per case in temporary SQLite. This
  small sanity pilot does not establish real-source accuracy, calibration,
  publisher rights, provider retention/billing terms, alpha, or investment
  quality.

Local hardening is not equivalent to 10/10 release readiness. Rights,
retention, rejected-request billing, real-source labeled quality, and the
source coverage gaps remain separate gates.

## Autonomous continuation after checkpoint 13dd3b9

### Completed local safeguards

- `PASS` — GDELT stops its current company sweep on the first HTTP 429 and
  persists a source-wide cooldown across restarts. It honors `Retry-After`,
  otherwise uses bounded exponential backoff, creates no synthetic delivery
  during cooldown, and clears the failure state after a successful resumed
  request. Deterministic tests cover sweep termination, restart, expiry,
  recovery, corrupt stored cooldown, and backoff limits.
- `PASS` — Jev stays off unless a key, explicit per-source allowlist, and both
  finite UTC-day budgets are configured. Ingestion, pending drains, retry
  scheduling, and operator retry enforce admission. The maximum is 100
  request attempts and 400,000 serialized input bytes per day. Budget
  reservation and row claiming are atomic; exhausted or corrupt budgets fail
  closed and keep real evidence pending. No provider request was made.
- `PASS` — SEC EDGAR stays disabled unless `SEC_USER_AGENT` contains contact
  information within the configured length bound; no generic fallback remains.
- `PASS` — full local verification after these changes: 106 tests across 18
  files, TypeScript typecheck, production build, and `git diff --check`.
- `ADVANCED, STILL GATED` — the SEC Webmaster FAQ explicitly says EDGAR public
  filing content is free to access and reuse; SEC website terms also permit
  copying/further distribution without SEC permission. This gives the desk a
  narrow source basis for a public-EDGAR evaluation, with filing-content
  exceptions, marks, User-Agent, fair-access, and non-endorsement limits still
  observed. The SEC allows no more than 10 requests/sec across machines; this
  app paces each process at 8 requests/sec, while cross-process coordination
  remains unproven.
- `BLOCKED ON EXTERNAL AUTHORITY` — before sending even eligible public EDGAR
  text to Jev, the authorized TypeSafe account owner must review the MCA updated
  2026-09-23, account limits/auto-refill, telemetry scope, retention, and
  rejected-request billing. The MCA says each submitted Input consumes credits
  and permits broad perpetual use of telemetry, including classifications and
  summary statistics, to improve TypeSafe products; the privacy policy's
  no-input-training statement does not remove those separate terms.
- `BLOCKED ON SOURCE RIGHTS` — Google News, Yahoo Finance, GDELT-linked
  publisher content, Finnhub, Reddit, and X do not have documented permission
  in the current records for this app's storage/display/model-forwarding path.
  No publisher text will be sent to Jev while this remains unresolved.
- `NOT RUN` — real-source classifier quality. The 96-case, two-reviewer,
  development/holdout proposal from the current Jev audit is planning evidence
  only; no real items were sampled or dispatched.
- `DEFERRED` — no new Opportunity Radar work until the operational desk,
  source admissions, and real-source Jev quality gates pass.

### Findings and boundaries

- `source_rights_audit` and a fresh official-page review confirm the SEC's
  public-EDGAR reuse basis and 10 requests/sec aggregate fair-access cap.
  The TypeSafe MCA currently posted as of 2026-09-23 adds a broad perpetual
  telemetry grant and says each submitted Input consumes credits. No real
  source text was sent. The source-by-source terms, account questions, and
  permitted SEC-only path are recorded in
  `project-record/3-project-specs/live-data-etl.json`.
- `jev_readiness_audit` confirmed the app presently drains up to 5,000 pending
  records at startup and drains again every 15 seconds when a TypeSafe key is
  present, with a default concurrency of six. Do not set that key in the live
  environment or invoke the real pipeline as a test. Existing tests and
  isolated fictional fixtures remain available for code-path verification.
- The expanded gates were added to
  `project-record/3-project-specs/sentiment-desk-completion.md` before
  implementation. The local GDELT cooldown and Jev admission implementation
  gates now pass; real-source quality, source rights/account authorization,
  and historical provider-usage reconciliation remain unrun or externally
  blocked.

## Current checkpoint result

The real-data admission and GDELT cooldown checkpoint was pushed as `58f6ba1`
to `origin/codex/real-data-rebuild`. This continuation records a second,
read-only collector audit and the follow-up rate-limit fixes. The UI/chart
workflow and real-data-only
runtime also passed a fresh production-build browser smoke at
`http://127.0.0.1:8794/`. A SQLite backup of the verified real-only database
was used so the existing application database stayed untouched. The UI showed
real pending source rows, and selecting Adobe updated the company and drew its
real Yahoo 7D price history. The weekend 24H window remained empty. The
isolated database contained 2,281 source-backed observations (1,933
`google_news_rss`, 347 `yahoo_finance_rss`, and 1 `sec_edgar`), zero
`demo_simulation` observations, 2,281 pending judgments, and 1,604 real price
points. GDELT reported HTTP 429 and its persisted cooldown remained visible;
Google News RSS, Yahoo Finance RSS, and Yahoo quotes delivered during the
smoke. The temporary server was stopped after verification to avoid continued
polling. Jev was explicitly disabled, all model usage remained zero, and no
real-source text was sent to Jev. Optional X, Reddit, Finnhub, and SEC
collectors were disabled for this smoke. No demo or synthetic observations
were introduced into the application.

The targeted code tests made no provider calls. The separate browser smoke
above intentionally exercised the live public-source UI path; its counts and
outcomes are limited to that temporary database and date.

## Follow-up: provider rate limits and request fanout

An independent read-only review of the checked-out collector paths found a
rate-limit retry risk beyond GDELT. Before the follow-up, the default RSS
poller could issue 48 requests every 30 seconds with four concurrent workers;
HTTP 429s did not stop the current feed rotation. Yahoo quote requests retried
429s after two seconds without using `Retry-After`, quote/chart share the same
provider, and simultaneous identical chart cache misses could duplicate
requests. SEC primary documents had no spacing within one company's filings.
Optional Finnhub, Reddit, and X collectors stopped or paced inconsistently
after rate limits.

The follow-up implementation now:

- Adds durable provider-level cooldown state with `Retry-After` support,
  bounded exponential fallback, a one-day upper bound, restart persistence,
  corrupt-state fail-closed behavior, and protection against an older
  in-flight success clearing a newer 429 cooldown.
- Paces request starts per provider. RSS defaults to a three-minute cadence
  with two workers; Google and Yahoo requests are at least one second apart.
  Quotes default to 90 seconds and Yahoo chart/quote requests are at least
  500ms apart. SEC requests are at least 125ms apart. These are application
  controls, not proof of provider quotas or permission.
- Stops only the rate-limited provider's current sweep. RSS, Yahoo quote/chart,
  SEC, Finnhub, Reddit, and X do not keep issuing requests after the first 429;
  unrelated providers in the RSS cycle may continue. No synthetic success or
  delivery receipt is created for a cooldown skip.
- Removes the immediate Yahoo retry, honors Yahoo `Retry-After`, shares a
  provider cooldown between its RSS and chart endpoints, pauses chart
  backfill while the provider is cooling down, and coalesces simultaneous
  requests for the same ticker/window.

Focused regressions cover RSS isolation, Retry-After parsing, cooldown across
a SQLite reopen, corrupt stored state, all credentialed poller sweep stops,
Yahoo quote/chart behavior, duplicate chart-request coalescing, and preserving
the longest cooldown deadline when overlapping 429 responses complete out of
order. Full local verification passes 121 tests across 21 files, TypeScript
typecheck, production build, and `git diff --check`. These tests use mocks; no
provider was contacted for this follow-up. The remaining release gates are
unchanged: source/model-use
rights, TypeSafe account and retention/billing settings, labeled real-source
Jev quality, exhaustive coverage, and historical legacy-usage reconciliation.

The final independent read-only review confirmed the overlapping-429 fix and
found no remaining actionable defects in the audited collector changes. The
focused reviewer reran the cooldown, poller, RSS, market/coalescing tests,
typecheck, and diff check successfully. No external provider or model was
called for this review.

## Fresh rights-policy evidence and next gate

A direct read-only review of current official pages refined the source gate:

- The SEC Webmaster FAQ says EDGAR public filing content is free to access and
  reuse. SEC website dissemination terms also permit copying/further
  distribution of sec.gov information without SEC permission, subject to the
  stated exclusions and SEC mark/non-endorsement restrictions. The SEC fair
  access page sets a 10 requests/second aggregate cap across machines; this
  app spaces starts by 125ms (8 per second) within each process. It does not
  coordinate across multiple processes.
- `SEC_USER_AGENT` is absent from the current local environment, so no live SEC
  request was made. SEC collection stays disabled until the operator configures
  a descriptive identifier and contact email.
- TypeSafe's current MCA is marked updated 2026-09-23. It says each submitted
  Input consumes credits; account settings control consumption and automatic
  refills. It grants TypeSafe service-processing rights during the term and
  perpetual processing of Customer Data to derive Telemetry, defined to
  include hashes, summary statistics, classifications, metrics, and learnings
  that TypeSafe may use without restriction to improve its services. The
  privacy policy says Inputs are not used for model training/fine-tuning, while
  describing reasonably necessary retention and U.S. hosting. The MCA also
  restricts using Services or Output to develop a similar or competing product
  or service; whether the intended private Sentiment Desk use fits the account
  terms requires confirmation. API docs describe 429/529 retries but do not
  establish free rejected requests.
- This narrows the potential evaluation source to public EDGAR content but
  does not authorize use of a TypeSafe account. Before the first real Jev
  request, the authorized account owner must confirm the current agreement,
  account/credit and auto-refill settings, telemetry acceptability, retention,
  rejected-request billing, and whether the app's intended use is within the
  similar/competing-product restriction. Other publisher feeds remain
  unapproved for model forwarding. No real content was transmitted.

Primary sources: SEC [EDGAR reuse FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions), [website dissemination policy](https://www.sec.gov/about/privacy-information), and [developer fair-access guidance](https://www.sec.gov/about/developer-resources); TypeSafe [MCA](https://typesafe.ai/legal/mca), [privacy policy](https://typesafe.ai/legal/privacy-policy), and [API errors](https://docs.typesafe.ai/api). Detailed source-by-source findings remain in `project-record/3-project-specs/live-data-etl.json`.

## Real-source Jev evaluation protocol prepared

The completion spec now contains a frozen SEC-only evaluation design covering
the sampling frame, filing/issuer clustering, blinded two-reviewer labels,
provenance, sample-size precision targets, quality and calibration measures,
release thresholds, cost limits, stop conditions, and scope limitations. The
plan evaluates the fixed product rubric only on authorized real EDGAR inputs;
no generated fixtures enter its label set and no additional model or hosted
grader receives source text. Its target is honest source-scoped research triage,
not investment performance.

The evaluation remains `BLOCKED`, not passed: no real content or labels exist,
`SEC_USER_AGENT` is absent, and the TypeSafe account owner has not verified the
current account/use terms or approved the spend ceiling. The manifest cannot be
finalized until a label-only pilot estimates real class prevalence and reviewer
disagreement; final sample IDs and size must then be frozen before Jev output is
seen. A successful EDGAR cohort would not clear publisher/social-source rights,
source coverage, or historical usage reconciliation.
