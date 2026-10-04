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

## Later bounded real-source run — 2026-10-04

Trace: `TRACE-20261004-sentiment-desk`

After this note's original verification, a single collection-only process used
the user's public-source/API rights attestation to call exactly Google News RSS,
Yahoo Finance RSS, Yahoo quote, Yahoo chart, and GDELT. The process ran from
`2026-10-04T00:40:30Z`; its last source receipt completed at
`2026-10-04T00:41:43Z`. It was stopped before another scheduled cycle. Its
startup used `env -i`; both classifier keys were empty, both account approvals
were false, all model budgets were zero, and alert delivery had no webhook.

The canonical database now has 1,118 new source observations, all linked to
delivery receipts. Google News and Yahoo Finance RSS supplied all 1,118. Yahoo
returned 1,584 chart points and 21 new company quote points. The five feeds
created 101 receipts, including 24 successful deliveries each for Google News
RSS, Yahoo Finance RSS, and Yahoo chart, plus 27 successful Yahoo quote
deliveries. GDELT recorded one failure and one rate-limited response. Every new
observation remains pending. There were no new scored rows, model attempts, or
alert deliveries.

The source-time readback found publisher timestamps from
`2026-09-29T18:25:45Z` through `2026-10-04T00:14:56Z`; retrieval completed by
`2026-10-04T00:41:43Z`. The median publication-to-retrieval age was 30.58 hours,
and 10 observations were older than 72 hours. The newest Yahoo price point is
source-timestamped `2026-10-02T20:03:10Z`; retrieval on October 4 did not make
the closed-market price current.

The canonical database passed `quick_check` with zero foreign-key violations.
After stopping collection, an exact replay of one real Google News observation
against a disposable copy inserted no duplicate and changed no observation or
judgment counts. The production app then restarted in saved-data-only mode on
`http://127.0.0.1:8798/`. Its AAPL API path returned 100 saved records with 20
pending items on the page, 27 local price points, and zero Luna sentiment
observations. Opportunity Radar stayed disabled.

The replay database and full aggregate run artifact remain in the ignored local
directory `.engineering-evidence/collection-only-2026-10-04/`; neither the
canonical database nor the private evidence directory was pushed. The in-app
browser policy still prevented a fresh rendered screenshot. The saved-data UI
is available locally at the URL above, but this run does not prove continuous
monitoring, Luna operation, GDELT availability, or investor value.

## Checkpoint correction

The code checkpoint was committed and pushed to
`codex/real-data-rebuild` as
`daed1f7541ad13c84af1e4cfd4ca45d9b69dc6d0`. Remote readback matched that SHA.
This record and the bounded-run trace are being checkpointed separately.
