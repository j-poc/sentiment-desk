# Operational Sentiment Desk, then Opportunity Radar

Status (2026-09-29): The whole-build detector review found a missing saved-feed
recovery path and stale phase-gate records. Server-side filter pagination and
all-history recovery for pending/failed judgments are implemented and being
verified; current outcome is recorded in
`project-record/4-log/2026-09-29-engineering-bullshit-detector-review.md`.
Opportunity Radar code exists from earlier work, but Sentiment Desk operational
gates have not passed. Do not expand or promote Radar until they do.

Historical checkpoint: Sentiment Desk comparison-empty-state, watchlist-sort,
usage, provider-integrity, and reaction-measurement hardening was
checkpointed at `76b46c2` on `origin/codex/real-data-rebuild`, after `2a0f199`.
Outcome windows require a post-publication baseline, timely endpoint prices,
and a matured horizon; four-hour-only data cannot inflate the 30-minute
hit-rate denominator, and watchlist-wide correlation is labelled exploratory
and unclustered. The company endpoint aggregates all eligible events while
the UI discloses its eight displayed examples. Collectors preserve raw provider
row counts and distinguish clean empty, partly malformed, and unusable results;
repeated X pagination, missing SEC CIK mappings, malformed SEC/Yahoo responses,
durable Finnhub history retries, atomic earnings-cache replacement, and health
disclosure have regression coverage. Top Movers distinguishes
unscored companies from scores without a comparison baseline; the watchlist
falls back to alphabetical order and disables movement sorting when every
company delta is null.
Verification passed 208 tests across 27 files, typecheck, production build,
and the offline startup/request-gate probes. The refreshed saved-data browser
check selected AMD from the watchlist, showed its persisted sentiment/price
chart, `30m n=41`, `4h n=7`, `hit 37%`, and `top 8 of 41 measured items`.
Watchlist readback showed 736 timely 30-minute prices among 2,732 items and
item-level rank IC 0.032, descriptive only. External requests were paused.
This remains a local
checkpoint, not live-source, account-authority, rights, or real-source Jev
quality proof. Those gates remain open. Do not expand or promote Opportunity
Radar until the Sentiment Desk gates pass.

## Intent

Finish the current local Sentiment Desk before adding Opportunity Radar. The
desk is complete when a researcher can follow a real source item from public
collection through Jev's unchanged per-item sentiment judgment into the local
dashboard, understand source timing and delivery health, and recover the SQLite
service without losing history.

Jev remains the per-item sentiment and event classifier. The initial Radar
implementation followed an earlier local Desk gate and compares Jev-scored
observations already in the local ledger. Later account, source-rights, and
real-source-quality gates remain open, so do not expand or promote Radar now.
Its design preserves publisher identity, source clocks, opposing directions,
and coverage state rather than turning sentiment or source counts into a claim
of alpha.

## Scope

Phase 1 closes the live-data, identity, timing, health, storage, and dashboard
gaps. The first Phase 2 release compares event-category counts across equal
company windows, groups exact-normalized headline copies, and lets the user
inspect every publisher row, counter-direction, timestamp, and delivery state.
It adds no second AI classifier. Both phases remain local and single-user.
Provider enrollment, paid feeds, hosted deployment, and source-code licensing
are not included.

Broader behavioral convergence, market-structure inputs, search trends,
app-store reviews, hiring signals, and named second-order suppliers remain
future work until their data contracts and rights are verified.

## Handoff

See `project-record/3-project-specs/sentiment-desk-completion.md` for Phase 1
acceptance and `project-record/3-project-specs/opportunity-radar-acceptance.md`
for the Radar contract. Verification outcomes and current provider gaps are
recorded in `project-record/4-log` and
`project-record/3-project-specs/live-data-etl.json`.
