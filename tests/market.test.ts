import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { MarketData } from "../server/market.js";
import { fetchPriceSeries, fetchQuote } from "../server/sources/quotes.js";
import type { Company } from "../server/types.js";

const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function chartResponse(symbol = "ACME") {
  const nowSec = Math.floor(Date.now() / 1000);
  return new Response(JSON.stringify({
    chart: {
      result: [{
        meta: { symbol, regularMarketPrice: 125.5, chartPreviousClose: 120, regularMarketTime: nowSec, currency: "EUR" },
        timestamp: [nowSec - 3600, nowSec - 1800, nowSec],
        indicators: { quote: [{ close: [123, 124, 125.5] }] },
      }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function market(db: Desk, externalRequestsEnabled = true) {
  return new MarketData({
    companies: [company], indices: [], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), db, externalRequestsEnabled,
  });
}

describe("market quote provenance", () => {
  it("rejects legacy price rows without source and currency lineage", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-price-lineage-"));
    const path = join(directory, "desk.db");
    const oldDb = new DatabaseSync(path);
    oldDb.exec(`CREATE TABLE price_points (
      ticker TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (ticker, t)
    )`);
    oldDb.prepare("INSERT INTO price_points (ticker, t, price) VALUES (?, ?, ?)")
      .run("ACME", 1_000, 125);
    oldDb.close();

    const db = new Desk(path);
    try {
      expect(db.priceWindow("ACME", 0)).toEqual([]);
      const deliveryId = db.recordDelivery({
        collector: "yahoo_chart", companyId: null, requestKey: "test-price-lineage",
        startedAt: 1_900, completedAt: 2_000, result: "success", parsedItemCount: 1,
        adapterVersion: "yahoo-chart/1", responseDigest: "fixture-digest",
      });
      db.upsertPricePoint({
        ticker: "ACME", t: 1_000, price: 125, collector: "yahoo_chart",
        currency: "USD", retrievedAt: 2_000, adapterVersion: "yahoo-chart/1", deliveryId,
      });
      expect(db.priceWindow("ACME", 0)).toEqual([{
        t: 1_000, price: 125, currency: "USD", collector: "yahoo_chart",
        retrievedAt: 2_000, adapterVersion: "yahoo-chart/1", deliveryId,
      }]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers a sourced chart candle when a quote has the same timestamp", () => {
    const db = new Desk(":memory:");
    const quoteReceipt = db.recordDelivery({
      collector: "yahoo_quote", companyId: null, requestKey: "test-quote-collision",
      startedAt: 1_900, completedAt: 2_000, result: "success", parsedItemCount: 1,
      adapterVersion: "yahoo-quote/1", responseDigest: "quote-digest",
    });
    const chartReceipt = db.recordDelivery({
      collector: "yahoo_chart", companyId: null, requestKey: "test-chart-collision",
      startedAt: 2_100, completedAt: 2_200, result: "success", parsedItemCount: 1,
      adapterVersion: "yahoo-chart/1", responseDigest: "chart-digest",
    });
    db.upsertPricePoint({
      ticker: "ACME", t: 3_000, price: 125, collector: "yahoo_quote",
      currency: "USD", retrievedAt: 2_000, adapterVersion: "yahoo-quote/1", deliveryId: quoteReceipt,
    });
    db.upsertPricePoint({
      ticker: "ACME", t: 3_000, price: 124.5, collector: "yahoo_chart",
      currency: "USD", retrievedAt: 2_200, adapterVersion: "yahoo-chart/1", deliveryId: chartReceipt,
    });

    expect(db.priceWindow("ACME", 0)).toEqual([{
      t: 3_000, price: 124.5, currency: "USD", collector: "yahoo_chart",
      retrievedAt: 2_200, adapterVersion: "yahoo-chart/1", deliveryId: chartReceipt,
    }]);
    db.close();
  });

  it("does not invent a currency when Yahoo omits it", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      chart: { result: [{
        meta: { symbol: "ACME", regularMarketPrice: 125.5, chartPreviousClose: 120, regularMarketTime: 1 },
        timestamp: [1], indicators: { quote: [{ close: [125.5] }] },
      }], error: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchQuote("ACME")).rejects.toThrow("currency missing or invalid");
    await expect(fetchPriceSeries("ACME", 24)).rejects.toThrow("currency missing or invalid");
  });

  it("rejects malformed Yahoo chart payloads instead of caching them as empty", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      chart: { result: null, error: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchPriceSeries("ACME", 24)).rejects.toThrow("omitted its result list");
  });

  it("rejects quote and chart data whose provider-reported ticker differs from the request", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      chart: { result: [{
        meta: { symbol: "OTHER", regularMarketPrice: 125.5, chartPreviousClose: 120, currency: "USD" },
        timestamp: [1], indicators: { quote: [{ close: [125.5] }] },
      }], error: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchQuote("ACME")).rejects.toThrow("symbol missing or mismatched");
    await expect(fetchPriceSeries("ACME", 24)).rejects.toThrow("symbol missing or mismatched");
  });

  it("rejects misaligned Yahoo timestamps and close values", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      chart: { result: [{ meta: { symbol: "ACME", currency: "USD" }, timestamp: [1, 2], indicators: { quote: [{ close: [125] }] } }], error: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchPriceSeries("ACME", 24)).rejects.toThrow("inconsistent lengths");
  });

  it("honors Yahoo Retry-After without retrying a rejected request", async () => {
    const request = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "120" },
    }));
    globalThis.fetch = request;

    await expect(fetchQuote("ACME")).rejects.toMatchObject({
      name: "RateLimitedError",
      provider: "yahoo",
      retryAfterMs: 120_000,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("persists Yahoo cooldown and skips the rest of quote and chart requests", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    const request = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "120" },
    }));
    globalThis.fetch = request;

    await data.refresh();
    await data.waitForIdle();
    expect(request).toHaveBeenCalledTimes(1);
    const storedRetryAt = Number(db.getKv("provider-cooldown:yahoo:retry-at"));
    expect(storedRetryAt).toBeGreaterThan(Date.now());
    await data.refresh();
    await data.waitForIdle();
    expect(request).toHaveBeenCalledTimes(1);
    await expect(data.priceSeries("ACME", 24)).rejects.toMatchObject({ deferred: true });
    expect(request).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("coalesces concurrent identical price-series cache misses", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const request = vi.fn(async () => response);
    globalThis.fetch = request;

    const first = data.priceSeries("ACME", 24);
    const second = data.priceSeries("ACME", 24);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    expect(request).toHaveBeenCalledTimes(1);
    release(chartResponse());
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(request).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("does not report current chart health when Yahoo fetch succeeds but price persistence fails", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    globalThis.fetch = vi.fn(async () => chartResponse());
    vi.spyOn(db, "upsertPricePoint").mockImplementation(() => { throw new Error("price sink unavailable"); });

    await expect(data.priceSeries("ACME", 24)).rejects.toThrow("price sink unavailable");
    expect(db.deliverySummary()).toMatchObject([{ collector: "yahoo_chart", result: "success" }]);
    expect(db.deliverySummary()).toHaveLength(1);
    expect(db.priceWindow("ACME", 0)).toEqual([]);
    expect(db.deliveryHealth([{
      collector: "yahoo_chart", enabled: true, intervalSeconds: 60, targetCount: 1,
    }], Date.now())[0]).toMatchObject({
      state: "failed", latestResult: "success", coverageCount: 0,
      latestIngestionState: "failed", latestIngestionExpectedCount: 3,
      latestIngestionProcessedCount: 0, latestError: "price sink unavailable",
    });
    db.close();
  });

  it("serves only persisted points while external requests are disabled", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const now = Date.now();
    const deliveryId = db.recordDelivery({
      collector: "yahoo_chart", companyId: "acme", requestKey: "test-price-cache",
      startedAt: now - 1, completedAt: now, result: "success", parsedItemCount: 2,
      adapterVersion: "yahoo-chart/1", responseDigest: "fixture-digest",
    });
    db.upsertPricePoint({ ticker: "ACME", t: now - 60_000, price: 124, collector: "yahoo_chart", currency: "EUR", retrievedAt: now, adapterVersion: "yahoo-chart/1", deliveryId });
    db.upsertPricePoint({ ticker: "ACME", t: now, price: 125, collector: "yahoo_chart", currency: "EUR", retrievedAt: now, adapterVersion: "yahoo-chart/1", deliveryId });
    const latestStoredAt = Math.floor(now / 1_000) * 1_000;
    const data = market(db, false);
    const request = vi.fn(async () => { throw new Error("network must remain disabled"); });
    globalThis.fetch = request;

    await data.refresh();
    await data.waitForIdle();
    const result = await data.priceSeries("ACME", 24);

    expect(result).toMatchObject({ delivery: "local_store", sourceLatestAt: latestStoredAt });
    expect(result.points).toEqual([
      { t: latestStoredAt - 60_000, price: 124, currency: "EUR", collector: "yahoo_chart", retrievedAt: now, adapterVersion: "yahoo-chart/1", deliveryId },
      { t: latestStoredAt, price: 125, currency: "EUR", collector: "yahoo_chart", retrievedAt: now, adapterVersion: "yahoo-chart/1", deliveryId },
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(db.deliverySummary()).toHaveLength(1);
    db.close();
  });

  it("gates Yahoo quotes and chart calls independently", async () => {
    const chartDb = new Desk(":memory:");
    chartDb.seedCompanies([company]);
    const chartRequest = vi.fn(async () => chartResponse());
    globalThis.fetch = chartRequest;
    const chartOnly = new MarketData({
      companies: [company], indices: [], hub: new Hub(),
      health: new HealthTracker(false, false, "unconfigured"),
      db: chartDb, externalRequestsEnabled: true,
      quoteRequestsEnabled: false, chartRequestsEnabled: true,
    });

    await chartOnly.refresh();
    await chartOnly.waitForIdle();
    expect(chartRequest).not.toHaveBeenCalled();
    expect((await chartOnly.priceSeries("ACME", 24)).delivery).toBe("network");
    expect(chartRequest).toHaveBeenCalledOnce();
    chartDb.close();

    const quoteDb = new Desk(":memory:");
    quoteDb.seedCompanies([company]);
    const quoteRequest = vi.fn(async () => chartResponse());
    globalThis.fetch = quoteRequest;
    const quoteOnly = new MarketData({
      companies: [company], indices: [], hub: new Hub(),
      health: new HealthTracker(false, false, "unconfigured"),
      db: quoteDb, externalRequestsEnabled: true,
      quoteRequestsEnabled: true, chartRequestsEnabled: false,
    });

    await quoteOnly.refresh();
    await quoteOnly.waitForIdle();
    expect(quoteRequest).toHaveBeenCalledOnce();
    expect((await quoteOnly.priceSeries("ACME", 24)).delivery).toBe("local_store");
    expect(quoteRequest).toHaveBeenCalledOnce();
    quoteDb.close();
  });

  it("marks a retained last-good quote as cache after a failed refresh", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    globalThis.fetch = vi.fn(async () => chartResponse());
    await data.refresh();
    await data.waitForIdle();
    const first = data.current().quotes.ACME!;
    expect(first.currency).toBe("EUR");
    expect(first.delivery).toBe("network");
    expect(first.at).not.toBeNull();

    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await data.refresh();
    await data.waitForIdle();
    const cached = data.current().quotes.ACME!;
    expect(cached.delivery).toBe("cache");
    expect(cached.price).toBe(first.price);
    expect(cached.retrievedAt).toBe(first.retrievedAt);
    expect(cached.lastAttemptAt).toBeGreaterThanOrEqual(first.lastAttemptAt);
    expect(db.deliverySummary()[0]?.result).toBe("failed");
    const quoteHealth = db.deliveryHealth([
      { collector: "yahoo_quote", enabled: true, intervalSeconds: 45, targetCount: 1 },
    ]);
    expect(quoteHealth[0]?.state).toBe("failed");
    db.close();
  });

  it("does not let a failed auxiliary index quote degrade company quote health", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-market-"));
    let db: Desk | undefined;
    try {
      const dbPath = join(directory, "desk.db");
      db = new Desk(dbPath);
      db.seedCompanies([company]);
      const health = new HealthTracker(false, false, "unconfigured");
      const request = vi.fn(async (input: RequestInfo | URL) => {
        const ticker = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1) ?? "");
        return ticker === "^GSPC"
          ? new Response("index quote unavailable", { status: 503 })
          : chartResponse();
      });
      globalThis.fetch = request;
      const data = new MarketData({
        companies: [company], indices: ["^GSPC"], hub: new Hub(), health, db,
        externalRequestsEnabled: true, quoteRequestsEnabled: true, chartRequestsEnabled: false,
      });

      await data.refresh();
      const delivery = db.deliveryHealth([{
        collector: "yahoo_quote", enabled: true, intervalSeconds: 45, targetCount: 1,
        healthCompanyOnly: true,
      }]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(delivery[0]).toMatchObject({ state: "current", coverageCount: 1, latestResult: "success" });
      expect(health.snapshot().quotes).toMatchObject({ ok: 1, fail: 0, lastError: null });
      expect(db.deliverySummary().some((row) => row.companyId === null && row.result === "failed")).toBe(true);
      expect(db.recentEvents(5)).toContainEqual(expect.objectContaining({
        level: "warn", source: "yahoo_index_quote", message: "^GSPC: HTTP 503",
      }));
      expect(db.getKv("yahoo:index-quote-failure:%5EGSPC")).toBe("1");
      db.close();

      // A new Desk and MarketData instance simulate a process restart while
      // retaining the durable database state and warning event.
      db = new Desk(dbPath);
      db.seedCompanies([company]);
      const restarted = new MarketData({
        companies: [company], indices: ["^GSPC"], hub: new Hub(),
        health: new HealthTracker(false, false, "unconfigured"), db,
        externalRequestsEnabled: true, quoteRequestsEnabled: true, chartRequestsEnabled: false,
      });
      globalThis.fetch = vi.fn(async () => chartResponse("^GSPC"));
      await restarted.refresh();
      expect(db.recentEvents(5)).toContainEqual(expect.objectContaining({
        level: "info", source: "yahoo_index_quote", message: "^GSPC: index quote recovered",
      }));
      expect(db.getKv("yahoo:index-quote-failure:%5EGSPC")).toBe("");
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("labels the bounded in-memory price-series cache and preserves the source timestamp", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    globalThis.fetch = vi.fn(async () => chartResponse());
    const first = await data.priceSeries("ACME", 24);
    const second = await data.priceSeries("ACME", 24);
    expect(first.delivery).toBe("network");
    expect(first.sourceLatestAt).toBe(first.points.at(-1)?.t);
    expect(second.delivery).toBe("memory_cache");
    expect(second.cacheAgeMs).not.toBeNull();
    db.close();
  });

  it("waits for the quote backfill side task before database shutdown", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    let releaseBackfill!: (response: Response) => void;
    const backfillResponse = new Promise<Response>((resolve) => { releaseBackfill = resolve; });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("interval=30m") ? backfillResponse : chartResponse(),
    );

    await data.refresh();
    let settled = false;
    const waiting = data.waitForIdle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseBackfill(chartResponse());
    await waiting;
    expect(settled).toBe(true);
    expect(db.priceWindow("ACME", 0).length).toBeGreaterThan(0);
    db.close();
  });
});
