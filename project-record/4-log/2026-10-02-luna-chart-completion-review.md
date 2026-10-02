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

The real saved-data preview at `http://127.0.0.1:54862/` uses a protected copy
of the local database with external requests and model keys disabled. Apple
shows 246 genuine historical Jev-scored records in 33 visible buckets, with
the latest score about three days old and real source headlines below the
chart. The panel says “Luna paused”; the Luna view has zero saved
classifications and stays empty. The historical route is explicitly labeled
Jev and states that collection is paused. The underlying main database is not
modified by the preview. Earlier same-candidate browser checks exercised
company selection, tab persistence, source drilldown, and 320px/390px layouts
without horizontal overflow; the 390px run showed actual saved Jev data.

The implementation adds the separate Luna categorical chart, exact UTC
aggregation and half-open evidence spans, timestamp precision, snapshot-bound
pagination, keyboard inspection, responsive chart scrolling, cancellation and
recovery handling, and data-aware initial selection. Historical Jev and price
polling runs only while that view is selected. No product fixture, mock
classification, or invented price series was used.

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
  24 companies, 538 genuine NVIDIA Jev records in 34 seven-day buckets, zero
  saved Luna rows, and external requests disabled.
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
- Existing blinded agent references have no negative sentiment examples.
  Agent references are diagnostic evidence, not human ground truth or a
  statistical quality certificate.
- The user attested to rights for public sources and APIs. Endpoint-specific
  retention, display, model-processing, and deletion permissions remain
  unresolved in the source assessment. The scoped live smoke deliberately did
  not request SEC, and makes no current SEC-collection claim.
- Provider usage evidence for historical `legacy_unknown` rows is unavailable;
  those rows remain quarantined. Sustained scale and investor value are not
  measured. Opportunity Radar remains disabled.

## Checkpoint

Repository: `https://github.com/j-poc/sentiment-desk.git`

Branch: `codex/real-data-rebuild`

Commit and remote SHA: recorded after final commit and GitHub readback.

This record is not a PR, merge, deployment, or release authorization.
