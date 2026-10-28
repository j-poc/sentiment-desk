import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { Pipeline } from "../server/pipeline.js";
import { ModelProviderClassifier, sourceIdentityDigest } from "../server/model-provider-classifier.js";
import { ModelProviderClassificationService } from "../server/model-provider-classification-service.js";
import { ModelProviderCredentialVault } from "../server/model-provider-credential-vault.js";
import type { Company } from "../server/types.js";
import { TestDesk } from "./test-desk.js";

// Synthetic fixtures exercise persistence and routing only; no fixture is used as product data or a model-quality claim.
const company: Company = { id: "fixture-acme", name: "Acme Incorporated", ticker: "ACME", sector: "Industrials", aliases: ["Acme"], color: "#123456" };
const now = Date.parse("2026-10-13T12:00:00Z");
const directories: string[] = [];
const desks: TestDesk[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of desks.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const directory = mkdtempSync(join(tmpdir(), "synthetic-gemini-chart-")); directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new TestDesk(dbPath); desks.push(db); db.seedCompanies([company]);
  let secret: Uint8Array | undefined;
  const vault = new ModelProviderCredentialVault(join(directory, "credentials"), {
    getSecret: async () => secret, setSecret: async value => { secret = Uint8Array.from(value); },
  });
  let providerRequests = 0;
  const fetchImpl: typeof fetch = async () => {
    providerRequests++;
    return new Response("{}", { status: 500 });
  };
  const modelProviders = new ModelProviderClassificationService({ loopbackBound: true, externalRequestsEnabled: true, db, vault,
    classifier: new ModelProviderClassifier({ fetchImpl }), storageAllowsProviderRequests: () => true,
    allowedCollectors: new Set(["google_news_rss"]) });
  const hub = new Hub();
  const health = new HealthTracker(false, false, "synthetic-gemini-chart", false, false, false, false);
  const pipeline = new Pipeline({ db, judge: null, classifier: null, provider: "openai_luna", hub, health,
    engineLabel: "synthetic-gemini-chart", inputPricePerMTok: 0, concurrency: 1, allowedCollectors: new Set(),
    externalRequestsEnabled: false, dailyBudget: { utcDay: () => "2026-10-13", maxRequests: 0, maxRequestBytes: 0 } });
  const app = createApp({ db, dbPath, pipeline, market: {} as AppDeps["market"], hub, health,
    version: "synthetic-gemini-chart", deliverySources: [], modelProviders });
  const origin = "http://127.0.0.1:5174";
  const request = (path: string) => app.request(`${origin}${path}`, { headers: { origin } });

  function addSavedClassification(input: { sourceTimeAt: number | null; provider?: "google_gemini" | "openai"; invalidSourceDigest?: boolean; missingDeliveryReceipt?: boolean }) {
    const collector = "google_news_rss" as const;
    const adapterVersion = "synthetic-fixture/1";
    const retrievedAt = now - 9_000;
    const deliveryId = db.recordDelivery({ collector, companyId: company.id, requestKey: randomUUID(),
      startedAt: now - 11_000, completedAt: now - 10_000, result: "success", parsedItemCount: 1,
      adapterVersion, processingRequired: true });
    const observationId = db.insertObservation({ companyId: company.id, kind: "rss", sourceName: "Synthetic saved source",
      sourceUrl: `https://source.example/${randomUUID()}`, tier: "wire", title: "Acme Incorporated signs an industrial supply contract",
      snippet: "Acme Incorporated reported a new supply contract for its industrial products.", publishedAt: null,
      ...(input.sourceTimeAt == null ? {} : { aggregatorPublishedAt: input.sourceTimeAt }), retrievedAt, collector,
      sourceItemId: randomUUID(), publisherName: "Synthetic fixture publisher", publisherDomain: "source.example",
      adapterVersion, ...(input.missingDeliveryReceipt ? {} : { deliveryId }) }).observationId;
    const savedSource = db.mentionRow(observationId)!;
    const sourceSha256 = input.invalidSourceDigest ? "0".repeat(64) : sourceIdentityDigest({
      sourceId: savedSource.id,
      company: { name: company.name, ticker: company.ticker, sector: company.sector },
      source: { collector: savedSource.collector, publisher: savedSource.publisher_name, title: savedSource.title, excerpt: savedSource.snippet },
      sourceUrl: savedSource.source_url, retrievedAt: savedSource.retrieved_at,
    });
    const provider = input.provider ?? "google_gemini";
    const modelRequested = provider === "google_gemini" ? "gemini-3.8-flash" : "gpt-6-luna";
    const attemptId = randomUUID();
    expect(db.reserveModelProviderAttempt({ id: attemptId, observationId, provider, modelRequested, sourceSha256,
      requestSha256: "d".repeat(64), requestBytes: 128, promptVersion: "synthetic-fixture/1", promptSha256: "e".repeat(64),
      schemaVersion: "synthetic-fixture/1", schemaSha256: "f".repeat(64), utcDay: "2026-10-13", reservedAt: now - 8_000,
      costReservationMicros: 100, maxDailyRequests: 10, maxDailyBytes: 10_000, maxDailyCostMicros: 10_000 })).toBe("reserved");
    expect(db.markModelProviderDispatched(attemptId, now - 7_000)).toBe(true);
    expect(db.finishModelProviderAttempt({ attemptId, outcome: "completed", completedAt: now - 4_000, httpStatus: 200,
      modelReturned: modelRequested, responseId: `synthetic-response-${attemptId}`, responseSha256: "b".repeat(64),
      inputTokens: 50, outputTokens: 20, estimatedCostUsd: 0.00001, latencyMs: 10, errorCategory: null,
      classification: { modelReturned: modelRequested, sourceSha256, sourceTimeAt: input.sourceTimeAt, retrievedAt,
        sentiment: provider === "google_gemini" ? "positive" : "negative", eventType: "corporate_action", takeaway: "supply_contract",
        about: true, material: true, investorRelevant: true, evidenceSufficient: true,
        summary: "Synthetic saved classification fixture.", supportingExcerpt: savedSource.title, disposition: "classified" } })).toBe(true);
    return observationId;
  }
  return { db, providerRequests: () => providerRequests, request, addSavedClassification };
}

describe("Google Gemini isolated sentiment-chart lane", () => {
  it("plots only receipt-valid Gemini classifications by source time and reconciles bucket evidence without model calls", async () => {
    const f = await fixture();
    const sourceAt = now - 37 * 60_000;
    const timedGeminiId = f.addSavedClassification({ sourceTimeAt: sourceAt });
    const untimedGeminiId = f.addSavedClassification({ sourceTimeAt: null });
    const invalidReceiptId = f.addSavedClassification({ sourceTimeAt: now - 20 * 60_000, invalidSourceDigest: true });
    const openAiId = f.addSavedClassification({ sourceTimeAt: now - 15 * 60_000, provider: "openai" });

    const response = await f.request(`/api/companies/${company.id}/google-gemini-categorical-series?hours=24`);
    expect(response.status).toBe(200);
    const series = await response.json() as {
      classifierProvider: string; classifierModel: string; snapshotKey: string; counts: { total: number; positive: number; negative: number };
      eligibleObservationCount: number; plottedObservationCount: number; untimedObservationCount: number; candidateClassificationCount: number;
      withheldInvalidCount: number; points: Array<{ bucketStartMs: number; counts: { total: number } }>;
    };
    expect(series).toMatchObject({ classifierProvider: "google_gemini", classifierModel: "gemini-3.8-flash",
      counts: { total: 1, positive: 1, negative: 0 }, eligibleObservationCount: 2, plottedObservationCount: 1,
      untimedObservationCount: 1, candidateClassificationCount: 3, withheldInvalidCount: 1 });
    expect(series.points.filter(point => point.counts.total > 0)).toHaveLength(1);
    const bucketStartMs = Math.floor(sourceAt / 900_000) * 900_000;
    const evidenceResponse = await f.request(`/api/companies/${company.id}/google-gemini-categorical-bucket?${new URLSearchParams({
      snapshot: series.snapshotKey, at: String(bucketStartMs), limit: "50",
    })}`);
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json() as { counts: { total: number }; items: Array<{ id: string; source: { url: string; deliveryId: string }; providerCategorical: { provider: string; modelReturned: string; sentiment: string; classifiedAt: number } }> };
    expect(evidence).toMatchObject({ counts: { total: 1 }, items: [{ id: timedGeminiId,
      source: { url: expect.stringMatching(/^https:\/\/source\.example\//), deliveryId: expect.any(String) },
      providerCategorical: { provider: "google_gemini", modelReturned: "gemini-3.8-flash", sentiment: "positive", classifiedAt: now - 4_000 } }] });
    expect(evidence.items.map(item => item.id)).not.toContain(untimedGeminiId);
    expect(evidence.items.map(item => item.id)).not.toContain(invalidReceiptId);
    expect(evidence.items.map(item => item.id)).not.toContain(openAiId);
    expect(f.providerRequests()).toBe(0);
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now).counts.total).toBe(0);
    expect(f.db.typeSafeJevByokFeed(company.id, 0, now)).toHaveLength(0);
  });

  it("withholds classifications without a saved immutable source-delivery receipt", async () => {
    const f = await fixture();
    f.addSavedClassification({ sourceTimeAt: now - 2_000, missingDeliveryReceipt: true });
    const response = await f.request(`/api/companies/${company.id}/google-gemini-categorical-series?hours=24`);
    const result = await response.json() as { candidateClassificationCount: number; eligibleObservationCount: number; withheldInvalidCount: number; counts: { total: number } };
    expect(result).toMatchObject({ candidateClassificationCount: 1, eligibleObservationCount: 0, withheldInvalidCount: 1, counts: { total: 0 } });
    expect(f.providerRequests()).toBe(0);
  });

  it("rejects bad windows, provider-mismatched snapshots, and altered snapshot keys", async () => {
    const f = await fixture();
    expect((await f.request(`/api/companies/${company.id}/google-gemini-categorical-series?hours=0`)).status).toBe(400);
    const series = await (await f.request(`/api/companies/${company.id}/google-gemini-categorical-series?hours=24`)).json() as { snapshotKey: string };
    const otherLane = await f.request(`/api/companies/${company.id}/categorical-bucket?${new URLSearchParams({ snapshot: series.snapshotKey, at: String(Math.floor((now - 900_000) / 900_000) * 900_000) })}`);
    expect(otherLane.status).toBe(409);
    const altered = await f.request(`/api/companies/${company.id}/google-gemini-categorical-bucket?${new URLSearchParams({ snapshot: `${series.snapshotKey}x`, at: String(Math.floor((now - 900_000) / 900_000) * 900_000) })}`);
    expect(altered.status).toBe(409);
    expect(f.providerRequests()).toBe(0);
  });
});
