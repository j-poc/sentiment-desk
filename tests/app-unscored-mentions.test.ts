import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { StorageLimits } from "../server/storage-capacity.js";
import type { Company, RawMention } from "../server/types.js";

const directories: string[] = [];
const testStorageLimits: StorageLimits = {
  maxDatabaseBytes: 32 * 1024 * 1024,
  maxFamilyBytes: 64 * 1024 * 1024,
  minimumFreeBytes: 1024 * 1024,
  writeHeadroomBytes: 1024 * 1024,
};
const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function mention(sourceItemId: string, publishedAt: number): RawMention {
  return {
    companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: `https://reuters.com/${sourceItemId}`,
    tier: "wire", title: `Acme update ${sourceItemId}`, snippet: "Source-persisted fixture",
    publishedAt, retrievedAt: Date.now(), collector: "google_news_rss",
    sourceItemId, publisherName: "Reuters", publisherDomain: "reuters.com",
  };
}

describe("unscored mentions API", () => {
  it("returns stable bounded cursors for older items and rejects malformed cursors", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-29T09:00:00.000Z");
    vi.setSystemTime(now);
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-unscored-api-"));
    directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new Desk(dbPath, testStorageLimits);
    db.seedCompanies([company]);
    const recent = db.insertObservation(mention("recent", now - 1_000));
    const older = db.insertObservation(mention("older-than-seven-days", now - 9 * 24 * 60 * 60 * 1_000));
    db.markFailed(older.observationId, "Provider response was not received", false);
    const offTarget = db.insertObservation(mention("off-target-history", now - 8 * 24 * 60 * 60 * 1_000));
    db.markScored(offTarget.observationId, {
      sentiment: "neutral", pPos: 0.1, pNeu: 0.8, pNeg: 0.1, confidence: 0.8,
      about: 0.2, material: 0.1, novel: 0.2, credible: 0.9, investorRelevant: 0.2,
      eventType: "other", takeaway: "routine", magnitude: 0, surprise: 0,
      eventScore: 10, impact: 0, weight: 0.2, engine: "test", inputTokens: 10,
      outputTokens: 8, estimatedInputCostUsd: 0.00001, latencyMs: 1,
      rubricSha: "test-rubric", scoredAt: now,
    }, true);
    const app = createApp({
      db,
      dbPath,
      pipeline: {} as AppDeps["pipeline"],
      market: {} as AppDeps["market"],
      hub: new Hub(),
      health: new HealthTracker(false, false, "unconfigured", false, false, false, false),
      version: "test",
      webRoot: join(directory, "missing-web-root"),
      deliverySources: [],
    });

    try {
      const response = await app.request("/api/companies/acme/mentions-page?filter=failed&hours=24&limit=1");
      expect(response.status).toBe(200);
      const firstPage = await response.json() as { items: Array<{ title: string }>; nextCursor: { orderAt: number; ingestedAt: number; id: string } | null };
      expect(firstPage.items).toMatchObject([{ title: "Acme update recent", status: "pending" }]);
      expect(firstPage.nextCursor).not.toBeNull();

      db.markScored(recent.observationId, {
        sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
        about: 1, material: 0.8, novel: 0.8, credible: 0.9, investorRelevant: 0.9,
        eventType: "results", takeaway: "positive update", magnitude: 0.5, surprise: 0.2,
        eventScore: 70, impact: 56, weight: 0.8, engine: "test", inputTokens: 10,
        outputTokens: 8, estimatedInputCostUsd: 0.00001, latencyMs: 1,
        rubricSha: "test-rubric", scoredAt: now,
      }, false);
      const cursor = encodeURIComponent(JSON.stringify(firstPage.nextCursor));
      const olderResponse = await app.request(`/api/companies/acme/mentions-page?filter=failed&hours=24&limit=1&cursor=${cursor}`);
      expect(olderResponse.status).toBe(200);
      await expect(olderResponse.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ title: "Acme update older-than-seven-days", status: "failed" })],
        nextCursor: null,
      });
      const historyFirst = await app.request("/api/companies/acme/mentions-page?filter=history&hours=24&limit=1");
      expect(historyFirst.status).toBe(200);
      const historyPage = await historyFirst.json() as { items: Array<{ title: string }>; nextCursor: { orderAt: number; ingestedAt: number; id: string } | null };
      expect(historyPage.items).toMatchObject([{ title: "Acme update recent" }]);
      expect(historyPage.nextCursor).not.toBeNull();
      const historyCursor = encodeURIComponent(JSON.stringify(historyPage.nextCursor));
      const historyOlder = await app.request(`/api/companies/acme/mentions-page?filter=history&hours=24&limit=1&cursor=${historyCursor}`);
      const historyOlderPage = await historyOlder.json() as { items: Array<{ title: string; status: string }>; nextCursor: { orderAt: number; ingestedAt: number; id: string } | null };
      expect(historyOlderPage).toMatchObject({
        items: [expect.objectContaining({ title: "Acme update off-target-history", status: "off_target" })],
        nextCursor: expect.any(Object),
      });
      const historyNextCursor = encodeURIComponent(JSON.stringify(historyOlderPage.nextCursor));
      const historyFinal = await app.request(`/api/companies/acme/mentions-page?filter=history&hours=24&limit=10&cursor=${historyNextCursor}`);
      await expect(historyFinal.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ title: "Acme update older-than-seven-days", status: "failed" })],
        nextCursor: null,
      });
      const boundedAll = await app.request("/api/companies/acme/mentions-page?filter=all&hours=24&limit=10");
      await expect(boundedAll.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ title: "Acme update recent", status: "scored" })],
      });
      expect((await app.request("/api/companies/acme/mentions-page?filter=unknown")).status).toBe(400);
      const bullish = await app.request("/api/companies/acme/mentions-page?filter=bull&hours=24");
      await expect(bullish.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ title: "Acme update recent", status: "scored" })],
        nextCursor: null,
      });
      expect((await app.request("/api/companies/acme/mentions-page?cursor=not-json")).status).toBe(400);
    } finally {
      db.close();
    }
  });
});
