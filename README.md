# Sentiment Desk

Sentiment Desk has a local research app and an authenticated cloud research
app. Local mode is single-user. Cloud mode keeps company research workspaces
private to each signed-in account and shares published SEC source data.

Cloud mode starts from saved data and retrieves shared SEC records on explicit
refresh. Local mode can retrieve public SEC issuer, filing, and CompanyFacts
records out of the box; other external collectors remain disabled by default.
Every model request still requires a per-item or per-company review and send
action. Local provider keys are stored in the operating system credential
store. Cloud company assessments accept OpenAI or Gemini keys for one request
and do not save them in application storage.

Local source classification supports three separate provider choices. OpenAI
uses GPT-6 Luna and Gemini uses Gemini 3.8 Flash for categorical source
classification. TypeSafe Jev keeps its own sentiment rubric and result history.
The local app stores each provider key in the operating system credential store.
Saving or verifying a key does not classify a source. You choose a saved source,
review what will be sent, and authorize each model request.

Cloud company evidence assessments support OpenAI GPT-6 Luna and Gemini 3.8
Flash. The user supplies a key for the individual request. TypeSafe Jev remains
a source-level workflow and is not a company-fundamentals assessment. These
provider paths do not silently substitute one model for another.

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
- **Judgment**: local OpenAI and Gemini requests use source-level categorical
  outputs. TypeSafe Jev uses its separate source-level rubric and probability
  fields. Provider keys, source approvals, external-request gates, and local
  daily request and byte limits apply before a request can run. The app records
  provider, model, source identity, and request outcome. It does not claim to
  know provider billing or account quota. Uncertain delivery is not retried
  automatically. Cloud company assessments use selected SEC facts and filing
  metadata; filing text is not sent. Their citations identify supplied records,
  but do not independently prove that every model interpretation is correct.

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
- **Data connections & operations**: selected-provider gates, source failures, pending
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

Start the local API in one terminal. A fresh local install can retrieve official
SEC issuer, filing, and company facts without a separate backend account or API
key. Non-SEC sources remain off unless separately configured:

```bash
npm run dev
```

In a second terminal, start the Vite interface, which proxies `/api` to the
local server:

```bash
npm run dev:web
```

For local model access, open **Model API Keys**, enter a key for OpenAI, Gemini,
or TypeSafe Jev, and save it. The app clears the input after saving. Verify the
provider connection, then choose a saved source and review the request before
you send it. TypeSafe Jev results remain separate from OpenAI and Gemini
classifications.

External requests are off by default. To enable SEC reads, explicitly set
`EXTERNAL_REQUESTS_ENABLED=true` and configure `SEC_USER_AGENT` with a real
operator/product identifier and contact email. You can pause all external
requests with `EXTERNAL_REQUESTS_ENABLED=false`. Model access does not enable
additional collectors. Local request and byte limits remain in effect for
provider calls.

The SEC's [EDGAR reuse FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions)
allows reuse of public filing data subject to SEC policies and fair-access
limits. The local example enables only `sec_edgar` and `sec_company_facts`; set
a valid SEC User-Agent before enabling requests. Add another collector only after reviewing
its source terms and setting both `EXTERNAL_SOURCE_COLLECTORS` and
`SOURCE_RIGHTS_APPROVED_COLLECTORS`. Local BYOK source assessments use a
separate per-item consent flow; the `OPENAI_ALLOWED_COLLECTORS` list is for the
automatic ChatGPT-plan pipeline.

Real-source classification quality remains unvalidated. Fixture checks
establish logic only; saved Jev judgments do not qualify the OpenAI or Gemini
profiles. The frozen
labeling, sampling, metrics, and pass/fail rules are in
[`sentiment-desk-completion.md`](project-record/3-project-specs/sentiment-desk-completion.md).
A source allowlist is a technical control, not proof of rights. The separate
ChatGPT-plan classifier remains unavailable until its account connection,
model access, source approvals, external-request opt-in, and local request/byte
limits are ready. The BYOK flow uses the key saved for the selected provider.
Sentiment Desk does not expose provider account balance or add API billing.

```bash
npm run dev                # local API on :8787; network requests remain off by default
```

To pause public-source traffic, set `EXTERNAL_REQUESTS_ENABLED=false`. To add a
source, confirm its applicable terms and include it in both source lists in
`.env`:

```bash
EXTERNAL_REQUESTS_ENABLED=true EXTERNAL_SOURCE_COLLECTORS=sec_edgar,sec_company_facts SOURCE_RIGHTS_APPROVED_COLLECTORS=sec_edgar,sec_company_facts npm run dev
```

The local defaults allow only official SEC sources and leave
`SEC_USER_AGENT` blank. Configure a real contact-bearing value and explicitly
enable external requests before SEC lookups can run. Transient failures are
recorded in delivery health and retried on the SEC polling cadence. Only collectors listed in both
`EXTERNAL_SOURCE_COLLECTORS` and `SOURCE_RIGHTS_APPROVED_COLLECTORS` can poll or
fetch charts. The second list is an operator attestation, not independent
verification of rights. Credentials alone do not enable another collector. Luna has its own account,
source, request/byte/USD controls described above. Keep publisher feeds and Yahoo quote/chart
endpoints out of the approval list until their exact use rights are established.

The no-ticker **Recent Filings** view reads an explicitly selected same-user
Public Data Hub installation. By default, Desk reads
`~/.codex/references/sentiment-desk-public-data-hub-installation.json`; set
`DESK_HUB_INSTALLATION_FILE` only when the descriptor is stored elsewhere.
Create that file with mode `600` and these exact fields: `schema_version: 1`,
`scope: "same-local-user-and-host"`, the Hub checkout's canonical absolute
`repository` path, `repository_url:
"https://github.com/j-poc/public-data-hub"`, a loopback-only `base_url` such
as `http://127.0.0.1:8766/`, and the canonical absolute `state_directory` that
is a direct child of that checkout's private `.runtime` directory. The Hub
state directory and `client.token` must be owned by the current user and have
no group/world permissions. The Desk never falls back to the shared Hub
descriptor. This selects a local endpoint; the Desk still checks the current
8-K profile, receipt revision, display-only rights, source clocks, and issuer
identity before showing filings. Starting the feed requires an explicit user
click and enables the Hub's recurring 15-minute SEC profile; it does not enable
separate SEC polling in the Desk. This local connection assumes the
operator trusts the Hub process bound to the configured loopback port; the Hub
API does not currently attest its running code revision to the Desk.

Production:

```bash
npm run build              # web -> dist/web, server -> dist/server
npm start                  # one process serves API + UI on :8787
```

## Rebuild and run with real data

Docker Compose builds the server and dashboard from source and stores SQLite
history in a named volume. Local server defaults allow official SEC records
only. To pause source requests, set `EXTERNAL_REQUESTS_ENABLED=false`; to add a
collector, review its source terms and set matching request and approval lists. For example,
`EXTERNAL_SOURCE_COLLECTORS=sec_edgar` plus
`SOURCE_RIGHTS_APPROVED_COLLECTORS=sec_edgar` enables SEC filings only; SEC
still requires a valid `SEC_USER_AGENT`. The ChatGPT-plan classifier remains
paused until its account connection, source approvals, external-request switch,
and finite local request/byte limits are ready. `CLASSIFICATION_PROVIDER=typesafe`
remains rejected for that legacy pipeline. The separate **TypeSafe Jev** BYOK
workflow accepts a user key and keeps its results in separate history.
Optional Finnhub, Reddit, and X credentials do not enable those sources unless
both their request and approval entries are present.

The no-ticker Recent Filings inbox also checks the current Nasdaq Trader security
directories when you explicitly activate the page. Permit both
`sec_latest_filings_8k` and `nasdaq_symbol_directories` in both source lists; the
directory fetch stays paused unless external requests and both source approvals
are active. Its raw directory snapshot is held in memory only.

```bash
docker compose up --build
```

For an explicit SEC-only launch:

```bash
EXTERNAL_REQUESTS_ENABLED=true EXTERNAL_SOURCE_COLLECTORS=sec_edgar,sec_company_facts SOURCE_RIGHTS_APPROVED_COLLECTORS=sec_edgar,sec_company_facts docker compose up --build
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
must come from the recorded provider. Local categorical judgments use the
selected OpenAI or Gemini provider. TypeSafe Jev results keep their separate
provenance. Unconfigured judgments stay pending; generated fixtures are
confined to automated tests and frozen evaluations. Existing simulation
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

### Hosted core

The hosted investor workflows use the same PostgreSQL schema locally and in
production. The browser bundle uses Supabase Auth and row-level security; the
Edge Functions acquire SEC JSON only on an explicit refresh. No SQLite file,
service-role key, or source credential is used by this cloud path. Local builds
default to the full sentiment desk. Vercel builds set `VITE_APP_MODE=cloud`
explicitly and serve the separate SEC research surface. The cloud surface does
not provide the local source-linked sentiment chart or ChatGPT-plan classifier.

For local development, start the isolated Supabase stack and apply the checked-in
migrations:

```bash
DOCKER_CONTEXT=colima-sentiment-desk-verify supabase start
supabase db reset --local
supabase status
supabase functions serve --env-file .env
```

Set `VITE_APP_MODE=cloud`, the local Supabase URL, and its public anon or
publishable key in `.env`. Keep the service-role key only in the local Edge
Function environment. Configure `APP_ALLOWED_ORIGINS` for the local web origin.
The two `SEC_*_SOURCE_ENABLED` switches stay `false` until the operator has
verified the exact source use. A descriptive `SEC_USER_AGENT` is required for
SEC access. Refreshes are user initiated, cached for 24 hours, bounded by
response/row limits, and shared refresh leases enforce a source-wide cooldown.

To host the web frontend, deploy this repo to Vercel with build command
`VITE_APP_MODE=cloud npm run build:web` and output directory `dist/web` (also set
in `vercel.json`). Set `VITE_APP_MODE=cloud` in the Vercel build environment if
you override the repository build command. The local sentiment desk requires
its local Hono service and SQLite store; a static cloud deployment cannot use
that local classifier or chart API.
Create a Supabase project on the same supported Postgres major version, apply
`supabase/migrations` with `supabase db push`, and deploy the two functions:

```bash
supabase functions deploy refresh-sec-issuer-directory
supabase functions deploy refresh-sec-company-evidence
```

Set only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Vercel
browser build variables. Configure Supabase Auth's site URL and redirect list
for the production domain and set up a real transactional email provider for
magic links. In Supabase Edge Function secrets, configure
`APP_ALLOWED_ORIGINS`, `SEC_USER_AGENT`, `SEC_DIRECTORY_SOURCE_ENABLED=false`,
and `SEC_COMPANY_DATA_ENABLED=false`. Supabase supplies its server-side
function credentials. Do not put service-role or SEC operator values in Vercel
or the browser.

Remote Supabase/Vercel accounts and credentials are not part of this checkout,
so this describes a reproducible deployment path rather than claiming a live
deployment. The core no-ticker screen is the SEC issuer directory; it is not a
small-cap screen. Market-cap ranking remains unavailable until a permitted
price, shares, and corporate-action data chain is chosen and verified.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLASSIFICATION_PROVIDER` | `openai_luna` | new-record classifier; `typesafe` is rejected, historical Jev remains read-only |
| `OPENAI_ALLOWED_COLLECTORS` | `google_news_rss,yahoo_finance_rss` | public RSS sources eligible for automatic ChatGPT-plan Luna, intersected with enabled and rights-approved sources |
| `CHATGPT_PLAN_MAX_REQUESTS_PER_DAY` | `100` | local UTC-day reservation cap for public classification and explicitly confirmed private-note analysis; provider allowance remains controlled by ChatGPT |
| `CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY` | `1638400` | local serialized-request-byte cap per UTC day (100 × 16 KiB); Luna dispatch is serialized to one request at a time |
| `EXTERNAL_REQUESTS_ENABLED` | `false` | Set `true` to opt in to source and provider requests. |
| `EXTERNAL_SOURCE_COLLECTORS` | `sec_edgar,sec_company_facts` | Comma-separated collectors permitted to make network requests; the local default uses official SEC records only. |
| `SOURCE_RIGHTS_APPROVED_COLLECTORS` | `sec_edgar,sec_company_facts` | Separate source-use allowlist; a requested collector without this entry cannot make requests. It does not independently prove rights. |
| `X_BEARER_TOKEN` | — | enables the X source; optional |
| `SEC_USER_AGENT` | unset (SEC requests disabled) | real operator/product identifier plus contact email |
| `DESK_HUB_INSTALLATION_FILE` | `~/.codex/references/sentiment-desk-public-data-hub-installation.json` | private descriptor selecting the same-user loopback Public Data Hub; no shared-locator fallback |
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
