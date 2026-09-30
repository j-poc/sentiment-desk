import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { providerCoolingDown } from "../server/provider-cooldown.js";
import { startFinnhubPoller, startRedditPoller, startSecCollector, startSecPoller, startXPoller } from "../server/schedule.js";
import { xQuery } from "../server/sources/x.js";
import type { Pipeline } from "../server/pipeline.js";
import type { Company } from "../server/types.js";

const companies: Company[] = [
  { id: "alpha", name: "Alpha Inc", ticker: "ALPH", sector: "Technology", aliases: ["Alpha"], color: "#123456" },
  { id: "beta", name: "Beta Inc", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321" },
];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("optional provider rate limits", () => {
  it("retries a failed SEC ticker-directory bootstrap and starts the poller after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const health = new HealthTracker(false, false, "unconfigured", true);
    const resolveTickerCiks = vi.fn()
      .mockRejectedValueOnce(new Error("temporary SEC directory failure"))
      .mockResolvedValueOnce(new Map([["ALPH", "0000000001"]]));
    const fetchFilings = vi.fn().mockResolvedValue([]);
    const control = startSecCollector({
      companies: [companies[0]!],
      userAgent: "Sentiment Desk test@example.com",
      pipeline: {} as Pipeline,
      db,
      health,
      intervalSeconds: 1,
      resolveTickerCiks,
      fetchFilings,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveTickerCiks).toHaveBeenCalledTimes(1);
      expect(db.deliverySummary().find((row) => row.collector === "sec_edgar"))
        .toMatchObject({ result: "failed", companyId: null, error: "temporary SEC directory failure" });
      expect(health.snapshot().sec).toMatchObject({ fail: 1, lastError: "SEC ticker directory: temporary SEC directory failure" });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(resolveTickerCiks).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(150);
      expect(db.deliverySummary().filter((row) => row.collector === "sec_edgar").map((row) => row.result))
        .toEqual(["empty", "success", "failed"]);
      expect(fetchFilings).toHaveBeenCalledWith(expect.objectContaining({ cik: "0000000001", ticker: "ALPH" }));
      expect(db.deliverySummary().find((row) => row.companyId === "alpha" && row.collector === "sec_edgar"))
        .toMatchObject({ result: "empty", companyId: "alpha" });
      expect(health.snapshot().sec).toMatchObject({ ok: 2, fail: 1, lastError: "SEC ticker directory: temporary SEC directory failure" });
    } finally {
      await control.stop();
      db.close();
    }
  });

  it("stops SEC's company sweep and persists Retry-After", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const request = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "300" },
    }));
    globalThis.fetch = request;
    const control = startSecPoller({
      companies,
      cikByTicker: new Map([["ALPH", "0000000001"], ["BETA", "0000000002"]]),
      userAgent: "Sentiment Desk test@example.com",
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", true),
      intervalSeconds: 90,
    });
    await control.stop();
    expect(request).toHaveBeenCalledTimes(1);
    expect(providerCoolingDown(db, "sec")).toBe(true);
    expect(db.deliverySummary().filter((row) => row.collector === "sec_edgar")).toHaveLength(1);
    db.close();
  });

  it("scores SEC filings only when source document text is available", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const acceptedAt = new Date().toISOString();
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/submissions/")) {
        return new Response(JSON.stringify({
          filings: { recent: {
            form: ["8-K", "8-K", "8-K"],
            filingDate: ["2026-09-28", "2026-09-28", "2026-09-28"],
            acceptanceDateTime: [acceptedAt, acceptedAt, acceptedAt],
            accessionNumber: ["0000000001-26-000001", "0000000001-26-000002", "0000000001-26-000003"],
            primaryDocument: ["unavailable.htm", "", "available.htm"],
            items: ["2.02", "5.02", "2.02"],
          } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/available.htm")) return new Response("Actual SEC filing text", { status: 200 });
      return new Response("document unavailable", { status: 503 });
    });
    globalThis.fetch = request;
    const ingest = vi.fn(() => true);
    const control = startSecPoller({
      companies: [companies[0]!],
      cikByTicker: new Map([["ALPH", "0000000001"]]),
      userAgent: "Sentiment Desk test@example.com",
      pipeline: { ingest } as unknown as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", true),
      intervalSeconds: 90,
    });

    try {
      await control.stop();
      expect(request).toHaveBeenCalledTimes(3);
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        sourceItemId: "0000000001-26-000003",
        snippet: "Actual SEC filing text",
        deliveryId: expect.any(String),
        adapterVersion: "sec-primary-document/1",
      }));
      expect(db.deliverySummary().find((row) => row.collector === "sec_edgar" && row.adapterVersion === "sec-submissions/1"))
        .toMatchObject({ result: "partial", parsedItemCount: 3, error: "2 SEC filing document(s) unavailable; omitted from Jev input" });
    } finally {
      db.close();
    }
  });

  it("records a visible SEC delivery gap for watchlist companies without a CIK mapping", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const health = new HealthTracker(false, false, "unconfigured", true);
    const fetchFilings = vi.fn(async () => []);
    const control = startSecPoller({
      companies,
      cikByTicker: new Map([["ALPH", "0000000001"]]),
      userAgent: "Sentiment Desk test@example.com",
      pipeline: {} as Pipeline,
      db,
      health,
      intervalSeconds: 120,
      fetchFilings,
    });

    try {
      await control.stop();
      expect(fetchFilings).toHaveBeenCalledTimes(1);
      expect(db.deliverySummary().find((row) => row.companyId === "beta" && row.adapterVersion === "sec-ticker-mapping/1"))
        .toMatchObject({ result: "invalid", error: "BETA: no CIK mapping in the SEC ticker directory" });
      expect(db.deliveryHealth([{
        collector: "sec_edgar", enabled: true, intervalSeconds: 120, targetCount: 2,
      }], Date.now())[0]).toMatchObject({
        state: "failed", coverageCount: 1, targetCount: 2,
        latestError: "BETA: no CIK mapping in the SEC ticker directory",
      });
      expect(health.snapshot().sec).toMatchObject({ fail: 1, lastError: "BETA: no CIK mapping in the SEC ticker directory" });
    } finally {
      db.close();
    }
  });

  it("stops Finnhub backfill, earnings, and recent calls after the first 429", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const request = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "240" },
    }));
    globalThis.fetch = request;
    const control = startFinnhubPoller({
      companies,
      token: "synthetic-test-token",
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", false, true),
      intervalSeconds: 120,
      backfillDays: 0,
    });
    await control.stop();
    expect(request).toHaveBeenCalledTimes(1);
    expect(providerCoolingDown(db, "finnhub")).toBe(true);
    expect(db.deliverySummary().filter((row) => row.collector === "finnhub")).toHaveLength(1);
    db.close();
  });

  it("replaces stale earnings dates atomically and exposes malformed news rows", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    db.setKv("finnhub:earnings:alpha", "1790726400000");
    db.setKv("finnhub:earnings:beta", "1790812800000");
    const health = new HealthTracker(false, false, "unconfigured", false, true);
    const control = startFinnhubPoller({
      companies,
      token: "test-token",
      pipeline: { ingest: vi.fn(() => true) } as unknown as Pipeline,
      db,
      health,
      intervalSeconds: 120,
      backfillDays: 0,
      fetchUpcomingEarnings: vi.fn(async () => new Map([[
        "ALPH", Date.parse("2026-10-15T00:00:00.000Z"),
      ]])),
      fetchEarningsHistory: vi.fn(async () => []),
      fetchNews: vi.fn(async (symbol: string) => symbol === "ALPH"
        ? {
          items: [{
            headline: "Alpha Inc reports revenue growth",
            summary: "",
            source: "finnhub",
            url: "https://news.example/alpha",
            datetime: Date.now(),
          }],
          providerItemCount: 2,
          malformedItemCount: 1,
        }
        : { items: [], providerItemCount: 1, malformedItemCount: 1 }),
    });

    try {
      await control.stop();
      expect(db.getKv("finnhub:earnings:alpha")).toBe(String(Date.parse("2026-10-15T00:00:00.000Z")));
      expect(db.getKv("finnhub:earnings:beta")).toBe("");
      expect(db.deliverySummary().find((row) => row.collector === "finnhub" && row.companyId === "alpha" && row.error === "Finnhub discarded 1 malformed news item"))
        .toMatchObject({ result: "partial", parsedItemCount: 2, error: "Finnhub discarded 1 malformed news item" });
      expect(db.deliveryHealth([{
        collector: "finnhub", enabled: true, intervalSeconds: 120, targetCount: 2,
        healthAdapterVersions: ["finnhub-news/1"],
      }], Date.now())[0]).toMatchObject({ state: "failed", coverageCount: 0 });
      expect(health.snapshot().finnhub).toMatchObject({ fail: 1 });
    } finally {
      db.close();
    }
  });

  it("backs off malformed Finnhub history scans and retries unresolved companies after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-finnhub-backfill-"));
    const databasePath = join(directory, "desk.db");
    let db = new Desk(databasePath);
    const gamma: Company = { id: "gamma", name: "Gamma Inc", ticker: "GAMM", sector: "Technology", aliases: ["Gamma"], color: "#456789" };
    const backfillCompanies = [...companies, gamma];
    db.seedCompanies(backfillCompanies);
    const historicalRequests: string[] = [];
    const fetchNews = vi.fn(async (_symbol: string, _token: string, days?: number) => {
      if (days == null) return { items: [], providerItemCount: 0, malformedItemCount: 0 };
      historicalRequests.push(_symbol);
      const attempt = historicalRequests.filter((symbol) => symbol === _symbol).length;
      if (_symbol === "ALPH" && attempt === 1) return { items: [], providerItemCount: 2, malformedItemCount: 2 };
      if (_symbol === "GAMM" && attempt === 1) throw new Error("temporary Finnhub history failure");
      return { items: [], providerItemCount: 0, malformedItemCount: 0 };
    });
    const start = (desk: Desk) => startFinnhubPoller({
      companies: backfillCompanies,
      token: "test-token",
      pipeline: {} as Pipeline,
      db: desk,
      health: new HealthTracker(false, false, "unconfigured", false, true),
      intervalSeconds: 120,
      backfillDays: 14,
      pause: async () => {},
      fetchNews,
      fetchUpcomingEarnings: vi.fn(async () => new Map()),
      fetchEarningsHistory: vi.fn(async () => []),
    });

    try {
      const firstRun = start(db);
      await firstRun.stop();
      expect(historicalRequests).toEqual(["ALPH", "BETA", "GAMM"]);
      expect(Number(db.getKv("finnhub:backfill:14:alpha"))).toBeGreaterThan(Date.now());
      expect(db.getKv("finnhub:backfill:14:beta")).toBe("complete");
      expect(Number(db.getKv("finnhub:backfill:14:gamma"))).toBeGreaterThan(Date.now());
      db.close();

      db = new Desk(databasePath);
      const backoffRun = start(db);
      await backoffRun.stop();
      expect(historicalRequests).toEqual(["ALPH", "BETA", "GAMM"]);
      vi.setSystemTime(new Date("2026-09-29T12:16:00.000Z"));
      const retryRun = start(db);
      await retryRun.stop();
      expect(historicalRequests).toEqual(["ALPH", "BETA", "GAMM", "ALPH", "GAMM"]);
      expect(db.getKv("finnhub:backfill:14:alpha")).toBe("complete");
      expect(db.getKv("finnhub:backfill:14:beta")).toBe("complete");
      expect(db.getKv("finnhub:backfill:14:gamma")).toBe("complete");
      expect(db.deliverySummary().find((row) => row.collector === "finnhub" && row.error === "Finnhub discarded 2 malformed news items"))
        .toMatchObject({ result: "invalid", parsedItemCount: 2 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops Reddit's search rotation after the first 429", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "180" },
      }));
    globalThis.fetch = request;
    const control = startRedditPoller({
      companies,
      creds: { clientId: "test-id", clientSecret: "test-secret" },
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", false, false, true),
      intervalSeconds: 180,
      pause: async () => {},
    });
    await control.stop();
    expect(request).toHaveBeenCalledTimes(2);
    expect(providerCoolingDown(db, "reddit")).toBe(true);
    expect(db.deliverySummary().filter((row) => row.collector === "reddit")).toHaveLength(1);
    db.close();
  });

  it("preserves a missing Reddit source timestamp as unknown", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { children: [{ data: {
          id: "post-1",
          title: "$ALPH revenue report",
          selftext: "Alpha Inc reports revenue growth.",
          subreddit: "stocks",
          author: "researcher",
          permalink: "/r/stocks/comments/post-1/alpha_revenue_report/",
          score: 3,
          num_comments: 1,
        } }], after: null },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = request;
    const ingest = vi.fn(() => true);
    const control = startRedditPoller({
      companies: [companies[0]!],
      creds: { clientId: "test-id", clientSecret: "test-secret" },
      pipeline: { ingest } as unknown as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", false, false, true),
      intervalSeconds: 180,
      pause: async () => {},
    });

    try {
      await control.stop();
      expect(request).toHaveBeenCalledTimes(2);
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ publishedAt: null }));
    } finally {
      db.close();
    }
  });

  it("reports malformed Reddit children as partial coverage", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { children: [
        { data: { id: "valid", title: "$ALPH revenue report", permalink: "/r/stocks/comments/valid/", selftext: "Alpha Inc reports growth" } },
        { data: { id: "malformed", title: "$ALPH revenue report" } },
      ], after: null } }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = request;
    const health = new HealthTracker(false, false, "unconfigured", false, false, true);
    const control = startRedditPoller({
      companies: [companies[0]!],
      creds: { clientId: "test-id", clientSecret: "test-secret" },
      pipeline: { ingest: vi.fn(() => true) } as unknown as Pipeline,
      db,
      health,
      intervalSeconds: 180,
      pause: async () => {},
    });

    try {
      await control.stop();
      expect(db.deliveryHealth([{
        collector: "reddit", enabled: true, intervalSeconds: 180, targetCount: 1,
      }], Date.now())[0]).toMatchObject({
        state: "partial", latestResult: "partial", latestItemCount: 2, coverageCount: 0,
        latestError: "Reddit discarded 1 malformed listing item",
      });
      expect(health.snapshot().reddit).toMatchObject({ ok: 1, fail: 0 });
    } finally {
      db.close();
    }
  });

  it("marks a non-empty all-malformed Reddit page invalid", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { children: [
        { data: { id: "malformed", title: "", permalink: "/r/stocks/comments/malformed/" } },
      ], after: null } }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = request;
    const health = new HealthTracker(false, false, "unconfigured", false, false, true);
    const control = startRedditPoller({
      companies: [companies[0]!],
      creds: { clientId: "test-id", clientSecret: "test-secret" },
      pipeline: {} as Pipeline,
      db,
      health,
      intervalSeconds: 180,
      pause: async () => {},
    });

    try {
      await control.stop();
      expect(db.deliveryHealth([{
        collector: "reddit", enabled: true, intervalSeconds: 180, targetCount: 1,
      }], Date.now())[0]).toMatchObject({
        state: "failed", latestResult: "invalid", latestItemCount: 1, coverageCount: 0,
      });
      expect(health.snapshot().reddit).toMatchObject({ ok: 0, fail: 1 });
    } finally {
      db.close();
    }
  });

  it("resumes Reddit listing pages from the saved provider cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-reddit-pages-"));
    const databasePath = join(directory, "desk.db");
    let db = new Desk(databasePath);
    db.seedCompanies([companies[0]!]);
    const urls: URL[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("access_token")) {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      urls.push(url);
      const after = url.searchParams.get("after");
      const post = after == null
        ? { id: "post-1", title: "$ALPH revenue report", permalink: "/r/stocks/comments/post-1/", selftext: "Alpha reports growth" }
        : { id: "post-2", title: "$ALPH revenue guidance", permalink: "/r/stocks/comments/post-2/", selftext: "Alpha updates guidance" };
      return new Response(JSON.stringify({
        data: { children: [{ data: { ...post, subreddit: "stocks", author: "member", created_utc: 1_790_000_000 } }],
          after: after == null ? "t3_next-page" : null },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = request;
    const ingest = vi.fn(() => true);
    const deps = {
      companies: [companies[0]!],
      creds: { clientId: "test-id", clientSecret: "test-secret" },
      pipeline: { ingest } as unknown as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", false, false, true),
      intervalSeconds: 180,
      pause: async () => {},
    };

    try {
      const firstPage = startRedditPoller(deps);
      await firstPage.stop();
      expect(JSON.parse(db.getKv("reddit:pagination:alpha") ?? "{}")).toMatchObject({
        after: "t3_next-page", page: 2, query: '"Alpha Inc" OR "$ALPH"', limit: 25,
      });
      expect(db.deliverySummary().find((row) => row.adapterVersion === "reddit-search/1"))
        .toMatchObject({ result: "partial", parsedItemCount: 1 });

      db.close();
      db = new Desk(databasePath);
      deps.db = db;
      const secondPage = startRedditPoller(deps);
      await secondPage.stop();
      expect(urls).toHaveLength(2);
      expect(urls[0]?.searchParams.has("after")).toBe(false);
      expect(urls[1]?.searchParams.get("after")).toBe("t3_next-page");
      expect(db.getKv("reddit:pagination:alpha")).toBe("");
      expect(ingest).toHaveBeenCalledTimes(2);
      expect(db.deliverySummary().filter((row) => row.adapterVersion === "reddit-search/1")
        .map((row) => row.result).sort()).toEqual(["partial", "success"]);
      expect(db.deliveryHealth([{
        collector: "reddit", enabled: true, intervalSeconds: 180, targetCount: 1,
      }], Date.now())[0]).toMatchObject({ state: "current", coverageCount: 1, latestResult: "success" });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("restarts Reddit from the newest listing when a saved cursor is rejected", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const query = '"Alpha Inc" OR "$ALPH"';
    db.setKv("reddit:pagination:alpha", JSON.stringify({ after: "t3_expired", page: 3, query, limit: 25 }));
    const searchUrls: URL[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("access_token")) {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      searchUrls.push(url);
      if (url.searchParams.has("after")) return new Response("cursor expired", { status: 400 });
      return new Response(JSON.stringify({ data: { children: [], after: null } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = request;
    const deps = {
      companies: [companies[0]!],
      creds: { clientId: "test-id", clientSecret: "test-secret" },
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(false, false, "unconfigured", false, false, true),
      intervalSeconds: 180,
      pause: async () => {},
    };

    try {
      const rejected = startRedditPoller(deps);
      await rejected.stop();
      expect(db.getKv("reddit:pagination:alpha")).toBe("");
      expect(db.deliverySummary().find((row) => row.result === "failed"))
        .toMatchObject({ error: "Reddit pagination cursor was rejected with HTTP 400" });

      const replay = startRedditPoller(deps);
      await replay.stop();
      expect(searchUrls).toHaveLength(2);
      expect(searchUrls[0]?.searchParams.get("after")).toBe("t3_expired");
      expect(searchUrls[1]?.searchParams.has("after")).toBe(false);
      expect(db.deliverySummary().filter((row) => row.adapterVersion === "reddit-search/1")
        .map((row) => row.result).sort()).toEqual(["empty", "failed"]);
    } finally {
      db.close();
    }
  }, 15_000);

  it("drains X search pages before committing the newest seen ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-x-pages-"));
    const databasePath = join(directory, "desk.db");
    let db = new Desk(databasePath);
    db.seedCompanies([companies[0]!]);
    const urls: URL[] = [];
    const posts = [
      { id: "200", text: "$ALPH reports revenue growth", created_at: "2026-09-29T10:00:00.000Z", author_id: "author-1" },
      { id: "199", text: "$ALPH revenue guidance is lifted", created_at: "2026-09-29T09:59:00.000Z", author_id: "author-1" },
    ];
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      const body = url.searchParams.has("next_token")
        ? { data: [posts[1]], meta: { newest_id: "199", result_count: 1 } }
        : { data: [posts[0]], meta: { newest_id: "200", next_token: "opaque-page-2", result_count: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = request;
    const ingest = vi.fn(() => true);
    const deps = {
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: { ingest } as unknown as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };

    try {
      const firstPage = startXPoller(deps);
      await firstPage.stop();
      expect(db.getKv("x:since:alpha")).toBeUndefined();
      expect(JSON.parse(db.getKv("x:pagination:alpha") ?? "{}")).toMatchObject({
        sinceId: null,
        newestId: "200",
        nextToken: "opaque-page-2",
        page: 2,
        query: '("Alpha" OR "$ALPH") lang:en -is:retweet -is:reply',
        maxResults: 25,
      });
      expect(db.deliverySummary().find((row) => row.collector === "x"))
        .toMatchObject({ result: "partial", parsedItemCount: 1 });

      db.close();
      db = new Desk(databasePath);
      deps.db = db;
      const secondPage = startXPoller(deps);
      await secondPage.stop();
      expect(urls).toHaveLength(2);
      expect(urls[0]?.searchParams.has("next_token")).toBe(false);
      expect(urls[1]?.searchParams.get("next_token")).toBe("opaque-page-2");
      expect(db.getKv("x:since:alpha")).toBe("200");
      expect(db.getKv("x:pagination:alpha")).toBe("");
      expect(ingest).toHaveBeenCalledTimes(2);
      expect(db.deliverySummary().map((row) => row.result).sort()).toEqual(["partial", "success"]);
      expect(db.deliveryHealth([{
        collector: "x", enabled: true, intervalSeconds: 180, targetCount: 1,
      }], Date.now())[0]).toMatchObject({ state: "current", coverageCount: 1, latestResult: "success" });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restarts X from the last committed ID after a continuation token is rejected", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    db.setKv("x:since:alpha", "150");
    db.setKv("x:since-state:alpha", JSON.stringify({
      sinceId: "150", query: xQuery(companies[0]!), maxResults: 25,
    }));
    const urls: URL[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.searchParams.has("next_token")) return new Response("invalid cursor", { status: 400 });
      if (urls.length === 1) {
        return new Response(JSON.stringify({ data: [], meta: { newest_id: "200", next_token: "rejected-token", result_count: 0 } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [], meta: { newest_id: "210", result_count: 0 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = request;
    const deps = {
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };

    try {
      const firstPage = startXPoller(deps);
      await firstPage.stop();
      expect(db.getKv("x:pagination:alpha")).toContain("rejected-token");
      expect(db.getKv("x:since:alpha")).toBe("150");

      const rejectedPage = startXPoller(deps);
      await rejectedPage.stop();
      expect(db.getKv("x:pagination:alpha")).toBe("");
      expect(db.getKv("x:since:alpha")).toBe("150");
      expect(db.deliverySummary().find((row) => row.result === "failed"))
        .toMatchObject({ error: "X pagination token was rejected with HTTP 400" });

      const replay = startXPoller(deps);
      await replay.stop();
      expect(urls).toHaveLength(3);
      expect(urls[2]?.searchParams.has("next_token")).toBe(false);
      expect(urls[2]?.searchParams.get("since_id")).toBe("150");
      expect(db.getKv("x:since:alpha")).toBe("210");
    } finally {
      db.close();
    }
  });

  it("fails closed on malformed X pagination metadata without advancing the cursor", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const query = xQuery(companies[0]!);
    db.setKv("x:since:alpha", "150");
    db.setKv("x:since-state:alpha", JSON.stringify({ sinceId: "150", query, maxResults: 25 }));
    const urls: URL[] = [];
    const tokens: unknown[] = [123, ""];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ data: [], meta: { newest_id: "200", next_token: tokens.shift(), result_count: 0 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const deps = {
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };

    try {
      const firstAttempt = startXPoller(deps);
      await firstAttempt.stop();
      const secondAttempt = startXPoller(deps);
      await secondAttempt.stop();
      expect(urls).toHaveLength(2);
      expect(urls.every((url) => url.searchParams.get("since_id") === "150")).toBe(true);
      expect(urls.every((url) => !url.searchParams.has("next_token"))).toBe(true);
      expect(db.getKv("x:since:alpha")).toBe("150");
      expect(JSON.parse(db.getKv("x:since-state:alpha") ?? "{}")).toMatchObject({ sinceId: "150", query, maxResults: 25 });
      expect(db.deliverySummary().filter((row) => row.result === "invalid")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("clears an X continuation when the provider repeats the same pagination token", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    const query = xQuery(companies[0]!);
    db.setKv("x:since:alpha", "150");
    db.setKv("x:since-state:alpha", JSON.stringify({ sinceId: "150", query, maxResults: 25 }));
    db.setKv("x:pagination:alpha", JSON.stringify({
      sinceId: "150", newestId: "200", nextToken: "repeat-token", page: 2, query, maxResults: 25,
    }));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [], meta: { newest_id: "200", next_token: "repeat-token", result_count: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const control = startXPoller({
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    });

    try {
      await control.stop();
      expect(db.getKv("x:pagination:alpha")).toBe("");
      expect(db.getKv("x:since:alpha")).toBe("150");
      expect(db.deliverySummary().find((row) => row.collector === "x"))
        .toMatchObject({ result: "invalid", error: "X API returned a non-advancing pagination token" });
    } finally {
      db.close();
    }
  });

  it("replays X recent search when a committed query's aliases change", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    db.setKv("x:since:alpha", "150");
    db.setKv("x:since-state:alpha", JSON.stringify({
      sinceId: "150", query: xQuery(companies[0]!), maxResults: 25,
    }));
    const updatedCompany = { ...companies[0]!, aliases: ["NewAlpha"] };
    let requestedUrl: URL | undefined;
    const request = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({
        data: [{ id: "140", text: "NewAlpha revenue momentum accelerates", created_at: "2026-09-29T10:00:00.000Z", author_id: "author-1" }],
        meta: { newest_id: "140", result_count: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = request;
    const ingest = vi.fn(() => true);
    const deps = {
      bearer: "test-token",
      companies: [updatedCompany],
      pipeline: { ingest } as unknown as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };

    try {
      const control = startXPoller(deps);
      await control.stop();
      expect(requestedUrl?.searchParams.get("query")).toBe(xQuery(updatedCompany));
      expect(requestedUrl?.searchParams.has("since_id")).toBe(false);
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        sourceItemId: "140", title: "NewAlpha revenue momentum accelerates",
      }));
      expect(db.getKv("x:since:alpha")).toBe("140");
      expect(JSON.parse(db.getKv("x:since-state:alpha") ?? "{}")).toMatchObject({
        sinceId: "140", query: xQuery(updatedCompany), maxResults: 25,
      });
    } finally {
      db.close();
    }
  });

  it("does not trust an X cursor created before query fingerprints were stored", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    db.setKv("x:since:alpha", "150");
    let requestedUrl: URL | undefined;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ data: [], meta: { newest_id: "160", result_count: 0 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const deps = {
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };

    try {
      const control = startXPoller(deps);
      await control.stop();
      expect(requestedUrl?.searchParams.has("since_id")).toBe(false);
      expect(db.getKv("x:since:alpha")).toBe("160");
      expect(JSON.parse(db.getKv("x:since-state:alpha") ?? "{}")).toMatchObject({
        sinceId: "160", query: xQuery(companies[0]!), maxResults: 25,
      });
    } finally {
      db.close();
    }
  });

  it("does not advance X past a response with missing posts and a nonzero result count", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    db.setKv("x:since:alpha", "150");
    db.setKv("x:since-state:alpha", JSON.stringify({
      sinceId: "150", query: xQuery(companies[0]!), maxResults: 25,
    }));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      meta: { newest_id: "200", result_count: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const control = startXPoller({
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    });

    try {
      await control.stop();
      expect(db.getKv("x:since:alpha")).toBe("150");
      expect(db.deliverySummary().find((row) => row.collector === "x"))
        .toMatchObject({ result: "invalid", parsedItemCount: 0, error: "X API returned an invalid response: posts were omitted despite a nonzero result count" });
    } finally {
      db.close();
    }
  });

  it("replays X recent search when a committed cursor is malformed", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies([companies[0]!]);
    db.setKv("x:since:alpha", "garbage");
    db.setKv("x:since-state:alpha", JSON.stringify({
      sinceId: "garbage", query: xQuery(companies[0]!), maxResults: 25,
    }));
    let requestedUrl: URL | undefined;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ data: [], meta: { newest_id: "170", result_count: 0 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const deps = {
      bearer: "test-token",
      companies: [companies[0]!],
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };

    try {
      const control = startXPoller(deps);
      await control.stop();
      expect(requestedUrl?.searchParams.has("since_id")).toBe(false);
      expect(db.getKv("x:since:alpha")).toBe("170");
      expect(JSON.parse(db.getKv("x:since-state:alpha") ?? "{}")).toMatchObject({
        sinceId: "170", query: xQuery(companies[0]!), maxResults: 25,
      });
    } finally {
      db.close();
    }
  });

  it("persists X's reset time and does not retry until the provider reset", async () => {
    const db = new Desk(":memory:");
    db.seedCompanies(companies);
    const resetAt = Math.floor((Date.now() + 600_000) / 1_000);
    const request = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "x-rate-limit-reset": String(resetAt) },
    }));
    globalThis.fetch = request;
    const deps = {
      bearer: "test-token",
      companies,
      pipeline: {} as Pipeline,
      db,
      health: new HealthTracker(true, false, "unconfigured"),
      intervalSeconds: 180,
    };
    const firstPass = startXPoller(deps);
    await firstPass.stop();
    const afterRateLimit = request.mock.calls.length;
    const secondPass = startXPoller(deps);
    await secondPass.stop();
    expect(afterRateLimit).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(providerCoolingDown(db, "x")).toBe(true);
    expect(db.deliverySummary().filter((row) => row.collector === "x")).toHaveLength(1);
    db.close();
  });
});
