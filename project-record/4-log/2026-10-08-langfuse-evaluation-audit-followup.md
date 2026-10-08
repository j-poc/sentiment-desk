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
and collect paired investor-task outcomes. Restore the canonical Hub connection
and verify the resulting SEC filing workflow through its intended rendered
interface before changing any blocked acceptance verdict.
