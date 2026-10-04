# Sentiment Desk

Sentiment Desk is a private, single-user research product that can collect from
explicitly enabled public-source adapters. It starts in saved-data-only mode;
live requests require per-source configuration. The repository is visible for
inspection and is not a hosted multi-user data service.

**OpenAI GPT-6 Luna** is selected for new per-item sentiment and event
classification. It uses strict categorical Structured Outputs through Responses;
it does not supply Jev probability vectors or a numeric impact index. Missing
credentials, account/source approvals or finite request, byte and dollar budgets
leave observations pending. No automatic TypeSafe fallback is permitted.
[Official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

Existing genuine Jev judgments remain unchanged under their historical profile.
Luna categories are stored separately and never become synthetic probabilities,
confidence percentages, impact points, reaction metrics or numeric alerts.
Both profiles remain independently unvalidated until their own real-source
qualification is complete. This build supplies decision support and source
inspection; it has no autonomous trading authority.

## What is real

- **Mentions**: Google News RSS, Yahoo Finance headline RSS, and GDELT DOC 2.0
  are keyless collectors; their live availability can vary. SEC EDGAR company
  submissions and filing text are collected using the configured watchlist.
  Optional Finnhub, Reddit, and X collectors start only when both their
  credentials and matching external-source allowlist entries are configured.
  X recent-search pages resume from a persisted continuation cursor and only
  advance the committed post ID after the page chain completes; the endpoint
  still covers a bounded recent window and the configured search terms.
  Reddit search also resumes its provider listing cursor one page per poll.
  GDELT requests up to its documented 250-article maximum and marks a response
  at that cap as partial coverage because older matches may be omitted.
  Every item keeps publisher identity, source identity, and source, provider,
  retrieval, and ingestion clocks separately. Missing source time stays
  unknown. New observations link to an immutable delivery receipt; older saved
  observations without a stored receipt remain labeled unlinked historical data.
- **Market data**: explicitly allowlisted Yahoo Finance endpoints supply quotes
  and historical price context. Quote currency, provider observation time, retrieval time,
  and cache/network state stay separate. Quotes older than 15 minutes, or
  quotes without an observation time, are visibly marked in the tape,
  watchlist, and selected-company header. Price charts plot only actual
  provider observations inside the selected time window; missing periods are
  left empty and an out-of-window latest quote is never carried forward.
- **Judgment**: Luna requests require `OPENAI_API_KEY`, account-use attestation,
  approved source overlap, and positive finite daily request, serialized-byte and
  estimated-dollar limits. Preparation records prompt/schema/profile and exact
  request hashes. Each result retains actual provider/model/response identity,
  source support and usage; missing evidence is review-required, not neutral.
  Transport-unknown requests are not resubmitted automatically and retain their
  worst-case reservation. Cost estimates are not provider invoices or balances.
  Historical Jev judgments remain readable, but new classification dispatch is
  Luna-only. The retired TypeSafe route cannot be selected for new inputs.

## The terminal

The selected-company workspace links company, history and source evidence:

- **Watchlist**: saved-history and quote freshness; click to select or use `j`/`k`.
  A sparkline requires actual scored records in its window.
- **Company workspace**: starts at seven days of saved history and previews three
  distinct actual source titles. Exact-title repetitions are labeled as rows,
  without claiming independent reporting.
- **Historical chart**: genuine saved Jev record summaries on a fixed −100 to
  +100 impact-point scale. Each populated UTC 15-minute bucket shows its
  weighted mean, record count, and observed minimum/maximum. Empty intervals
  stay visibly blank; values are never connected, carried forward, or decayed.
  Clicking a bucket or using its keyboard table opens the complete 20-bin
  record distribution and paginated source rows for that exact half-open UTC
  interval. Optional price comparison has a separate currency scale and plots
  only sourced provider observations. Luna categories do not populate this
  historical chart; absent history is explicit.
- **Source feed**: bullish, bearish, material, off-target and unscored/review
  filters work with each profile. Luna shows supported categories and source
  quotations; Jev shows its actual probability-derived fields. The drawer links
  the saved collection URL and records source/model request provenance.
- **Sources & operations**: selected-provider gates, source failures, pending
  alert delivery and estimated/reserved usage. Failed health refresh preserves
  the last received evidence and remains visible.
- **First run**: the product reports only history and readiness in the current
  installation. It does not show an out-of-installation archive or a saved
  result that cannot be verified locally.
- **Opportunity Radar**: disabled until Sentiment Desk operational gates pass.

Historical Jev metrics summarize scored source records, not stock returns or
independent investor opinion. Repeated coverage can count more than once.

## Repository rights

This repository currently has no license. Public visibility does not grant
permission to use, copy, modify, distribute, or build from the code; obtain
permission from the copyright holder before doing so.

## Run it

```bash
npm install
cp .env.example .env
```

Start the local API in one terminal. It uses saved real data only by default:

```bash
npm run dev
```

In a second terminal, start the Vite interface, which proxies `/api` to the
local server:

```bash
npm run dev:web
```

To enable the new classifier, configure an OpenAI API key locally and explicitly
set `OPENAI_ACCOUNT_USE_APPROVED=true`, a matching `OPENAI_ALLOWED_COLLECTORS`
entry and finite `OPENAI_MAX_REQUESTS_PER_DAY`,
`OPENAI_MAX_REQUEST_BYTES_PER_DAY` and `OPENAI_MAX_DAILY_COST_USD` values.
External requests and source rights must be enabled separately. All defaults
keep dispatch off. Do not paste keys in Git, logs or issue descriptions.

`CLASSIFICATION_PROVIDER=typesafe` is rejected. Existing Jev judgments remain
available under their saved historical semantics, but the application does
not send new input to TypeSafe or silently move failed Jev work to Luna.

The SEC's [EDGAR reuse FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions)
states public filing content is free to access and reuse, subject to SEC
policies and fair-access limits. This is the only currently documented narrow
source path for a first real-source classification evaluation; configure a descriptive
`SEC_USER_AGENT`, set `EXTERNAL_SOURCE_COLLECTORS=sec_edgar` to collect only
EDGAR filings, and separately set `OPENAI_ALLOWED_COLLECTORS=sec_edgar` for
Luna. Effective forwarding is the intersection of request, rights and
provider lists, so a provider-only collector setting
cannot forward retained records from a source that is currently disabled.
Real-source Luna classification quality remains unvalidated. Isolated fixture
checks establish logic only; retained historical Jev judgments do not qualify
the new Luna profile. The frozen
labeling, sampling, metrics, and pass/fail rules are in
[`sentiment-desk-completion.md`](project-record/3-project-specs/sentiment-desk-completion.md).
A source allowlist is a technical control, not proof of rights. New Luna
classification remains off until direct OpenAI API access, provider-specific
permissions, and finite account spending limits are configured.

```bash
npm run dev                # saved real data only by default on :8787
```

After applicable source and account terms are confirmed, explicitly opt in to
live provider traffic and add only the cleared source to both source lists:

```bash
EXTERNAL_REQUESTS_ENABLED=true EXTERNAL_SOURCE_COLLECTORS=sec_edgar SOURCE_RIGHTS_APPROVED_COLLECTORS=sec_edgar npm run dev
```

Set a descriptive `SEC_USER_AGENT` in `.env` before using the SEC-only example.
SEC ticker-directory lookup runs after the local API is available; transient
failures are recorded in delivery health and retried on the SEC polling cadence.
The global opt-in pauses every external request by default; even after it is
enabled, only collectors listed in both `EXTERNAL_SOURCE_COLLECTORS` and
`SOURCE_RIGHTS_APPROVED_COLLECTORS` can poll or fetch charts. The second list is
an operator attestation, not independent verification of rights. Credentials
alone do not enable a collector. Luna has its own account,
source, request/byte/USD controls described above. Keep publisher feeds and Yahoo quote/chart
endpoints out of the approval list until their exact use rights are established.

Production:

```bash
npm run build              # web -> dist/web, server -> dist/server
npm start                  # one process serves API + UI on :8787
```

## Rebuild and run with real data

Docker Compose builds the server and dashboard from source and stores SQLite
history in a named volume. It defaults to saved-data-only mode. After applicable
source and account terms are confirmed, set `EXTERNAL_REQUESTS_ENABLED=true`
and matching source-by-source request and approval lists. For example,
`EXTERNAL_SOURCE_COLLECTORS=sec_edgar` plus
`SOURCE_RIGHTS_APPROVED_COLLECTORS=sec_edgar` enables SEC filings only; SEC
still requires a valid `SEC_USER_AGENT`. Luna remains disabled until its own key,
account/source flags and positive finite request/byte/USD caps are configured.
`CLASSIFICATION_PROVIDER=typesafe` is rejected; persisted Jev classifications
remain read-only historical records.
Optional Finnhub, Reddit, and X credentials do not enable those sources unless
both their request and approval entries are present.

```bash
docker compose up --build
```

To explicitly enable live source polling:

```bash
EXTERNAL_REQUESTS_ENABLED=true EXTERNAL_SOURCE_COLLECTORS=sec_edgar SOURCE_RIGHTS_APPROVED_COLLECTORS=sec_edgar docker compose up --build
```

Docker Compose 2.24 or newer is required for optional `.env` loading ([Compose
reference](https://docs.docker.com/reference/compose-file/services/#env_file)).
Open <http://127.0.0.1:8787>. The service binds to this computer only. To add credentials or change settings,
copy `.env.example` to `.env` and edit that local file; `.env` is ignored by Git
and excluded from the Docker build context. Compose does not mount your host
`~/.newsjack/.env` file into the container.

The database survives container rebuilds and `docker compose down`; `docker
compose down -v` removes the saved database. To inspect the running service,
use `docker compose logs -f sentiment-desk`.

The application has no synthetic-data runtime. All displayed mentions must
come from configured source collectors, and all sentiment/event judgments
must come from the recorded provider. New categorical judgments use Luna;
historical Jev probabilities retain their own provenance. Unconfigured judgments stay pending; generated fixtures
are confined to automated tests and frozen evaluations. Existing simulation
rows from older versions remain stored for auditability but are excluded from
the UI, aggregates, retry queue, and usage totals. EDGAR filings without
retrievable document text are reported as partial delivery and never scored
from locally constructed replacement text.

To verify a live, credential-free Compose rebuild and persistent-volume
recovery, first obtain and configure source-use approvals for Google News RSS,
Yahoo Finance RSS, GDELT, Yahoo quote, and Yahoo chart. Then export
`SOURCE_RIGHTS_APPROVED_COLLECTORS=google_news_rss,yahoo_finance_rss,gdelt_doc_api,yahoo_quote,yahoo_chart`
and run `./scripts/verify-live-compose.sh`. The script refuses to self-approve
these sources. It uses a temporary Compose project, disables classifier calls and optional
credentialed sources, checks live quote and news-source health through the API,
recreates the container, then removes only its temporary volume.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLASSIFICATION_PROVIDER` | `openai_luna` | new-record classifier; `typesafe` is rejected, historical Jev remains read-only |
| `OPENAI_API_KEY` | empty | direct OpenAI API credential; never derived from Codex/ChatGPT authentication |
| `OPENAI_ACCOUNT_USE_APPROVED` | `false` | authorized account-use attestation; not independent account/terms verification |
| `OPENAI_ALLOWED_COLLECTORS` | empty | classifier admission intersected with enabled and rights-approved sources |
| `OPENAI_MAX_REQUESTS_PER_DAY` | `0` | durable UTC-day request reservation cap |
| `OPENAI_MAX_REQUEST_BYTES_PER_DAY` | `0` | durable serialized request-byte cap |
| `OPENAI_MAX_DAILY_COST_USD` | `0` | finite daily estimated cost cap; unknown/unpriced outcomes retain reservation |
| `EXTERNAL_REQUESTS_ENABLED` | `false` | Set `true` to allow configured source and selected-classifier requests; the default serves saved local data only. |
| `EXTERNAL_SOURCE_COLLECTORS` | empty | Comma-separated real collectors permitted to make network requests; examples include `sec_edgar`, `google_news_rss`, `yahoo_quote`, and `yahoo_chart`. Empty means no source polling or remote chart requests. |
| `SOURCE_RIGHTS_APPROVED_COLLECTORS` | empty | Separate operator-attestation allowlist; a requested collector without this entry cannot make requests. It does not independently prove rights. |
| `X_BEARER_TOKEN` | — | enables the X source; optional |
| `SEC_USER_AGENT` | empty (SEC disabled) | required descriptive SEC User-Agent with operator contact information |
| `POLL_SEC_SECONDS` | `90` | EDGAR submissions poll cadence |
| `POLL_GDELT_SECONDS` | `300` | GDELT breadth poll cadence |
| `POLL_RSS_SECONDS` | `180` | Google/Yahoo RSS poll cadence; backs off source-wide on HTTP 429 |
| `POLL_X_SECONDS` | `180` | X poll cadence |
| `POLL_QUOTES_SECONDS` | `90` | market quote poll cadence; Yahoo 429 cooldown is shared with its RSS feed |
| `POLL_FINNHUB_SECONDS` | `120` | Finnhub poll cadence |
| `POLL_REDDIT_SECONDS` | `180` | Reddit poll cadence |
| `BACKFILL_DAYS` | `5` | Finnhub company-news backfill window |
| `RSS_CONCURRENCY` | `2` | maximum concurrent RSS requests; provider requests are spaced one second apart |
| `INDICES` | `SPY,QQQ,^VIX` | context rows on the tape (never scored) |
| `SCORE_CONCURRENCY` | `6` | maximum concurrent classifier calls after source and budget admission |
| `DB_PATH` | `./data/desk.db` | SQLite file |
| `COMPANIES_PATH` | `./config/companies.json` | watchlist |

The watchlist (`config/companies.json`) is plain data: id, name, ticker,
sector, aliases (used by the match guard; feed queries use name + ticker), and
an accent color.

## The rubric

Jev applies the same fixed rubric to every item. The schema covers sentiment,
company and investor relevance, materiality, novelty, credibility, event type,
magnitude, surprise, and takeaway. Its SHA-256 is stored on every judgment.
Luna uses a separately versioned categorical prompt/schema based on supported
sentiment, event, takeaway, aboutness and relevance concepts. A supported
quotation and summary are required before accepting sufficient evidence. Its
boolean material label is not Jev materiality, and no scalar fields are
invented. The disabled Radar retains historical Jev's
saved event type and sentiment; it makes no additional model call.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/companies` | watchlist snapshots: index, delta, counts |
| `GET /api/companies/:id/series?hours=` | bucketed sentiment series |
| `GET /api/companies/:id/price?ticker=&hours=` | intraday price series for the aligned comparison pane |
| `GET /api/companies/:id/mentions?hours=&limit=` | mentions with full scores |
| `GET /api/companies/:id/radar?hours=` | current/prior equal-window event and source summary |
| `GET /api/companies/:id/radar/evidence?hours=&period=&eventType=&offset=&limit=` | paginated source evidence for a Radar category |
| `GET /api/companies/:id/reactions?hours=` | measured price reactions after scored mentions |
| `GET /api/validation?hours=` | watchlist-wide signal validation summary |
| `GET /api/quotes` | latest quotes for tickers and indices |
| `GET /api/tape?limit=` | latest scored mentions across companies |
| `GET /api/health` | sources, selected classifier, legacy Jev health, estimated/reserved usage, events, DB size |
| `GET /api/stream` | SSE: `hello`, `mention`, `company`, `quotes`, `ping` |

## Architecture

```
server/
  index.ts      boot, wiring, graceful shutdown
  config.ts     env + credential chain + watchlist loading (zod-validated)
  db.ts         node:sqlite schema and queries
  rubric.ts     the fixed question set + hash
  openai-classifier.ts  categorical Luna Responses adapter, bounded schema/provenance/usage
  jev.ts        Legacy TypeSafe client: /v1/systemone, retries, contract validation
  scoring.ts    legacy rubric-era scoring module (not a separate Radar classifier)
  pipeline.ts   queue, Jev judgments, state building, snapshots, broadcasts
  radar.ts      deterministic headline/publisher and window aggregation
  delivery.ts   persisted source delivery health and freshness projections
  schedule.ts   RSS + X pollers and company match guards
  market.ts     quote store, poll loop, price-series cache
  sources/      Google/Yahoo RSS, SEC EDGAR, GDELT, Finnhub, Reddit, X, Yahoo quotes
web/
  src/          React + Tailwind 4 terminal (SSE live updates)
tests/          vitest: wire contract, post-rules, RSS parsing
```

Design rules worth keeping as the product grows:

- Provider event/publication times stay distinct from retrieval and ingestion
  times. Missing publisher time is not filled with local fetch time; untimed
  observations remain outside the Radar's publication-time windows.
- A mention is never scored by default; missing answers fail closed.
- The rubric is identical for every company; comparison rests on that.
- Low-confidence and off-target judgments remain visible, just weighted
  honestly.
- Quote failures preserve last-known data with an explicit cache label and
  original source/retrieval times; they are not presented as fresh network
  observations.

## Roadmap

- Broaden source coverage only after provider access, timing, rights, and
  retention contracts are verified. Reddit and X remain credential- and
  terms-dependent; app reviews, search trends, jobs, YouTube, podcasts, and
  arbitrary web scraping are not implemented.
- Evaluate Jev judgments against labeled cases before changing its rubric.
- Keep market-structure, retail-flow, and value-chain analyses out of Radar
  until supported data contracts and independent evaluation exist.
