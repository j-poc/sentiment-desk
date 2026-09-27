# Sentiment Desk completion plan

Status: local implementation and keyless verification pass, including the
latest isolated Compose live-data and persistence checks. This is ready for the
scoped local workflow, but it is not a 10/10 release: live current-item Jev
scoring, source-use terms, and labeled classifier evaluation remain unproven.
Latest hardening changes are being checkpointed to `codex/real-data-rebuild`.

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
3. A duplicate delivery does not create another Jev charge. Two independent
   source records with similar headlines remain separately attributable.
4. Missing publication or observation time is never replaced by retrieval
   time. The API and UI show source time separately from collection time.
5. Provider failure, malformed data, restart, and stale-but-successful
   delivery leave prior evidence intact and visibly degraded.
6. Desktop and narrow-screen flows let the researcher select a company, read
   the score/index, inspect the source and Jev rubric, and understand data
   health without hidden overflow or dead controls.
7. `npm test` (63 tests across 11 files), typecheck, production build, fresh
   keyless local start, 390px and 1280px browser passes, accessible mention
   drawer interaction, SSE shutdown, and isolated Docker persistence smoke
   pass. The source-data contract records what these checks prove and what
   remains unavailable.

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

The current checkout has no Jev key configured. Offline provider-contract
tests can prove validation and bounded retry behavior, but cannot prove that a
current headline is scored by the live Jev service. A release-level 10/10 claim
also requires a labeled accuracy/calibration evaluation, confirmation of
provider 429 billing semantics and model/output compatibility, and review of
source display/model-use/retention terms. Those external proofs are not
available in this checkout.

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
- [ ] Checkpoint the reviewed implementation and project records on the
  existing GitHub branch.
