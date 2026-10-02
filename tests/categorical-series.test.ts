import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { Pipeline } from "../server/pipeline.js";
import type { MarketData } from "../server/market.js";
import type { CategoricalClassification, Company, RawMention } from "../server/types.js";

const directories: string[] = [];
const desks: Desk[] = [];
const company: Company = { id: "acme", name: "Acme Incorporated", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };
const bucketMs = 15 * 60_000;
const now = Date.parse("2026-10-02T12:00:00.000Z");
const promptSha = "a".repeat(64);
const schemaSha = "b".repeat(64);

afterEach(() => {
  vi.useRealTimers();
  for (const db of desks.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openDesk(path = ":memory:") {
  const db = new Desk(path);
  db.seedCompanies([company]);
  desks.push(db);
  return db;
}

function appFor(db: Desk) {
  const health = new HealthTracker(false, false, "test", false, false, false, false, new Set(), undefined, {
    provider: "openai_luna", model: "gpt-6-luna", configured: false, enabled: false, blockedReason: "OpenAI API key missing",
  });
  const hub = new Hub();
  const pipeline = new Pipeline({
    db, judge: null, classifier: null, provider: "openai_luna", hub, health, engineLabel: "test",
    inputPricePerMTok: 0, concurrency: 1, allowedCollectors: new Set(), externalRequestsEnabled: false,
    dailyBudget: { utcDay: () => "2026-10-02", maxRequests: 0, maxRequestBytes: 0, maxDailyCostMicros: 0 },
  });
  return createApp({ db, dbPath: ":memory:", pipeline, market: {} as MarketData, hub, health, version: "test", deliverySources: [], webRoot: "/missing-test-web-root" });
}

function sourceInput(sourceItemId: string, at: number, deliveryId?: string): RawMention {
  return {
    companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: `https://reuters.example/${sourceItemId}`,
    tier: "wire", title: `Acme update ${sourceItemId}`, snippet: "Evidence excerpt from the source record.",
    publishedAt: at - 60_000, retrievedAt: at - 5, collector: "google_news_rss", sourceItemId,
    publisherName: "Reuters", publisherDomain: "reuters.example", ...(deliveryId ? { deliveryId } : {}),
  };
}

function insertClassified(db: Desk, input: {
  id: string; classifiedAt: number; disposition?: CategoricalClassification["disposition"];
  sentiment?: CategoricalClassification["sentiment"]; profile?: "v1" | "v2"; receipt?: boolean;
}) {
  const adapterVersion = "google_news_rss/1";
  let deliveryId: string | undefined;
  if (input.receipt !== false) {
    deliveryId = db.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: `request-${input.id}`,
      startedAt: input.classifiedAt - 10, completedAt: input.classifiedAt - 8, result: "success",
      parsedItemCount: 1, adapterVersion,
    });
  }
  const observationId = db.insertObservation({ ...sourceInput(input.id, input.classifiedAt, deliveryId), adapterVersion }).observationId;
  const requestSha = createHash("sha256").update(`request-${input.id}`).digest("hex");
  const claim = db.claimForScoringWithBudget({
    id: observationId, now: input.classifiedAt - 3, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-02",
    requestBytes: 400, requestSha256: requestSha, requestedModel: "gpt-6-luna", rubricSha256: promptSha,
    maxRequests: 100, maxRequestBytes: 100_000, provider: "openai_luna", maxDailyCostMicros: 100_000,
    reservedCostMicros: 500, requestedServiceTier: "default", maxOutputTokens: 700, schemaSha256: schemaSha,
  });
  if (claim.kind !== "claimed") throw new Error(`Luna test claim failed: ${claim.kind}`);
  expect(db.recordJevDispatchIntent(claim.attemptId, input.classifiedAt - 2)).toBe(true);
  const profile = input.profile ?? "v1";
  const responseId = `resp_${input.id}`;
  const category: CategoricalClassification = {
    provider: "openai_luna", modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna",
    serviceTierRequested: "default", serviceTier: "default",
    promptVersion: profile === "v1" ? "luna-prompt/1" : "luna-prompt/2",
    promptSha256: profile === "v1" ? promptSha : "c".repeat(64),
    schemaVersion: profile === "v1" ? "luna-schema/1" : "luna-schema/2",
    schemaSha256: profile === "v1" ? schemaSha : "d".repeat(64),
    sentiment: input.sentiment === undefined ? "positive" : input.sentiment,
    eventType: "results", takeaway: "reported_change", about: true, material: true, investorRelevant: true,
    evidenceSufficient: true, summary: "A real-source test record.", supportingExcerpt: `Acme update ${input.id}`,
    disposition: input.disposition ?? (input.sentiment === null ? "review_required" : "classified"),
    responseId, responseSha256: createHash("sha256").update(responseId).digest("hex"),
    inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 30, reasoningTokens: 0,
    totalTokens: 130, estimatedCostUsd: 0.00002, latencyMs: 12, classifiedAt: input.classifiedAt,
  };
  db.recordCategoricalClassification(observationId, category, {
    attemptId: claim.attemptId, outcome: "response", occurredAt: input.classifiedAt, httpStatus: 200,
    inputTokens: 100, outputTokens: 30, resolvedModel: "gpt-6-luna", latencyMs: 12, errorCategory: null,
    cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 130,
    responseId, responseSha256: category.responseSha256, estimatedCostUsd: category.estimatedCostUsd,
    responseServiceTier: "default",
  });
  return observationId;
}

describe("Luna categorical trend and source bucket", () => {
  it("keeps five reachable outcomes separate, sends missing direction to review, and freezes receipt-linked pages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const db = openDesk();
    const firstBucket = now - 60 * 60_000;
    insertClassified(db, { id: "positive", classifiedAt: firstBucket, sentiment: "positive" });
    insertClassified(db, { id: "neutral", classifiedAt: firstBucket + 60_000, sentiment: "neutral" });
    insertClassified(db, { id: "negative", classifiedAt: firstBucket + bucketMs, sentiment: "negative" });
    insertClassified(db, { id: "uncertain", classifiedAt: firstBucket + bucketMs + 60_000, sentiment: null });
    insertClassified(db, { id: "inconsistent-classified-null", classifiedAt: firstBucket + bucketMs + 90_000, sentiment: null, disposition: "classified" });
    insertClassified(db, { id: "review", classifiedAt: firstBucket + bucketMs + 120_000, disposition: "review_required", sentiment: "negative" });
    insertClassified(db, { id: "excluded", classifiedAt: firstBucket + 2 * bucketMs, disposition: "excluded", sentiment: "positive" });
    insertClassified(db, { id: "unreceipted", classifiedAt: firstBucket + 30_000, receipt: false });
    insertClassified(db, { id: "at-window-end", classifiedAt: now, sentiment: "negative" });

    const snapshot = db.categoricalTrendSnapshot(company.id, 1, now);
    expect(snapshot.counts).toEqual({ positive: 1, neutral: 1, negative: 1, reviewRequired: 3, excluded: 1, total: 7 });
    expect(snapshot.eligibleObservationCount).toBe(7);
    expect(snapshot.candidateClassificationCount).toBe(8);
    expect(snapshot.withheldInvalidCount).toBe(1);
    expect(snapshot.latestClassifiedAt).toBe(firstBucket + 2 * bucketMs);
    expect(snapshot.lineages).toHaveLength(1);
    expect(snapshot.aggregates.reduce((sum, row) => sum + row.counts.total, 0)).toBe(7);

    const firstPage = db.categoricalBucketEvidence({
      companyId: company.id, snapshotKey: snapshot.snapshotKey, bucketStartMs: firstBucket, limit: 1, cursor: null,
    });
    expect(firstPage.counts).toEqual({ positive: 1, neutral: 1, negative: 0, reviewRequired: 0, excluded: 0, total: 2 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    insertClassified(db, { id: "backdated-after-snapshot", classifiedAt: firstBucket + 30_000, profile: "v2" });
    const secondPage = db.categoricalBucketEvidence({
      companyId: company.id, snapshotKey: snapshot.snapshotKey, bucketStartMs: firstBucket, limit: 1, cursor: firstPage.nextCursor,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toContain("backdated-after-snapshot");
    expect(secondPage.counts).toEqual(firstPage.counts);
    expect(secondPage.nextCursor).toBeNull();
    const uncertainBucket = db.categoricalBucketEvidence({
      companyId: company.id, snapshotKey: snapshot.snapshotKey,
      bucketStartMs: firstBucket + bucketMs, limit: 10, cursor: null,
    });
    expect(uncertainBucket.counts.reviewRequired).toBe(3);
    expect(() => db.categoricalBucketEvidence({
      companyId: "other-company", snapshotKey: snapshot.snapshotKey, bucketStartMs: firstBucket, limit: 1, cursor: null,
    })).toThrow("categorical_snapshot_unavailable");
  });

  it("returns bounded, validated routes and invalidates a snapshot after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-categorical-series-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = openDesk(path);
    insertClassified(db, { id: "route-row", classifiedAt: now - 20_000, profile: "v2" });
    const app = appFor(db);

    expect((await app.request("/api/companies/missing/categorical-series?hours=1")).status).toBe(404);
    expect((await app.request("/api/companies/acme/categorical-series?hours=0")).status).toBe(400);
    expect((await app.request("/api/companies/acme/categorical-series?hours=1.5")).status).toBe(400);
    const response = await app.request("/api/companies/acme/categorical-series?hours=1");
    expect(response.status).toBe(200);
    const result = await response.json() as ReturnType<Pipeline["categoricalSeries"]>;
    expect(result).toMatchObject({ companyId: "acme", timeBasis: "classification_available_at", countBasis: "immutable_source_observation", eligibleObservationCount: 1 });
    expect(result.snapshotGeneration).toMatch(/^[0-9a-f-]{36}$/);
    const point = result.points.find((entry) => entry.counts.total === 1)!;
    const query = new URLSearchParams({ snapshot: result.snapshotKey, at: String(point.bucketStartMs), limit: "1" });
    const bucketResponse = await app.request(`/api/companies/acme/categorical-bucket?${query}`);
    expect(bucketResponse.status).toBe(200);
    const bucket = await bucketResponse.json() as { counts: { total: number }; items: Array<{ id: string; source: { deliveryId: string | null }; classification: { provider: string; sentiment: string | null } }> };
    expect(bucket.counts.total).toBe(1);
    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0]).toMatchObject({ id: expect.any(String), source: { deliveryId: expect.any(String) }, classification: { provider: "openai_luna", sentiment: "positive" } });
    for (const duration of [1_800_000, 3_600_000, 10_800_000, 21_600_000]) {
      const durationStart = Math.floor(point.bucketStartMs / duration) * duration;
      const durationQuery = new URLSearchParams({ snapshot: result.snapshotKey, at: String(durationStart), span: String(duration), limit: "10" });
      const durationResponse = await app.request(`/api/companies/acme/categorical-bucket?${durationQuery}`);
      expect(durationResponse.status).toBe(200);
      expect(await durationResponse.json()).toMatchObject({ bucketStartMs: durationStart, bucketDurationMs: duration, counts: { total: 1 } });
    }
    expect((await app.request(`/api/companies/acme/categorical-bucket?${new URLSearchParams({ snapshot: result.snapshotKey, at: String(point.bucketStartMs), span: "450000" })}`)).status).toBe(400);
    expect((await app.request(`/api/companies/acme/categorical-bucket?${new URLSearchParams({ snapshot: result.snapshotKey, at: String(point.bucketStartMs + 1) })}`)).status).toBe(400);

    const beforeRestartGeneration = result.snapshotGeneration;
    db.close();
    desks.splice(desks.indexOf(db), 1);
    db = openDesk(path);
    const restarted = appFor(db);
    const afterRestartResult = await (await restarted.request("/api/companies/acme/categorical-series?hours=1")).json() as typeof result;
    expect(afterRestartResult.snapshotGeneration).not.toBe(beforeRestartGeneration);
    expect(afterRestartResult.counts).toEqual(result.counts);
    const staleResponse = await restarted.request(`/api/companies/acme/categorical-bucket?${query}`);
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toEqual({ error: "categorical_snapshot_unavailable" });
  });
});
