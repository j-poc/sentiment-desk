# Feed pagination and health isolation — 2026-09-29

Trace ID: `TRACE-20260929-feed-pagination-and-health-isolation`

Implementation checkpoint: `485490d` (`fix(collectors): preserve provider coverage and isolate quote health`),
pushed to `origin/codex/real-data-rebuild`.

## Request and acceptance

Continue the Sentiment Desk operational build while keeping source requests and
Jev dispatch disabled. Preserve paginated X and Reddit coverage, prevent
unrelated Finnhub/index receipts from misstating company-feed health, report
GDELT cap saturation truthfully, and keep progress/recovery durable. Live
product data remains real-source-only; test fixtures stay isolated in automated
tests.

## Findings and changes

- The X collector previously advanced `x:since:<company>` after the first
  response and ignored the provider's `meta.next_token`. That could permanently
  skip older matching posts when one response was capped. The adapter now
  passes `next_token`, stores a durable SQLite continuation with the original
  `since_id`, maximum ID seen, query, page size, and page number, and advances
  the committed ID only after the final page. Both the in-progress continuation
  and committed cursor carry the exact query and page-size fingerprint. Legacy
  cursors without a fingerprint, or cursors whose query changed, are cleared
  and replayed from the recent window; source-item identity makes duplicates
  idempotent. A malformed committed ID is discarded unless it is null or
  decimal digits, so damaged state cannot create an endless invalid `since_id`
  retry. It fetches one page per company per scheduled cycle, preserving the
  existing request cadence and page cap.
- A continuation rejected with HTTP 400, 410, or 422 records a failed delivery,
  clears only the continuation, and leaves the last committed `since_id`
  unchanged so the next cycle can replay from that cursor. Invalid/missing
  pagination metadata and malformed/empty `next_token` values fail closed and
  cannot advance the committed cursor.
- `deliveryHealth` keeps the latest receipt per collector, company, and adapter
  version. Finnhub health filters to `finnhub-news/1` for its news row, so
  earnings/calendar success, failure, or partial receipts cannot fabricate or
  degrade news coverage. The database test confirms earnings alone yields
  `never`, then news success remains `current` after later earnings failures.
- The X poller test closes and reopens a file-backed SQLite database between
  pages, checks the exact persisted cursor and committed post ID, and verifies
  current health after the final page. A separate recovery test rejects a
  continuation and verifies replay from the prior committed `since_id`.
- README now describes bounded, resumable X pagination.
- Reddit now follows its listing `after` cursor one page per company per
  scheduled cycle, persists the cursor and exact query/page-size fingerprint,
  resumes after a SQLite restart, and clears/replays when a cursor is rejected
  or does not advance. Each non-terminal page is recorded as partial until a
  terminal page succeeds. The provider's `after` pagination contract is
  documented in the [official Reddit API reference](https://www.reddit.com/dev/api/).
- GDELT now asks for its documented 250-row maximum. The adapter preserves the
  raw provider row count before discarding malformed rows; reaching the
  requested cap, including with null or otherwise unusable rows, records a
  partial delivery with a truncation notice. This does not add provider-side
  pagination or prove complete coverage. The provider cap is documented in
  [GDELT's DOC API guide](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).
- Yahoo index quote receipts no longer affect company quote health or company
  quote counters. An index failure emits one warning; recovery survives a
  database close/reopen, and the warning/recovery event and durable state
  transition are written atomically.
- Regression coverage includes GDELT raw-cap saturation with malformed rows,
  Yahoo index-health isolation and restart recovery, plus the Reddit page-chain
  restart and rejected-cursor paths.

The code changes are in `README.md`, `server/db.ts`, `server/index.ts`,
`server/market.ts`, `server/schedule.ts`, `server/sources/gdelt.ts`,
`server/sources/reddit.ts`, `server/sources/x.ts` (in the preceding code
checkpoint), and the database, market, GDELT, and provider-poller tests.

## Source and side-effect boundaries

No X, Finnhub, SEC, RSS, GDELT, Reddit, Yahoo, or Jev request was sent for this
change. Poller tests inject local mock HTTP responses. The fresh-process
verifier intercepts external fetches before network access. The UI's separate
saved-data-only browser evidence remains recorded in
`2026-09-29-collector-operations-hardening.md` and uses an isolated database
copy; it does not prove a current external delivery.

The X endpoint's documented recent-search window is seven days. Resuming a
continuation does not make the feed exhaustive if the process is inactive past
that window, provider access is restricted, or the query omits relevant posts.
The adapter's query and `next_token` usage follow the [official X Recent Search
guide](https://github.com/xdevplatform/docs/blob/main/docs/x-api/posts/search/quickstart/recent-search.mdx).
Other bounded queries are: Google News asks for two days; Finnhub's default
backfill is five days; Reddit requests 25 newest link posts from a one-week
search and follows returned listing cursors; GDELT requests up to 250
English-language results from two days, but a response at that cap is still
partial; SEC polls 8-K/8-K/A filings accepted within three days; Yahoo RSS is
one provider feed response per ticker. These have no completeness claim.
“Current” delivery health means the configured request completed for its
watchlist, not that all public activity was observed. Provider access, rights,
and feed completeness remain open.

An aggregate read-only audit of the isolated local database copy found 4,700
saved Jev judgments on `legacy_unknown` observations (3,958 scored and 742
off-target), all labeled `jev-1.13.0`; saved usage fields totaled 9,706,499
input tokens and 1,797,596 output tokens, with an estimated USD 0.407673 input
cost under the recorded unit rate. Migrated `score_attempts` values were zero.
These saved fields are estimates, not provider request receipts or an invoice;
the zero counters do not prove no historical transmission. No source text,
request payload, provider logs, credentials, or billing records were read.
Historical usage and billing therefore remain blocked pending account-owner
records.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 175 tests across 24 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**; default startup served all 24
  configured companies with every provider paused and zero attempted fetches.
  Nine collector-specific guarded probes and the positive-budget
  Jev/source-mismatch probe passed with fetch intercepted before network
  access. The script ran the production build.
- The production client retains its existing Vite main-chunk warning at
  531.79 kB; the build succeeds.
- `git diff --check` — **PASS**.
- Independent read-only review found and drove fixes for cross-adapter Finnhub
  health, rejected X/Reddit continuation tokens, query changes and legacy
  cursor replay, malformed pagination metadata, corrupt committed IDs, GDELT
  raw-row saturation with malformed rows, Yahoo index/company health
  isolation, and durable warning/recovery transitions. Follow-up reviews
  confirmed these scoped findings are closed. Post-drain page-chain health is
  `current`: `deliveryHealth` selects the latest receipt per company and
  adapter, so a terminal page supersedes its earlier partial page.
  The index recovery regression uses an orderly file-backed SQLite close/reopen;
  crash atomicity follows from the transaction boundary and was not tested by
  killing a process mid-transaction.

## Remaining gates

This is a local feed-integrity checkpoint, not external operation, 10/10, or
release readiness. External requests remain disabled. Non-SEC publisher rights,
TypeSafe account authority/terms/telemetry/retention/rejected-request billing
and an approved spend ceiling, SEC contact configuration, independent
real-source Jev labels and quality, historical legacy model-use/billing, and
exhaustive coverage remain unresolved. Opportunity Radar remains downstream of
those Sentiment Desk gates.
