# Investor/UI review and gate refresh — 2026-09-30

Trace ID: `TRACE-20260930-investor-ui-review-and-gate-refresh`

## Request

The user asked independent investor and UI reviewers to score the build and
asked for fixable gaps to be improved. The continuing product objective is the
full Sentiment Desk real-data-only goal in
`project-record/3-project-specs/sentiment-desk-completion.md`; this UI pass does
not narrow or complete that goal.

## Independent reviews and fixes

The initial and intermediate ratings (8.3/9.2, then 8.5/9.0) are historical.
Fresh independent reratings after the latest fixes scored the saved-data
investor evidence workflow **9.0/10** and **8.8/10**; the UI scored **9.1/10**
(visual quality 9.3, interaction/recovery 9.5, accessibility/responsive 8.6).
The whole-build engineering review remains **FAIL** for operational readiness;
the independent investor reviewer rates full live research readiness **2/10**.
Reviewers inspected the current source and focused tests but did not observe a
rendered-browser session or conduct an investor task study. None rated the
build 10/10. They found no remaining justified local code edit. Jev's real-
source quality, the usefulness of the related-title heuristic, and the actual
investor/mobile journeys remain unvalidated.

The requested GPT-6.1 Sol advisor reviewed the current trace and completion
contract at extra-high effort. It found no further code change supported by
evidence and recommended pushing the verified checkpoint before marking the
goal blocked on external evidence.

A final whole-build engineering-bullshit-detector review found no reproducible
local code defect. It rated the saved-data UI **8/10**, investor evidence
workflow **7/10**, and operational readiness **3/10**. These are separate
reviewer rubrics, not a composite score; the full ratings remain bounded by the
unobserved rendered UI and investor task outcomes. The review also found that
the offline preview process had stopped, so this trace now describes it in the
past tense.

The first review pass returned different category scores. The fresh rerate
above is the current score snapshot; earlier values are not current ratings.

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

- `npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000` — **PASS**,
  294 tests across 43 files, including the `.tsx` component suite.
- The focused related-title run — **PASS**, 9 tests across two files.
- `npm run typecheck` — **PASS** after the final source and UI changes.
- `npm run build` — **PASS**. Vite reports a 591.45 kB client JavaScript
  chunk, above its 500 kB advisory threshold.
- `npm audit --omit=dev --audit-level=high` — **PASS**, zero production
  vulnerabilities reported at run time.
- `git diff --check` — **PASS**.
- `gitleaks dir . --redact --no-banner` — **PASS**, no leaks found.
- The latest frozen-source gate status, timestamp, fingerprint, five check
  outcomes, and supplemental `check_receipt` are recorded in
  `project-record/4-log/live-data-etl-evidence.json`. For reference, the
  preceding 17:49:39Z `verify` and 17:49:52Z `check` passed for fingerprint
  `839573c4bd9111204ea4996edd89ced8143dd1e71ed988b933852b537ff2fcc3`;
  this record update supersedes that fingerprint, so the artifact carries the
  result for the newly frozen records. The five checks cover fixtures, recovery, replay,
  offline request gates, and a bounded authorized keyless live smoke. That
  smoke uses an isolated temporary Compose database with no credentials or Jev
  request and verifies that a real pending item survives container recreation.
  It cannot prove TypeSafe approval, Jev quality, or source completeness.
- A production server was run at `http://127.0.0.1:8797/` against an isolated
  copy of the 81 MB saved SQLite database. External requests and Jev were
  explicitly disabled; no demo rows were added. The final review found the
  preview process stopped. The in-app browser policy rejected navigation to
  the local URL, so no current rendered UI or interaction is claimed.

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
