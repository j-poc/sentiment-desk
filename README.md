# Sentiment Desk

Sentiment Desk is a private, single-user research product that runs against live
public sources. Its source and build can be shared publicly so other researchers
can rebuild their own local copy with their own provider credentials. It is not
a hosted multi-user data service.

Every eligible headline or post that touches a watchlisted company is judged by
**Jev** (TypeSafe AI System One) against one fixed, published rubric when a
`TYPESAFE_API_KEY` is configured. Without that key, live collection continues
and mentions stay unscored.

The core idea is the live "BS meter" pattern: per-item typed questions (~400 ms,
~$0.00005 per call), the same questions for everyone, no claim of fact-checking
— only judgment, with the source attached.

## What is real

- **Mentions**: Google News RSS, Yahoo Finance headline RSS, and GDELT DOC 2.0
  run without provider keys. SEC EDGAR 8-K filings also run by default; set
  `SEC_USER_AGENT` to a contact-bearing value for unattended use. Optional
  Finnhub, Reddit, and X collectors start only when their own credentials are
  configured. 8-K items map onto the event taxonomy and retain filing and
  acceptance timestamps when the SEC provides them.
- **Market data**: Yahoo Finance chart endpoint (no key) supplies snapshot
  quotes for watched tickers and context indices plus price series for the
  chart overlay. The quote health panel reports collection failures and the
  latest successful cycle. Last-known values are retained in process after a
  failed cycle; freshness is not modeled separately for every ticker.
- **Judgment**: Jev scoring starts when `TYPESAFE_API_KEY` is present. For a
  local Node run, the app also checks `~/.newsjack/.env`; Docker Compose passes
  values from this project’s `.env` only. Without a key, real collection still
  runs and mentions stay pending.

## The terminal

Data-dense, dark-only, monospace numerics — the shared language of the
Bloomberg-style open-source terminals (OpenBB, Neuberg, the React terminal
clones), applied to sentiment.

- **Ticker tape**: indices then every watched ticker, live price, session
  change, sentiment dot. Click to select.
- **Watchlist**: sparkline, quote, change, index, delta; sortable by movement
  or alphabet. `j`/`k` or arrow keys to walk it.
- **Company panel**: needle gauge, price chip, weighted index vs trailing 24 h,
  window selector (`1`–`4`).
- **Chart**: sentiment area with honest gaps (no interpolation) and an optional
  normalized price overlay (`c`) so divergence between narrative and price is
  readable directly.
- **Mention feed**: filter chips (bullish / bearish / material / off-target /
  unscored, `f` to cycle), every row links to its source with confidence,
  materiality, novelty, latency, and cost visible.
- **Right rail**: top movers by absolute 24 h delta, the live tape, desk health
  (source failures, Jev errors, cost today).
- **Status bar**: engine state, p50 score latency, market session (open /
  pre-market / after hours / closed in ET), stream state, SSE clients, DB size.

Nothing here is investment advice. The meter measures sentiment in published
coverage; it does not price securities.

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

Every mention is judged by the same five questions (`server/rubric.ts`):

1. **sentiment** — choice: negative / neutral / positive, with written criteria
2. **about** — noul: is this genuinely about this company?
3. **material** — noul: would an investor weigh this?
4. **novel** — noul: new information or recycled commentary?
5. **credible** — noul: does this source meet editorial standards?

The rubric ships as data, its SHA-256 is stored on every score, and the wording
can be reviewed or swapped without touching code. Post-rules live in
`server/scoring.ts`: off-target mentions are excluded from every index,
low-confidence mentions are damped, and the weight blends materiality,
novelty, source tier, and credibility. All components are stored and
unit-tested.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/companies` | watchlist snapshots: index, delta, counts |
| `GET /api/companies/:id/series?hours=` | bucketed sentiment series |
| `GET /api/companies/:id/price?ticker=&hours=` | intraday price series (overlay) |
| `GET /api/companies/:id/mentions?hours=&limit=` | mentions with full scores |
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
  scoring.ts    parse, post-rules, weighted index, bucketing (pure)
  pipeline.ts   queue, state building, snapshots, broadcasts
  schedule.ts   RSS + X pollers, match guards, demo loop
  market.ts     quote store, poll loop, price-series cache
  sources/      Google/Yahoo RSS, SEC EDGAR, GDELT, Finnhub, Reddit, X, Yahoo quotes
  demo.ts       synthetic mentions + stub judge for keyless runs
web/
  src/          React + Tailwind 4 terminal (SSE live updates)
tests/          vitest: wire contract, post-rules, RSS parsing
```

Design rules worth keeping as the product grows:

- Provider event/publication times should stay distinct from retrieval times.
  Some current source adapters still fill missing source timestamps with local
  fetch time; see the [live-data contract](project-record/3-project-specs/live-data-etl.json)
  for this known limitation.
- A mention is never scored by default; missing answers fail closed.
- The rubric is identical for every company; comparison rests on that.
- Low-confidence and off-target judgments remain visible, just weighted
  honestly.
- Quote failures retain last-known values and increment health failures. The
  displayed age is the latest successful cycle time, not a per-ticker
  freshness guarantee.

## Cost model

At list price ($0.042 per million input tokens, output free), one scored
mention costs roughly $0.00005. A 24-company watchlist at a few thousand
mentions a day costs cents, which is what makes real-time per-item judgment
economically sane.

## Roadmap

- Management-claim tracking (the literal BS meter): score what executives say,
  then check it against later reporting.
- X webhooks instead of polling for lower latency.
- Per-rubric agreement evals (Jev vs a strong reference model) before trusting
  a new rubric.
