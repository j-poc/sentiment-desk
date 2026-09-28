import type { Company } from "./types.js";
import { fetchPriceSeries, fetchQuote, RateLimitedError, type PricePoint, type Quote } from "./sources/quotes.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { Desk } from "./db.js";
import { classifyDeliveryError, recordDelivery } from "./delivery.js";
import { scheduleTask, type SchedulerControl } from "./scheduler.js";
import {
  clearProviderRateLimit,
  providerCoolingDown,
  providerRetryAt,
  recordProviderRateLimit,
} from "./provider-cooldown.js";

/**
 * The market store: one poll loop, one in-memory snapshot, broadcast on change.
 * Quotes are read-only market facts and run in every mode; they give the
 * dashboard its market context (tape, watchlist prices, price overlay) even
 * while sentiment scoring depends on the Jev key.
 */

export interface MarketSnapshot {
  quotes: Record<string, ServedQuote>; // keyed by ticker
  updatedAt: number;
}

export interface ServedQuote extends Quote {
  retrievedAt: number;
  lastAttemptAt: number;
  delivery: "network" | "cache";
}

export interface PriceSeriesResult {
  points: PricePoint[];
  delivery: "network" | "memory_cache" | "local_store";
  servedAt: number;
  sourceLatestAt: number | null;
  cacheAgeMs: number | null;
}

const SERIES_CACHE_TTL_MS = 60_000;

export class MarketData {
  private snapshot: MarketSnapshot = { quotes: {}, updatedAt: 0 };
  private readonly seriesCache = new Map<string, { retrievedAt: number; points: PricePoint[] }>();
  private readonly backfilled = new Set<string>();
  private readonly seriesRequests = new Map<string, Promise<PriceSeriesResult>>();
  private backfillTask: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      companies: Company[];
      indices: string[];
      hub: Hub;
      health: HealthTracker;
      db: Desk;
      externalRequestsEnabled?: boolean;
    },
  ) {}

  current(): MarketSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<void> {
    if (this.deps.externalRequestsEnabled === false) return;
    if (providerCoolingDown(this.deps.db, "yahoo")) return;
    const tickers = [...this.deps.companies.map((c) => c.ticker), ...this.deps.indices];
    const quotes: Record<string, ServedQuote> = {};
    let ok = 0;
    let fail = 0;
    let lastError: string | null = null;
    for (const ticker of tickers) {
      if (providerCoolingDown(this.deps.db, "yahoo")) break;
      const startedAt = Date.now();
      const company = this.deps.companies.find((c) => c.ticker === ticker) ?? null;
      try {
        const received = await fetchQuote(ticker);
        const retrievedAt = Date.now();
        quotes[ticker] = { ...received, retrievedAt, lastAttemptAt: retrievedAt, delivery: "network" };
        recordDelivery({
          db: this.deps.db, collector: "yahoo_quote", companyId: company?.id ?? null,
          requestKey: `yahoo-chart:quote:${ticker}`, startedAt, adapterVersion: "yahoo-chart/1",
          result: "success", parsedItemCount: 1, normalizedItems: received,
        });
        clearProviderRateLimit(this.deps.db, "yahoo", startedAt);
        ok += 1;
      } catch (err) {
        const prior = this.snapshot.quotes[ticker];
        if (prior) quotes[ticker] = { ...prior, lastAttemptAt: Date.now(), delivery: "cache" };
        recordDelivery({
          db: this.deps.db, collector: "yahoo_quote", companyId: company?.id ?? null,
          requestKey: `yahoo-chart:quote:${ticker}`, startedAt, adapterVersion: "yahoo-chart/1",
          result: classifyDeliveryError(err), parsedItemCount: 0, error: err,
        });
        fail += 1;
        lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof RateLimitedError) {
          recordProviderRateLimit({
            db: this.deps.db,
            provider: "yahoo",
            minDelayMs: 60_000,
            retryAfterMs: err.retryAfterMs,
          });
          break;
        }
      }
    }
    // Keep last-known values for failed tickers; refresh what succeeded.
    this.snapshot = {
      quotes: { ...this.snapshot.quotes, ...quotes },
      updatedAt: ok > 0 ? Date.now() : this.snapshot.updatedAt,
    };
    // Persist source observations only. While markets are closed, repeated
    // successful fetches keep the exchange-reported timestamp and INSERT OR
    // IGNORE prevents them becoming new time-series points. Company tickers
    // only; indices are context.
    for (const company of this.deps.companies) {
      const q = quotes[company.ticker];
      if (q?.at != null) this.deps.db.upsertPricePoint(company.ticker, q.at, q.price);
    }
    this.startBackfill();
    if (ok > 0) this.deps.health.recordQuotes(true);
    if (fail > 0) this.deps.health.recordQuotes(false, lastError ?? "quote fetch failures");
    if (Object.keys(quotes).length > 0) this.deps.hub.broadcast("quotes", { quotes, updatedAt: this.snapshot.updatedAt });
  }

  async waitForIdle(): Promise<void> {
    await this.backfillTask;
  }

  private startBackfill(): void {
    if (this.backfillTask) return;
    const task = this.backfillSeries().finally(() => {
      if (this.backfillTask === task) this.backfillTask = null;
    });
    this.backfillTask = task;
  }

  /**
   * Per-ticker backfill from Yahoo's 5-day/30-minute history so the reaction
   * module has depth immediately instead of waiting for the poller to
   * accumulate. A ticker is only marked done after a successful fetch, so
   * transient failures retry on the next quote cycle until they succeed.
   */
  private async backfillSeries(): Promise<void> {
    if (this.deps.externalRequestsEnabled === false) return;
    for (const company of this.deps.companies) {
      if (this.backfilled.has(company.ticker)) continue;
      if (providerCoolingDown(this.deps.db, "yahoo")) break;
      const startedAt = Date.now();
      try {
        const points = await fetchPriceSeries(company.ticker, 72);
        for (const p of points) this.deps.db.upsertPricePoint(company.ticker, p.t, p.price);
        this.backfilled.add(company.ticker);
        clearProviderRateLimit(this.deps.db, "yahoo", startedAt);
        recordDelivery({
          db: this.deps.db, collector: "yahoo_chart", companyId: company.id,
          requestKey: `yahoo-chart:series:${company.ticker}:72h`, startedAt,
          adapterVersion: "yahoo-chart/1", result: points.length === 0 ? "empty" : "success",
          parsedItemCount: points.length, normalizedItems: points,
        });
      } catch (err) {
        recordDelivery({
          db: this.deps.db, collector: "yahoo_chart", companyId: company.id,
          requestKey: `yahoo-chart:series:${company.ticker}:72h`, startedAt,
          adapterVersion: "yahoo-chart/1", result: classifyDeliveryError(err),
          parsedItemCount: 0, error: err,
        });
        if (err instanceof RateLimitedError) {
          recordProviderRateLimit({
            db: this.deps.db,
            provider: "yahoo",
            minDelayMs: 60_000,
            retryAfterMs: err.retryAfterMs,
          });
          break;
        }
        /* retried on the next quotes cycle; live points accrue regardless */
      }
    }
  }

  async priceSeries(ticker: string, hours: number): Promise<PriceSeriesResult> {
    const bucket = hours <= 24 ? 24 : hours <= 72 ? 72 : hours <= 168 ? 168 : 24 * 30;
    const key = `${ticker}:${bucket}`;
    if (this.deps.externalRequestsEnabled === false) {
      const servedAt = Date.now();
      const points = this.deps.db.priceWindow(ticker, servedAt - bucket * 60 * 60 * 1000);
      return {
        points,
        delivery: "local_store",
        servedAt,
        sourceLatestAt: points.at(-1)?.t ?? null,
        cacheAgeMs: null,
      };
    }
    const cached = this.seriesCache.get(key);
    const now = Date.now();
    if (cached && now - cached.retrievedAt < SERIES_CACHE_TTL_MS) {
      return {
        points: cached.points,
        delivery: "memory_cache",
        servedAt: now,
        sourceLatestAt: cached.points.at(-1)?.t ?? null,
        cacheAgeMs: now - cached.retrievedAt,
      };
    }
    const existing = this.seriesRequests.get(key);
    if (existing) return existing;
    const request = this.loadPriceSeries(ticker, bucket);
    this.seriesRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.seriesRequests.get(key) === request) this.seriesRequests.delete(key);
    }
  }

  private async loadPriceSeries(ticker: string, bucket: number): Promise<PriceSeriesResult> {
    const key = `${ticker}:${bucket}`;
    const cooldownUntil = providerRetryAt(this.deps.db, "yahoo");
    if (cooldownUntil > Date.now()) {
      throw new RateLimitedError(cooldownUntil - Date.now(), "Yahoo Finance cooldown active", true);
    }
    const startedAt = Date.now();
    try {
      const points = await fetchPriceSeries(ticker, bucket);
      const retrievedAt = Date.now();
      this.seriesCache.set(key, { retrievedAt, points });
      clearProviderRateLimit(this.deps.db, "yahoo", startedAt);
      const company = this.deps.companies.find((item) => item.ticker === ticker);
      recordDelivery({
        db: this.deps.db, collector: "yahoo_chart", companyId: company?.id ?? null,
        requestKey: `yahoo-chart:series:${ticker}:${bucket}h`, startedAt,
        adapterVersion: "yahoo-chart/1", result: points.length === 0 ? "empty" : "success",
        parsedItemCount: points.length, normalizedItems: points,
      });
      return {
        points,
        delivery: "network",
        servedAt: retrievedAt,
        sourceLatestAt: points.at(-1)?.t ?? null,
        cacheAgeMs: null,
      };
    } catch (error) {
      if (error instanceof RateLimitedError && !error.deferred) {
        recordProviderRateLimit({
          db: this.deps.db,
          provider: "yahoo",
          minDelayMs: 60_000,
          retryAfterMs: error.retryAfterMs,
        });
      }
      const company = this.deps.companies.find((item) => item.ticker === ticker);
      if (!(error instanceof RateLimitedError && error.deferred)) {
        recordDelivery({
          db: this.deps.db, collector: "yahoo_chart", companyId: company?.id ?? null,
          requestKey: `yahoo-chart:series:${ticker}:${bucket}h`, startedAt,
          adapterVersion: "yahoo-chart/1", result: classifyDeliveryError(error),
          parsedItemCount: 0, error,
        });
      }
      throw error;
    }
  }
}

export function startQuotesPoller(deps: {
  market: MarketData;
  db: Desk;
  intervalSeconds: number;
}): SchedulerControl {
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
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}
