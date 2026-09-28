# Offline Jev evaluator hardening — 2026-09-28

## Purpose

The real-source Jev quality gate is still blocked because the account-use,
source-rights, SEC User-Agent, budget-approval, and independent-label
requirements are unresolved. I completed the local evaluation tool so those
requirements cannot be bypassed by an aggregate score, an unsafe retry, an
unbounded run, or incomplete provenance. No real source text was fetched,
opened, or sent to Jev during this work.

## Changes

- The eligible population manifest requires collector and parser versions for
  every observation and includes them in the population and sample digests.
- Standard and strict-identity `about` and `investor_relevant` precision are
  calculated and gated separately. Each slice needs at least 10 positive
  human labels from at least 10 issuer clusters; an under-supported slice is
  `UNVERIFIED`. A regression confirms that mixed-cohort precision above 0.90
  cannot hide strict-identity precision of 0.50.
- Final studies freeze a request limit, estimated USD cost ceiling, approved
  input/output unit prices, approval time, and digest of the approval record
  before sample freeze. The run must use the frozen rates. Request/cost
  overruns fail; missing token usage leaves budget compliance `UNVERIFIED`.
  The local tool validates the attestation format and sequence but does not
  authenticate the underlying approval or provider invoice.
- Each observation permits at most one submitted model request. A second
  request is rejected after any response, rejection, or unknown outcome.
- The final report records the analyzed model-run digest. That digest identifies
  the caller-supplied JSON but does not authenticate a TypeSafe receipt or
  independently verify the reported score or token counts.
- Added `scripts/jev-label-evaluation.ts`, the local CLI
  `scripts/evaluate-jev-labels.ts`, and focused regressions in
  `tests/jev-label-evaluation.test.ts`. Updated the frozen acceptance contract
  and `live-data-etl.json` with the gates, evidence, and remaining limits.

## Evaluation evidence and verification

The tests use generated in-memory fixtures solely to exercise parser and gate
behavior. They are never persisted as product data or presented as model
quality evidence. The intended evaluation dataset remains actual,
rights-reviewed public EDGAR observations with blinded qualified-human labels;
none is currently available for an authorized run. Graders are deterministic
confusion-matrix, per-class, inclusion-boundary, and clustered-bootstrap
metrics. The replay strategy is offline parsing of frozen local label and run
JSON artifacts; the evaluator performs no HTTP, source, database, or Jev call.

- Focused evaluator suite: **19 passed**.
- Full suite: **143 passed across 22 files**.
- `npm run typecheck`: passed.
- `npm run build`: passed. Vite retains the existing 529.62 kB main-chunk
  advisory.
- `npm run evaluate:jev-labels -- --help`: passed and confirms the local JSON
  interface.
- `live-data-etl.json` parsed successfully and `git diff --check` passed.
- Fresh read-only adversarial review found no remaining false-pass path in the
  repaired strict-slice, provenance, budget, or duplicate-request controls.

No application database, source adapter, credentials, provider key, network,
or `output/` artifact was accessed. No real source observation or provider
response was used by the tests.

## Remaining blockers

This implementation work does not make Sentiment Desk 10/10 or release-ready.
No real-source Jev labels or quality estimates exist. SEC User-Agent and source
coverage, exact publisher rights, TypeSafe account/telemetry/retention/billing
terms, independent label review, account-owner budget approval, and historical
provider-use reconciliation remain open. Preserve real observations as pending
until these gates are resolved and a real evaluation is authorized. Opportunity
Radar remains downstream of an operationally validated Sentiment Desk.
