import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { Pipeline } from "../server/pipeline.js";
import { ModelProviderClassifier } from "../server/model-provider-classifier.js";
import { ModelProviderClassificationService } from "../server/model-provider-classification-service.js";
import { ModelProviderCredentialVault } from "../server/model-provider-credential-vault.js";
import { ExternalRequestPausedError } from "../server/external-request-gate.js";
import type { CategoricalTrendResult, Company } from "../server/types.js";
import { TestDesk } from "./test-desk.js";

// Synthetic guardrail only: no provider network, real account key, or live quality claim.
const company: Company = { id: "acme", name: "Acme Incorporated", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };
const now = Date.parse("2026-10-13T12:00:00Z");
const directories: string[] = [];
const desks: TestDesk[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of desks.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(options: { sourceTimeAt?: number | null; deliveryReceipt?: boolean; returnedModel?: string; pauseProviderRequests?: boolean; externalRequestsEnabled?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const directory = mkdtempSync(join(tmpdir(), "synthetic-byok-chart-")); directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new TestDesk(dbPath); desks.push(db); db.seedCompanies([company]);
  const deliveryId = db.recordDelivery({ collector: "google_news_rss", companyId: company.id, requestKey: "synthetic-delivery",
    startedAt: now - 20_000, completedAt: now - 10_000, result: "success", parsedItemCount: 1, adapterVersion: "synthetic-guardrail/1" });
  const observationId = db.insertObservation({ companyId: company.id, kind: "rss", sourceName: "Synthetic Reuters-shaped fixture",
    sourceUrl: "https://source.example/synthetic-acme-contract", tier: "wire", title: "Acme wins an industrial contract",
    snippet: "Acme said the contract will add production capacity.", publishedAt: null,
    aggregatorPublishedAt: options.sourceTimeAt === undefined ? now - 60_000 : options.sourceTimeAt,
    retrievedAt: now - 10_000, collector: "google_news_rss", sourceItemId: "synthetic-chart-source", publisherName: "Fixture publisher",
    publisherDomain: "source.example", adapterVersion: "synthetic-guardrail/1",
    ...(options.deliveryReceipt === false ? {} : { deliveryId }) }).observationId;
  let secret: Uint8Array | undefined;
  const vault = new ModelProviderCredentialVault(join(directory, "synthetic-credentials"), {
    getSecret: async () => secret, setSecret: async value => { secret = Uint8Array.from(value); },
  });
  await vault.save("openai", "synthetic-test-key"); await vault.save("google_gemini", "synthetic-test-key");
  const classification = { sentiment: "positive", event_type: "corporate_action", takeaway: "product_win", about: true,
    material: true, investor_relevant: true, evidence_sufficient: true, summary: "Acme won an industrial contract.",
    supporting_excerpt: "Acme wins an industrial contract" };
  let calls = 0;
  const fetchImpl: typeof fetch = async url => {
    if (options.pauseProviderRequests) throw new ExternalRequestPausedError();
    calls++;
    const gemini = String(url).includes("googleapis");
    return new Response(JSON.stringify(gemini ? { modelVersion: "gemini-3.8-flash", responseId: `fixture-gemini-${calls}`,
      candidates: [{ content: { parts: [{ text: JSON.stringify(classification) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 } } : {
      id: `fixture-openai-${calls}`, model: options.returnedModel ?? "gpt-6-luna", service_tier: "default", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(classification) }] }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }, output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 130 },
    }), { status: 200 });
  };
  const modelProviders = new ModelProviderClassificationService({ loopbackBound: true, externalRequestsEnabled: options.externalRequestsEnabled ?? true, db, vault,
    classifier: new ModelProviderClassifier({ fetchImpl }), storageAllowsProviderRequests: () => true, allowedCollectors: new Set(["google_news_rss"]) });
  const hub = new Hub(); const health = new HealthTracker(false, false, "synthetic-guardrail", false, false, false, false);
  const pipeline = new Pipeline({ db, judge: null, classifier: null, provider: "openai_luna", hub, health, engineLabel: "synthetic-guardrail",
    inputPricePerMTok: 0, concurrency: 1, allowedCollectors: new Set(), externalRequestsEnabled: false,
    dailyBudget: { utcDay: () => "2026-10-13", maxRequests: 0, maxRequestBytes: 0 } });
  const app = createApp({ db, dbPath, pipeline, market: {} as AppDeps["market"], hub, health, version: "synthetic-guardrail",
    deliverySources: [], modelProviders });
  const origin = "http://127.0.0.1:5174";
  const request = (method: string, path: string, body?: unknown) => app.request(`${origin}${path}`, {
    method, headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { db, dbPath, observationId, request, calls: () => calls };
}

describe("synthetic explicit BYOK classification to Luna chart route guardrails", () => {
  it("keeps paused verification and classification out of the allowance ledgers", async () => {
    const f = await fixture({ externalRequestsEnabled: false });
    for (const provider of ["openai", "google_gemini"]) {
      for (let index = 0; index < 6; index++) {
        const response = await f.request("POST", `/api/model-providers/${provider}/verify`, {});
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "external_requests_disabled" });
      }
      expect(f.db.modelProviderVerificationUsage(provider as "openai" | "google_gemini", "2026-10-13")).toBe(0);
    }
    const response = await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "openai", confirmDataSend: true });
    expect(response.status).toBe(503);
    expect(f.db.modelProviderAttemptHistory(f.observationId, "openai")).toEqual([]);
    expect(f.calls()).toBe(0);
  });

  it("plots a consented OpenAI Luna receipt and reads its exact bucket evidence after reopening", async () => {
    const f = await fixture();
    const path = `/api/mentions/${f.observationId}/model-classification`;
    expect((await f.request("POST", path, { provider: "openai", confirmDataSend: false })).status).toBe(400);
    expect(f.calls()).toBe(0);
    const assessment = await f.request("POST", path, { provider: "openai", confirmDataSend: true, confirmProviderUsageReview: false });
    expect(assessment.status).toBe(200);
    expect(await assessment.json()).toMatchObject({ result: { provider: "openai", modelReturned: "gpt-6-luna", sentiment: "positive" } });
    const seriesResponse = await f.request("GET", `/api/companies/${company.id}/categorical-series?hours=24`);
    const series = await seriesResponse.json() as CategoricalTrendResult;
    expect(series.counts).toMatchObject({ total: 1, positive: 1 });
    expect(series.withheldInvalidCount).toBe(0);
    const bucket = series.points.find(point => point.counts.total > 0)!;
    const evidence = await f.request("GET", `/api/companies/${company.id}/categorical-bucket?snapshot=${encodeURIComponent(series.snapshotKey)}&at=${bucket.bucketStartMs}`);
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({ counts: { total: 1 }, items: [{ id: f.observationId,
      source: { url: "https://source.example/synthetic-acme-contract", deliveryId: expect.any(String) },
      aggregatorPublishedAt: now - 60_000, retrievedAt: now - 10_000,
      classification: { provider: "openai_luna", receiptOrigin: "explicit_byok", accountingRoute: "api_key", responseId: "fixture-openai-1",
        modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna", serviceTierRequested: "default", serviceTier: "default",
        inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 5, totalTokens: 130 } }] });
    expect(f.calls()).toBe(1);
    expect(f.db.testDb.prepare("SELECT COUNT(*) AS count FROM categorical_classifications").get()).toMatchObject({ count: 0 });
    expect(f.db.testDb.prepare("SELECT COUNT(*) AS count FROM jev_request_attempts").get()).toMatchObject({ count: 0 });
    f.db.close(); desks.splice(desks.indexOf(f.db), 1);
    const reopened = new TestDesk(f.dbPath); desks.push(reopened);
    expect(reopened.categoricalTrendSnapshot(company.id, 24, now).counts).toMatchObject({ total: 1, positive: 1 });
  });

  it("keeps Gemini separate and freezes the chart snapshot before later OpenAI requests", async () => {
    const f = await fixture(); const path = `/api/mentions/${f.observationId}/model-classification`;
    const withoutAttestation = await f.request("POST", path, { provider: "google_gemini", confirmDataSend: true });
    expect(withoutAttestation.status).toBe(400);
    expect(await withoutAttestation.json()).toMatchObject({ error: "gemini_paid_service_attestation_required" });
    expect(f.calls()).toBe(0);
    expect((await f.request("POST", path, { provider: "google_gemini", confirmDataSend: true, confirmGeminiPaidService: true })).status).toBe(200);
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now).counts.total).toBe(0);
    expect((await f.request("POST", path, { provider: "openai", confirmDataSend: true })).status).toBe(200);
    const snapshot = f.db.categoricalTrendSnapshot(company.id, 24, now);
    expect(snapshot.counts.total).toBe(1);
    expect((await f.request("POST", path, { provider: "openai", confirmDataSend: true })).status).toBe(200);
    const page = f.db.categoricalBucketEvidence({ companyId: company.id, snapshotKey: snapshot.snapshotKey,
      bucketStartMs: Math.floor((now - 60_000) / 900_000) * 900_000, limit: 50, cursor: null });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.classification?.responseId).toBe("fixture-openai-2");
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now + 1).counts.total).toBe(1);
  });

  it("keeps an unknown source clock untimed instead of substituting retrieval or classification time", async () => {
    const f = await fixture({ sourceTimeAt: null });
    expect((await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "openai", confirmDataSend: true })).status).toBe(200);
    const snapshot = f.db.categoricalTrendSnapshot(company.id, 24, now);
    expect(snapshot).toMatchObject({ eligibleObservationCount: 1, plottedObservationCount: 0, untimedObservationCount: 1, withheldInvalidCount: 0 });
    expect(snapshot.counts.total).toBe(0);
    expect(snapshot.aggregates).toEqual([]);
  });

  it("withholds a result without its source delivery receipt", async () => {
    const f = await fixture({ deliveryReceipt: false });
    expect((await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "openai", confirmDataSend: true })).status).toBe(200);
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now)).toMatchObject({ candidateClassificationCount: 1, eligibleObservationCount: 0, withheldInvalidCount: 1 });
  });

  it("withholds a receipt after the company identity inputs change", async () => {
    const f = await fixture();
    expect((await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "openai", confirmDataSend: true })).status).toBe(200);
    f.db.seedCompanies([{ ...company, sector: "Changed synthetic sector" }]);
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now)).toMatchObject({ candidateClassificationCount: 1, eligibleObservationCount: 0, withheldInvalidCount: 1 });
  });

  it("holds old BYOK receipts with missing provider metadata instead of inventing tier and total tokens", async () => {
    const f = await fixture();
    expect((await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "openai", confirmDataSend: true })).status).toBe(200);
    // Represent the older ledger shape in this isolated synthetic database only.
    f.db.testDb.exec("DROP TRIGGER model_provider_attempts_transition");
    f.db.testDb.exec("UPDATE model_provider_attempts SET categorical_receipt_json=NULL");
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now)).toMatchObject({ candidateClassificationCount: 1, eligibleObservationCount: 0, withheldInvalidCount: 1 });
  });

  it("rejects a returned model mismatch before any Luna chart result exists", async () => {
    const f = await fixture({ returnedModel: "gpt-6-luna-unexpected" });
    const response = await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "openai", confirmDataSend: true });
    expect(response.status).toBe(502);
    expect(f.calls()).toBe(1);
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now)).toMatchObject({ candidateClassificationCount: 0, eligibleObservationCount: 0 });
    expect(f.db.latestModelProviderClassification(f.observationId, "openai")).toBeNull();
  });

  it("records a final-boundary pause as not sent and adds no chart point", async () => {
    const f = await fixture({ pauseProviderRequests: true });
    const response = await f.request("POST", `/api/mentions/${f.observationId}/model-classification`, { provider: "google_gemini", confirmDataSend: true, confirmGeminiPaidService: true });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provider_request_not_sent" });
    expect(f.calls()).toBe(0);
    expect(f.db.modelProviderAttemptHistory(f.observationId, "google_gemini")[0]).toMatchObject({ status: "not_sent", errorCategory: "provider_request_not_sent" });
    expect(f.db.categoricalTrendSnapshot(company.id, 24, now).counts.total).toBe(0);
  });
});
