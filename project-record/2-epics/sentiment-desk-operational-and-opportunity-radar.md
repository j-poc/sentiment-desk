# Operational Sentiment Desk, then Opportunity Radar

Status: Phase 1 and the first supported-data Radar release are implemented and
verified; the authorized GitHub checkpoint is pending.

## Intent

Finish the current local Sentiment Desk before adding Opportunity Radar. The
desk is complete when a researcher can follow a real source item from public
collection through Jev's unchanged per-item sentiment judgment into the local
dashboard, understand source timing and delivery health, and recover the SQLite
service without losing history.

Jev remains the per-item sentiment and event classifier. Opportunity Radar was
built after the operational gate and compares Jev-scored observations already
in the local ledger. It preserves publisher identity, source clocks, opposing
directions, and coverage state rather than turning sentiment or source counts
into a claim of alpha.

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
