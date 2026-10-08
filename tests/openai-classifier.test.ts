import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { rowToDTO } from "../server/db.js";
import { TestDesk as Desk } from "./test-desk.js";
import { ExternalRequestPausedError } from "../server/external-request-gate.js";
import { OpenAIClassifier, OpenAIClassifierError, OPENAI_MODEL, OPENAI_PROMPT_SHA256, OPENAI_SCHEMA_SHA256, OPENAI_PRICING, prepareOpenAIRequest } from "../server/openai-classifier.js";
import { Pipeline } from "../server/pipeline.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { CategoricalClassification, Company, RawMention } from "../server/types.js";

const tempDirs: string[] = [];
const openDbs: Desk[] = [];
const pipelines: Pipeline[] = [];
const company: Company = { id: "acme", name: "Acme Incorporated", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };
const input = {
  company: { name: company.name, ticker: company.ticker, sector: company.sector },
  source: { collector: "google_news_rss", publisher: "Reuters", title: "Acme wins an industrial contract", excerpt: "Acme said the contract will add production capacity." },
};

afterEach(() => {
  for (const pipeline of pipelines.splice(0)) pipeline.stop();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function output(overrides: Record<string, unknown> = {}) {
  return {
    sentiment: "positive", event_type: "corporate_action", takeaway: "product_win",
    about: true, material: true, investor_relevant: true, evidence_sufficient: true,
    summary: "Acme won an industrial contract.", supporting_excerpt: "Acme wins an industrial contract",
    ...overrides,
  };
}

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test_1", model: "gpt-6-luna", service_tier: "default", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output()) }] }],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }, output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 130 },
    ...overrides,
  };
}

function classifier(fetchImpl: typeof fetch) {
  return new OpenAIClassifier({ apiKey: "test-key", model: OPENAI_MODEL, fetchImpl, timeoutMs: 1000 });
}

describe("OpenAI Luna categorical classifier", () => {
  it("sends the exact bounded strict Responses body with no storage, tools, or reasoning", async () => {
    const prepared = prepareOpenAIRequest(input);
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: (init?.headers as Record<string, string>).authorization ?? "" });
      return new Response(JSON.stringify(responseBody()), { status: 200 });
    }) as typeof fetch;
    const result = await classifier(fetchImpl).classifyPrepared(prepared);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://api.openai.com/v1/responses", auth: "Bearer test-key" });
    expect(seen[0]?.body).toMatchObject({ model: OPENAI_MODEL, store: false, reasoning: { effort: "none" }, max_output_tokens: 700 });
    expect(seen[0]?.body).not.toHaveProperty("tools");
    expect((seen[0]?.body.text as { format: Record<string, unknown> }).format).toMatchObject({ type: "json_schema", strict: true });
    expect(prepared.requestBytes).toBe(Buffer.byteLength(prepared.body, "utf8"));
    expect(prepared.payloadSha256).toBe(createHash("sha256").update(prepared.body).digest("hex"));
    expect(prepared.promptSha256).toBe(OPENAI_PROMPT_SHA256);
    expect(prepared.schemaSha256).toBe(OPENAI_SCHEMA_SHA256);
    expect(result.classification).toMatchObject({ sentiment: "positive", about: true, material: true, supportingExcerpt: input.source.title });
    expect(result.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningTokens: 5, totalTokens: 130 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo((80 * OPENAI_PRICING.inputPerMillionUsd + 20 * OPENAI_PRICING.cachedInputPerMillionUsd + 30 * OPENAI_PRICING.outputPerMillionUsd) / 1_000_000);
  });

  it.each([
    ["refusal", { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }],
    ["incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["unsupported quote", { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output({ supporting_excerpt: "invented wording" })) }] }] }],
  ])("withholds %s output", async (_label, overrides) => {
    const fetchImpl = (async () => new Response(JSON.stringify(responseBody(overrides as Record<string, unknown>)), { status: 200 })) as typeof fetch;
    await expect(classifier(fetchImpl).classifyPrepared(prepareOpenAIRequest(input))).rejects.toBeInstanceOf(OpenAIClassifierError);
  });

  it.each([
    ["a different model ID", { model: "gpt-6-luna-unexpected" }, "gpt-6-luna-unexpected", "default"],
    ["a different service tier", { service_tier: "flex" }, "gpt-6-luna", "flex"],
  ])("withholds a completed response with %s while preserving its usage receipt", async (_label, overrides, returnedModel, serviceTier) => {
    const fetchImpl = (async () => new Response(JSON.stringify(responseBody(overrides as Record<string, unknown>)), { status: 200 })) as typeof fetch;

    await expect(classifier(fetchImpl).classifyPrepared(prepareOpenAIRequest(input))).rejects.toMatchObject({
      name: "OpenAIClassifierError", status: 200, retryable: false, outcomeUnknown: false,
      returnedModel, serviceTier, usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
    });
  });

  it("keeps a model-mismatched completed response failed while retaining its provider usage receipt", async () => {
    const db = new Desk(":memory:");
    openDbs.push(db);
    db.seedCompanies([company]);
    const now = Date.now();
    const adapterVersion = "google_news_rss/1";
    const deliveryId = db.recordDelivery({
      collector: "google_news_rss", companyId: "acme", requestKey: "request-model-mismatch",
      startedAt: now - 2_000, completedAt: now - 1_000, result: "success", parsedItemCount: 1, adapterVersion,
    });
    const source: RawMention = {
      companyId: "acme", kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.example/model-mismatch",
      tier: "wire", title: input.source.title, snippet: input.source.excerpt, publishedAt: now - 3_000,
      retrievedAt: now, collector: "google_news_rss", sourceItemId: "model-mismatch", adapterVersion, deliveryId,
    };
    const apiFetch = (async () => new Response(JSON.stringify(responseBody({ model: "gpt-6-luna-unexpected" })), { status: 200 })) as typeof fetch;
    const model = classifier(apiFetch);
    const health = new HealthTracker(false, false, OPENAI_MODEL, false, false, false, true, new Set(["google_news_rss"]), undefined, {
      provider: "openai_luna", model: OPENAI_MODEL, configured: true, enabled: true, blockedReason: null,
    });
    const pipeline = new Pipeline({
      db, judge: null, classifier: (prepared) => model.classifyPrepared(prepared), provider: "openai_luna",
      hub: new Hub(), health, engineLabel: OPENAI_MODEL, inputPricePerMTok: 0, concurrency: 1,
      allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-04", maxRequests: 1, maxRequestBytes: 100_000, maxDailyCostMicros: 10_000 },
    });
    pipelines.push(pipeline);

    pipeline.ingest(source);
    await pipeline.waitForIdle();

    const saved = db.mentionsForCompany("acme", 0, 10)[0]!;
    expect(saved).toMatchObject({ status: "failed", score: null, classification: null, usageCheckRequired: true });
    expect(db.jevAttemptHistory(saved.id)).toMatchObject([{
      outcome: "response", provider: "openai_luna", resolvedModel: "gpt-6-luna-unexpected",
      inputTokens: 100, outputTokens: 30, errorCategory: "provider_rejected_or_response_invalid",
    }]);
    expect(db.categoricalTrendSnapshot("acme", 24, now).counts.total).toBe(0);
  });

  it.each([
    ["excluded", { about: false }, "excluded"],
    ["insufficient evidence", { evidence_sufficient: false }, "review_required"],
  ] as const)("derives the persisted disposition for %s output through the real classification path", async (_label, classificationOverrides, expectedDisposition) => {
    const db = new Desk(":memory:");
    openDbs.push(db);
    db.seedCompanies([company]);
    const now = Date.now();
    const adapterVersion = "google_news_rss/1";
    const deliveryId = db.recordDelivery({
      collector: "google_news_rss", companyId: "acme", requestKey: `request-${expectedDisposition}`,
      startedAt: now - 2_000, completedAt: now - 1_000, result: "success", parsedItemCount: 1, adapterVersion,
    });
    const source: RawMention = {
      companyId: "acme", kind: "rss", sourceName: "Reuters", sourceUrl: `https://reuters.example/${expectedDisposition}`,
      tier: "wire", title: input.source.title, snippet: input.source.excerpt, publishedAt: now - 3_000,
      retrievedAt: now, collector: "google_news_rss", sourceItemId: `disposition-${expectedDisposition}`, adapterVersion, deliveryId,
    };
    const model = classifier((async () => new Response(JSON.stringify(responseBody({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output(classificationOverrides)) }] }],
    })), { status: 200 })) as typeof fetch);
    const health = new HealthTracker(false, false, OPENAI_MODEL, false, false, false, true, new Set(["google_news_rss"]), undefined, {
      provider: "openai_luna", model: OPENAI_MODEL, configured: true, enabled: true, blockedReason: null,
    });
    const pipeline = new Pipeline({
      db, judge: null, classifier: (prepared) => model.classifyPrepared(prepared), provider: "openai_luna",
      hub: new Hub(), health, engineLabel: OPENAI_MODEL, inputPricePerMTok: 0, concurrency: 1,
      allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-04", maxRequests: 1, maxRequestBytes: 100_000, maxDailyCostMicros: 10_000 },
    });
    pipelines.push(pipeline);

    pipeline.ingest(source);
    await pipeline.waitForIdle();

    const saved = db.mentionsForCompany("acme", 0, 10)[0]!;
    expect(saved.classification?.disposition).toBe(expectedDisposition);
    const classifiedAt = saved.classification?.classifiedAt;
    if (classifiedAt == null) throw new Error("Expected the completed classifier result to persist its classification time");
    expect(db.categoricalTrendSnapshot("acme", 24, classifiedAt).counts.total).toBe(0);
    const counts = db.categoricalTrendSnapshot("acme", 24, classifiedAt + 1).counts;
    expect(counts.total).toBe(1);
    expect(expectedDisposition === "review_required" ? counts.reviewRequired : counts.excluded).toBe(1);
    expect(counts.positive).toBe(0);
    expect(counts.neutral).toBe(0);
    expect(counts.negative).toBe(0);
  });

  it("keeps a completed-status unreadable response outcome unknown", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("connection ended while reading")); },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    await expect(classifier(fetchImpl).classifyPrepared(prepareOpenAIRequest(input))).rejects.toMatchObject({ outcomeUnknown: true, status: 200 });
  });

  it("preserves a final storage admission pause as known-not-sent rather than unknown usage", async () => {
    const fetchImpl = (async () => { throw new ExternalRequestPausedError(); }) as typeof fetch;
    await expect(classifier(fetchImpl).classifyPrepared(prepareOpenAIRequest(input)))
      .rejects.toBeInstanceOf(ExternalRequestPausedError);
  });

  it("persists a separate categorical record and reopens with a null Jev score and no probabilities", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentiment-desk-openai-classification-"));
    tempDirs.push(dir);
    const path = join(dir, "desk.db");
    let db = new Desk(path);
    openDbs.push(db);
    db.seedCompanies([company]);
    const id = db.insertObservation({ companyId: "acme", kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.example/acme", tier: "wire",
      title: input.source.title, snippet: input.source.excerpt, publishedAt: 10, retrievedAt: 20, collector: "google_news_rss", sourceItemId: "openai-row" }).observationId;
    const request = prepareOpenAIRequest(input);
    const claim = db.claimForScoringWithBudget({ id, now: 30, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-01",
      requestBytes: request.requestBytes, requestSha256: request.payloadSha256, requestedModel: request.requestedModel,
      rubricSha256: request.profileSha256, maxRequests: 3, maxRequestBytes: 100_000, provider: "openai_luna",
      maxDailyCostMicros: 1_000_000, reservedCostMicros: 500, requestedServiceTier: "default", maxOutputTokens: 700,
      schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim was not created");
    expect(db.recordJevDispatchIntent(claim.attemptId, 31)).toBe(true);
    const category: CategoricalClassification = {
      provider: "openai_luna", modelRequested: OPENAI_MODEL, modelReturned: "gpt-6-luna", serviceTierRequested: "default", serviceTier: "default",
      promptVersion: "openai-luna-classification/1", promptSha256: OPENAI_PROMPT_SHA256,
      profileSha256: request.profileSha256,
      schemaVersion: "openai-luna-classification-json/1", schemaSha256: OPENAI_SCHEMA_SHA256,
      sentiment: "positive", eventType: "corporate_action", takeaway: "product_win", about: true, material: true,
      investorRelevant: true, evidenceSufficient: true, summary: "Acme won a contract.",
      supportingExcerpt: input.source.title, disposition: "classified", responseId: "resp_test_1",
      responseSha256: "c".repeat(64), inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30,
      reasoningTokens: 5, totalTokens: 130, estimatedCostUsd: 0.00002, latencyMs: 12, classifiedAt: 40,
    };
    db.recordCategoricalClassification(id, category, { attemptId: claim.attemptId, outcome: "response", occurredAt: 40, httpStatus: 200,
      inputTokens: 100, outputTokens: 30, resolvedModel: category.modelReturned, latencyMs: 12, errorCategory: null,
      cachedInputTokens: 20, cacheWriteInputTokens: 0, reasoningTokens: 5, totalTokens: 130, responseId: category.responseId,
      responseSha256: category.responseSha256, estimatedCostUsd: category.estimatedCostUsd, responseServiceTier: "default" });
    expect(db.mentionRow(id)?.status).toBe("classified");
    db.close();
    openDbs.splice(openDbs.indexOf(db), 1);
    db = new Desk(path);
    openDbs.push(db);
    const row = db.mentionRow(id)!;
    const dto = rowToDTO(row);
    expect(dto).toMatchObject({ status: "classified", score: null, classification: { provider: "openai_luna", disposition: "classified", sentiment: "positive", material: true } });
    expect(dto.classification).not.toHaveProperty("pPos");
    expect(dto.classification).not.toHaveProperty("confidence");
    expect(db.jevAttemptHistory(id)[0]).toMatchObject({ provider: "openai_luna", cachedInputTokens: 20, reasoningTokens: 5, responseId: "resp_test_1" });
  });

  it("keeps OpenAI cost reservations atomic and fails closed when any default budget is zero", () => {
    const db = new Desk(":memory:");
    openDbs.push(db);
    db.seedCompanies([company]);
    const id = db.insertObservation({ companyId: "acme", kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.example/acme", tier: "wire",
      title: input.source.title, snippet: input.source.excerpt, publishedAt: 10, retrievedAt: 20, collector: "google_news_rss", sourceItemId: "openai-budget" }).observationId;
    const request = prepareOpenAIRequest(input);
    const args = { id, now: 30, allowedCollectors: ["google_news_rss"] as const, utcDay: "2026-10-01", requestBytes: request.requestBytes,
      requestSha256: request.payloadSha256, requestedModel: request.requestedModel, rubricSha256: request.profileSha256,
      maxRequests: 3, maxRequestBytes: 100_000, provider: "openai_luna" as const, reservedCostMicros: 500,
      requestedServiceTier: "default" as const, maxOutputTokens: 700, schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 };
    expect(db.claimForScoringWithBudget({ ...args, maxDailyCostMicros: 0 }).kind).toBe("budget_exhausted");
    expect(db.claimForScoringWithBudget({ ...args, maxDailyCostMicros: 499 }).kind).toBe("budget_exhausted");
    expect(db.claimForScoringWithBudget({ ...args, maxDailyCostMicros: 500 }).kind).toBe("claimed");
    expect(db.getKv("openai:budget:2026-10-01:cost-micros")).toBe("500");
  });

  it("accounts an over-reservation receipt atomically and keeps the closed UTC-day gate after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentiment-desk-openai-budget-restart-"));
    tempDirs.push(dir);
    const path = join(dir, "desk.db");
    let db = new Desk(path);
    openDbs.push(db);
    db.seedCompanies([company]);
    const makeId = (sourceItemId: string) => db.insertObservation({ companyId: "acme", kind: "rss", sourceName: "Reuters",
      sourceUrl: "https://reuters.example/acme", tier: "wire", title: input.source.title, snippet: input.source.excerpt,
      publishedAt: 10, retrievedAt: 20, collector: "google_news_rss", sourceItemId }).observationId;
    const ids = [makeId("overrun-a"), makeId("overrun-b"), makeId("overrun-c")];
    const request = prepareOpenAIRequest(input);
    const claim = (id: string) => db.claimForScoringWithBudget({ id, now: 30, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-01",
      requestBytes: request.requestBytes, requestSha256: request.payloadSha256, requestedModel: request.requestedModel,
      rubricSha256: request.profileSha256, maxRequests: 5, maxRequestBytes: 100_000, provider: "openai_luna",
      maxDailyCostMicros: 1_000, reservedCostMicros: 500, requestedServiceTier: "default", maxOutputTokens: 700,
      schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 });
    const first = claim(ids[0]!);
    const concurrent = claim(ids[1]!);
    expect(first.kind).toBe("claimed");
    expect(concurrent.kind).toBe("claimed");
    if (first.kind !== "claimed" || concurrent.kind !== "claimed") throw new Error("budget reservations were not created");
    db.recordJevDispatchIntent(first.attemptId, 31);
    db.recordJevAttemptReceipt({ attemptId: first.attemptId, outcome: "response", occurredAt: 32, httpStatus: 200,
      inputTokens: 100, outputTokens: 1_100, resolvedModel: "gpt-6-luna", latencyMs: 1, errorCategory: null,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 1_200,
      estimatedCostUsd: 0.00056, responseServiceTier: "default" });
    expect(db.getKv("openai:budget:2026-10-01:cost-micros")).toBe("1060");
    expect(db.getKv("openai:budget:2026-10-01:closed")).toBe("1");
    db.close();
    openDbs.splice(openDbs.indexOf(db), 1);
    db = new Desk(path);
    openDbs.push(db);
    // The second claim was known not sent when the process closed, so its
    // request, byte, and cost reservation is returned during recovery.
    expect(db.getKv("openai:budget:2026-10-01:cost-micros")).toBe("560");
    expect(claim(ids[2]!).kind).toBe("budget_exhausted");
  });

  it("closes a dispatched Luna budget after restart and reports an unfinished receipt as unpriced", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentiment-desk-openai-unknown-restart-"));
    tempDirs.push(dir);
    const path = join(dir, "desk.db");
    let db = new Desk(path);
    openDbs.push(db);
    db.seedCompanies([company]);
    const request = prepareOpenAIRequest(input);
    const add = (sourceItemId: string) => db.insertObservation({ companyId: "acme", kind: "rss", sourceName: "Reuters",
      sourceUrl: "https://reuters.example/acme", tier: "wire", title: input.source.title, snippet: input.source.excerpt,
      publishedAt: 10, retrievedAt: 20, collector: "google_news_rss", sourceItemId }).observationId;
    const id = add("crashed-openai-request");
    const claim = db.claimForScoringWithBudget({ id, now: 30, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-01",
      requestBytes: request.requestBytes, requestSha256: request.payloadSha256, requestedModel: request.requestedModel,
      rubricSha256: request.profileSha256, maxRequests: 5, maxRequestBytes: 100_000, provider: "openai_luna",
      maxDailyCostMicros: 20_000, reservedCostMicros: 1_000, requestedServiceTier: "default", maxOutputTokens: 700,
      schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("budget reservation was not created");
    db.recordJevDispatchIntent(claim.attemptId, 31);
    expect(db.classifierUsageSince(0)).toMatchObject({ requests: 1, estimatedCostUsd: null, unpricedAttempts: 1, usageIncompleteAttempts: 1, inputTokens: null });
    db.close();
    openDbs.splice(openDbs.indexOf(db), 1);
    db = new Desk(path);
    openDbs.push(db);
    expect(db.getKv("openai:budget:2026-10-01:closed")).toBe("1");
    expect(db.jevAttemptHistory(id)[0]?.outcome).toBe("unknown");
    expect(db.classifierUsageSince(0)).toMatchObject({ unknownOutcomes: 1, unpricedAttempts: 1, usageIncompleteAttempts: 1, inputTokens: null });
    expect(db.claimForScoringWithBudget({ id: add("blocked-after-unknown"), now: 40, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-01",
      requestBytes: request.requestBytes, requestSha256: request.payloadSha256, requestedModel: request.requestedModel,
      rubricSha256: request.profileSha256, maxRequests: 5, maxRequestBytes: 100_000, provider: "openai_luna",
      maxDailyCostMicros: 20_000, reservedCostMicros: 1_000, requestedServiceTier: "default", maxOutputTokens: 700,
      schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 }).kind).toBe("budget_exhausted");
  });

  it("releases Luna request and cost reservations for an explicitly not-sent storage pause", () => {
    const db = new Desk(":memory:");
    openDbs.push(db);
    db.seedCompanies([company]);
    const id = db.insertObservation({ companyId: "acme", kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.example/acme",
      tier: "wire", title: input.source.title, snippet: input.source.excerpt, publishedAt: 10, retrievedAt: 20,
      collector: "google_news_rss", sourceItemId: "storage-paused-luna" }).observationId;
    const request = prepareOpenAIRequest(input);
    const claim = db.claimForScoringWithBudget({ id, now: 30, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-01",
      requestBytes: request.requestBytes, requestSha256: request.payloadSha256, requestedModel: request.requestedModel,
      rubricSha256: request.profileSha256, maxRequests: 1, maxRequestBytes: 100_000, provider: "openai_luna",
      maxDailyCostMicros: 500, reservedCostMicros: 500, requestedServiceTier: "default", maxOutputTokens: 700,
      schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("budget reservation was not created");
    expect(db.getKv("openai:budget:2026-10-01:requests")).toBe("1");
    expect(db.getKv("openai:budget:2026-10-01:request-bytes")).toBe(String(request.requestBytes));
    expect(db.getKv("openai:budget:2026-10-01:cost-micros")).toBe("500");
    expect(db.recordJevDispatchIntent(claim.attemptId, 31)).toBe(true);
    db.recordJevAttemptReceipt({ attemptId: claim.attemptId, outcome: "not_sent", occurredAt: 32,
      httpStatus: null, inputTokens: null, outputTokens: null, resolvedModel: null, latencyMs: null, errorCategory: "storage_paused" });
    db.markRetrying(id, "Storage admission paused before dispatch", 60_000);

    expect(db.getKv("openai:budget:2026-10-01:requests")).toBe("0");
    expect(db.getKv("openai:budget:2026-10-01:request-bytes")).toBe("0");
    expect(db.getKv("openai:budget:2026-10-01:cost-micros")).toBe("0");
    expect(db.getKv("openai:budget:2026-10-01:closed")).toBeUndefined();
    expect(db.jevAttemptHistory(id)[0]).toMatchObject({ outcome: "not_sent", dispatchAt: null, errorCategory: "storage_paused" });
    expect(db.classifierUsageSince(0)).toMatchObject({ requests: 0, reservedRequests: 1, estimatedCostUsd: 0,
      reservedCostUsd: 0, unknownOutcomes: 0, unpricedAttempts: 0, usageIncompleteAttempts: 0, inputTokens: 0 });
  });

  it("does not report partial optional-token sums when one dispatched receipt omits cache accounting", () => {
    const db = new Desk(":memory:");
    openDbs.push(db);
    db.seedCompanies([company]);
    const request = prepareOpenAIRequest(input);
    for (const [index, detail] of [true, false].entries()) {
      const id = db.insertObservation({ companyId: "acme", kind: "rss", sourceName: "Reuters", sourceUrl: `https://reuters.example/${index}`,
        tier: "wire", title: input.source.title, snippet: input.source.excerpt, publishedAt: 10 + index,
        retrievedAt: 20 + index, collector: "google_news_rss", sourceItemId: `mixed-usage-${index}` }).observationId;
      const claim = db.claimForScoringWithBudget({ id, now: 30 + index, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-01",
        requestBytes: request.requestBytes, requestSha256: request.payloadSha256, requestedModel: request.requestedModel,
        rubricSha256: request.profileSha256, maxRequests: 5, maxRequestBytes: 100_000, provider: "openai_luna",
        maxDailyCostMicros: 20_000, reservedCostMicros: 1_000, requestedServiceTier: "default", maxOutputTokens: 700,
        schemaSha256: request.schemaSha256, promptSha256: request.promptSha256 });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") throw new Error("budget reservation was not created");
      db.recordJevDispatchIntent(claim.attemptId, 40 + index);
      db.recordJevAttemptReceipt({ attemptId: claim.attemptId, outcome: "response", occurredAt: 50 + index, httpStatus: 200,
        inputTokens: 100, outputTokens: 30, resolvedModel: detail ? "gpt-6-luna" : "gpt-6-luna-unknown-variant",
        latencyMs: 1, errorCategory: null, cachedInputTokens: detail ? 20 : null, cacheWriteInputTokens: detail ? 0 : null,
        reasoningTokens: detail ? 5 : null, totalTokens: 130, estimatedCostUsd: detail ? 0.000017 : null,
        responseServiceTier: "default" });
    }
    expect(db.classifierUsageSince(0)).toMatchObject({ cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null,
      estimatedCostUsd: null, knownCostSubtotalUsd: 0.000017, unpricedAttempts: 1, usageIncompleteAttempts: 0 });
  });
});
