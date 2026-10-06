import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TestDesk } from "./test-desk.js";
import type { Company, MentionScore, RawMention } from "../server/types.js";
import { createApp, type AppDeps } from "../server/app.js";
import { Pipeline } from "../server/pipeline.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";

const directories: string[] = [];
const company: Company = { id: "archive", name: "Archive Co", ticker: "ARCH", sector: "Technology", aliases: [], color: "#123456" };
const weekMs = 7 * 24 * 60 * 60_000;
const monday = Date.parse("2026-09-28T00:00:00.000Z");
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function raw(id: string, at: number, title = `Archive evidence ${id}`, deliveryId?: string): RawMention {
  return { companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: `https://reuters.com/${id}`, tier: "wire",
    title, snippet: "Saved source row", publishedAt: null, aggregatorPublishedAt: at,
    retrievedAt: at, collector: "google_news_rss", sourceItemId: id, publisherName: "Reuters", publisherDomain: "reuters.com", deliveryId };
}
function score(at: number): MentionScore {
  return { sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8, about: 1, material: 0.8,
    novel: 0.8, credible: 0.9, investorRelevant: 0.9, eventType: "results", takeaway: "Saved result",
    magnitude: 0.5, surprise: 0.2, eventScore: 70, impact: 50, weight: 0.8, engine: "Jev",
    inputTokens: 1, outputTokens: 1, estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "real-rubric", scoredAt: at };
}

describe("saved Jev UTC week archive", () => {
  it("selects only eligible real saved scores, observes half-open boundaries, and skips invalid newer weeks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-jev-week-"));
    directories.push(directory);
    const db = new TestDesk(join(directory, "desk.db"));
    db.seedCompanies([company]);
    let invalidNewerObservationId = "";
    for (const [id, at] of [["start", monday], ["sunday", monday + weekMs - 1],
      ["exclusive-end", monday + weekMs], ["invalid-newer", monday + weekMs + 1]] as const) {
      const inserted = db.insertObservation(raw(id, at));
      db.markScored(inserted.observationId, score(at), false);
      if (id === "invalid-newer") invalidNewerObservationId = inserted.observationId;
    }
    db.testDb.prepare("UPDATE jev_judgments SET weight = -1 WHERE observation_id = ?").run(invalidNewerObservationId);

    const latest = db.jevHistoryWeeks(company.id, monday);
    expect(latest).not.toBeNull();
    expect(latest).toMatchObject({ weekStartMs: monday, latestWeekStartMs: monday + weekMs,
      latestEligibleScoreAtMs: monday + weekMs - 1, newerWeekStartMs: monday + weekMs });
    expect(latest?.items.map((row) => row.id)).toHaveLength(2);
    expect(db.jevHistoryWeeks(company.id, monday + weekMs + weekMs)).toBeNull();
    const app = createApp({
      db, dbPath: join(directory, "desk.db"),
      pipeline: { jevHistoryWeek: (id: string, week: number | null) => id === company.id && week === monday
        ? { companyId: id, weekStartMs: monday, fromMs: monday, throughMs: monday + weekMs, points: [],
          latestEligibleScoreAtMs: monday + weekMs - 1, olderWeekStartMs: null, newerWeekStartMs: null, latestWeekStartMs: monday }
        : null } as unknown as AppDeps["pipeline"],
      market: {} as AppDeps["market"], hub: new Hub(),
      health: new HealthTracker(false, false, "unconfigured", false, false, false, false),
      version: "test", webRoot: join(directory, "missing"), deliverySources: [],
    });
    const mondayResponse = await app.request(`/api/companies/archive/jev-history-week?week=${monday}`);
    expect(mondayResponse.status).toBe(200);
    await expect(mondayResponse.json()).resolves.toMatchObject({ companyId: company.id, weekStartMs: monday });
    expect((await app.request(`/api/companies/archive/jev-history-week?week=${monday - 86_400_000}`)).status).toBe(400);
    db.close();
  });

  it("attaches receipt and repeated-title cues to the exact historical score bucket", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-jev-lineage-"));
    directories.push(directory);
    const db = new TestDesk(join(directory, "desk.db"));
    db.seedCompanies([company]);
    const scoredAt = monday + 10 * 60 * 60_000 + 60_000;
    const deliveryId = db.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: "lineage-receipt",
      startedAt: scoredAt - 2_000, completedAt: scoredAt, result: "success", parsedItemCount: 1,
      responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
    });
    const rows = [
      { id: "linked", title: "Acme raises outlook", deliveryId },
      { id: "repeat", title: "  ACME   RAISES OUTLOOK ", deliveryId: undefined },
      { id: "other", title: "Analyst reports a separate result", deliveryId: undefined },
    ];
    for (const row of rows) {
      const inserted = db.insertObservation(raw(row.id, scoredAt, row.title, row.deliveryId));
      db.markScored(inserted.observationId, score(scoredAt), false);
    }
    const pipeline = new Pipeline({
      db, judge: null, provider: "typesafe", hub: new Hub(), health: new HealthTracker(true, false, "jev-latest"),
      engineLabel: "jev-latest", inputPricePerMTok: 0, concurrency: 1, allowedCollectors: new Set(),
      externalRequestsEnabled: false,
      dailyBudget: { utcDay: () => "2026-10-04", maxRequests: 0, maxRequestBytes: 1_000 },
    });
    try {
      const result = pipeline.jevHistoryWeek(company.id, monday);
      const point = result?.points.find((candidate) => candidate.scoredRecordCount === rows.length);
      expect(point?.sourceLineage).toEqual({
        recordCount: 3,
        receiptLinkedRecordCount: 1,
        repeatedTitleRecordCount: 2,
        exactNormalizedTitleCount: 2,
      });
    } finally {
      pipeline.stop();
      db.close();
    }
  });
});
