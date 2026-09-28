# 2026-09-28 — Real-data-only runtime and chart recovery

## User outcome and constraints

The user requires application data to be real, with no demo or synthetic
observations. Jev remains the intended per-item sentiment/event classifier.
Opportunity Radar continues to consume persisted Jev judgments. With no Jev
key configured, source records must stay pending; the application must not
invent a judgment. Public-source rights and TypeSafe retention/billing remain
open, so this run did not send publisher text to Jev.

## Runtime changes

- Removed the demo-data generator and demo mode from the application, config,
  scheduler, package scripts, and production interface. New simulation
  observations and delivery records are rejected. Legacy simulation rows,
  if present in an older database, are preserved for audit and excluded from
  views, aggregates, retries, and usage.
- Made company charts use source-timestamped price observations only. The API
  returns in-window points unchanged and in order, preserves the latest source
  timestamp for an empty window, and rejects a ticker/company mismatch.
- Added visible quote observation age in the tape, watchlist, and selected
  company header. Retrieval time stays separate from the provider observation
  time.
- Hardened the GDELT adapter to reject malformed/non-JSON bodies with a
  bounded error rather than exposing provider response text or ingesting it as
  an article.
- Fixed keyless Jev handling: ingestion does not queue for a missing engine,
  startup does not drain pending records without a configured judge, and the
  guard no longer increments Jev failure counters. Real items remain pending
  without an error or default score.

## Verification

Code revision at the start of this verification was the dirty branch
`codex/real-data-rebuild`; the final checkpoint is recorded in Git after this
log. The isolated production server ran at `http://127.0.0.1:8794/` against
`/private/tmp/sentiment-desk-real-only.CnCHE9/desk.db`, with an explicitly
empty `TYPESAFE_API_KEY` and optional X/Finnhub/Reddit credentials. The
runtime ID after a clean backend restart was
`a7cadbf9-82f6-45ce-889f-7b3f1f517935`.

- `PASS` — read-only SQLite inspection found 1,361 observations: 1,119 from
  `google_news_rss`, 241 from `yahoo_finance_rss`, and 1 from `sec_edgar`.
  There were zero `demo_simulation` observations, zero `demo-sim` judgments,
  and all 1,361 judgments were pending.
- `PASS` — live API readback returned real ADBE source rows from Google News
  RSS and Yahoo Finance RSS, with HTTP source URLs and `pending` status. The
  browser displayed the source rows as “awaiting judgment.”
- `PASS` — Jev health was disabled with 0 successes, 0 failures, no last error;
  usage was 0 judgments, 0 input/output tokens, and $0 estimated input cost.
  New real observations continued to arrive while Jev remained off.
- `PASS` — the Adobe 24-hour price response returned zero points and retained
  the last actual observation timestamp (2026-09-25 20:00:00 UTC) as metadata.
  The 7-day response returned 67 actual Yahoo Finance observations with 67
  distinct prices, from 2026-09-21 13:30:00 UTC through 2026-09-25 20:00:01
  UTC. The live browser drew this varying series, explicitly said “No Jev
  scores in this window,” and showed the quote as “source 2d ago.”
- `PASS` — browser selection changed Adobe→NVIDIA→Adobe; the company heading,
  quote, and company-specific real source mentions changed with the selection.
  A mismatched AAPL ticker on Adobe's API path returned HTTP 409.
- `PASS` — after the keyless queue fix, the live health panel showed `jev-latest
  · off`, 0 judged, $0 estimated input, and no Jev errors. Browser console
  contained zero errors and warnings. The live UI remains open at the verified
  Adobe 7-day chart.
- `PASS` — `npm test -- --reporter=dot`: 93 tests across 15 files;
  `npm run typecheck`: pass; `npm run build`: pass. Vite still reports the
  existing 529.50 kB main chunk above its 500 kB advisory threshold.
- `PASS` — focused tests cover simulated collector rejection and legacy-row
  exclusion; null-Jev pending behavior; exact source chart windows; quote age;
  and GDELT plain-text rejection, HTTP 429 preservation, and valid JSON
  normalization.

## Degraded or unverified boundaries

- GDELT's current delivery is `HTTP 429`; the adapter's plain-text rejection
  is proven by fixtures, but a post-fix live HTTP-200 non-JSON response was not
  observed in this run. Prior successful evidence is retained; no missing
  GDELT activity is inferred.
- Finnhub, Reddit, and X are disabled because no credentials were supplied.
  Source coverage and pagination are not exhaustive.
- Yahoo Finance chart/quote endpoint terms, publisher snippet rights for
  storage/display/model processing, SEC text-use terms, TypeSafe retention, and
  rejected-request billing are unresolved. No real-source Jev request was
  made; classifier quality on real source material remains `NOT RUN`.
- The current market snapshot is delayed relative to the live clock and is
  explicitly labeled by source age. The 7-day history is historical provider
  data, not a real-time intraday stream.

The application UI uses real source observations only. Synthetic examples
remain in isolated unit/evaluation fixtures and historical records; they were
not loaded into this application database, shown in the live UI, or sent to a
model in this verification.

## Final post-build restart check

After the final database-filter regression was added, the built server was
restarted again at `http://127.0.0.1:8794/` against the same isolated
`DB_PATH`, with an explicitly empty `TYPESAFE_API_KEY`. Runtime ID:
`2735fb88-dd14-4f9d-ab08-1a1fd18c59e9`.

- `PASS` — read-only SQLite inspection found 1,496 source-backed records:
  1,248 `google_news_rss`, 247 `yahoo_finance_rss`, and 1 `sec_edgar`.
  Zero observations used `demo_simulation`, zero judgments used `demo-sim`,
  and all 1,496 judgments remained pending. The UI showed 1,490 records
  collected in its rolling 24-hour window; this is a different denominator
  from total retained DB rows.
- `PASS` — Adobe's live mentions API returned pending rows with publisher
  names, collector identity, and source URLs; its browser list showed the
  same source-attributed items as awaiting judgment.
- `PASS` — Adobe 24H had no in-window source price observations and retained
  the latest real source time. Adobe 7D returned 67 points with 67 distinct
  prices. The fresh browser displayed the varying 7D chart and “No Jev scores
  in this window”; the source-age label remained visible.
- `PASS` — health reported Jev disabled, zero judgments, zero failures, and
  zero usage. Google News RSS, Yahoo Finance RSS, SEC, and Yahoo quotes
  delivered; GDELT was currently failing with HTTP 429, and optional feeds
  were disabled. This is a source-coverage limitation, not evidence of no
  activity.
- `PASS` — Adobe's mismatched AAPL price request returned HTTP 409. The full
  suite (93 tests across 15 files), typecheck, and production build had passed
  after the final code edit. The existing 529.50 kB Vite chunk advisory
  remains.
