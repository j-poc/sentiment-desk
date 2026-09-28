# Operational Sentiment Desk, then Opportunity Radar

Status (2026-09-29): the repository contains the earlier local Desk and Radar
implementations, but Sentiment Desk is not yet externally operational or
release-ready. Local hardening is checkpointed at
`485490d` on `origin/codex/real-data-rebuild`. X and Reddit pagination resumes
from persisted query-matched cursors; X advances its committed post ID after
the page chain completes. GDELT raw-cap saturation is visible as partial
coverage, and Finnhub news/Yahoo index receipts are isolated from unrelated
company health. Verification passed 175 tests, typecheck, production build,
and the fresh-process no-network/collector-allowlist probes. Source/account
authority, real label quality, legacy-use reconciliation, and exhaustive
coverage remain open.
Do not expand or promote Opportunity Radar until the Sentiment Desk gates pass.

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
