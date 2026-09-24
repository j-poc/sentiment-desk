# Sentiment Desk

Real-time company sentiment, scored mention by mention. Every headline or post
that touches a watched company is judged within seconds by **Jev** (TypeSafe AI
System One) against one fixed, published rubric, and the dashboard shows the
meter, the change, and the exact evidence behind every point.

The core idea is taken from the live "BS meter" pattern: per-item typed
questions (~400 ms, ~$0.00004 per call), the same questions for everyone, and
no claim of fact-checking — only judgment, with the source attached.

## What it does

- **Ingests** mentions per watchlisted company from Google News RSS (always on)
  and the X API v2 recent-search endpoint (when `X_BEARER_TOKEN` is set).
- **Scores** each mention with five typed questions: direction
  (negative/neutral/positive), aboutness, materiality, novelty, source
  credibility. One Jev call per mention, bounded-concurrency queue.
- **Applies deterministic post-rules**: off-target mentions are excluded from
  every index, low-confidence mentions are damped, weights blend materiality,
  novelty, source tier, and credibility. All components are stored, so every
  number on screen can be audited and recomputed offline.
- **Publishes** a live dashboard: per-company meter, weighted index vs the
  trailing 24 h baseline, time-series with gaps left honest (null buckets are
  never interpolated), a live tape of every scored mention, and desk health
  (source failures, Jev errors, cost today).
- **Persists** everything in SQLite (WAL) with full provenance: source URL,
  source-declared publication time, retrieval time, content digest, rubric
  hash, token usage, and cost per mention.

Nothing on the desk is investment advice. The meter measures sentiment in
published coverage; it does not price securities.

## Run it

```bash
npm install
cp .env.example .env       # add TYPESAFE_API_KEY for live scoring
npm run demo               # no keys needed: synthetic mentions + stub judge
npm run dev                # live scoring + RSS ingestion on :8787
npm run dev:web            # Vite dev UI on :5173 (proxies /api)
```

Production:

```bash
npm run build              # web -> dist/web, server -> dist/server
npm start                  # one process serves API + UI on :8787
```

Or with Docker: `docker build -t sentiment-desk . && docker run -p 8787:8787
--env-file .env sentiment-desk`. The image is a single Node process with a
health check on `/api/health`; mount a volume at `/app/data` to keep history.

## Configuration

All configuration is environment-driven (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Jev scoring; without it mentions stay pending |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | override for tests/proxy |
| `TYPESAFE_MODEL` | `jev-latest` | model id sent with each call |
| `X_BEARER_TOKEN` | — | enables the X source; optional |
| `POLL_RSS_SECONDS` | `60` | news poll cadence |
| `POLL_X_SECONDS` | `180` | X poll cadence |
| `SCORE_CONCURRENCY` | `6` | parallel Jev calls |
| `DB_PATH` | `./data/desk.db` | SQLite file |
| `COMPANIES_PATH` | `./config/companies.json` | watchlist |
| `DEMO` | off | synthetic mentions + deterministic stub judge |

The watchlist (`config/companies.json`) is plain data: id, name, ticker,
sector, aliases (used for feed queries and match guards), and an accent color.

## The rubric

Every mention is judged by the same five questions (`server/rubric.ts`):

1. **sentiment** — choice: negative / neutral / positive, with written criteria
2. **about** — noul: is this genuinely about this company?
3. **material** — noul: would an investor weigh this?
4. **novel** — noul: new information or recycled commentary?
5. **credible** — noul: does this source meet editorial standards?

The rubric ships as data, its SHA-256 is stored on every score, and the wording
can be reviewed or swapped without touching code. Post-rules live in
`server/scoring.ts` and are deterministic and unit-tested.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/companies` | watchlist snapshots: index, delta, counts |
| `GET /api/companies/:id/series?hours=` | bucketed index series |
| `GET /api/companies/:id/mentions?hours=&limit=` | mentions with full scores |
| `GET /api/tape?limit=` | latest scored mentions across companies |
| `GET /api/health` | sources, Jev health, usage, recent events |
| `GET /api/stream` | SSE: `hello`, `mention`, `company`, `ping` |

## Architecture

```
server/
  index.ts      boot, wiring, graceful shutdown
  config.ts     env + watchlist loading (zod-validated)
  db.ts         node:sqlite schema and queries
  rubric.ts     the fixed question set + hash
  jev.ts        TypeSafe client: /v1/systemone, retries, contract validation
  scoring.ts    parse, post-rules, weighted index, bucketing (pure)
  pipeline.ts   queue, state building, snapshots, broadcasts
  schedule.ts   RSS + X pollers, match guards, demo loop
  sources/      rss (Google News), x (API v2), tier mapping
  demo.ts       synthetic mentions + stub judge for keyless runs
web/
  src/          React + Tailwind 4 dashboard (SSE live updates)
tests/          vitest: contract, post-rules, RSS parsing
```

Design rules worth keeping as the product grows:

- Retrieval time never substitutes for publication time.
- A mention is never scored by default; missing answers fail closed.
- The rubric is identical for every company; comparison rests on that.
- Low-confidence and off-target judgments remain visible, just weighted
  honestly.

## Cost model

At list price ($0.042 per million input tokens, output free), one scored
mention costs roughly $0.00005. A 10-company watchlist at a few thousand
mentions a day costs cents, which is what makes real-time per-item judgment
economically sane.

## Roadmap

- Management-claim tracking (the literal BS meter): score what executives say,
  then check it against later reporting.
- X webhooks instead of polling for lower latency.
- Per-rubric agreement evals (Jev vs a strong reference model) before trusting
  a new rubric, reusing the methodology from the newsjack `jev-coarse-agreement`
  eval.
