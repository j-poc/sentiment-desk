import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { Company, MentionScore, RawMention } from "../server/types.js";

const directories: string[] = [];
const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};
const bucketMs = 15 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sourceMention(sourceItemId: string, publishedAt: number): RawMention {
  return {
    companyId: company.id,
    kind: "rss",
    sourceName: "Reuters",
    sourceUrl: `https://reuters.com/${sourceItemId}`,
    tier: "wire",
    title: `Acme update ${sourceItemId}`,
    snippet: "Isolated score-bucket API fixture",
    publishedAt,
    retrievedAt: publishedAt,
    collector: "google_news_rss",
    sourceItemId,
    publisherName: "Reuters",
    publisherDomain: "reuters.com",
  };
}

function scoredAt(scoredAt: number): MentionScore {
  return {
    sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
    about: 1, material: 0.8, novel: 0.8, credible: 0.9, investorRelevant: 0.9,
    eventType: "results", takeaway: "positive update", magnitude: 0.5, surprise: 0.2,
    eventScore: 70, impact: 56, weight: 0.8, engine: "test-fixture", inputTokens: 10,
    outputTokens: 8, estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "fixture-rubric", scoredAt,
  };
}

describe("score-bucket evidence API", () => {
  it("returns the chart bucket's saved scored rows with inclusive first-bucket boundary and stable pages", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-29T10:22:00.000Z");
    vi.setSystemTime(now);
    const through = Math.floor(now / bucketMs) * bucketMs;
    const from = through - bucketMs;
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-score-bucket-api-"));
    directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new Desk(dbPath);
    db.seedCompanies([company]);
    const records = [
      ["before", from - 1],
      ["boundary", from],
      ["inside", from + 1],
      ["through", through],
    ] as const;
    for (const [id, at] of records) {
      const inserted = db.insertObservation(sourceMention(id, at));
      db.markScored(inserted.observationId, scoredAt(at), false);
    }

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
      const firstResponse = await app.request(
        `/api/companies/acme/score-bucket?hours=24&through=${through}&includeFromBoundary=true&limit=2`,
      );
      expect(firstResponse.status).toBe(200);
      const firstPage = await firstResponse.json() as {
        items: Array<{ id: string; title: string; score: { scoredAt: number } }>;
        nextCursor: { scoredAt: number; id: string } | null;
        includeFromBoundary: boolean;
      };
      expect(firstPage.includeFromBoundary).toBe(true);
      expect(firstPage.items.map((item) => item.title)).toEqual(["Acme update through", "Acme update inside"]);
      expect(firstPage.nextCursor).not.toBeNull();

      const lookupResponse = await app.request("/api/companies/acme/mentions/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [firstPage.items[0]!.id, "missing-row"] }),
      });
      expect(lookupResponse.status).toBe(200);
      await expect(lookupResponse.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ id: firstPage.items[0]!.id, title: "Acme update through" })],
      });
      expect((await app.request("/api/companies/acme/mentions/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [firstPage.items[0]!.id, firstPage.items[0]!.id] }),
      })).status).toBe(400);
      expect((await app.request("/api/companies/missing/mentions/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [firstPage.items[0]!.id] }),
      })).status).toBe(404);

      const cursor = encodeURIComponent(JSON.stringify(firstPage.nextCursor));
      const secondResponse = await app.request(
        `/api/companies/acme/score-bucket?hours=24&through=${through}&includeFromBoundary=true&limit=2&cursor=${cursor}`,
      );
      expect(secondResponse.status).toBe(200);
      await expect(secondResponse.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ title: "Acme update boundary", score: expect.objectContaining({ scoredAt: from }) })],
        nextCursor: null,
      });

      const normalBoundaryResponse = await app.request(
        `/api/companies/acme/score-bucket?hours=24&through=${through}&includeFromBoundary=false`,
      );
      await expect(normalBoundaryResponse.json()).resolves.toMatchObject({
        items: [
          expect.objectContaining({ title: "Acme update through" }),
          expect.objectContaining({ title: "Acme update inside" }),
        ],
      });
      expect((await app.request(`/api/companies/acme/score-bucket?through=${through}&includeFromBoundary=yes`)).status).toBe(400);
      expect((await app.request(`/api/companies/acme/score-bucket?through=${through + 1}&cursor=${encodeURIComponent(JSON.stringify({ scoredAt: through + 2, id: "future" }))}`)).status).toBe(400);
      expect((await app.request(`/api/companies/missing/score-bucket?through=${through}`)).status).toBe(404);
    } finally {
      db.close();
    }
  });
});
