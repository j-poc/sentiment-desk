import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { Company, RawMention } from "../server/types.js";

const directories: string[] = [];
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
    const db = new Desk(dbPath);
    db.seedCompanies([company]);
    const recent = db.insertObservation(mention("recent", now - 1_000));
    const older = db.insertObservation(mention("older-than-seven-days", now - 9 * 24 * 60 * 60 * 1_000));
    db.markFailed(older.observationId, "Provider response was not received", false);

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
