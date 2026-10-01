# Investor/UI review and gate refresh — 2026-09-30

Trace ID: `TRACE-20260930-investor-ui-review-and-gate-refresh`

## Request

The user asked independent investor and UI reviewers to score the build and
asked for fixable gaps to be improved. The continuing product objective is the
full Sentiment Desk real-data-only goal in
`project-record/3-project-specs/sentiment-desk-completion.md`; this UI pass does
not narrow or complete that goal.

## Independent reviews and fixes

Fresh scores are separate reviewer scopes. The investor reviewer scored the
saved-data evidence workflow **8.8/10** and live research readiness **2/10**.
The UI reviewer scored hierarchy **8.5/10**, chart interpretation **9/10**,
discoverability **8.5/10**, responsive/mobile **8/10**, and accessibility
**8.5/10**. The current whole-build engineering-bullshit-detector review
independently drove the app and scored the saved-data UI **8.5/10**, evidence
workflow **8/10**, and live research readiness **2/10**. It found no
reproducible local defect in the inspected paths. These rubrics are not
combined; none establishes 10/10, and no investor task study or
assistive-technology session has been run.

The requested GPT-6.1 Sol advisor worked at extra-high effort and found no
additional UI change justified by current evidence. It highlighted that the
sequential index is order-sensitive by design: equal-weight +100 then −100
events differ from the reverse order. This is an analytical validation
question, not grounds to smooth the series without investor and real-label
evidence.

Current parent and independent browser checks showed the fixed scale, modeled
decay, 15-minute record-count pane, repeat disclosure, stale-data labels,
keyboard source drilldown, and honest empty price state. Parent-rendered
1280×720 Adobe 7D showed 58 scored records in 23 buckets, latest source/score
about 2 days old, zero new source rows in 24h, and no saved lineage-eligible
Yahoo points. The whole-build reviewer selected Adobe 3D, inspected 20 buckets,
opened the keyboard table and exact seven-record source bucket, and confirmed
those historic rows were not linked to source delivery receipts. The preview at
`http://127.0.0.1:8797/` uses an isolated copy of the real saved database with
external requests and Jev disabled. This is rendered saved-data evidence; it
does not establish live Jev quality, rights, or investor task value.

This continuation preserves separate latest-collection and latest-score
freshness when the current interval has no new rows, adds an aligned record-
arrival histogram without changing the fixed index scale, and extends keyboard
inspection with source time, collected time, currency, and price. Jev/price
loading, failure, and confirmed-empty states remain distinct, including
price-only comparison. Focused regressions cover these conditions. The
watchlist also names the age of the latest saved source record when its 24-hour
count is zero.

The final review pass fixed two additional investor-facing clarity gaps. The
MentionDrawer now shows reported publisher and domain separately from the
collector and saved-link host, explains that source attribution is not
independently verified, and labels Google News URLs as results. A regression
uses a Reuters publisher attribution alongside a `news.google.com` collection
link. EvidenceBreadth now warns prominently that counts describe only the
loaded rows, not the full window, when an older page exists. These changes make
source identity and the denominator inspectable without presenting either as
stronger evidence than the saved record supports.

The whole-build audit also found an RSS provenance defect affecting 4,349 of
4,349 local Google News observations: publisher labels varied across 673 names,
but the saved domain was always `news.google.com`. New RSS parsing now takes the
publisher domain from the feed's `<source url>` metadata, falling back to a
non-aggregator item-link host only when appropriate. The adapter version moved
to `/3`; historical observations remain immutable and their aggregator domain
is masked from research DTOs and Radar evidence. Jev receives the collection
URL separately from publisher identity, and the credibility rubric now tells
it to treat those fields as attribution rather than independent verification.
The rubric hash changes with that instruction. No live Jev call was made; a
real-source evaluation remains required before treating the new contract as
validated.

This continuation fixed two review-confirmed defects in the new
similar-title inspector:

- The related-row metric used the cumulative candidate time span while its
  label said “anchor-pair”. It now computes and displays the exact span between
  the anchor bucket and that title bucket. A regression covers a 15-minute
  pair span inside a 90-minute full candidate span.
- An accessibility test expected obsolete button wording and failed. The button
  now identifies the publisher in its accessible name and keeps the title,
  domain, collector, time basis, Jev class, and impact available to assistive
  technology; the test now exercises that current label.

The final comment audit found one stale description of `processingRequired`.
Yahoo quote and chart flows also pass price points through domain-specific
processors. The comment now describes that shared contract without limiting it
to source-observation ingestion. The audit found no added TypeScript, ESLint,
coverage, or formatting suppressions.

The earlier visual defects remain fixed: the watchlist no longer mislabels the
`J/K` company-navigation keys as sorting, the narrow layout has a configured
company picker, Top Movers reports impact points, and future quote timestamps
warn consistently across the header, watchlist, and ticker.

The whole-build engineering reviewer returned **FAIL for operational
readiness**: it scored the saved-data UI 8/10, investor workflow 4/10, and
operations 2/10. It confirmed two code defects during review, both fixed in
this continuation:

- The watchlist sort control displayed `J/K` even though those keys select the
  previous or next company. The false badge was removed, and `J/K nav` is now
  labeled separately beside the watchlist.
- The narrow layout hid the desktop watchlist and offered no discoverable
  company picker. A labeled native picker now lists the configured companies,
  reflects selection, and calls the same company-selection state path.
- The Top Movers caption called a weighted-mean difference “index pts”; it now
  says “impact pts”, consistent with the main research view.
- A future provider timestamp could pass as fresh in the selected-company
  header. `quoteSourceAgeLabel` now returns a future-time warning used by the
  header, watchlist, and ticker. The watchlist no longer carries separate
  future-time logic.

The narrow-picker tests cover the accessible label, configured company
options, current selection callback, responsive class and explicit empty
state. They do not establish a full browser-driven refresh of chart and feed.
`tests/quote-age.test.ts` covers a source timestamp ahead of `now`. No
dependency was added.

The engineering contract validates against the gate's 120-second per-check
limit. It declares ignored `data/` as mutable runtime data so the local SQLite
history is excluded from source fingerprinting and from the checkpoint. The
native alignment map is present, but the whole-build objective remains
unaccepted while the account, real-source Jev, and investor-validation evidence
is missing.

The similar-title inspector reads only loaded scored rows with identified
collectors. Exact headline repeats are partitioned into full spans no longer
than six hours; non-identical titles require three shared content terms and
unrounded Jaccard overlap of at least 40%. Every candidate's entire record span
must remain within six hours. Unknown-provenance rows are excluded. It shows
publisher labels, domains, collectors, record-time basis, sentiment/impact
disagreement, and drilldown into saved source rows. It does not claim verified
story identity or source independence and does not affect scores, charts, or
rankings. Unit and UI tests cover these boundaries. No real-source event labels
are available to validate precision or recall.

## Verification evidence

- `npm run typecheck`, `npm audit --omit=dev --audit-level=high`,
  `gitleaks dir . --redact --no-banner`, and `git diff --check` passed before
  the final project-record edits. The frozen-source ETL gate covers fixtures,
  recovery/replay, offline startup gates, production build, and bounded keyless
  live smoke. Exact latest results and source fingerprint are recorded in
  `project-record/4-log/live-data-etl-evidence.json`.
- The previously recorded 17:56:28Z PASS / 17:56:41Z check predates this
  checkpoint and is not current evidence. A valid final disposition requires
  the newest matching `verify` and `check` after all source files and records
  are frozen; consult the evidence artifact for its exact status.
- The parent browser read used the local production build at
  `http://127.0.0.1:8797/` against an isolated copy of the saved SQLite
  database. It displayed `SAVED DATA ONLY`; external requests and Jev were
  paused. It showed the score index, arrival counts, stale-source age, and
  correct no-lineage-eligible-price state. The independent whole-build
  reviewer separately exercised Adobe 3D selection and score-bucket drilldown.
  Neither session claims live provider-to-Jev operation or classification
  quality.

## Real-data and operational limits

The live application rejects newly ingested synthetic observations and
quarantines `demo_simulation` and `legacy_unknown` rows from research reads and
Jev work. A whole-build read-only review counted 4,700 `legacy_unknown` rows in
the local database; their historical provider and Jev usage remain
unreconciled. Historical rows without original receipt IDs remain unlinked and
are identified as such rather than receiving fabricated lineage. The fresh
keyless smoke left its real item pending; it did not exercise Jev.

The user's 2026-09-29 public-source-rights statement remains an operator
attestation. It does not establish independent endpoint-specific terms. The
full objective still needs authorized TypeSafe account-owner confirmation of
permitted use, telemetry/retention, billing/refill behavior, limits and a spend
ceiling; a contact-bearing SEC User-Agent; two independent blinded
provenance-backed real-source label reviewers and a passing frozen Jev
evaluation; provider usage/billing records for the 4,700 unknown rows; and
source-specific rights and finite-coverage evidence. Opportunity Radar remains
disabled and downstream of Sentiment Desk readiness.

On 2026-09-30, the current official TypeSafe Master Customer Agreement page
showed a 2026-09-23 revision. It says only a representative with authority may
accept for a customer. It defines telemetry to include classifications and
allows TypeSafe to process telemetry without restriction. It also makes no
promise to retain Customer Data. The account Order sets usage limits, and no
authorized account owner's Order or usage record is available here. These
terms reinforce the existing gate; they do not authorize a Jev request from
this workspace. See the [TypeSafe Master Customer Agreement](https://typesafe.ai/legal/mca).

The official GDELT DOC 2.0 material describes its search endpoint and query
parameters. This check did not locate official public API documentation for
the Google News RSS or Yahoo Finance chart endpoints used by the smoke. The
keyless smoke therefore records observed source and persistence behavior; it
does not establish provider support, downstream rights, or complete coverage.
See the [GDELT DOC 2.0 API description](https://blog.gdeltproject.org/gdelt-doc-2-0-api/).

The native goal service reported **active** when this review was prepared. The
same external evidence gates have persisted across at least three resumed goal
turns. Decision: keep the goal incomplete after the code checkpoint and mark
it **blocked**, not complete. Operational and research validation gates remain
open, and the current build is not 10/10. The final review and checkpoint
decisions are in `project-record/4-log/2026-09-30-final-checkpoint.tsv`.

## Final source-bound checkpoint continuation — 2026-09-30

The current engineering-bullshit-detector verdict is **FAIL for full operational
readiness**, with no additional reproducible local defect in the reviewed
paths. The saved-data workflow is functional, while live Jev quality and the
source-to-judgment path remain unverified. The advisor recommends a finite,
rights-cleared real-source → Jev → persisted judgment → visible-evidence
cohort, followed by investor tasks that trace a swing, distinguish repeated
coverage from independent developments, identify stale/modelled values, and
explain whether evidence changes a thesis. Do not chase agent ratings with
more visual polish; keep Opportunity Radar parked.

A read-only aggregate over isolated saved Adobe history found no exact
score-timestamp ties in the 58 displayed scored records. Thus those large
movements were not caused by a same-millisecond ID tie-break in that sample.
This does not establish that repeated records are independent or that the
index is a validated investor signal.

The final frozen-source `verify` and `check`, checkpoint commit, remote branch
readback, and goal disposition are recorded in the live ETL evidence artifact,
final checkpoint TSV, and the task completion report. The previous 17:56
evidence is superseded.

## Superseding final-pass record — 2026-10-01T00:36:56Z

Correction: the preceding paragraph described future actions as already
recorded. At this timestamp, the newest ETL artifact was still the
`2026-09-30T21:21:29Z` receipt, which predates the current candidate; the final
candidate was not pushed, and the goal status had not been changed in this
pass. Do not treat that older receipt or sentence as final evidence. The
project records are now frozen for the next `verify` then `check`; their exact
result belongs in `project-record/4-log/live-data-etl-evidence.json`.

The final whole-build read-only review returned **FAIL for live operational
readiness**. Its bounded scores are saved-data UX **8.5/10**, operations
**7.5/10**, and live readiness **2/10**. It found no new reproducible local
defect after checking the webhook empty-state fix, prioritized alert history,
and responsive health summary. The investor reviewer returned saved-data
workflow **8.6/10** and live readiness **2/10**. The UI reviewer returned
**8.6/10** overall and **8.5/10** for health/alert discoverability after the
same fix. The investor and UI reviewers could not operate the coordinator's
browser tab; neither rating is a 10/10 claim or task-study result.

The coordinator rebuilt and reloaded the current production app in the
Codex in-app browser at `http://127.0.0.1:8798/`. It rendered the explicit
`webhook not configured` status with an empty outbox, `SAVED DATA ONLY`, paused
external sources and Jev, and no source price series. Selecting ADBE then AAPL
changed the company view. AAPL showed 334 saved scored rows across 37 buckets
in 7D and zero rows/buckets in 24H; ADBE showed 58 across 23 in 7D. The shown
saved source and score timestamps were about two days old. No demo or synthetic
records were added to the app database.

The final regression run passed **333 tests across 46 files**; typecheck,
production build, production dependency audit, and diff check passed. Gitleaks
v8.30.1 initially matched 26 strings only inside the Git-ignored mutable
SQLite WAL. The checked-in `.gitleaks.toml` now scopes secret scanning away from
the non-source runtime `data/` directory. The redacted scan then passed with no
source leaks; the 84 MB local database exceeds the scanner's 20 MB file limit.
The root engineering evidence receipt and independent acceptance-alignment
review remain separate from ETL verification; do not substitute one for the
other.

The full goal remains incomplete until permitted TypeSafe account use,
telemetry/retention and budget settings are confirmed by an authorized owner;
a descriptive SEC User-Agent contact, blinded labels from two independent
human reviewers, an authorized real-source Jev cohort with a passing frozen
evaluation, source-specific rights/coverage evidence, and provider
usage/billing records to reconcile the 4,700 `legacy_unknown` rows are
available. The user has attested to public-source rights; the exact endpoint
terms and those remaining operational inputs are not evidenced here.


## ETL declaration repair — 2026-10-01T00:46:32Z

The first current `live_data_etl_gate.py verify` invocation stopped before running checks: the contract omitted every source acquisition declaration and every check's `source_ids`, so fixture/failure/replay/live-smoke coverage could not be validated. No declared command ran and no provider request was made. The contract is now schema 2 with code-bound adapter paths and per-check source IDs. Google News RSS, Yahoo Finance RSS, GDELT, and Finnhub are metadata locators with unknown document freshness/publication/availability; SEC, Yahoo quote/chart, Reddit, X, and the Jev result are timestamped observations, with Jev explicitly described as derived output that cannot improve input freshness.

The global `live_claim` is now false because requests default off and only five public keyless paths have bounded smoke coverage. The required live-smoke command still covers those five exact source IDs; it does not imply general live operation or evidence for optional credentialed sources or Jev. Source rights remain user-attested and restricted/independently unverified where recorded. This appended entry supersedes the earlier pre-run freeze note until the repaired contract is frozen for a new verify/check.


## ETL cache semantics addendum — 2026-10-01T00:48:35Z

A second `live_data_etl_gate.py verify` invocation also stopped at contract validation before any declared checks or provider requests. It required network and cache delivery states for all `live_observation` sources. The contract now reflects retained saved-value fallback while preserving original source timing and freshness; Yahoo chart memory reuse is bounded at 60 seconds. Direct schema validation now returns zero issues. The contract/log were changed again after the 00:46 pre-run note, which is superseded; a new freeze and complete verify/check are required.


## Live-smoke runtime recovery — 2026-10-01T00:54:07Z

After schema validation was repaired, the full ETL gate passed its fixture, failure/recovery, replay, and offline source-gate checks; `authorized_keyless_live_smoke` failed because the specifically declared Docker context did not exist while its Colima profile was stopped. The currently selected context was Citrini, which was left untouched. I started the existing `sentiment-desk-verify` profile with `--activate=false`, creating/restoring the expected isolated Docker context, and reran the exact smoke successfully. Its disposable Compose stack returned 27 real Yahoo quotes, 24 companies, one real Google News pending observation, current collector health, and confirmed that the same pending item and volume survived container recreation. No application `data/` database, Jev key, optional credential, or webhook was used. A fresh whole verify/check remains pending for the frozen tree.
