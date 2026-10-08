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
