import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { derivePriceChartState, derivePriceRefreshLabels } from "../web/src/App.js";
import { SeriesChart } from "../web/src/components/SeriesChart.js";

const now = Date.parse("2026-09-28T08:00:00.000Z");
const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

type TestPricePoint = { t: number; price: number; currency: string; retrievedAt?: number; deliveryId?: string };

function appWithPricePoints(
  points: TestPricePoint[],
  sourceLatestAt: number | null,
  storedPoints: TestPricePoint[] = [],
  refreshError: Error | null = null,
  countLegacyRows: () => number = () => 3,
) {
  const market = {
    priceSeries: vi.fn(async () => {
      if (refreshError) throw refreshError;
      return {
        points: points.map((point) => ({
          ...point, collector: "yahoo_chart" as const, retrievedAt: point.retrievedAt ?? now,
          adapterVersion: "yahoo-chart/1", deliveryId: point.deliveryId ?? "fixture-delivery-id",
        })),
        delivery: "network" as const,
        servedAt: now,
        sourceLatestAt,
        cacheAgeMs: null,
      };
    }),
  };
  const savedRows = storedPoints.map((point) => ({
    ...point,
    retrievedAt: point.retrievedAt ?? now,
    collector: "yahoo_chart" as const,
    adapterVersion: "yahoo-chart/1",
    deliveryId: point.deliveryId ?? "saved-delivery-id",
  }));
  const app = createApp({
    db: {
      companies: vi.fn(() => [{ id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" }]),
      priceWindow: vi.fn((_ticker: string, since: number) => savedRows.filter((point) => point.t >= since)),
      legacyUnknownPriceRowCount: vi.fn(countLegacyRows),
    } as unknown as AppDeps["db"],
    dbPath: "/not-used/desk.db",
    pipeline: {} as AppDeps["pipeline"],
    market: market as unknown as AppDeps["market"],
    hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"),
    version: "test",
    webRoot: "/not-used/web",
    deliverySources: [],
  });
  return { app, market };
}

async function getPrice(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/companies/acme/price?ticker=ACME&hours=24");
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    points: Array<{ t: number; price: number; currency: string; collector: string; retrievedAt: number; adapterVersion: string; deliveryId: string }>;
    sourceLatestAt: number | null;
    resampling: string;
    refreshError: string | null;
    quarantine: { legacyUnknownRows: number; scope: "all_saved_history" };
  }>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("price API source timestamps", () => {
  it("does not carry a stale quote into every bucket of an empty window", async () => {
    const lastFridayClose = now - 36 * hour;
    const { app } = appWithPricePoints([{ t: lastFridayClose, price: 125.5, currency: "USD" }], lastFridayClose);

    const body = await getPrice(app);

    expect(body.points).toEqual([]);
    expect(body.sourceLatestAt).toBe(lastFridayClose);
    expect(body.quarantine).toEqual({ legacyUnknownRows: 3, scope: "all_saved_history" });
  });

  it("returns actual in-window observations at their provider timestamps without filling gaps", async () => {
    const lastFridayClose = now - 36 * hour;
    const observations = [
      { t: lastFridayClose, price: 120, currency: "USD" },
      { t: now - 3 * hour - 7 * 60_000, price: 123.25, currency: "USD" },
      { t: now - 18 * 60_000, price: 124.75, currency: "USD" },
      { t: now + 5 * 60_000, price: 999, currency: "USD" },
    ];
    const { app } = appWithPricePoints(observations, observations.at(-1)!.t);

    const body = await getPrice(app);

    expect(body.points.map(({ t, price }) => ({ t, price }))).toEqual(observations.slice(1, 3).map(({ t, price }) => ({ t, price })));
    expect(body.points.every((point) => point.currency === "USD" && point.collector === "yahoo_chart" && point.adapterVersion === "yahoo-chart/1" && point.retrievedAt === now && point.deliveryId === "fixture-delivery-id")).toBe(true);
    expect(body.sourceLatestAt).toBe(observations[2]!.t);
    expect(body.resampling).toBe("source_observations_in_window");
  });

  it("rejects a ticker that does not belong to the requested company", async () => {
    const { app, market } = appWithPricePoints([{ t: now - hour, price: 125.5, currency: "USD" }], now - hour);

    const response = await app.request("/api/companies/acme/price?ticker=ADBE&hours=24");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "company_ticker_mismatch" });
    expect(market.priceSeries).not.toHaveBeenCalled();
  });

  it("refreshes a sufficiently populated but stale saved series", async () => {
    const stored = Array.from({ length: 8 }, (_, index) => ({
      t: now - (8 - index) * minute,
      price: 100 + index,
      currency: "USD",
      retrievedAt: now - 11 * minute,
    }));
    const refreshed = { t: now - 30_000, price: 112, currency: "USD" };
    const { app, market } = appWithPricePoints([refreshed], refreshed.t, stored);

    const body = await getPrice(app);

    expect(market.priceSeries).toHaveBeenCalledWith("ACME", 24);
    expect(body.points.at(-1)?.price).toBe(112);
  });

  it("does not refresh a sufficiently populated fresh saved series", async () => {
    const stored = Array.from({ length: 8 }, (_, index) => ({
      t: now - (8 - index) * minute,
      price: 100 + index,
      currency: "USD",
      retrievedAt: now - minute,
    }));
    const { app, market } = appWithPricePoints([], null, stored);

    const body = await getPrice(app);

    expect(market.priceSeries).not.toHaveBeenCalled();
    expect(body.points).toHaveLength(8);
  });

  it("keeps saved points visible after a refresh error and labels the stale fallback", async () => {
    const stored = Array.from({ length: 3 }, (_, index) => ({
      t: now - (3 - index) * minute,
      price: 100 + index,
      currency: "USD",
      retrievedAt: now - 12 * minute,
    }));
    const { app } = appWithPricePoints([], null, stored, new Error("provider unavailable"));

    const body = await getPrice(app);

    expect(body.points.map((point) => point.price)).toEqual([100, 101, 102]);
    expect(body.refreshError).toBe("provider unavailable");
  });

  it("keeps saved points when a successful refresh has no observations", async () => {
    const stored = Array.from({ length: 3 }, (_, index) => ({
      t: now - (3 - index) * minute,
      price: 100 + index,
      currency: "USD",
      retrievedAt: now - 12 * minute,
    }));
    const { app } = appWithPricePoints([], null, stored);

    const body = await getPrice(app);

    expect(body.points.map((point) => point.price)).toEqual([100, 101, 102]);
    expect(body.refreshError).toBeNull();
  });

  it("still fails closed when the provider fails and no lineage-verified saved points exist", async () => {
    const { app } = appWithPricePoints([], null, [], new Error("provider unavailable"));

    const response = await app.request("/api/companies/acme/price?ticker=ACME&hours=24");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider unavailable" });
  });

  it("reports lineage-verified history in the prior seven days when the selected window is empty", async () => {
    const older = { t: now - 36 * hour, price: 125.5, currency: "USD", retrievedAt: now - 36 * hour };
    const { app } = appWithPricePoints([], null, [older]);

    const body = await getPrice(app);

    expect(body.points).toEqual([]);
    expect(body.sourceLatestAt).toBe(older.t);
  });

  it("keeps the seven-day history hint when current-window refresh fails", async () => {
    const older = { t: now - 36 * hour, price: 125.5, currency: "USD", retrievedAt: now - 36 * hour };
    const { app } = appWithPricePoints([], null, [older], new Error("provider unavailable"));

    const body = await getPrice(app);

    expect(body.points).toEqual([]);
    expect(body.sourceLatestAt).toBe(older.t);
    expect(body.refreshError).toBe("provider unavailable");
  });

  it("reads legacy quarantine count after the awaited provider refresh without changing provider arguments or observations", async () => {
    const order: string[] = [];
    const refreshed = { t: now - 30_000, price: 112, currency: "USD" };
    const count = vi.fn(() => { order.push("count"); return 7; });
    const { app, market } = appWithPricePoints([refreshed], refreshed.t, [], null, count);
    market.priceSeries.mockImplementation(async () => {
      order.push("refresh");
      return {
        points: [{ ...refreshed, collector: "yahoo_chart" as const, retrievedAt: now, adapterVersion: "yahoo-chart/1", deliveryId: "fixture-delivery-id" }],
        delivery: "network" as const, servedAt: now, sourceLatestAt: refreshed.t, cacheAgeMs: null,
      };
    });

    const body = await getPrice(app);

    expect(order).toEqual(["refresh", "count"]);
    expect(market.priceSeries).toHaveBeenCalledWith("ACME", 24);
    expect(body.points).toMatchObject([{ t: refreshed.t, price: refreshed.price, currency: "USD" }]);
    expect(body.quarantine).toEqual({ legacyUnknownRows: 7, scope: "all_saved_history" });
  });

  it("preserves the exact mixed-currency failure response without returning quarantine metadata", async () => {
    const values = [
      { t: now - 2 * minute, price: 100, currency: "USD" },
      { t: now - minute, price: 100, currency: "EUR" },
    ];
    const { app } = appWithPricePoints(values, now - minute);

    const response = await app.request("/api/companies/acme/price?ticker=ACME&hours=24");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "price_currency_mismatch" });
  });

  it("does not present a successful empty refresh-failure DTO's quarantine count as current in the App chart", async () => {
    const savedOutsideWindow = { t: now - 36 * hour, price: 125.5, currency: "USD", retrievedAt: now - 36 * hour };
    const { app } = appWithPricePoints([], null, [savedOutsideWindow], new Error("provider unavailable"), () => 2883);
    const response = await app.request("/api/companies/acme/price?ticker=ACME&hours=24");
    expect(response.status).toBe(200);
    const dto = await response.json();
    expect(dto).toMatchObject({ points: [], refreshError: "provider unavailable", quarantine: { legacyUnknownRows: 2883, scope: "all_saved_history" } });
    const headerLabels = derivePriceRefreshLabels(dto, true, false, dto.points.length);
    expect(headerLabels.label).toBe("refresh failed · no verified points in this window");
    expect(headerLabels.titleDetail).toBe("refresh failed; no verified price points are available in this window");
    expect(headerLabels.label).not.toMatch(/saved series|saved data retained/i);
    expect(headerLabels.titleDetail).not.toMatch(/saved series|saved data retained/i);
    const chartState = derivePriceChartState(dto, false, false);
    const html = renderToStaticMarkup(createElement(SeriesChart, {
      points: [], hours: 24, loading: false, mode: "comparison", price: dto.points, currency: null,
      latestPriceAt: dto.sourceLatestAt, latestScoreAvailableAt: null, ...chartState,
    }));
    expect(chartState.priceError).toBe(true);
    expect(html).toContain("Price history unavailable");
    expect(html).not.toContain("2,883 legacy price rows");
    expect(html).not.toMatch(/saved series|saved data retained/i);
  });
});
