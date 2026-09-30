import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { MarketData } from "../server/market.js";
import { Pipeline } from "../server/pipeline.js";
import { buildRadar, normalizeHeadline } from "../server/radar.js";
import type { Company, MentionScore, RadarItemEvidence, RawMention } from "../server/types.js";

const company: Company = {
  id: "acme", name: "Acme Incorporated", ticker: "ACME", sector: "Technology",
  aliases: ["Acme"], color: "#123456",
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function evidence(overrides: Partial<RadarItemEvidence> = {}): RadarItemEvidence {
  return {
    id: "item-a",
    title: "Acme launches product update",
    sourceUrl: "https://a.example/story",
    publisherName: "Publisher A",
    publisherDomain: "a.example",
    publishedAt: Date.now() - 60 * 60_000,
    retrievedAt: Date.now() - 30 * 60_000,
    collector: "google_news_rss",
    eventType: "product",
    sentiment: "positive",
    takeaway: "product_win",
    ...overrides,
  };
}

function score(sentiment: MentionScore["sentiment"], eventType: string): MentionScore {
  const probabilities = sentiment === "positive"
    ? { pPos: 0.8, pNeu: 0.1, pNeg: 0.1, impact: 70 }
    : sentiment === "negative"
      ? { pPos: 0.1, pNeu: 0.1, pNeg: 0.8, impact: -70 }
      : { pPos: 0.1, pNeu: 0.8, pNeg: 0.1, impact: 0 };
  return {
    sentiment, ...probabilities, confidence: 0.9, about: 1, material: 0.8,
    novel: 0.8, credible: 0.9, investorRelevant: 0.9, eventType,
    takeaway: "product_win", magnitude: 0.5, surprise: 0.5, eventScore: 75,
    weight: 0.8, engine: "jev-test-fixture", inputTokens: 10, outputTokens: 8,
    estimatedInputCostUsd: 0.00001, latencyMs: 10, rubricSha: "test-rubric", scoredAt: Date.now(),
  };
}

function storeItem(db: Desk, input: Partial<RawMention> & { sourceItemId: string }, judged?: MentionScore["sentiment"]): string {
  const stored = db.insertObservation({
    companyId: company.id,
    kind: "rss",
    sourceName: input.publisherName ?? "Publisher A",
    sourceUrl: input.sourceUrl ?? "https://a.example/story",
    tier: "trade",
    title: input.title ?? "Acme launches product update",
    snippet: "Normalized test excerpt",
    publishedAt: input.publishedAt === undefined ? Date.now() - 60 * 60_000 : input.publishedAt,
    providerObservedAt: input.providerObservedAt,
    retrievedAt: input.retrievedAt ?? Date.now() - 30 * 60_000,
    collector: input.collector ?? "google_news_rss",
    sourceItemId: input.sourceItemId,
    publisherName: input.publisherName ?? "Publisher A",
    publisherDomain: input.publisherDomain === undefined ? "a.example" : input.publisherDomain,
  });
  if (judged) db.markScored(stored.observationId, score(judged, input.title === "Acme quarterly results" ? "results" : "product"), false);
  return stored.observationId;
}

describe("Opportunity Radar evidence comparison", () => {
  it("uses exact headline normalization and keeps similar headlines distinct", () => {
    expect(normalizeHeadline("Acme’s NEW product-update! ")).toBe("acme s new product update");
    const now = Date.now();
    const result = buildRadar({
      hours: 24,
      now,
      currentRows: [
        evidence({ id: "one", title: "Acme launches product update" }),
        evidence({ id: "copy", title: "ACME launches product update!", collector: "yahoo_finance_rss" }),
        evidence({ id: "similar", title: "Acme launches its new product", publisherDomain: "b.example" }),
        evidence({ id: "bad-category", eventType: "unverified_category" }),
        evidence({ id: "bad-sentiment", sentiment: "uncertain" }),
      ],
      previousRows: [evidence({ id: "prior", publishedAt: now - 30 * 60 * 60_000 })],
      untimedScored: 2,
      unjudged: 3,
    });
    const product = result.categories.find((category) => category.eventType === "product");
    expect(result.current.headlineGroups).toBe(2);
    expect(result.current.sourceRows).toBe(3);
    expect(result.current.publisherCount).toBe(2);
    expect(result.current.publisherJudgments).toBe(2);
    expect(result.headlineChange).toBe(1);
    expect(result.untimedScored).toBe(2);
    expect(result.unjudged).toBe(3);
    expect(result.unclassified).toBe(2);
    expect(product?.current.headlineGroups).toBe(2);
    expect(product?.current.positive).toBe(2);
    expect(new Set(product?.recentEvidence.map((group) => group.title))).toEqual(new Set([
      "Acme launches product update",
      "Acme launches its new product",
    ]));
  });

  it("serves current and prior summaries from persisted Jev records with untimed and failed coverage visible", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-radar-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    db.seedCompanies([company]);
    const now = Date.now();
    const recent = now - 60 * 60_000;
    const collected = now - 30 * 60_000;

    storeItem(db, { sourceItemId: "a1", publishedAt: recent, retrievedAt: collected }, "positive");
    storeItem(db, {
      sourceItemId: "a2", publishedAt: recent + 1_000, retrievedAt: collected + 1_000,
      collector: "yahoo_finance_rss", title: "ACME launches product update!",
    }, "positive");
    storeItem(db, {
      sourceItemId: "b1", publishedAt: recent + 2_000, retrievedAt: collected + 2_000,
      sourceUrl: "https://b.example/story", publisherName: "Publisher B", publisherDomain: "b.example",
      collector: "gdelt_doc_api",
    }, "negative");
    storeItem(db, {
      sourceItemId: "a3", publishedAt: recent + 3_000, retrievedAt: collected + 3_000,
      title: "Acme adds a manufacturing site", sourceUrl: "https://a.example/factory",
    }, "positive");
    storeItem(db, {
      sourceItemId: "a4", publishedAt: recent + 4_000, retrievedAt: collected + 4_000,
      title: "Acme quarterly results", sourceUrl: "https://a.example/results",
    }, "neutral");
    storeItem(db, {
      sourceItemId: "prior", publishedAt: now - 30 * 60 * 60_000,
      retrievedAt: collected, title: "Acme prior product update", sourceUrl: "https://a.example/prior",
    }, "positive");
    const untimedId = storeItem(db, {
      sourceItemId: "untimed", publishedAt: null,
      providerObservedAt: recent, retrievedAt: collected, sourceUrl: "https://a.example/untimed",
    }, "neutral");
    const pendingId = storeItem(db, {
      sourceItemId: "pending", publishedAt: null,
      providerObservedAt: recent, retrievedAt: collected, sourceUrl: "https://a.example/pending",
    });
    expect(untimedId).not.toBe(pendingId);

    db.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: "news:acme",
      startedAt: now - 2_000, completedAt: now - 1_000, result: "failed", parsedItemCount: 0,
      adapterVersion: "google-news/2", error: "upstream unavailable",
    });
    const hub = new Hub();
    const health = new HealthTracker(false, false, "jev-latest");
    const pipeline = new Pipeline({
      db, judge: null, hub, health, engineLabel: "unconfigured", inputPricePerMTok: 0, concurrency: 1,
      allowedCollectors: new Set(),
      dailyBudget: { utcDay: () => "2026-09-28", maxRequests: 0, maxRequestBytes: 0 },
    });
    const market = new MarketData({ companies: [company], indices: [], hub, health, db });
    const app = createApp({
      db, dbPath: join(directory, "desk.db"), pipeline, market, hub, health,
      version: "test",
      opportunityRadarEnabled: true,
      deliverySources: [{ collector: "google_news_rss", enabled: true, intervalSeconds: 30, targetCount: 1 }],
    });
    const disabledApp = createApp({
      db, dbPath: join(directory, "desk.db"), pipeline, market, hub, health,
      version: "test",
      deliverySources: [{ collector: "google_news_rss", enabled: true, intervalSeconds: 30, targetCount: 1 }],
    });

    try {
      const disabledHealth = await disabledApp.fetch(new Request("http://localhost/api/health"));
      expect(disabledHealth.status).toBe(200);
      expect(await disabledHealth.json()).toEqual(expect.objectContaining({ opportunityRadarEnabled: false }));
      const disabledRadar = await disabledApp.fetch(new Request("http://localhost/api/companies/acme/radar?hours=24"));
      const disabledEvidence = await disabledApp.fetch(new Request("http://localhost/api/companies/acme/radar/evidence?eventType=product"));
      expect(disabledRadar.status).toBe(404);
      expect(disabledEvidence.status).toBe(404);

      const response = await app.fetch(new Request("http://localhost/api/companies/acme/radar?hours=24"));
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        hours: 24,
        current: expect.objectContaining({
          sourceRows: 5, headlineGroups: 3, publisherCount: 2,
          publisherJudgments: 4, positive: 2, neutral: 1, negative: 1,
        }),
        previous: expect.objectContaining({ sourceRows: 1, headlineGroups: 1 }),
        headlineChange: 2,
        untimedScored: 1,
        unjudged: 1,
        categories: expect.arrayContaining([
          expect.objectContaining({
            eventType: "product",
            current: expect.objectContaining({ sourceRows: 4, headlineGroups: 2, publisherCount: 2, positive: 2, negative: 1 }),
            previous: expect.objectContaining({ sourceRows: 1, headlineGroups: 1 }),
            recentEvidence: expect.arrayContaining([
              expect.objectContaining({
                sources: expect.arrayContaining([expect.objectContaining({ sourceUrl: "https://a.example/story" })]),
              }),
            ]),
          }),
          expect.objectContaining({ eventType: "results", current: expect.objectContaining({ headlineGroups: 1 }) }),
        ]),
        coverage: expect.arrayContaining([expect.objectContaining({ collector: "google_news_rss", state: "failed" })]),
      }));
      const snapshotAt = (body as { generatedAt: number }).generatedAt;

      const firstPage = await app.fetch(new Request(
        `http://localhost/api/companies/acme/radar/evidence?hours=24&asOf=${snapshotAt}&period=current&eventType=product&offset=0&limit=1`,
      ));
      const firstPageBody: unknown = await firstPage.json();
      expect(firstPageBody).toEqual(expect.objectContaining({
        period: "current", total: 2,
        items: expect.arrayContaining([expect.objectContaining({ title: "Acme adds a manufacturing site" })]),
      }));
      await new Promise((resolve) => setTimeout(resolve, 3));
      storeItem(db, {
        sourceItemId: "arrived-after-snapshot",
        publishedAt: recent + 2_500,
        retrievedAt: collected + 2_500,
        title: "Acme launches another product update",
        sourceUrl: "https://c.example/story",
        publisherName: "Publisher C",
        publisherDomain: "c.example",
      }, "positive");
      const secondPage = await app.fetch(new Request(
        `http://localhost/api/companies/acme/radar/evidence?hours=24&asOf=${snapshotAt}&period=current&eventType=product&offset=1&limit=1`,
      ));
      const secondPageBody: unknown = await secondPage.json();
      expect(secondPageBody).toEqual(expect.objectContaining({
        period: "current", total: 2,
        items: expect.arrayContaining([expect.objectContaining({ title: "Acme launches product update" })]),
      }));
      const previousPage = await app.fetch(new Request(
        `http://localhost/api/companies/acme/radar/evidence?hours=24&asOf=${snapshotAt}&period=previous&eventType=product`,
      ));
      const previousPageBody: unknown = await previousPage.json();
      expect(previousPageBody).toEqual(expect.objectContaining({
        period: "previous", total: 1,
        items: expect.arrayContaining([expect.objectContaining({ title: "Acme prior product update" })]),
      }));
      const invalidEventType = await app.fetch(new Request(
        "http://localhost/api/companies/acme/radar/evidence?eventType=thematic_inference",
      ));
      expect(invalidEventType.status).toBe(400);
      const invalidSnapshot = await app.fetch(new Request(
        "http://localhost/api/companies/acme/radar/evidence?asOf=not-a-timestamp&eventType=product",
      ));
      expect(invalidSnapshot.status).toBe(400);

      const missingCompany = await app.fetch(new Request("http://localhost/api/companies/missing/radar"));
      expect(missingCompany.status).toBe(404);
    } finally {
      db.close();
    }
  });
});
