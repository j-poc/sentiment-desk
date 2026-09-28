import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { providerCoolingDown } from "../server/provider-cooldown.js";
import { startFinnhubPoller, startRedditPoller, startSecPoller, startXPoller } from "../server/schedule.js";
import type { Pipeline } from "../server/pipeline.js";
import type { Company } from "../server/types.js";

const companies: Company[] = [
  { id: "alpha", name: "Alpha Inc", ticker: "ALPH", sector: "Technology", aliases: ["Alpha"], color: "#123456" },
  { id: "beta", name: "Beta Inc", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321" },
];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("optional provider rate limits", () => {
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
    });
    await control.stop();
    expect(request).toHaveBeenCalledTimes(2);
    expect(providerCoolingDown(db, "reddit")).toBe(true);
    expect(db.deliverySummary().filter((row) => row.collector === "reddit")).toHaveLength(1);
    db.close();
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
