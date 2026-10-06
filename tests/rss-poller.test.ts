import { afterEach, describe, expect, it, vi } from "vitest";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { ProviderRateLimitError } from "../server/provider-cooldown.js";
import { startRssPoller } from "../server/schedule.js";
import { Hub } from "../server/hub.js";
import { Pipeline } from "../server/pipeline.js";
import type { Company } from "../server/types.js";

const companies: Company[] = [
  { id: "alpha", name: "Alpha Inc", ticker: "ALPH", sector: "Technology", aliases: ["Alpha"], color: "#123456" },
  { id: "beta", name: "Beta Inc", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321" },
];

afterEach(() => vi.restoreAllMocks());

describe("RSS rate-limit recovery", () => {
  it("runs only the RSS collector explicitly named in the allowlist", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const requests: string[] = [];
    const fetchFeed = vi.fn(async (url: string) => {
      requests.push(url);
      return { items: [], providerItemCount: 0, malformedItemCount: 0 };
    });
    const control = startRssPoller({
      companies,
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured"),
      intervalSeconds: 120,
      concurrency: 1,
      enabledCollectors: new Set(["google_news_rss"]),
      fetchFeed,
      pause: async () => {},
    });
    await control.stop();

    expect(requests).toHaveLength(companies.length);
    expect(requests.every((url) => url.includes("news.google.com"))).toBe(true);
    expect(db.deliverySummary().every((row) => row.collector === "google_news_rss")).toBe(true);
    db.close();
  });

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
      return { items: [], providerItemCount: 0, malformedItemCount: 0 };
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

  it("marks mixed malformed feed rows partial so they do not count as coverage", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const health = new HealthTracker(false, false, "unconfigured");
    const fetchFeed = vi.fn(async () => ({
      items: [{
        title: "Alpha Inc reports quarterly results",
        url: "https://news.example/story",
        sourceName: "news.example",
        publisherDomain: "news.example",
        publishedAt: Date.now(),
        aggregatorPublishedAt: null,
        sourceItemId: "alpha-story",
        snippet: "",
        tier: "trade" as const,
      }],
      providerItemCount: 2,
      malformedItemCount: 1,
    }));
    const pipeline = new Pipeline({
      db, judge: null, hub: new Hub(), health, engineLabel: "jev-latest", inputPricePerMTok: 0.042,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]),
      dailyBudget: { utcDay: () => "2026-09-29", maxRequests: 100, maxRequestBytes: 1_000_000 },
    });
    const control = startRssPoller({
      companies: companies.slice(0, 1),
      pipeline,
      db,
      health,
      intervalSeconds: 120,
      concurrency: 1,
      enabledCollectors: new Set(["google_news_rss"]),
      fetchFeed,
      pause: async () => {},
    });
    await control.stop();

    expect(db.deliveryHealth([{
      collector: "google_news_rss", enabled: true, intervalSeconds: 120, targetCount: 1,
    }], Date.now())[0]).toMatchObject({
      state: "partial", latestResult: "partial", latestItemCount: 2, coverageCount: 0,
      latestError: "RSS discarded 1 malformed item",
    });
    expect(health.snapshot().rss).toMatchObject({ ok: 1, fail: 0 });
    const stored = db.mentionsForCompany("alpha", 0, 10)[0];
    expect(stored?.source.deliveryId).toEqual(expect.any(String));
    pipeline.stop();
    db.close();
  });

  it("does not report current health when an observation fails after a successful fetch", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const health = new HealthTracker(false, false, "unconfigured");
    const pipeline = {
      ingest: vi.fn(() => { throw new Error("observation persistence failed"); }),
    } as unknown as Pipeline;
    const control = startRssPoller({
      companies: companies.slice(0, 1),
      pipeline,
      db,
      health,
      intervalSeconds: 120,
      concurrency: 1,
      enabledCollectors: new Set(["google_news_rss"]),
      fetchFeed: vi.fn(async () => ({
        items: [{
          title: "Alpha Inc reports quarterly results",
          url: "https://news.example/story",
          sourceName: "news.example",
          publisherDomain: "news.example",
          publishedAt: Date.now(),
          aggregatorPublishedAt: null,
          sourceItemId: "alpha-storage-failure",
          snippet: "",
          tier: "trade" as const,
        }],
        providerItemCount: 1,
        malformedItemCount: 0,
      })),
      pause: async () => {},
    });
    await control.stop();

    expect(db.deliverySummary()[0]).toMatchObject({ result: "success", parsedItemCount: 1 });
    expect(db.deliveryHealth([{
      collector: "google_news_rss", enabled: true, intervalSeconds: 120, targetCount: 1,
    }], Date.now())[0]).toMatchObject({ state: "failed", latestError: "observation persistence failed" });
    db.close();
  });

  it("records a partial ingestion outcome when a later item fails in the same fetched batch", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const items = ["alpha-first", "alpha-second"].map((id) => ({
      title: "Alpha Inc reports quarterly results",
      url: `https://news.example/${id}`,
      sourceName: "news.example",
      publisherDomain: "news.example",
      publishedAt: Date.now(),
      aggregatorPublishedAt: null,
      sourceItemId: id,
      snippet: "",
      tier: "trade" as const,
    }));
    const pipeline = {
      ingest: vi.fn()
        .mockReturnValueOnce(true)
        .mockImplementationOnce(() => { throw new Error("second item could not be saved"); }),
    } as unknown as Pipeline;
    const control = startRssPoller({
      companies: companies.slice(0, 1),
      pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured"),
      intervalSeconds: 120,
      concurrency: 1,
      enabledCollectors: new Set(["google_news_rss"]),
      fetchFeed: vi.fn(async () => ({ items, providerItemCount: 2, malformedItemCount: 0 })),
      pause: async () => {},
    });
    await control.stop();

    const [source] = db.deliveryHealth([{
      collector: "google_news_rss", enabled: true, intervalSeconds: 120, targetCount: 1,
    }], Date.now());
    expect(source).toMatchObject({
      state: "partial", latestResult: "success", coverageCount: 0,
      latestIngestionState: "partial", latestIngestionExpectedCount: 2,
      latestIngestionProcessedCount: 1, latestIngestionInsertedCount: 1,
      latestError: "second item could not be saved",
    });
    db.close();
  });

  it("marks all-malformed provider rows invalid instead of successful-empty", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const health = new HealthTracker(false, false, "unconfigured");
    const control = startRssPoller({
      companies: companies.slice(0, 1),
      pipeline: {} as Pipeline,
      db,
      health,
      intervalSeconds: 120,
      concurrency: 1,
      enabledCollectors: new Set(["yahoo_finance_rss"]),
      fetchFeed: vi.fn(async () => ({ items: [], providerItemCount: 2, malformedItemCount: 2 })),
      pause: async () => {},
    });
    await control.stop();

    expect(db.deliveryHealth([{
      collector: "yahoo_finance_rss", enabled: true, intervalSeconds: 120, targetCount: 1,
    }], Date.now())[0]).toMatchObject({
      state: "failed", latestResult: "invalid", latestItemCount: 2, coverageCount: 0,
      latestError: "RSS discarded 2 malformed items",
    });
    expect(health.snapshot().rss).toMatchObject({ ok: 0, fail: 1 });
    db.close();
  });
});
