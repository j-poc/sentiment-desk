import type { Company } from "./types.js";
import { fetchPriceSeries, fetchQuote, RateLimitedError, type PricePoint, type Quote } from "./sources/quotes.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { Desk } from "./db.js";
import { classifyDeliveryError, processDeliveryItems, recordDelivery } from "./delivery.js";
import { scheduleTask, type SchedulerControl } from "./scheduler.js";
import {
  clearProviderRateLimit,
  providerCoolingDown,
  providerRetryAt,
  recordProviderRateLimit,
} from "./provider-cooldown.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";

/**
 * The market store: one poll loop, one in-memory snapshot, broadcast on change.
 * When their collectors are explicitly enabled, Yahoo quote/chart requests
 * provide market context. Saved-data-only mode reads persisted price points.
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
  private indexQuoteFailureKey(ticker: string): string {
    return `yahoo:index-quote-failure:${encodeURIComponent(ticker)}`;
  }

  constructor(
    private readonly deps: {
      companies: Company[];
      indices: string[];
      hub: Hub;
      health: HealthTracker;
      db: Desk;
      externalRequestsEnabled?: boolean;
      quoteRequestsEnabled?: boolean;
      chartRequestsEnabled?: boolean;
    },
  ) {}

  current(): MarketSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<void> {
    if (!this.quoteRequestsAllowed()) return;
    if (!this.deps.db.prepareExternalWork()) return;
    if (providerCoolingDown(this.deps.db, "yahoo")) return;
    const tickers = [...this.deps.companies.map((c) => c.ticker), ...this.deps.indices];
    const quotes: Record<string, ServedQuote> = {};
    let ok = 0;
    let companyOk = 0;
    let companyFail = 0;
    let companyError: string | null = null;
    for (const ticker of tickers) {
      if (!this.deps.db.canStartExternalWork()) break;
      if (providerCoolingDown(this.deps.db, "yahoo")) break;
      const startedAt = Date.now();
      const company = this.deps.companies.find((c) => c.ticker === ticker) ?? null;
      let deliveryId: string | null = null;
      try {
        const received = await fetchQuote(ticker);
        const retrievedAt = Date.now();
        quotes[ticker] = { ...received, retrievedAt, lastAttemptAt: retrievedAt, delivery: "network" };
        const recordedDeliveryId = recordDelivery({
          db: this.deps.db, collector: "yahoo_quote", companyId: company?.id ?? null,
          requestKey: `yahoo-quote:${ticker}`, startedAt, adapterVersion: "yahoo-quote/1",
          result: "success", parsedItemCount: 1, normalizedItems: received,
          processingExpected: company != null && received.at != null,
        });
        deliveryId = recordedDeliveryId;
        if (company && received.at != null) {
          processDeliveryItems({ db: this.deps.db, deliveryId: recordedDeliveryId, expectedCount: 1, process: (itemProcessed) => {
            const inserted = this.deps.db.upsertPricePoint({
              ticker: company.ticker, t: received.at!, price: received.price, collector: "yahoo_quote",
              currency: received.currency, retrievedAt, adapterVersion: "yahoo-quote/1", deliveryId: recordedDeliveryId,
            });
            itemProcessed(inserted);
          } });
        }
        clearProviderRateLimit(this.deps.db, "yahoo", startedAt);
        ok += 1;
        if (company) companyOk += 1;
        else {
          this.deps.db.transitionKvWithEvent({
            key: this.indexQuoteFailureKey(ticker),
            when: { equals: "1" },
            value: "",
            event: { level: "info", source: "yahoo_index_quote", message: `${ticker}: index quote recovered` },
          });
        }
      } catch (err) {
        if (err instanceof ExternalRequestPausedError && err.dispatchedRequests === 0) break;
        const prior = this.snapshot.quotes[ticker];
        if (prior) quotes[ticker] = { ...prior, lastAttemptAt: Date.now(), delivery: "cache" };
        if (deliveryId == null) recordDelivery({
          db: this.deps.db, collector: "yahoo_quote", companyId: company?.id ?? null,
          requestKey: `yahoo-quote:${ticker}`, startedAt, adapterVersion: "yahoo-quote/1",
          result: classifyDeliveryError(err), parsedItemCount: 0, error: err,
        });
        const message = err instanceof Error ? err.message : String(err);
        if (company) {
          companyFail += 1;
          companyError = message;
        } else {
          const failureKey = this.indexQuoteFailureKey(ticker);
          this.deps.db.transitionKvWithEvent({
            key: failureKey,
            when: { notEquals: "1" },
            value: "1",
            event: { level: "warn", source: "yahoo_index_quote", message: `${ticker}: ${message}` },
          });
        }
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
    // Company price points are persisted and their receipt outcomes finalized
    // inside the per-ticker request boundary above. Index quotes stay in memory.
    if (this.chartRequestsAllowed()) this.startBackfill();
    if (companyOk > 0) this.deps.health.recordQuotes(true);
    if (companyFail > 0) this.deps.health.recordQuotes(false, companyError ?? "company quote fetch failures");
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
    if (!this.chartRequestsAllowed()) return;
    for (const company of this.deps.companies) {
      if (!this.deps.db.canStartExternalWork()) break;
      if (this.backfilled.has(company.ticker)) continue;
      if (providerCoolingDown(this.deps.db, "yahoo")) break;
      const startedAt = Date.now();
      let deliveryId: string | null = null;
      try {
        const points = await fetchPriceSeries(company.ticker, 72);
        const retrievedAt = Date.now();
        const recordedDeliveryId = recordDelivery({
          db: this.deps.db, collector: "yahoo_chart", companyId: company.id,
          requestKey: `yahoo-chart:series:${company.ticker}:72h`, startedAt,
          adapterVersion: "yahoo-chart/1", result: points.length === 0 ? "empty" : "success",
          parsedItemCount: points.length, normalizedItems: points, processingExpected: true,
        });
        deliveryId = recordedDeliveryId;
        processDeliveryItems({ db: this.deps.db, deliveryId: recordedDeliveryId, expectedCount: points.length, process: (itemProcessed) => {
          for (const p of points) {
            const inserted = this.deps.db.upsertPricePoint({
              ticker: company.ticker, t: p.t, price: p.price, collector: "yahoo_chart",
              currency: p.currency, retrievedAt, adapterVersion: "yahoo-chart/1", deliveryId: recordedDeliveryId,
            });
            itemProcessed(inserted);
          }
        } });
        this.backfilled.add(company.ticker);
        clearProviderRateLimit(this.deps.db, "yahoo", startedAt);
      } catch (err) {
        if (err instanceof ExternalRequestPausedError && err.dispatchedRequests === 0) break;
        if (deliveryId == null) recordDelivery({
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
    if (!this.chartRequestsAllowed()) {
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
    if (!this.deps.db.prepareExternalWork()) {
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
    if (!this.deps.db.canStartExternalWork()) {
      const servedAt = Date.now();
      const points = this.deps.db.priceWindow(ticker, servedAt - bucket * 60 * 60 * 1000);
      return { points, delivery: "local_store", servedAt, sourceLatestAt: points.at(-1)?.t ?? null, cacheAgeMs: null };
    }
    const cooldownUntil = providerRetryAt(this.deps.db, "yahoo");
    if (cooldownUntil > Date.now()) {
      throw new RateLimitedError(cooldownUntil - Date.now(), "Yahoo Finance cooldown active", true);
    }
    const startedAt = Date.now();
    let deliveryId: string | null = null;
    try {
      const points = await fetchPriceSeries(ticker, bucket);
      const retrievedAt = Date.now();
      const company = this.deps.companies.find((item) => item.ticker === ticker);
      const recordedDeliveryId = recordDelivery({
        db: this.deps.db, collector: "yahoo_chart", companyId: company?.id ?? null,
        requestKey: `yahoo-chart:series:${ticker}:${bucket}h`, startedAt,
        adapterVersion: "yahoo-chart/1", result: points.length === 0 ? "empty" : "success",
        parsedItemCount: points.length, normalizedItems: points, processingExpected: true,
      });
      deliveryId = recordedDeliveryId;
      processDeliveryItems({ db: this.deps.db, deliveryId: recordedDeliveryId, expectedCount: points.length, process: (itemProcessed) => {
        for (const point of points) {
          const inserted = this.deps.db.upsertPricePoint({
            ticker, t: point.t, price: point.price, collector: "yahoo_chart",
            currency: point.currency, retrievedAt, adapterVersion: "yahoo-chart/1", deliveryId: recordedDeliveryId,
          });
          itemProcessed(inserted);
        }
      } });
      const sourcedPoints = points.map((point) => ({
        ...point, collector: "yahoo_chart" as const, retrievedAt,
        adapterVersion: "yahoo-chart/1", deliveryId: recordedDeliveryId,
      }));
      clearProviderRateLimit(this.deps.db, "yahoo", startedAt);
      this.seriesCache.set(key, { retrievedAt, points: sourcedPoints });
      return {
        points: sourcedPoints,
        delivery: "network",
        servedAt: retrievedAt,
        sourceLatestAt: points.at(-1)?.t ?? null,
        cacheAgeMs: null,
      };
    } catch (error) {
      if (error instanceof ExternalRequestPausedError) {
        const servedAt = Date.now();
        const points = this.deps.db.priceWindow(ticker, servedAt - bucket * 60 * 60 * 1000);
        if (error.dispatchedRequests > 0 && deliveryId == null) {
          const company = this.deps.companies.find((item) => item.ticker === ticker);
          recordDelivery({
            db: this.deps.db, collector: "yahoo_chart", companyId: company?.id ?? null,
            requestKey: `yahoo-chart:series:${ticker}:${bucket}h`, startedAt,
            adapterVersion: "yahoo-chart/1", result: "failed", parsedItemCount: 0, error,
          });
        }
        return { points, delivery: "local_store", servedAt, sourceLatestAt: points.at(-1)?.t ?? null, cacheAgeMs: null };
      }
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
        if (deliveryId == null) recordDelivery({
          db: this.deps.db, collector: "yahoo_chart", companyId: company?.id ?? null,
          requestKey: `yahoo-chart:series:${ticker}:${bucket}h`, startedAt,
          adapterVersion: "yahoo-chart/1", result: classifyDeliveryError(error),
          parsedItemCount: 0, error,
        });
      }
      throw error;
    }
  }

  private quoteRequestsAllowed(): boolean {
    return this.deps.externalRequestsEnabled !== false && this.deps.quoteRequestsEnabled !== false;
  }

  private chartRequestsAllowed(): boolean {
    return this.deps.externalRequestsEnabled !== false && this.deps.chartRequestsEnabled !== false;
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
  return scheduleTask(tick, deps.intervalSeconds * 1000, { beforeRun: () => deps.db.prepareExternalWork() });
}
