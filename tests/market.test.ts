import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { MarketData } from "../server/market.js";
import type { Company } from "../server/types.js";

const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function chartResponse() {
  const nowSec = Math.floor(Date.now() / 1000);
  return new Response(JSON.stringify({
    chart: {
      result: [{
        meta: { regularMarketPrice: 125.5, chartPreviousClose: 120, regularMarketTime: nowSec, currency: "EUR" },
        timestamp: [nowSec - 3600, nowSec - 1800, nowSec],
        indicators: { quote: [{ close: [123, 124, 125.5] }] },
      }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function market(db: Desk) {
  return new MarketData({
    companies: [company], indices: [], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), db,
  });
}

describe("market quote provenance", () => {
  it("marks a retained last-good quote as cache after a failed refresh", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const data = market(db);
    globalThis.fetch = vi.fn(async () => chartResponse());
    await data.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = data.current().quotes.ACME!;
    expect(first.currency).toBe("EUR");
    expect(first.delivery).toBe("network");
    expect(first.at).not.toBeNull();

    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await data.refresh();
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
