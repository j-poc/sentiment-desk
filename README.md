# Sentiment Desk

Real-time company sentiment, scored mention by mention. Every headline or post
that touches a watchlisted company is judged within seconds by **Jev** (TypeSafe
AI System One) against one fixed, published rubric. The terminal shows the
meter, the change, live quotes, and the exact evidence behind every point.

The core idea is the live "BS meter" pattern: per-item typed questions (~400 ms,
~$0.00005 per call), the same questions for everyone, no claim of fact-checking
— only judgment, with the source attached.

## What is real

- **Mentions** (all free, no keys required):
  Google News RSS per company (breadth), Yahoo Finance per-ticker headline RSS
  (speed), GDELT DOC 2.0 (global breadth + confirmation, keyless, slow-polled),
  and **SEC EDGAR 8-K filings** — the company speaking under penalty of law,
  with exchange-accepted sub-second timestamps. 8-K items map onto the event
  taxonomy (Item 2.02 = results, 5.02 = leadership, 4.02 = accounting
  non-reliance). Filings carry the gold `8-K FILING` badge and outrank every
  news tier in the weight blend. X API v2 recent search joins when
  `X_BEARER_TOKEN` is set. Every mention is deduped by content digest.
- **Market data**: Yahoo Finance chart endpoint (no key). Snapshot quotes for
  all 24 tickers plus context indices (SPY, QQQ, VIX) every 45 seconds, and
  intraday price series for the chart overlay. Quota-safe: paced requests, one
  backoff retry, cycle aborts on 429.
- **Judgment**: live Jev scoring the moment `TYPESAFE_API_KEY` is present.
  Resolution order: `.env`, then `~/.newsjack/.env` (shared with the newsjack
  CLI). Without a key, ingestion continues and the header shows ADD API KEY
  while mentions stay pending. With `DEMO=1` a deterministic stub scores a
  synthetic stream so the full pipeline is observable without any key; the UI
  badges it as DEMO SENTIMENT.

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
npm run dev                # real ingestion + real quotes on :8787
npm run dev:web            # Vite dev UI on :5173 (proxies /api)
npm run demo               # synthetic sentiment through the same pipeline
```

Production:

```bash
npm run build              # web -> dist/web, server -> dist/server
npm start                  # one process serves API + UI on :8787
```

Or with Docker: `docker build -t sentiment-desk . && docker run -p 8787:8787
--env-file .env sentiment-desk`. Mount a volume at `/app/data` to keep history.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Jev scoring; `.env` or `~/.newsjack/.env` |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | override for tests/proxy |
| `TYPESAFE_MODEL` | `jev-latest` | model id sent with each call |
| `X_BEARER_TOKEN` | — | enables the X source; optional |
| `SEC_USER_AGENT` | generic research default | personalize (name + email) for long unattended runs |
| `POLL_SEC_SECONDS` | `90` | EDGAR submissions poll cadence |
| `POLL_GDELT_SECONDS` | `300` | GDELT breadth poll cadence |
| `POLL_RSS_SECONDS` | `45` | news poll cadence |
| `POLL_X_SECONDS` | `180` | X poll cadence |
| `POLL_QUOTES_SECONDS` | `45` | quote poll cadence |
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
  sources/      rss (Google News), x (API v2), quotes (Yahoo), tiers
  demo.ts       synthetic mentions + stub judge for keyless runs
web/
  src/          React + Tailwind 4 terminal (SSE live updates)
tests/          vitest: wire contract, post-rules, RSS parsing
```

Design rules worth keeping as the product grows:

- Retrieval time never substitutes for publication time.
- A mention is never scored by default; missing answers fail closed.
- The rubric is identical for every company; comparison rests on that.
- Low-confidence and off-target judgments remain visible, just weighted
  honestly.
- Quote failures degrade to last-known values with visible age, never to zeros.

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
