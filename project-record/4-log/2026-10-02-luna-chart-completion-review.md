# Luna chart continuation and whole-build review — 2026-10-02

## Exit criteria

1. The application uses genuine retained/provider records only; no demo or
   synthetic product observations are introduced.
2. New classifications use a separate categorical Luna profile. Historical
   Jev scores remain labeled and calculated as Jev, never as Luna results.
3. Company/window selection, chart buckets, source drilldown, timestamp ranges,
   failure/recovery, and narrow layouts work against saved real records.
4. The operator sees an accurate empty or paused Luna state when no real Luna
   rows exist. Full completion also requires an authorized real Luna run,
   provider usage reconciliation, and a usable three-class diagnostic.
5. The final scoped ETL evidence is fresh, reviewed in the real UI, and the
   exact source checkpoint is pushed to the existing GitHub branch.

## Result

The local saved-data chart and evidence workflow meets the inspected scope. The
whole product remains blocked by external classifier and qualification
evidence; it is not rated 10/10 or called operational.

The real saved-data preview at `http://127.0.0.1:54863/` uses a protected copy
of the local database with external requests and model keys disabled. Direct
browser readback showed NVIDIA with 537 genuine historical Jev-scored records
in 33 populated seven-day buckets; its latest score was
`2026-09-28T17:45:12.776Z`, about four days old. A separate current API review
read back Apple at 245 records in 32 populated buckets. These are different
companies, and the older Apple 246/33 observation is now historical rather
than current. The panel says “Luna paused”; the Luna view has zero saved
classifications and the preview has zero eligible price points. The historical
route is explicitly labeled Jev and states that collection is paused. The
underlying main database is not modified by the preview.

The implementation adds the separate Luna categorical chart, exact UTC
aggregation and half-open evidence spans, timestamp precision, snapshot-bound
pagination, keyboard inspection, responsive chart scrolling, cancellation and
recovery handling, and data-aware initial selection. Historical Jev and price
polling runs only while that view is selected. No product fixture, mock
classification, or invented price series was used.

## Histogram-to-source proof and retry repair — 2026-10-02T18:25Z

The current browser UI opened NVIDIA's real `2026-09-28 10:00 UTC` score bucket.
It contains 74 records, a weighted mean of about `+51.97`, and observed spread
from `-88` to `+100`. Selecting the half-open impact band `[-90, -80)` returned
all six matching rows, including matches beyond the unfiltered first 50, while
preserving the 74-record total, full 20-bin histogram, mean, and spread.
Unfiltered pagination returned 50 plus 24 unique rows. Reusing the selected-bin
cursor under a different bin returned HTTP 400; using a changed snapshot
returned HTTP 409. Five of the six low-band records share one normalized
challenger headline across publisher labels. The 537 NVIDIA rows contain 206
normalized exact-title strings, and 461 rows fall into repeated-title groups;
these are not verified independent stories or investor opinions. None of the
537 rows has a delivery receipt. The interface labels repeated coverage and
historical records instead of calling them crowd convergence.

The whole-build engineering review found an initial bucket-load Retry that did
nothing when the failed request had not returned a snapshot key. Retry now
refreshes the selected chart baseline before reopening the interval; filtered
page errors continue to retry against their retained snapshot. Three focused
retry-mode regressions and the real bucket/API tests pass. The coordinator's
in-app browser directly verified the current rendered filter and rows at
1280x720. Independent reviewers could not access that protected browser tab, so
their visual scores are source/test judgments; the coordinator's screenshot is
the current rendered evidence.

## Verification and independent review

- Full suite: 497 tests across 60 files passed; TypeScript, production build,
  and offline-startup/source-gate verification passed.
- Production dependency audit: zero high-severity or critical vulnerabilities.
- Gitleaks source scan: passed after confirming the generic-key matches were
  hashes/IDs in ignored private run artifacts, then excluding that private
  evidence directory and local runtime data from source scanning. Neither is
  staged or uploaded.
- Scoped live-data gate: all five required checks passed at
  `2026-10-02T14:30:01Z`; the subsequent fingerprint `check` also passed.
  The bounded public-source smoke covers Google News RSS, Yahoo Finance RSS,
  GDELT, and Yahoo quote/chart in a disposable environment. It makes no Luna,
  Jev, Reddit, X, or Finnhub request and does not establish continuous live
  operation or endpoint-specific rights.
- The engineering-bullshit-detector reviewed the whole build and returned
  **FAIL** for full acceptance: saved-data usability 7/10, local engineering
  robustness 7/10, live classifier readiness 2/10, full product readiness
  4/10. It found no new reproducible chart defect. Its API readback confirmed
  24 companies, 537 genuine NVIDIA Jev records in 33 seven-day buckets, zero
  saved Luna rows, and external requests disabled. These counts are the
  readback at this review time; the rolling window can change between reads.
- The independent investment workflow review scored current investor
  usefulness **4/10**. It highlighted absent live Luna output, repeated
  coverage as a convergence risk, no category-to-price link, and incomplete
  historical Jev receipt lineage. These latter historical-data limits are
  disclosed; no new de-duplication or price semantics were inferred from the
  empty Luna dataset.
- The GPT-6.1 Sol xhigh UI advisor's recommendation to select real Historical
  Jev automatically only after a successful zero-row Luna read was
  implemented. It also identified and the implementation fixed evidence-load
  cancellation stranding, inactive-chart polling, and hidden sub-second range
  precision.

## Remaining blockers

- `OPENAI_API_KEY` is absent from the runtime. ChatGPT model access does not
  prove direct API entitlement or budget. No paid API request was made, and
  Jev is not a fallback for new classifications.
- No genuine Luna output, returned usage, or provider billing reconciliation
  exists. The required private run artifact
  `.engineering-evidence/luna-real-source/luna-independent-real-source-run.json`
  is absent, so the frozen real-source evaluation cannot be completed.
- The original pilot's 30-case reference set had no negative labels. The later
  post-hoc full-frame extension adds one negative label within those same 30
  cases and one positive label in the additional 18. It is a new diagnostic
  reference set, not a prospective sample; agent references remain distinct
  from human ground truth and do not certify classifier quality.
- The user attested to rights for public sources and APIs. Endpoint-specific
  retention, display, model-processing, and deletion permissions remain
  unresolved in the source assessment. The scoped live smoke deliberately did
  not request SEC, and makes no current SEC-collection claim.
- Provider usage evidence for historical `legacy_unknown` rows is unavailable;
  those rows remain quarantined. Sustained scale and investor value are not
  measured. Opportunity Radar remains disabled.

## Post-hoc full-frame reference extension

Two fresh, blinded agents labeled all 48 items in the pre-existing SEC source
frame without seeing each other's outputs or any Luna result. Both reference
outputs bind to packet SHA-256
`b425fcd5d169e19798ec33b46ec67a05095ba937747062c9342158908ad97716`. Their
private output hashes and the full-versus-subset counts are recorded in
`.engineering-evidence/luna-real-source/diagnostic-reference-20261002/validation-report.json`.

Each agent assigned 27 neutral, one negative, one positive, and 19 null
sentiment labels. The 48/48 sentiment agreement includes those 19 matching
nulls. The original 30-case subset contains one negative and no positive; the
additional 18 contain one positive and no negative. Three of 48 cases differ
on at least one of the other six fields. All three literal sentiment classes
are present, but one example per directional class is too little evidence to
support stable class-level quality estimates. Several reference excerpts omit
the filing exhibits they point to, so uncertainty is retained.

The extension was chosen after seeing the neutral-heavy pilot result, making
it exploratory and post-hoc. The agents used isolated contexts and different
requested GPT-6 family models, but they do not provide independent provider
families, calibrated human truth, Luna accuracy, investor value, or a test of
whether two models make independent errors. It made zero Luna API requests and
no product database writes. The final-model run and usage reconciliation are
still absent; live qualification remains blocked.

## Final local continuation — 2026-10-03

The final empty-price and stale-refresh correction passes its database, API,
and route-to-App regressions. The full suite passes 533 tests across 64 files;
TypeScript, production build, offline-startup verification, and the production
dependency audit pass. The audit reports zero high-severity or critical
vulnerabilities. The five-check keyless real-source ETL receipt passes for its
declared scope. The read-capacity check passed against a protected copy of the
real database: 96 serial and 96 interleaved eight-worker reads returned HTTP
200, with route p95 from 2.9 to 21.6 ms serially and 120.8 to 125.2 ms under
interleaving. This is local read evidence, not sustained or hosted scale.

The final preview at `http://127.0.0.1:8799/` is backed by a protected copy of
retained real data with external requests and model keys disabled. NVIDIA shows
537 historical Jev-scored records in 33 seven-day buckets, latest about four
days old, and explicitly says new Luna classifications are paused. The selected
price comparison has no provenance-verified Yahoo points; its visible empty
state quarantines 2,883 legacy rows across all saved history. At 1280×720 the
chart and source evidence render; at 390px the disclosure wraps without
horizontal page overflow. No product-database write or synthetic observation
was used in this preview.

The whole-build engineering-bullshit-detector returned **FAIL** for full
readiness: saved-data workflow 7/10, local engineering 7/10, live classifier
2/10, investor value 4/10, full product 4/10. It found no further reproducible
local defect after the price-refresh correction. The independent investor/UI
review rated the saved-data journey 4/10, interface 8.3/10 on inspected desktop,
saved-history evidence 7/10, live evidence 2–3/10, and operational readiness
2/10. Its review was limited to 1280×720; the separate coordinator inspection
covered the empty-price message at 390px. These are bounded agent judgments,
not customer validation or a 10/10 claim.

Remaining full-build blockers are external or qualification evidence. No direct
OpenAI API credential, account-use/spend-limit readback, genuine Luna output,
provider-returned usage, or billing reconciliation is available. The agent
reference set has only one negative and one positive case and was extended
post-hoc; it cannot qualify Luna. Historical delivery lineage is incomplete,
including provider usage evidence for legacy price rows, which remain
quarantined. The user attested to public-source rights, but endpoint-specific
retention, display, model-processing, deletion, and coverage terms were not
independently established by this work. The keyless smoke did not call SEC or
Luna. Sustained hosted scale and investor value remain unmeasured. Opportunity
Radar stays disabled.

## Checkpoint

Repository: `https://github.com/j-poc/sentiment-desk.git`

Branch: `codex/real-data-rebuild`

GitHub reports the existing repository visibility as `PUBLIC`; this work did
not change repository visibility or permissions. The reviewed source
checkpoint `37c0521dce941c125d6a0e63e87e7279d37d028d` is present on the remote
branch with the matching SHA. It contains no `.env`, local database,
`.engineering-evidence`, or untracked gate artifact. The remaining evidence
receipts are finalized in subsequent commits on the same branch.

This record is not a PR, merge, deployment, or release authorization.
