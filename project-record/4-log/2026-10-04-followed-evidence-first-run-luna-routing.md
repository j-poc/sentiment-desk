# Followed-company evidence, true-empty first run, and Luna-only routing

Trace ID: `TRACE-20261004-followed-evidence-first-run-luna`

## Decision and observable acceptance

The user asked to continue improving Sentiment Desk until its full real-data
acceptance passes. Opportunity Radar remains held. No demonstration or
synthetic observation may appear in live product data.

This checkpoint has a narrower local completion condition:

1. A company baseline is created only by an explicit action and stores the
   exact receipt-qualified real observation IDs captured at that time. It is
   append-only, bounded, idempotent, conflict-aware, and recoverable.
2. Later eligible observations are read in stable bounded pages with source,
   publisher, retrieval, ingestion, and late-arrival clocks visible. The UI
   describes these as newly eligible evidence and does not claim materiality,
   price impact, or a trading signal.
3. A zero-evidence installation shows a real empty state, no archived or
   demonstration result, and a direct route to the source/operations controls.
4. New classifications use OpenAI GPT-6 Luna only. Historical Jev judgments
   remain separate and readable. Missing credentials, approval, source scope,
   or finite budgets leave new rows pending without another-provider fallback.
5. Tests use isolated temporary databases; no fixture becomes product data.

The whole-product exit condition remains the frozen 19-item contract in
`engineering-contract.json`, including no-ticker company discovery,
filing-backed fundamental triage, real Luna outputs and usage evidence,
source/account proof, observed investor workflows, and the Master Eval.

## Implementation

- Added schema version 12 tables for per-company baseline versions and exact
  saved-observation membership. SQLite triggers prevent later update or delete.
  Capture verifies source delivery identity, successful/partial delivery and
  terminal ingestion, applies a 50,000-observation ceiling, checks the expected
  current baseline, and commits the baseline and its items atomically.
- Added GET and POST routes with bounded page sizes, strict UUID/cursor
  validation, explicit conflict handling, and retry-safe capture keys.
  Comparison pages bind a fixed snapshot time, source-row boundary, company,
  baseline, and stable keyset cursor. Late publisher and ingestion clocks are
  reported separately.
- Added a keyboard-operable panel for capturing and resetting a baseline,
  retrying current or later pages, opening the source evidence, and displaying
  the actual loading, empty, failed, stale, and confirmation states. It labels
  evidence as non-material until independent business context is available.
- Removed the separate archived SEC-to-Jev object from the first-run API and
  UI. Added a button that opens and focuses the collapsed Sources & operations
  panel.
- Removed TypeSafe credential fallback and production dispatch. Startup rejects
  `CLASSIFICATION_PROVIDER=typesafe`; OpenAI GPT-6 Luna is the only new-record
  route, subject to existing credential, approval, source allowlist, and finite
  request/byte/USD controls. The testable parser type is narrowed to the
  accepted provider, and the contract's classifier command now runs the
  provider-selection tests.
- Corrected small storage values to display MB instead of GB.

No new external dependencies were added. The canonical SQLite database was not
directly read, written, migrated, or copied. No API key was read or printed;
no source-provider, Jev, or OpenAI model request was made during this iteration.

## Evidence

The application-source candidate is based on HEAD
`22a7b860dc97b7f72a1d37b2ad918a950aba911c` with 26 changed source/config/test
paths and digest
`4bd10d178d5c4c4380fc045dd8fca6b1762a16566086e98bc24513400f9665f1`.

- `npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000`: **PASS**,
  589 tests across 70 files. The run prints two teardown warnings because
  asynchronous company snapshot callbacks outlive temporary test databases;
  no test failed.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**. Vite reports the existing 677 KB minified JS
  chunk-size warning; the built asset is 202 KB gzip. The server bundle is
  440.5 KB.
- `git diff --check`: **PASS**.
- `npm audit --omit=dev --audit-level=high`: **PASS**, zero vulnerabilities.
- Gitleaks: **PASS**, no leaks in the 11.32 MB scanned. It skipped ignored
  `data/desk.db` at 97 MB; that database is excluded from staging and upload.
- Isolated first-run browser preview at `127.0.0.1:54836`: zero eligible saved
  observations; charts hidden; all collection and classification requests
  disabled. The new Sources & operations control opened and focused the
  collapsed panel. This verifies only the true-empty route and disclosure
  action.
- Read-only use of the actual saved-data interface at `127.0.0.1:8798` showed
  that selecting AMD updates the selected company and historical Jev series
  (29 score buckets) and feed. This is saved-history interaction evidence,
  not current price, Luna, or baseline-capture evidence. External requests were
  paused in that runtime.
- The focused baseline persistence, restart, replay, immutability, conflict,
  pagination, failure, and component tests passed within the full suite. No
  baseline was captured in real user data, so real-data rendering of a
  populated baseline remains unverified.
- A fresh read-only whole-product engineering review returned **FAIL, about
  4/10**. It found no new defect in the exact-membership baseline path, while
  confirming that discovery, fundamental triage, interpreted material change,
  live Luna, investor outcomes, and the current GitHub checkpoint were still
  incomplete at review time.
- The independent UI source review previously rated the interface 7/10 and
  found the first-run route hidden. This candidate implements that route and
  the isolated browser interaction verifies the fix. No new intended-user
  study or fresh overall 10/10 UI score was produced.
- A fresh GPT-6.1 Sol xhigh advisor ranked filing-backed fundamental evidence
  and company triage as the next investor-value milestone. It advised keeping
  public business-fact comparisons separate from causal or investment claims.

## Non-passes and next work

`python3 /Users/jurgis/.codex/scripts/live_data_etl_gate.py check --workspace .`
returns **FAIL**: historical ETL evidence is stale for current code/config, and
the authorized keyless Compose smoke has no current passing evidence.
`engineering_gate.py check` reports a missing evidence receipt. The full
engineering gate was not run: its declared commands also consume private
classification and outcome artifacts and launch the Compose source smoke.
The current host showed about 1.2 GiB free and cannot safely start the
previously required 32 GiB verification VM. These are recorded non-passes, not
silently skipped acceptance criteria.

The full application still starts from a fixed 24-company large-cap universe.
It has no no-ticker small-cap discovery or CompanyFacts fundamental-triage
path. The followed-company panel surfaces eligible evidence but does not infer
materiality, business drivers, independent source origins, counterevidence, or
next checks. OpenAI credentials and an independently verified finite account
budget/usage readback are absent in this verification environment; no live
Luna result or reconciliation of the 4,700 `legacy_unknown` records exists.
Provider-specific source terms remain unverified beyond the operator's broad
rights attestation. Frozen AlphaSense comparison and intended-user results are
also absent.

The bounded next implementation is filing-backed fundamental evidence and
selected-company triage using the existing SEC provenance path, after checking
current official docs and compatible maintained financial-data routes. Its
required facts must retain issuer identity, accession, acceptance/filing time,
period, unit, retrieval time, and amendment lineage. Comparisons must withhold
incompatible or ambiguous periods and must not claim causation. No-ticker
discovery, small-cap labeling, real Luna qualification, user outcomes, and full
Desk completion remain separate acceptance gates. Opportunity Radar remains
disabled.

The code checkpoint was committed as
`646579ba4e0c7e00906adc6b61c7a0e2f9edf266` with message
`feat(sentiment): add followed evidence baseline and Luna-only routing` and
pushed to `https://github.com/j-poc/sentiment-desk`, branch
`codex/real-data-rebuild`. `git ls-remote` read back the same SHA. The existing
GitHub repository is public; this task did not change visibility or add a
license. The branch was clean immediately after the push. This checkpoint is a
reviewed progress milestone, not a full-product pass.
