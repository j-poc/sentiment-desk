# Real-source collection and recovery trace

Trace ID: `TRACE-20261004-sentiment-desk`

## Mandate and exit condition

The user requested that the Sentiment Desk be improved until its frozen
completion criteria pass. The product must use real source data, select GPT-6
Luna for new classifications, preserve historical Jev records, and keep
Opportunity Radar disabled until Desk operation is proven.

Completion remains open until the product's source, classification, recovery,
UI, engineering, and frozen investor outcome checks pass. A source smoke, test
suite, reviewer opinion, or agent-generated labels cannot substitute for
missing direct product results or observed investor outcomes.

## Method and configuration

The operator authorized use of public-source and API feeds. A single bounded
process used only these collectors: `google_news_rss`, `yahoo_finance_rss`,
`yahoo_quote`, `yahoo_chart`, and `gdelt_doc_api`. It used the canonical local
database at `data/desk.db` from `2026-10-04T00:40:30.480Z` through
`2026-10-04T00:41:43.194Z` for its source requests. Poll intervals were set
beyond the run so each scheduler could perform only its immediate sweep. The
process stopped before another scheduled cycle.

The process started from an empty environment. Its source request and rights
allowlists matched the five collectors above. The classification provider was
`openai_luna`; both provider API keys were empty, both account-use approvals
were false, the provider allowlists were empty, and OpenAI request, byte, and
USD budgets were zero. `ALERT_WEBHOOK_URL` was empty. SEC, Finnhub, Reddit, and
X credentials were empty. `EXTERNAL_REQUESTS_ENABLED` was scoped to this
temporary process only; the saved-data runtime and project defaults remain
offline.

Before the run, SQLite's online backup copied the canonical database to the
ignored local evidence directory. The source and copy both passed `PRAGMA
quick_check`. The baseline copy SHA-256 is
`4c0d880c449c18f16b64c31a4cb20d20d363bbc66e4feb97055636ba6a7b985b`. The
canonical database was not open in another process when collection started.

## Data lineage and results

Google News RSS, Yahoo Finance RSS, Yahoo Finance chart, and Yahoo quote each
returned successful receipts. GDELT produced one failed and one rate-limited
receipt. The run added 101 receipt rows: 24 Google News RSS, 24 Yahoo Finance
RSS, 24 Yahoo chart, 27 Yahoo quote, and two GDELT receipts. The stored response
digest field was present on all 101 rows. For failed or empty outcomes, it
represents normalized empty-item data, not a digest of a retained raw response.
The app does not retain raw feed bodies.

The collectors produced 1,118 new source observations: 936 Google News RSS
and 182 Yahoo Finance RSS. Every observation linked to an existing delivery
receipt. Publisher timestamps ranged from `2026-09-29T18:25:45Z` to
`2026-10-04T00:14:56Z`. Retrieval finished by `2026-10-04T00:41:43Z`.
Publication-to-retrieval age had a 30.58-hour median and 41.86-hour 90th
percentile; 10 items were older than 72 hours. Delivery time is not presented
as publisher event time.

Yahoo chart returned 1,584 saved price points. Yahoo quote added 21 distinct
company price points from 27 successful quote deliveries, which also included
market indices and unchanged source timestamps. The newest quote source time
was `2026-10-02T20:03:10Z`; retrieval on October 4 did not make the closed
market current.

The deterministic exact-normalized-title audit found 106 repeated-title groups
among the 1,118 collected observations, with 258 source records in those
groups. Eighty groups crossed collector feeds and 76 had multiple publisher
domain labels. These are duplicate cues only. They do not prove one story or
independent reporting.

## Verification and limits

All 1,118 new observations have `pending` judgment state. The database gained
zero new scored, failed, or off-target judgments; zero provider request
reservations or attempt events; and zero alert attempts, outbox items, or
receipts. The pre-shutdown health endpoint reported zero classifier requests,
zero reservations, no configured or enabled alert destination, and the exact
five approved collectors. Storage remained `ready` with more than 10 GB free.

After stopping the collector, the canonical database passed
`PRAGMA quick_check` and `PRAGMA foreign_key_check` returned no violations.
The production service restarted against the canonical database with external
requests disabled. Its API returned the 24-company set, 100 saved AAPL records
including 20 pending items on that page, and 27 local Yahoo price points. The
AAPL 24-hour Luna categorical chart contained zero classifications and 97
empty time buckets.

An exact replay of one real Google News observation was run through
`Desk.insertObservation` against a separate copy of the post-run database. It
returned the same identity with `inserted=false`; the copy retained the same
13,627 source-observation and judgment counts and passed SQLite integrity
checks. No second network call or canonical write was used for the replay.

The product remains incomplete. GDELT availability, direct Luna API access,
finite model account spending authority, a real Luna classification run,
model-quality evaluation, historical provider reconciliation, small-cap
discovery, complete fundamental research, linked old delivery lineage, and
observed investor/analyst outcomes remain open. The in-app browser rejected the
local preview URL, so no rendered screenshot was captured. The saved-data UI
is available at `http://127.0.0.1:8798/`; the local collection and replay
artifacts are under `.engineering-evidence/collection-only-2026-10-04/` and
are excluded from Git.

## Reproduction

Use the built `dist/server/index.js` with `env -i`, setting the five source
collectors in both source allowlists, matching the zero-budget/empty-credential
configuration above, and using a disposable verified backup before any repeat.
The saved-data verification uses `EXTERNAL_REQUESTS_ENABLED=false`. The private
one-record replay check is `.engineering-evidence/collection-only-2026-10-04/replay.ts`.
Do not copy the private database or evidence directory to GitHub.
