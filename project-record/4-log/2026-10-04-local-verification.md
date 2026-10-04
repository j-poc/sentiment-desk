# Sentiment Desk local verification — 2026-10-04

## Outcome

The changed build passes its local code and scoped ingestion checks. The full
Sentiment Desk goal is still open: the local product database contains only
historical Jev classifications, and the replacement GPT-6 Luna classifier has
not made a real request or saved a result. Opportunity Radar remains disabled.

## Current evidence

- `npm run typecheck` passed.
- `npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000` passed:
  571 tests in 67 files. The test harness now injects bounded storage limits
  only for temporary test databases. Production defaults remain unchanged.
- `npm run build` passed. Vite emitted a 667.57 kB minified entry-chunk
  warning; code splitting remains an optimization opportunity.
- `npm audit --omit=dev --audit-level=high` found zero vulnerabilities.
- Gitleaks found no leaks in scanned workspace files. Its configured 20 MB
  file limit skipped `data/desk.db`; that user database is excluded from Git.
- `live_data_etl_gate.py verify` passed at `2026-10-04T00:19:08Z`, followed by
  a passing code-bound `check`. The smoke used a disposable Compose database
  and the five explicitly approved keyless sources: Google News RSS, Yahoo
  Finance RSS, GDELT, Yahoo quote, and Yahoo chart. It disabled Jev, Luna,
  Finnhub, Reddit, X, and alerts. The project-specific verification VM was
  stopped after the gate. The main local database was not changed.
- The retained database's newest source retrieval is
  `2026-09-28T17:47:42Z`; the latest publisher timestamp is
  `2026-09-28T17:35:01Z`. This is archival evidence, not a current feed.
- The preview server starts at `http://127.0.0.1:8798/` against a separate
  verified SQLite backup, with external requests and classifiers disabled.
  Codex's in-app browser policy rejected navigation to this local URL, so this
  continuation has no fresh rendered-browser proof. The prior read-only UI
  review confirmed that selecting a company changes the selected chart and
  evidence view.

## Remaining acceptance gaps

- No direct OpenAI API credential or independently verified finite spend
  control is available in the product runtime. Luna remains configured but
  disabled, with zero requests and zero output records. A Jev credential is not
  used as a substitute.
- The 48-case real SEC filing reference artifact is an independent-subagent
  diagnostic. It is not human ground truth or prospective product-quality
  evidence, and the required Luna model-run artifact is absent.
- The prior TypeSafe usage/account and billing data needed to reconcile 4,700
  `legacy_unknown` rows is unavailable. Those price observations remain
  quarantined.
- The fixed 24-company catalog, no-ticker small-cap discovery workflow,
  complete fundamental research path, linked historical delivery lineage, and
  observed investor/analyst outcome study remain incomplete or unverified.
- The whole-build review remains FAIL for operational and investor readiness.
  The successful ETL smoke proves only the declared five-source isolated path;
  it does not prove classifier operation, broad source rights, current saved
  production data, or product value.

## Checkpoint

Repository: `https://github.com/j-poc/sentiment-desk`

Branch: `codex/real-data-rebuild`

Base before this continuation: `e963ef45bf362eb20f93c8a4d6b425752c23d4d1`

The candidate is being checkpointed after review. The commit and remote
readback are recorded in the continuation trace after push. No application
database, `.engineering-evidence` artifact, dependency directory, or secret is
included in the checkpoint.
