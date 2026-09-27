# Sentiment Desk

Sentiment Desk is a private, single-user research product that runs against live
public sources. The repository is visible for inspection and is not a hosted
multi-user data service.

Every eligible headline or post that touches a watchlisted company is judged by
**Jev** (TypeSafe AI System One) against one fixed, published rubric when a
`TYPESAFE_API_KEY` is configured. Without that key, live collection continues
and mentions stay unscored.

The core idea is the live "BS meter" pattern: the same structured Jev judgment
for every item, with the source attached. It is a judgment, not a claim of
fact-checking.

## What is real

- **Mentions**: Google News RSS, Yahoo Finance headline RSS, and GDELT DOC 2.0
  are keyless collectors; their live availability can vary. SEC EDGAR company
  submissions and filing text are collected using the configured watchlist.
  Optional Finnhub, Reddit, and X collectors start only with their credentials.
  Every item keeps publisher identity, source identity, and source, provider,
  retrieval, and ingestion clocks separately. Missing source time stays
  unknown.
- **Market data**: Yahoo Finance chart endpoints supply quotes and historical
  price context. Quote currency, provider source time, retrieval time, and
  cache/network state are exposed. Historical series retain provider times and
  disclose when display buckets use last-observation carry-forward.
- **Judgment**: Jev scoring starts when `TYPESAFE_API_KEY` is present. For a
  local Node run, the app also checks `~/.newsjack/.env`; Docker Compose passes
  values from this project’s `.env` only. Without a key, real observations are
  still collected and remain pending. Existing judgments are not re-scored on
  startup because the rubric changes.

## The terminal

Data-dense, dark-only, monospace numerics — the shared language of the
Bloomberg-style open-source terminals (OpenBB, Neuberg, the React terminal
clones), applied to sentiment.

- **Ticker tape**: indices then every watched ticker, live price, session
  change, sentiment dot. Click to select.
- **Watchlist**: sparkline, quote, change, index, delta; sortable by movement
  or alphabet. `j`/`k` or arrow keys to walk it.
- **Company panel**: sentiment index and comparison windows.
- **Chart**: sentiment area with honest gaps (no interpolation) and an optional
  normalized price overlay (`c`) so divergence between narrative and price is
  readable directly.
- **Mention feed**: filter chips for sentiment, investor relevance, off-target,
  and unscored items. Rows link to their source and expose Jev judgment,
  publisher time, collection time, and scoring metadata.
- **Right rail**: top movers by absolute 24 h delta, the live tape, desk health
  (source failures, Jev errors, cost today).
- **Status bar**: engine state, p50 score latency, market session (open /
  pre-market / after hours / closed in ET), stream state, SSE clients, DB size.
- **Opportunity Radar**: per-company comparison of Jev event categories across
  equal current and prior windows, with exact-normalized headline groups,
  distinct publisher counts, directional mix, source links, and delivery
  coverage. It is a sourced research view, not an opportunity or alpha signal.

Nothing here is investment advice. The meter measures sentiment in published
coverage; it does not price securities.

## Repository rights

This repository currently has no license. Public visibility does not grant
permission to use, copy, modify, distribute, or build from the code; obtain
permission from the copyright holder before doing so.

## Run it

```bash
npm install
cp .env.example .env       # add TYPESAFE_API_KEY to go live on judgment
npm run dev                # live sources + live quotes on :8787
npm run dev:web            # Vite dev UI on :5173 (proxies /api)
npm run demo               # optional synthetic-sentiment interface exercise
```

Production:

```bash
npm run build              # web -> dist/web, server -> dist/server
npm start                  # one process serves API + UI on :8787
```

## Rebuild and run with real data

Docker Compose builds the server and dashboard from source, starts the live
news and market-data collectors, and stores SQLite history in a named volume.
No API key is required to start. Add your own `TYPESAFE_API_KEY` to `.env` to
enable Jev scoring; without it, real stories are collected but remain pending.
Optional Finnhub, Reddit, and X keys enable those additional sources.

```bash
docker compose up --build
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

The default rebuild never enables demo mode. `npm run demo` or `DEMO=1` is an
optional interface exercise with synthetic sentiment; it disables news
collectors and still fetches real market quotes. It does not replace the live
data path.

To verify a live, credential-free Compose rebuild and persistent-volume
recovery, run `./scripts/verify-live-compose.sh`. It uses a temporary Compose
project, disables Jev and optional credentialed sources, checks live quote and
news-source health through the API, recreates the container, then removes only
its temporary volume.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Jev scoring; local Node also checks `~/.newsjack/.env` |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | override for tests/proxy |
| `TYPESAFE_MODEL` | `jev-latest` | model id sent with each call |
| `X_BEARER_TOKEN` | — | enables the X source; optional |
| `SEC_USER_AGENT` | generic research default | personalize (name + email) for long unattended runs |
| `POLL_SEC_SECONDS` | `90` | EDGAR submissions poll cadence |
| `POLL_GDELT_SECONDS` | `300` | GDELT breadth poll cadence |
| `POLL_RSS_SECONDS` | `30` | news poll cadence |
| `POLL_X_SECONDS` | `180` | X poll cadence |
| `POLL_QUOTES_SECONDS` | `45` | quote poll cadence |
| `POLL_FINNHUB_SECONDS` | `120` | Finnhub poll cadence |
| `POLL_REDDIT_SECONDS` | `180` | Reddit poll cadence |
| `BACKFILL_DAYS` | `5` | Finnhub company-news backfill window |
| `RSS_CONCURRENCY` | `4` | concurrent RSS requests |
| `INDICES` | `SPY,QQQ,^VIX` | context rows on the tape (never scored) |
| `SCORE_CONCURRENCY` | `6` | parallel Jev calls |
| `DB_PATH` | `./data/desk.db` | SQLite file |
| `COMPANIES_PATH` | `./config/companies.json` | watchlist |
| `DEMO` | off | synthetic mentions + deterministic stub judge |

The watchlist (`config/companies.json`) is plain data: id, name, ticker,
sector, aliases (used by the match guard; feed queries use name + ticker), and
an accent color.

## The rubric

Jev applies the same fixed rubric to every item. The schema covers sentiment,
company and investor relevance, materiality, novelty, credibility, event type,
magnitude, surprise, and takeaway. Its SHA-256 is stored on every judgment.
Jev is the only per-item sentiment and event classifier. The Radar uses Jev's
saved event type and sentiment; it makes no additional model call.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/companies` | watchlist snapshots: index, delta, counts |
| `GET /api/companies/:id/series?hours=` | bucketed sentiment series |
| `GET /api/companies/:id/price?ticker=&hours=` | intraday price series (overlay) |
| `GET /api/companies/:id/mentions?hours=&limit=` | mentions with full scores |
| `GET /api/companies/:id/radar?hours=` | current/prior equal-window event and source summary |
| `GET /api/companies/:id/radar/evidence?hours=&period=&eventType=&offset=&limit=` | paginated source evidence for a Radar category |
| `GET /api/companies/:id/reactions?hours=` | measured price reactions after scored mentions |
| `GET /api/validation?hours=` | watchlist-wide signal validation summary |
| `GET /api/quotes` | latest quotes for tickers and indices |
| `GET /api/tape?limit=` | latest scored mentions across companies |
| `GET /api/health` | sources, Jev health, usage, events, DB size |
| `GET /api/stream` | SSE: `hello`, `mention`, `company`, `quotes`, `ping` |

## Architecture

```
server/
  index.ts      boot, wiring, graceful shutdown
  config.ts     env + credential chain + watchlist loading (zod-validated)
  db.ts         node:sqlite schema and queries
  rubric.ts     the fixed question set + hash
  jev.ts        TypeSafe client: /v1/systemone, retries, contract validation
  scoring.ts    legacy rubric-era scoring module (not a separate Radar classifier)
  pipeline.ts   queue, Jev judgments, state building, snapshots, broadcasts
  radar.ts      deterministic headline/publisher and window aggregation
  delivery.ts   persisted source delivery health and freshness projections
  schedule.ts   RSS + X pollers, match guards, demo loop
  market.ts     quote store, poll loop, price-series cache
  sources/      Google/Yahoo RSS, SEC EDGAR, GDELT, Finnhub, Reddit, X, Yahoo quotes
  demo.ts       synthetic mentions + stub judge for keyless runs
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
