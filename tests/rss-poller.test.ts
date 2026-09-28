import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { ProviderRateLimitError } from "../server/provider-cooldown.js";
import { startRssPoller } from "../server/schedule.js";
import type { Pipeline } from "../server/pipeline.js";
import type { Company } from "../server/types.js";

const companies: Company[] = [
  { id: "alpha", name: "Alpha Inc", ticker: "ALPH", sector: "Technology", aliases: ["Alpha"], color: "#123456" },
  { id: "beta", name: "Beta Inc", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321" },
];

afterEach(() => vi.restoreAllMocks());

describe("RSS rate-limit recovery", () => {
  it("stops only the rate-limited provider's sweep and persists its cooldown", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const health = new HealthTracker(false, false, "unconfigured");
    const requests: string[] = [];
    const fetchFeed = vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes("news.google.com")) {
        throw new ProviderRateLimitError("google_news", 600_000);
      }
      return [];
    });
    const control = startRssPoller({
      companies,
      pipeline: {} as Pipeline,
      db,
      health,
      intervalSeconds: 120,
      concurrency: 1,
      fetchFeed,
      pause: async () => {},
      now: () => 10_000,
    });
    await control.stop();

    expect(requests.filter((url) => url.includes("news.google.com"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("finance.yahoo.com"))).toHaveLength(2);
    expect(Number(db.getKv("provider-cooldown:google_news:retry-at"))).toBe(610_000);
    expect(db.deliverySummary().filter((row) => row.collector === "google_news_rss")).toHaveLength(1);
    expect(db.deliverySummary().filter((row) => row.collector === "yahoo_finance_rss")).toHaveLength(2);

    const secondPass = startRssPoller({
      companies,
      pipeline: {} as Pipeline,
      db,
      health,
      intervalSeconds: 120,
      concurrency: 1,
      fetchFeed,
      pause: async () => {},
      now: () => 20_000,
    });
    await secondPass.stop();
    expect(requests.filter((url) => url.includes("news.google.com"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("finance.yahoo.com"))).toHaveLength(4);
    db.close();
  });
});
