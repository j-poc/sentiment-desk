# Feed pagination and health isolation — 2026-09-29

Trace ID: `TRACE-20260929-feed-pagination-and-health-isolation`

Implementation checkpoint: `7c996d3` (`fix(ops): preserve paginated source coverage`),
pushed to `origin/codex/real-data-rebuild`.

## Request and acceptance

Continue the Sentiment Desk operational build while keeping source requests and
Jev dispatch disabled. Fix data loss when an X recent-search query returns more
than one page, prevent unrelated Finnhub earnings/calendar deliveries from
misstating news-feed health, preserve truthful progress and recovery state, and
checkpoint only after offline verification. Live product data remains
real-source-only; test fixtures stay isolated in automated tests.

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

The code changes are in `README.md`, `server/db.ts`, `server/index.ts`,
`server/schedule.ts`, `server/sources/x.ts`, `tests/db.test.ts`, and
`tests/provider-pollers.test.ts`.

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
Code review also reconfirmed other bounded queries: Google News asks for two
days; Finnhub's default backfill is five days; Reddit requests 25 newest link
posts from a week; GDELT requests at most 25 English-language results from two
days; SEC polls 8-K/8-K/A filings accepted within three days; Yahoo RSS is one
provider feed response per ticker. These have no completeness claim. “Current”
delivery health means the configured request completed for its watchlist, not
that all public activity was observed. Provider access, rights, and feed
completeness remain open.

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

- `npm test -- --reporter=dot` — **PASS**, 167 tests across 24 files.
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
  health, rejected continuation tokens, query changes and legacy cursor replay,
  malformed pagination metadata, and corrupt nonnumeric committed IDs. The
  final review confirmed those findings are closed. Post-drain health is
  `current`: `deliveryHealth` selects the latest receipt per company and
  adapter, so a completed page chain supersedes its earlier partial page.

## Remaining gates

This is a local feed-integrity checkpoint, not external operation, 10/10, or
release readiness. External requests remain disabled. Non-SEC publisher rights,
TypeSafe account authority/terms/telemetry/retention/rejected-request billing
and an approved spend ceiling, SEC contact configuration, independent
real-source Jev labels and quality, historical legacy model-use/billing, and
exhaustive coverage remain unresolved. Opportunity Radar remains downstream of
those Sentiment Desk gates.
