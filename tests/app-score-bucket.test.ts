import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { isScoreBucketCoverage } from "../shared/score-bucket-coverage.js";
import { Hub } from "../server/hub.js";
import { weightedBucketSeries } from "../server/scoring.js";
import type { Company, MentionScore, RawMention } from "../server/types.js";

const directories: string[] = [];
const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};
const otherCompany: Company = {
  id: "other", name: "Other", ticker: "OTHR", sector: "Technology", aliases: ["Other"], color: "#654321",
};
const bucketMs = 15 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sourceMention(sourceItemId: string, publishedAt: number, title = `Acme update ${sourceItemId}`): RawMention {
  return {
    companyId: company.id, kind: "rss", sourceName: "Reuters",
    sourceUrl: `https://reuters.com/${sourceItemId}`, tier: "wire",
    title, snippet: "Isolated score-bucket API fixture",
    publishedAt: null, aggregatorPublishedAt: publishedAt, retrievedAt: publishedAt, collector: "google_news_rss",
    sourceItemId, publisherName: "Reuters", publisherDomain: "reuters.com",
  };
}

function scoredAt(at: number, impact = 56, weight = 0.8): MentionScore {
  return {
    sentiment: impact < 0 ? "negative" : "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
    about: 1, material: 0.8, novel: 0.8, credible: 0.9, investorRelevant: 0.9,
    eventType: "results", takeaway: "positive update", magnitude: 0.5, surprise: 0.2,
    eventScore: 70, impact, weight, engine: "test-fixture", inputTokens: 10,
    outputTokens: 8, estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "fixture-rubric", scoredAt: at,
  };
}

describe("score-bucket evidence API", () => {
  it("reconciles a full histogram to the exact half-open chart bucket across stable paginated source rows", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-29T10:22:00.000Z");
    vi.setSystemTime(now);
    const through = Math.floor(now / bucketMs) * bucketMs;
    const from = through - bucketMs;
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-score-bucket-api-"));
    directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new Desk(dbPath);
    db.seedCompanies([company, otherCompany]);

    for (let index = 0; index < 54; index += 1) {
      const at = from + 1 + index * 10_000;
      const title = index === 0 ? "Café earnings update"
        : index === 1 ? "CAFE\u0301   EARNINGS UPDATE"
          : index === 2 ? "   " : undefined;
      const inserted = db.insertObservation(sourceMention(`inside-${index}`, at, title));
      const impact = index === 0 ? -100 : index === 1 ? 100
        : index === 2 ? 0 : index === 3 ? 10 : index === 4 ? 20
          : index % 2 === 0 ? 5 : 15;
      db.markScored(inserted.observationId, scoredAt(at, impact, index === 2 ? 0 : 0.8), false);
    }
    const atFrom = db.insertObservation(sourceMention("exact-from", from));
    db.markScored(atFrom.observationId, scoredAt(from, -10), false);
    const atThrough = db.insertObservation(sourceMention("exact-through", through));
    db.markScored(atThrough.observationId, scoredAt(through, 88), false);

    const chartBucket = weightedBucketSeries(db.scoredMentions(from, through, company.id), bucketMs, bucketMs, through)
      .find((point) => point.bucketEndAtMs === through);
    expect(chartBucket).toBeDefined();
    expect(chartBucket?.bucketStartAtMs).toBe(from);
    expect(chartBucket?.scoredRecordCount).toBe(55);
    const expectedSnapshot = chartBucket!.bucketSnapshotKey;
    expect(expectedSnapshot).toMatch(/^[a-f0-9]{64}$/);

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
      const interval = `from=${from}&through=${through}&hours=24`;
      const firstResponse = await app.request(
        `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&limit=2`,
      );
      expect(firstResponse.status).toBe(200);
      const firstPage = await firstResponse.json() as {
        bucketFromMs: number; bucketThroughMs: number; recordCount: number;
        matchingRecordCount: number; impactBin: number | null;
        weightedMeanImpact: number; recordImpactMin: number; recordImpactMax: number;
        snapshotKey: string; impactDistribution: Array<{ from: number; through: number; includeThrough: boolean; count: number }>;
        coverageSummary: {
          exactNormalizedTitleCount: number; repeatedTitleRecordCount: number; untitledRecordCount: number;
          scoreCompletionTime: { earliestAtMs: number; latestAtMs: number } | null;
          sourceTimes: {
            publisherDeclared: { recordCount: number; timestampedRecordCount: number; range: { earliestAtMs: number; latestAtMs: number } | null };
            aggregatorDeclared: { recordCount: number; timestampedRecordCount: number; range: { earliestAtMs: number; latestAtMs: number } | null };
            providerObserved: { recordCount: number; timestampedRecordCount: number; range: { earliestAtMs: number; latestAtMs: number } | null };
            unknownRecordCount: number; legacyUnknownRecordCount: number;
          };
          receiptLinkedRecordCount: number;
        };
        items: Array<{ id: string; title: string; score: { scoredAt: number } }>;
        nextCursor: { companyId: string; scoredAt: number; id: string; fromMs: number; throughMs: number; impactBin: number | null; snapshotKey: string } | null;
      };
      expect(firstPage).toMatchObject({
        bucketFromMs: from, bucketThroughMs: through, recordCount: 55,
        matchingRecordCount: 55, impactBin: null,
        recordImpactMin: -100, recordImpactMax: 100, snapshotKey: expectedSnapshot,
      });
      expect(firstPage.weightedMeanImpact).toBeCloseTo(chartBucket!.weightedMeanImpact!, 10);
      expect(firstPage.impactDistribution).toHaveLength(20);
      expect(firstPage.impactDistribution.reduce((sum, bin) => sum + bin.count, 0)).toBe(firstPage.recordCount);
      expect(firstPage.impactDistribution[0]).toMatchObject({ from: -100, through: -90, count: 1, includeThrough: false });
      expect(firstPage.impactDistribution[19]).toMatchObject({ from: 90, through: 100, count: 1, includeThrough: true });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.coverageSummary).toMatchObject({
        exactNormalizedTitleCount: 53,
        repeatedTitleRecordCount: 2,
        untitledRecordCount: 1,
        scoreCompletionTime: { earliestAtMs: from, latestAtMs: from + 530_001 },
        sourceTimes: {
          publisherDeclared: { recordCount: 0, timestampedRecordCount: 0, range: null },
          aggregatorDeclared: { recordCount: 55, timestampedRecordCount: 55, range: { earliestAtMs: from, latestAtMs: from + 530_001 } },
          providerObserved: { recordCount: 0, timestampedRecordCount: 0, range: null },
          unknownRecordCount: 0,
          legacyUnknownRecordCount: 0,
        },
        receiptLinkedRecordCount: 0,
      });
      expect(isScoreBucketCoverage(firstPage.coverageSummary, firstPage.recordCount, from, through)).toBe(true);

      const lookupResponse = await app.request("/api/companies/acme/mentions/lookup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [firstPage.items[0]!.id, "missing-row"] }),
      });
      expect(lookupResponse.status).toBe(200);
      await expect(lookupResponse.json()).resolves.toMatchObject({
        items: [expect.objectContaining({ id: firstPage.items[0]!.id, title: firstPage.items[0]!.title })],
      });

      const cursor = encodeURIComponent(JSON.stringify(firstPage.nextCursor));
      const secondResponse = await app.request(
        `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&limit=2&cursor=${cursor}`,
      );
      expect(secondResponse.status).toBe(200);
      await expect(secondResponse.json()).resolves.toMatchObject({
        bucketFromMs: from, bucketThroughMs: through, recordCount: 55, snapshotKey: expectedSnapshot,
      });
      const companyMismatchCursor = await app.request(
        `/api/companies/other/score-bucket?${interval}&snapshot=${expectedSnapshot}&limit=2&cursor=${cursor}`,
      );
      expect(companyMismatchCursor.status).toBe(400);

      const binCounts = await Promise.all(Array.from({ length: 20 }, async (_, impactBin) => {
        const response = await app.request(
          `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&impactBin=${impactBin}&limit=100`,
        );
        expect(response.status).toBe(200);
        const page = await response.json() as {
          recordCount: number; matchingRecordCount: number; impactBin: number;
          impactDistribution: Array<{ count: number }>;
          items: Array<{ id: string; score: { impact: number } }>;
        };
        expect(page.recordCount).toBe(55);
        expect(page.impactBin).toBe(impactBin);
        expect(page.impactDistribution.reduce((sum, bin) => sum + bin.count, 0)).toBe(55);
        expect(page.items).toHaveLength(page.matchingRecordCount);
        return { ...page, ids: page.items.map((item) => item.id) };
      }));
      expect(binCounts[0]?.matchingRecordCount).toBe(1);
      expect(binCounts[0]?.items[0]?.score.impact).toBe(-100);
      expect(binCounts[10]?.matchingRecordCount).toBe(25);
      expect(binCounts[10]?.items.every((item) => item.score.impact >= 0 && item.score.impact < 10)).toBe(true);
      expect(binCounts[11]?.matchingRecordCount).toBe(26);
      expect(binCounts[11]?.items.some((item) => item.score.impact === 10)).toBe(true);
      expect(binCounts[12]?.matchingRecordCount).toBe(1);
      expect(binCounts[12]?.items[0]?.score.impact).toBe(20);
      expect(binCounts[19]?.matchingRecordCount).toBe(1);
      expect(binCounts[19]?.items[0]?.score.impact).toBe(100);
      expect(binCounts.reduce((sum, bin) => sum + bin.matchingRecordCount, 0)).toBe(55);
      expect(new Set(binCounts.flatMap((bin) => bin.ids)).size).toBe(55);
      const allRowsResponse = await app.request(
        `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&limit=100`,
      );
      const allRows = await allRowsResponse.json() as { items: Array<{ id: string }> };
      expect(new Set(binCounts.flatMap((bin) => bin.ids))).toEqual(new Set(allRows.items.map((item) => item.id)));

      const filteredFirstResponse = await app.request(
        `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&impactBin=10&limit=2`,
      );
      const filteredFirst = await filteredFirstResponse.json() as {
        recordCount: number; matchingRecordCount: number; impactBin: number;
        impactDistribution: Array<{ from: number; through: number; includeThrough: boolean; count: number }>;
        coverageSummary: typeof firstPage.coverageSummary;
        nextCursor: NonNullable<typeof firstPage.nextCursor>;
        items: Array<{ id: string; score: { impact: number } }>;
      };
      expect(filteredFirst).toMatchObject({ recordCount: 55, matchingRecordCount: 25, impactBin: 10 });
      expect(filteredFirst.items).toHaveLength(2);
      expect(filteredFirst.items.every((item) => item.score.impact >= 0 && item.score.impact < 10)).toBe(true);
      expect(filteredFirst.impactDistribution).toEqual(firstPage.impactDistribution);
      expect(filteredFirst.coverageSummary).toEqual(firstPage.coverageSummary);
      expect(filteredFirst.nextCursor).toMatchObject({ companyId: "acme", fromMs: from, throughMs: through, impactBin: 10, snapshotKey: expectedSnapshot });
      const filteredItems = [...filteredFirst.items];
      let pageCursor = filteredFirst.nextCursor;
      while (pageCursor) {
        const filteredCursor = encodeURIComponent(JSON.stringify(pageCursor));
        const response = await app.request(
          `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&impactBin=10&limit=2&cursor=${filteredCursor}`,
        );
        expect(response.status).toBe(200);
        const page = await response.json() as typeof filteredFirst;
        expect(page.matchingRecordCount).toBe(25);
        expect(page.coverageSummary).toEqual(firstPage.coverageSummary);
        expect(page.impactDistribution).toEqual(firstPage.impactDistribution);
        expect(page.items.every((item) => item.score.impact >= 0 && item.score.impact < 10)).toBe(true);
        filteredItems.push(...page.items);
        pageCursor = page.nextCursor;
      }
      expect(filteredItems).toHaveLength(25);
      expect(new Set(filteredItems.map((item) => item.id)).size).toBe(25);
      const filteredCursor = encodeURIComponent(JSON.stringify(filteredFirst.nextCursor));
      const mismatchedFilterCursor = await app.request(
        `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&impactBin=11&limit=2&cursor=${filteredCursor}`,
      );
      expect(mismatchedFilterCursor.status).toBe(400);

      const changed = db.insertObservation(sourceMention("snapshot-change", from + 2));
      db.markScored(changed.observationId, scoredAt(from + 2, 20), false);
      const staleCursorResponse = await app.request(
        `/api/companies/acme/score-bucket?${interval}&snapshot=${expectedSnapshot}&limit=2&cursor=${cursor}`,
      );
      expect(staleCursorResponse.status).toBe(409);

      expect((await app.request(`/api/companies/acme/score-bucket?hours=24&through=${through}`)).status).toBe(400);
      expect((await app.request(`/api/companies/acme/score-bucket?from=${from}&through=${through + 1}&hours=24`)).status).toBe(400);
      expect((await app.request(`/api/companies/acme/score-bucket?from=${through}&through=${through + bucketMs}&hours=24`)).status).toBe(400);
      expect((await app.request(`/api/companies/missing/score-bucket?${interval}`)).status).toBe(404);
    } finally {
      db.close();
    }
  });
});
