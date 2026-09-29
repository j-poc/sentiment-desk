import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";

const now = Date.parse("2026-09-28T08:00:00.000Z");
const minute = 60_000;

function appWithReactionRows(rows: Array<{
  id: string;
  title: string;
  publishedAt: number;
  sentiment: string;
  eventScore: number;
  eventType: string;
}>) {
  const eventAt = now - 45 * minute;
  const db = {
    companies: vi.fn(() => [{ id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" }]),
    scoredReactionEventsForCompany: vi.fn(() => rows),
    priceWindow: vi.fn(() => [
      { t: eventAt + minute, price: 100 },
      { t: eventAt + 30 * minute, price: 101 },
    ]),
  };
  const app = createApp({
    db: db as unknown as AppDeps["db"],
    dbPath: "/not-used/desk.db",
    pipeline: {} as AppDeps["pipeline"],
    market: {} as AppDeps["market"],
    hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"),
    version: "test",
    webRoot: "/not-used/web",
    deliverySources: [],
  });
  return { app, db };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reaction endpoint", () => {
  it("aggregates the complete window while returning only eight measured examples", async () => {
    const eventAt = now - 45 * minute;
    const rows = Array.from({ length: 250 }, (_, index) => ({
      id: `event-${index}`,
      title: `Event ${index}`,
      publishedAt: eventAt,
      sentiment: "positive",
      eventScore: index,
      eventType: "results",
    }));
    const { app, db } = appWithReactionRows(rows);

    const response = await app.request("/api/companies/acme/reactions?hours=24");
    const body = await response.json() as {
      events: Array<{ eventScore: number; r30: number | null }>;
      measuredEventCount: number;
      all: { n30m: number; n4h: number; hitRate: number | null };
    };

    expect(response.status).toBe(200);
    expect(db.scoredReactionEventsForCompany).toHaveBeenCalledWith("acme", now - 24 * 60 * minute);
    expect(body.all).toEqual({ n30m: 250, n4h: 0, median30m: 1, median4h: null, hitRate: 100 });
    expect(body.events).toHaveLength(8);
    expect(body.measuredEventCount).toBe(250);
    expect(body.events[0]?.eventScore).toBe(249);
    expect(body.events.every((event) => event.r30 === 1)).toBe(true);
  });
});
