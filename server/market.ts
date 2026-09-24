import type { Company } from "./types.js";
import { fetchPriceSeries, fetchQuote, RateLimitedError, type PricePoint, type Quote } from "./sources/quotes.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { Desk } from "./db.js";

/**
 * The market store: one poll loop, one in-memory snapshot, broadcast on change.
 * Quotes are read-only market facts and run in every mode; they give the
 * dashboard its market context (tape, watchlist prices, price overlay) even
 * while sentiment scoring depends on the Jev key.
 */

export interface MarketSnapshot {
  quotes: Record<string, Quote>; // keyed by ticker
  updatedAt: number;
}

const SERIES_CACHE_TTL_MS = 60_000;

export class MarketData {
  private snapshot: MarketSnapshot = { quotes: {}, updatedAt: 0 };
  private readonly seriesCache = new Map<string, { at: number; points: PricePoint[] }>();
  private readonly backfilled = new Set<string>();

  constructor(
    private readonly deps: {
      companies: Company[];
      indices: string[];
      hub: Hub;
      health: HealthTracker;
      db: Desk;
    },
  ) {}

  current(): MarketSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<void> {
    const tickers = [...this.deps.companies.map((c) => c.ticker), ...this.deps.indices];
    const quotes: Record<string, Quote> = {};
    let ok = 0;
    let fail = 0;
    let lastError: string | null = null;
    for (const ticker of tickers) {
      try {
        quotes[ticker] = await fetchQuote(ticker);
        ok += 1;
      } catch (err) {
        fail += 1;
        lastError = err instanceof Error ? err.message : String(err);
        // Quota protection: a 429 aborts the rest of this cycle; the next
        // rotation starts fresh. Partial results still broadcast.
        if (err instanceof RateLimitedError) break;
      }
      await sleep(500); // pacing: the whole rotation stays well under rate limits
    }
    // Keep last-known values for failed tickers; refresh what succeeded.
    this.snapshot = {
      quotes: { ...this.snapshot.quotes, ...quotes },
      updatedAt: ok > 0 ? Date.now() : this.snapshot.updatedAt,
    };
    // Persist our own price history: the poller appends a point per successful
    // company quote at FETCH time (exchange-reported regularMarketTime freezes
    // when the market is closed, which would starve the series). Company
    // tickers only; indices are context.
    for (const company of this.deps.companies) {
      const q = quotes[company.ticker];
      if (q) this.deps.db.upsertPricePoint(company.ticker, Date.now(), q.price);
    }
    void this.backfillSeries();
    if (ok > 0) this.deps.health.recordQuotes(true);
    if (fail > 0) this.deps.health.recordQuotes(false, lastError ?? "quote fetch failures");
    if (ok > 0) this.deps.hub.broadcast("quotes", { quotes, updatedAt: this.snapshot.updatedAt });
  }

  /**
   * Per-ticker backfill from Yahoo's 5-day/30-minute history so the reaction
   * module has depth immediately instead of waiting for the poller to
   * accumulate. A ticker is only marked done after a successful fetch, so
   * transient failures retry on the next quote cycle until they succeed.
   */
  private async backfillSeries(): Promise<void> {
    for (const company of this.deps.companies) {
      if (this.backfilled.has(company.ticker)) continue;
      try {
        const points = await fetchPriceSeries(company.ticker, 72);
        for (const p of points) this.deps.db.upsertPricePoint(company.ticker, p.t, p.price);
        this.backfilled.add(company.ticker);
      } catch {
        /* retried on the next quotes cycle; live points accrue regardless */
      }
      await sleep(600);
    }
  }

  async priceSeries(ticker: string, hours: number): Promise<PricePoint[]> {
    const bucket = hours <= 24 ? 24 : hours <= 72 ? 72 : hours <= 168 ? 168 : 24 * 30;
    const key = `${ticker}:${bucket}`;
    const cached = this.seriesCache.get(key);
    if (cached && Date.now() - cached.at < SERIES_CACHE_TTL_MS) return cached.points;
    const points = await fetchPriceSeries(ticker, bucket);
    this.seriesCache.set(key, { at: Date.now(), points });
    return points;
  }
}

export function startQuotesPoller(deps: {
  market: MarketData;
  db: Desk;
  intervalSeconds: number;
}): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deps.market.refresh();
    } catch (err) {
      deps.db.logEvent("warn", "quotes", err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
