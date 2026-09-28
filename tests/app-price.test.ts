import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";

const now = Date.parse("2026-09-28T08:00:00.000Z");
const hour = 60 * 60 * 1000;

function appWithPricePoints(points: Array<{ t: number; price: number }>, sourceLatestAt: number | null) {
  const market = {
    priceSeries: vi.fn(async () => ({
      points,
      delivery: "network" as const,
      servedAt: now,
      sourceLatestAt,
      cacheAgeMs: null,
    })),
  };
  const app = createApp({
    db: {
      companies: vi.fn(() => [{ id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" }]),
      priceWindow: vi.fn(() => []),
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
    points: Array<{ t: number; price: number }>;
    sourceLatestAt: number | null;
    resampling: string;
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
    const { app } = appWithPricePoints([{ t: lastFridayClose, price: 125.5 }], lastFridayClose);

    const body = await getPrice(app);

    expect(body.points).toEqual([]);
    expect(body.sourceLatestAt).toBe(lastFridayClose);
  });

  it("returns actual in-window observations at their provider timestamps without filling gaps", async () => {
    const lastFridayClose = now - 36 * hour;
    const observations = [
      { t: lastFridayClose, price: 120 },
      { t: now - 3 * hour - 7 * 60_000, price: 123.25 },
      { t: now - 18 * 60_000, price: 124.75 },
      { t: now + 5 * 60_000, price: 999 },
    ];
    const { app } = appWithPricePoints(observations, observations.at(-1)!.t);

    const body = await getPrice(app);

    expect(body.points).toEqual(observations.slice(1, 3));
    expect(body.sourceLatestAt).toBe(observations[2]!.t);
    expect(body.resampling).toBe("source_observations_in_window");
  });

  it("rejects a ticker that does not belong to the requested company", async () => {
    const { app, market } = appWithPricePoints([{ t: now - hour, price: 125.5 }], now - hour);

    const response = await app.request("/api/companies/acme/price?ticker=ADBE&hours=24");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "company_ticker_mismatch" });
    expect(market.priceSeries).not.toHaveBeenCalled();
  });
});
