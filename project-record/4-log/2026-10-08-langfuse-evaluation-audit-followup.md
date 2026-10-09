# Langfuse evaluation audit follow-up

Scope: refresh the audit-only evidence on 2026-10-08. No application code,
acceptance criteria, grader definitions, or model requests were changed or run.

## Observed results

- **Evaluator harness: PASS, narrow scope.** `npm test -- --reporter=dot
  --maxWorkers=1 --testTimeout=20000 tests/luna-label-evaluation.test.ts
  tests/luna-public-benchmark.test.ts tests/openai-classifier.test.ts` passed
  44 tests across three files. This tests the current evaluator/client
  invariants; it does not estimate classifier accuracy or grader false-pass
  rates on live predictions.
- **Luna qualification: BLOCKED / UNVERIFIED.** The registered final label file
  and persisted prediction run are missing. The final evaluator returned
  `INVALID_OR_UNVERIFIED_INPUT` with `ENOENT` for
  `.engineering-evidence/luna-real-source/luna-independent-real-source-final-labels.json`.
  No resolved serving-model identity, model response, usage, cost, latency, or
  source-linked prediction output is established.
- **Public benchmark: BLOCKED.** Benchmark rights, eligible rows, frozen
  profile, and saved run files are missing. The existing benchmark is a
  sentiment-component diagnostic only and cannot establish source support,
  finance fact correctness, abstention quality, or investor utility.
- **Investor outcomes: BLOCKED.** Both `master-eval` and `investor-workflows`
  outcome checks report that their outcome reports are missing. No paired
  AlphaSense results or intended-user task outcomes are established.
- **Current SEC input: BLOCKED in the canonical runtime.** With external
  requests explicitly disabled, `npm run verify:sec-filings-hub` returned
  `state=unavailable`, `freshness=unknown`, and `rows=0`; it made no provider
  request. An isolated candidate-Hub preview previously returned 38 real SEC
  rows, but it is not the canonical installation and its current rendered
  workflow was not visually verified.
- **Whole-build gate: FAIL, accurately.** `engineering_gate.py verify` reports
  a non-passing finding in the independent alignment review; that review has
  26 explicit one-to-one acceptance mappings and records unresolved outcomes.
  `live_data_etl_gate.py check` reports stale evidence and the missing passing
  `sec_filings_current_hub_receipt`. Current source metadata for
  `sec_company_facts` includes a positive freshness budget, network/cache
  delivery states, observation/retrieval timing fields, retained rights, and
  API acquisition. The earlier schema complaint about that row does not
  reproduce against the current file.

## Audit conclusion

The evaluator's offline tests pass, but the evaluation system cannot yet
distinguish a correct live Luna result from a convincing failure because there
is no persisted Luna prediction run against independently qualified reference
labels, no usable public benchmark run, and no protected investor outcome
reports. Existing agent-reference agreement is not human ground truth and does
not prove model performance. Langfuse instrumentation is not required by the
current deterministic runner; no Langfuse trace evidence was found in the
project's current evaluation record.

The overall classifier and investor-product verdict remains
**NOT QUALIFIED / NOT COMPLETE**. The native goal remains active. The current
native goal text still names Jev as the core classifier, while the accepted
project contract specifies GPT-6 Luna for new classifications; the goal tool
available in this session supports status changes only, so this mismatch is
recorded rather than hidden or falsely resolved.

## Next evidence required

Create and preserve the independently reviewed source labels and exact Luna
request profile, execute a bounded authorized real-source run, bind returned
model and per-row usage receipts, evaluate all predeclared cases including
missing/invalid/abstained outcomes, run the rights-cleared public benchmark,
and collect paired investor-task outcomes. Restore the Hub connection and
verify the resulting SEC filing workflow through its intended rendered
interface before changing any blocked acceptance verdict.

## Desk Hub integration check

The Desk now reads a Desk-specific, private Hub installation descriptor. It
selects the local SEC-capable Hub worktree at source revision
`efbbd01af07fe810dfe85c0b8870758f46130ebb`; that worktree is dirty and the Hub
API does not expose a build identity, so this is operator-side source evidence,
not a server-attested revision. The descriptor is owned by the current user
with mode `600`; the Hub token remains in the Hub's private state directory and
was not copied to the Desk or this record. The prior shared Hub locator is
unchanged. The operator trusts the local service bound to that loopback port.

- `npm run verify:sec-filings-hub` — **PASS, read-only receipt contract**: 38
  real 8-K rows, current source freshness, an accepted display-only receipt,
  `feed_updated_at=2026-10-08T07:14:41.000Z`, and
  `retrieved_at=2026-10-08T07:14:41.871Z`. The verifier explicitly reports no
  provider call.
- **Desk API path — PASS, limited scope**: a production server built from the
  candidate worktree read the receipt through `GET /api/sec-filings-inbox`
  using a temporary SQLite backup of the real saved Desk database. It returned
  `ready`, `current`, 38 rows, and the same receipt/source clocks. Startup
  reported external requests disabled and credentials unused. The temporary
  database was removed after shutdown. This is route and data-path evidence,
  not rendered-browser evidence or full small-cap discovery acceptance.
- **Descriptor regressions — PASS**: 20 installation tests plus 26 inbox,
  UI, and external-request regressions passed (46 total); typecheck and
  production build passed. The build retains its existing advisory warning
  for the 824.49 kB main web chunk.
- **Whole-build state — still open**: no saved Luna prediction run, resolved
  provider identity or usage receipt, task-matched public finance benchmark,
  paired AlphaSense result, intended-user outcome study, or rendered browser
  review is established. This SEC feed is a bounded 40-entry recent 8-K
  window, not an issuer universe, small-cap screen, materiality judgment, or
  market-wide coverage claim. Explicit activation enables the Hub's recurring
  15-minute profile; it does not enable direct SEC polling inside the Desk.

The Langfuse evaluation verdict remains **NOT QUALIFIED / NOT COMPLETE**. The
SEC connection does not change Luna quality, public benchmark, or investor
outcome results.

## Current-state reconciliation — 2026-10-08 08:19 UTC

The earlier 38-row `ready/current` API result was time-bound to the receipt
clocks above and must not be read as current availability. At the latest
read-only Hub check, `sec.latest_filings_8k` was not configured, its recurring
profile was disabled, and the only saved 38-row receipt still had source and
retrieval clocks at `2026-10-08T07:14:41Z`. A bounded activation attempt in an
isolated Desk process stopped before a provider request and returned the Hub's
SEC-contact User-Agent prerequisite. The live-data ETL verifier passes its
authorized keyless live smoke and every listed fixture/recovery check, but
fails `sec_filings_current_hub_receipt`; saved rows do not close that freshness
requirement.

The no-ticker recovery UI now exposes the stale/paused state, keeps the last
accepted filing rows and their source clocks through Hub unavailability, and
offers both saved-archive search and Sources & operations when those paths are
available. Focused SEC/UI tests passed 45 cases before the evaluator repair;
the final full suite below includes these changes. A browser security policy
refused navigation to loopback and prohibits alternate browser routes, so the
rendered filing workflow remains **UNVERIFIED** despite API and component-test
evidence.

The read-only Langfuse/evaluation audit found that deterministic safeguards
pass, but classifier quality, benchmark quality, source/reviewer authenticity,
and investor outcomes remain unverified or blocked. The 30-case agent-reference
cohort currently resolves to 28 neutral, one positive, one unresolved, and no
negative labels. The 48-case agreement report has only 29 jointly labeled
sentiment cases because 19 pairs both abstained. The current diagnostic replay
exits 2 because the frozen label revision does not match current HEAD. No live
Luna run, task-matched public benchmark result, paired AlphaSense study, or
intended-user outcome report is available. The suite's existing
`INVALID_OR_UNVERIFIED_INPUT` message is an evaluation-artifact diagnostic; it
does not indicate a passing model result.

The final report now compares every returned model and service tier with the
frozen requested identities. Any wrong or mixed identity is an execution
failure; missing tier evidence stays unverified and is counted explicitly.
Regressions cover a wrong model, wrong tier, mixed models, mixed tiers, and a
missing returned tier. The final validation for this change passed **881 tests
across 109 files**, the TypeScript typecheck, and the secret scan. No Luna
classification request was made. A full current engineering receipt and fresh
alignment review remain required after checkpointing these sources.

Full investor readiness remains **NOT COMPLETE**. In addition to live SEC
freshness and rendered filing interaction, the current scope still lacks a
verified no-ticker small-cap/discovery workflow, resolved real-source Luna
quality, the rights-cleared public finance benchmark, reconciled legacy rows,
paired competitive results, and intended-investor task outcomes. Opportunity
Radar remains gated off.

## Current whole-build and Langfuse-principles audit — 2026-10-08

This refresh followed the repository's Langfuse-principles audit workflow. The
project uses deterministic local evaluators and JSON evidence rather than a
Langfuse service. No evaluation definition, acceptance criterion, or model
request changed in this audit. I also completed the already-authorized SEC
inbox recovery repair; its code and regression tests are separate from Luna
qualification.

- **Evaluation harness: PASS, narrow scope.** The current full repository suite
  passed **109 files / 885 tests**, `npm run typecheck` passed, and
  `npm run build` passed. The production web bundle remains 826.46 kB and Vite
  reports its existing 500 kB advisory. The retained investor recovery
  regression passed **21 tests across two files**; its changed SEC test source
  was reviewed against the exact retained source and reconciliation was
  recorded in the local quality-loop archive. This proves test behavior only.
- **Real-source Luna quality: BLOCKED / UNVERIFIED.** The 30-case agent
  reference artifact is explicitly a pilot and its report says
  `humanGroundTruth=NOT_PROVIDED`. The required final-label file and persisted
  Luna model run are absent. No serving-model identity, request-linked output,
  token usage, cost, latency, abstention quality, or summary entailment result
  is established. No OpenAI Luna classification request was made.
- **Reference reliability: UNVERIFIED.** Separate blinded agent contexts were
  used, but the saved reviewer lineage does not establish distinct model-family
  independence. Their agreement is diagnostic reviewer evidence, not truth or
  investor value.
- **Public finance benchmark: BLOCKED.** No saved rights-qualified benchmark
  run exists. The sentiment-only FinEntity adaptation would not cover Desk
  event types, source entailment, or investor usefulness even if run.
- **Investor outcomes: BLOCKED.** The paired AlphaSense report and three
  prospective investor-workflow outcome reports are absent. No task evidence
  establishes small-cap discovery, research-worthiness, or followed-company
  change quality.
- **Current local runtime: FAIL for live coverage, with bounded saved data.**
  The read-only API reports 38 saved SEC 8-K rows, but both receipt and source
  freshness are stale (feed clock `2026-10-08T07:14:41Z`) and activation is
  unavailable. External requests are disabled, Luna is unconfigured, and the
  runtime has recorded zero classifier requests. The first-run API's 11,825
  locally eligible observations are saved history, not a current discovery
  universe; coverage is bounded to 24 configured companies. No rendered
  browser journey was observed.
- **Whole-build acceptance: FAIL.** The independent review found 10 scoped
  passes, 10 unverified criteria, 3 blocked criteria, and 3 failures before a
  new GitHub checkpoint. No-ticker small-cap discovery is a product-scope
  failure: the recent 8-K feed is explicitly unranked and not a small-cap
  screen. The current ETL evidence has 8/9 checks passing; the sole failed
  check is `sec_filings_current_hub_receipt`.
- **Evaluation principles audit: PARTIAL.** The native runner has useful
  deterministic source/profile binding, fail-closed missing-run behavior,
  preserved denominators, and a narrow offline suite. There are no Langfuse
  traces, because no real Luna serving run exists to trace. Adding observability
  infrastructure now would not resolve missing model outcomes, benchmark
  rights/run, or investor tasks.

The full test run emitted one expected `INVALID_OR_UNVERIFIED_INPUT` diagnostic
from a negative test that confirms the evaluator refuses to overwrite a
changed saved report; the suite still completed successfully. The active
native goal text still says Jev is the core classifier while the accepted
project contract selects GPT-6 Luna for new classifications. The available goal
control can change status but not objective, so the goal remains active and
this mismatch is explicit rather than silently rewritten.

The SEC inbox repair makes source freshness age from the SEC feed clock, keeps
the last accepted snapshot through request failures, prevents older responses
from replacing newer ones, and exposes a recovery action for an unconfigured
Hub. An independent review found no concrete code defect. One-shot timer
behavior and poll suppression are covered at helper level but lack a mounted
fake-timer journey; that detail remains unverified. These changes do not close
the live Hub, Luna, benchmark, discovery, or investor-outcome gates.

## Oct 8 blinded subagent-reference refresh

The requested Langfuse-principles reassessment compared two new independent
subagent label sets against the unchanged frozen packet of 30 real SEC excerpts
(packet SHA-256 `9cea2750644cd3522493f7128209596fe1095e56e72a61fadcfbb41cdaf4b75c`).
The outputs bind the same 30 accession IDs and contain all seven required label
fields with rationales. Their artifact hashes and per-field comparison are in
`.engineering-evidence/luna-real-source/luna-reference-relabel-agreement-20261008.json`;
that generated local artifact remains excluded by the repository's evidence
ignore rule. No product records were written, no synthetic examples were used
in this cohort, and no model-provider request was made.

| Field | Exact agreements | Both reviewers labeled | Agreements when both labeled |
|---|---:|---:|---:|
| Sentiment | 18/30 | 22/30 | 18/22 |
| Event type | 26/30 | 30/30 | 26/30 |
| Takeaway | 28/30 | 30/30 | 28/30 |
| About the company | 30/30 | 30/30 | 30/30 |
| Materiality | 19/30 | 23/30 | 19/23 |
| Investor relevance | 30/30 | 30/30 | 30/30 |
| Evidence sufficiency | 22/30 | 30/30 | 22/30 |

Only 13/30 complete records match across all seven fields; 37 field values
disagree. Perfect agreement on the two constant-true fields does not establish
useful discrimination. Both reviewers report start and completion in the same
second, so these timestamps do not establish review duration or model-serving
lineage. The comparison is supplemental reviewer-reliability evidence, not
ground truth, and does not replace or rewrite the frozen prior reference set.
The existing evaluator already treats unresolved references as `UNVERIFIED`;
the new comparison therefore changes the observed evidence, not the grader or
its acceptance threshold. No Luna classifier result exists to score.

Current checks after this comparison: the full suite passes **109 files / 890
tests**, `npm run typecheck` passes, and `npm run build` passes with the existing
826.46 kB web-chunk advisory. The native live-data ETL gate passes all **9/9**
checks. The independent review maps all 27 acceptance criteria exactly once and
sets `request_coverage: pass`, but its whole-build verdict remains **FAIL**:
13 scoped passes, 11 unverified, two blocked, and one fail. The 38-row real SEC
8-K inbox and selected-company chart render in the local browser; expanded
filing text still cannot be verified in the saved-data preview because direct
SEC document requests are disabled there.

The remaining evaluation and product gates are unchanged: no GPT-6 Luna API
credential or persisted classifier run; no rights-qualified public finance
benchmark run; no 30-task AlphaSense comparison or observed investor outcomes;
no completed zero-ticker small-cap discovery workflow; and no reconciliation
for 4,700 `legacy_unknown` records. Opportunity Radar remains disabled. The
active native goal still says Jev is the new-record classifier while the
authoritative project contract selects GPT-6 Luna; the available goal control
can update status but not its objective, so this mismatch remains recorded.

## Oct 8 third-model disagreement adjudication

A third blinded subagent using configured model `gpt-6-sol` adjudicated only
the 37 disputed fields between the unchanged Astra and Sol reference relabels.
The adjudication is bound to the same 30-item packet
(`9cea2750644cd3522493f7128209596fe1095e56e72a61fadcfbb41cdaf4b75c`) and to
both input label digests. The generated local artifact is
`.engineering-evidence/luna-real-source/adjudication-relabel-20261008.json`
(SHA-256 `94307759cfa1847d2223dee95986183252fa2ba4743c16b14aa82fa3b8e48602`).
An independent structural check matched all 30 packet IDs, both input digests,
the two original reviewer labels on each disputed field, and all 37 quoted
source offsets. It found 19 adjudicated values and left 18 null because the
packet excerpt did not support a defensible resolution.

| Field | Resolved | Left unresolved |
|---|---:|---:|
| Sentiment | 4 | 8 |
| Event type | 3 | 1 |
| Takeaway | 1 | 1 |
| Materiality | 3 | 8 |
| Evidence sufficiency | 8 | 0 |
| About / investor relevance | 0 | 0 |

The adjudicator specifically lacked the referenced exhibits for many results;
one appointment excerpt ended mid-sentence. This is a third model review, not
expert ground truth, independent model-family evidence, a majority vote, or a
Luna classifier result. It does not change the evaluator or qualification
verdict. Luna quality, source-grounded summaries, benchmark quality, and
investor outcomes remain **UNVERIFIED/BLOCKED**. The generated adjudication JSON
is ignored local evidence and is not included in the Git checkpoint; this log
records its digest and aggregate result. No model-provider request or product
write occurred.

## Categorical disposition false-pass repair

An adversarial evaluator test found that all 30 saved dispositions could be
flipped to contradict their own inclusion fields while
`structuredClassificationStatus` still returned `PASS`. Inclusion precision
alone did not catch this because the saved disposition determines whether a
classification is visible in the desk. The production pipeline now shares its
disposition rule with the evaluator; the evaluator fails contradictions
provable from the frozen output. Complete in-scope cases now remain
**UNVERIFIED** because source identity strength, which determines
`classified` versus `review_required`, is absent from the packet. An
end-to-end pipeline regression checks that excluded and review-required rows
remain out of sentiment chart counts.

The final focused Luna evaluation, classifier, public benchmark, and evaluator
CLI run passed **60 tests across four files**. Typecheck and production build
passed; the existing Vite large-bundle advisory remains. The independent code
review verified the shared disposition policy against 432 valid evidence
combinations and found no mismatch. `git diff --check` passed.

The final full suite passed **894 tests across 109 files** with
`npm test -- --maxWorkers=1 --testTimeout=20000` (96.72 seconds). An earlier
parallel run under concurrent machine load hit timeouts; one serial attempt
also hit `ENOSPC` when only 178 MB was free. After the temporary test files
released storage, the isolated serial rerun completed cleanly. Typecheck,
production build, focused tests, staged Gitleaks scan, and `git diff --check`
passed. The engineering completion gate remains non-passing on whole-build
findings, including stale live-data ETL evidence and missing real Luna,
benchmark, discovery, and investor-outcome evidence. These offline regressions
establish software invariants only; no Luna request or classifier-quality
conclusion was made.

Checkpoint: commit `7f4412d5d1153f921aca5c91164e31c8f34ea69e` is pushed to
`https://github.com/j-poc/sentiment-desk/tree/codex/real-data-rebuild` and the
remote branch SHA was read back as an exact match. The working tree was clean
after the code checkpoint.

## Repaired recovery-eval boundary — 2026-10-08

The user invoked the Langfuse-principles evaluation workflow during the active
build. I retained the repository's native deterministic checks; no Langfuse
service or model-provider request was needed for this defect.

- **Observed baseline failure:** the 2026-10-08 12:43 UTC live-data ETL run
  failed `failure_recovery_regressions` once. In
  `tests/openai-classifier.test.ts`, the completed insufficient-evidence
  classification was present in SQLite, but the test expected a 24-hour
  snapshot to count it when the independently sampled `Date.now()` cutoff
  equaled the saved classification timestamp. The snapshot contract is
  `[fromMs, throughMs)`: a record exactly at `throughMs` is excluded. The
  focused rerun passed, consistent with a millisecond-boundary false failure;
  this did not demonstrate a Luna classification error.
- **Repair and retained regression:** the test now reads the persisted
  `classifiedAt`, asserts exclusion at that exact end-exclusive cutoff, and
  asserts inclusion at `classifiedAt + 1`. It still verifies the mutually
  exclusive `review_required` or `excluded` disposition and zero directional
  sentiment counts. The product interval semantics remain unchanged.
- **Candidate results:** `live_data_etl_gate.py verify` passed all **9/9**
  checks at `2026-10-08T12:55:44Z`, including recovery, replay, offline request
  gates, real keyless-source Compose persistence/restart, capacity, SEC inbox
  protocol/failure handling, and the current SEC Hub receipt. The receipt
  verifier independently read **40 real 8-K rows**, source clock
  `2026-10-08T12:55:30.000Z`, retrieval clock `2026-10-08T12:55:30.585Z`, and
  made no provider call. The smoke explicitly disabled Luna and Jev and wrote
  only to a temporary Compose volume.
- **Regression and build checks:** the focused classifier/chart tests passed
  **21/21**; the full repository suite passed **894/894** across 109 files;
  TypeScript typecheck, production build, and `git diff --check` passed. Vite
  retains the existing 826.46 kB main-web-chunk advisory.
- **Classifier qualification remains unverified:** the fresh two-model-family
  blinded agent-reference report covers 30 real SEC cases across 15 issuers;
  13/30 cases fully match and sentiment agreement is 18/30 including abstention
  (18/22 when both agents label). The pair disagrees on 37 fields. These are
  reference-agreement diagnostics, not model accuracy or ground truth. There is
  still no persisted OpenAI Luna prediction run, resolved serving-model/usage
  receipt, or completed rights-cleared benchmark and investor-outcome study.
  No paid classifier request was made, and no demo or synthetic record entered
  the application or this cohort.

This repair improves the reliability of one deterministic recovery evaluator;
it does not change the classifier-quality, benchmark, investor-value, or
whole-build verdicts above.

## Primary SEC listing action and full-build recheck — 2026-10-09

The first primary-app filing check exposed a dead end: the server said listing
verification was available, but the `listing_unverified` state hid its action.
After the action was exposed, the SEC feed's independent 15-minute refresh
cooldown still disabled it even though listing verification can reuse a current
accepted SEC receipt and only fetches the two public Nasdaq Trader directories.

- Added a regression for the missing action and a separate cooldown predicate:
  `listing_unverified` can explicitly verify exchange listings while SEC feed
  refresh cadence continues to apply to SEC refresh states. The action is named
  “Verify current listings,” and the server's recovery copy uses the same name.
- Focused SEC inbox and UI tests passed **43/43**. The full repository suite
  passed **1,062/1,062** across 123 files; typecheck, production build, and
  `git diff --check` passed. The production web build retains its existing
  approximately 882.49 kB minified main-chunk advisory. The full suite prints a
  guard message from `scripts/evaluate-jev-labels.ts` when its persisted report
  differs from current inputs; Vitest still completed successfully.
- In the primary UI on a task-created temporary SQLite database, only
  `sec_latest_filings_8k` and `nasdaq_symbol_directories` were enabled. The
  active profile had no OpenAI key; health reported OpenAI GPT-6 Luna disabled,
  zero classifier requests, Jev disabled, and Opportunity Radar disabled. The
  listing button was available during the SEC cadence cooldown. Clicking it
  rendered **29** current-listed 8-K rows and withheld **10** unmatched or
  ambiguous rows. Both Nasdaq directory creation clocks and retrieval clocks
  appeared in the UI. The accepted SEC feed receipt was
  `4c940987-85e2-4729-9bdb-a7ddaece3d1d`, updated at
  `2026-10-08T23:47:09Z`; directory files were retrieved at
  `2026-10-08T23:49:18Z`.
- Attempting to inspect the first listed filing, Trinity Capital Inc. (CIK
  `0001786108`, accession `0001193125-26-418097`), ended at “Retry SEC evidence.”
  No filing task was saved, no model call occurred, and no private note or
  synthetic application record was created. Criterion 22 therefore remains
  unverified until an inspection, save, restart, and exact-task resume succeed.
- The fresh independent whole-product review remains **FAIL — 4.5/10**: 12
  PASS, 17 UNVERIFIED, 3 BLOCKED, 1 FAIL. It credits the live 29/10 listing
  view but does not upgrade the full SEC journey. Missing Luna output and a
  rights-qualified benchmark, tickerless small-cap discovery, AlphaSense
  comparison, intended-user outcomes, SEC/task resume journeys, and the 4,700
  legacy-row provider-usage reconciliation remain open.
- The Sentiment Desk server was stopped after the browser verification. At the
  follow-up check, `:5174` had been reused by a different local application;
  it must not be treated as this product's runtime. Source and regression tests
  were checkpointed as `d04e4b63ecc35a7ed0a467bab3a4be7ca42b25ae` on
  `origin/codex/real-data-rebuild`, confirmed by `git ls-remote`. The refreshed
  live-data ETL JSON is generated evidence and is not part of that source
  checkpoint; its code-bound gate remains to be rerun.

This closes the two observed listing-action dead ends, not the complete
Sentiment Desk objective or its remaining product and live-operations gates.

## Selected private-note analysis and current ETL recheck — 2026-10-08

The user confirmed that optional private notes about configured public issuers
may be analyzed by GPT-6 Luna only when the user explicitly chooses the item
and confirms external processing. Private companies remain outside the product
scope. The UI already names the exact note, configured issuer, Luna destination,
data sent, local-only result, and retention disclosure in a separate item-level
confirmation. The server still requires `confirmExternalProcessing: true`, binds
the request/result to the selected note digest, and keeps private results out of
public sentiment and charts.

- Added UI regressions for both consent outcomes: cancellation sends no analysis
  request; confirmation dispatches only the selected note to that issuer's Luna
  route and sends the explicit confirmation field. These use isolated test
  records only and do not call OpenAI.
- Focused private-evidence tests passed **86/86**; the complete suite passed
  **123 files / 1,057 tests**; TypeScript typecheck and production build passed.
  The secret scan found no leaks across 344 source/config files and client
  assets. The private-evidence scope check passed. The existing 882.21 kB
  minified frontend bundle warning remains.
- Restarted the existing dedicated `sentiment-desk-verify` Colima profile after
  the first live-smoke failure showed that its Docker socket was unavailable.
  The refreshed ETL receipt passes **9/10** checks, including the real keyless
  RSS/GDELT/Yahoo Compose persistence/recreation smoke and current Nasdaq
  directory replay. The sole remaining failure is
  `sec_filings_current_hub_receipt`.
- `npm run verify:sec-filings-hub` still reports the local Public Data Hub as
  unavailable, with zero rows and unknown source freshness. Its private
  installation descriptor was not inspected or changed, and this verifier made
  no provider request. No current SEC filing can yet be opened or saved in the
  Desk.
- No OpenAI Luna request was made: `OPENAI_API_KEY` is absent from the active
  process environment, external requests remain paused, and finite shared
  request/byte/USD limits and account-use approval are not configured in this
  installation. The user's earlier Jev credential is not used for Luna.
- The existing saved-data browser screenshot still proves the chart is visible,
  but the final brief copy and selected-note consent flow were not re-opened in
  the browser because local navigation was rejected by browser policy. UI tests
  do not substitute for that rendered check.

The selected-note consent path is verified at the component/request boundary,
not with a real note or model response. Classifier quality, source-grounded
investor usefulness, the paired AlphaSense study, intended-user outcomes, and
the local SEC Hub remain unverified or blocked. This update does not qualify the
Desk for release.
