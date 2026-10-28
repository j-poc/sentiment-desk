import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
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
    provider: "openai_luna", model: "gpt-6-luna", configured: false, enabled: false, blockedReason: "Connect a ChatGPT plan to enable GPT-6 Luna.",
  });
  const hub = new Hub();
  const pipeline = new Pipeline({
    db, judge: null, classifier: null, provider: "openai_luna", hub, health, engineLabel: "test",
    inputPricePerMTok: 0, concurrency: 1, allowedCollectors: new Set(), externalRequestsEnabled: false,
    dailyBudget: { utcDay: () => "2026-10-02", maxRequests: 0, maxRequestBytes: 0, maxDailyCostMicros: 0 },
  });
  return createApp({ db, dbPath: ":memory:", pipeline, market: {} as MarketData, hub, health, version: "test", deliverySources: [], webRoot: "/missing-test-web-root" });
}

function sourceInput(sourceItemId: string, at: number, deliveryId?: string, options: {
  company?: Company; title?: string; snippet?: string; scoped?: boolean; sourceTime?: number | null;
} = {}): RawMention {
  const selectedCompany = options.company ?? company;
  return {
    companyId: selectedCompany.id, kind: "rss", sourceName: "Reuters", sourceUrl: `https://reuters.example/${sourceItemId}`,
    tier: "wire", title: options.title ?? `Acme update ${sourceItemId}`, snippet: options.snippet ?? "Evidence excerpt from the source record.",
    publishedAt: null, aggregatorPublishedAt: options.sourceTime === undefined ? at - 60_000 : options.sourceTime,
    retrievedAt: at - 5, collector: "google_news_rss", sourceItemId,
    publisherName: "Reuters", publisherDomain: "reuters.example", scoped: options.scoped ?? false, ...(deliveryId ? { deliveryId } : {}),
  };
}

function insertClassified(db: Desk, input: {
  id: string; classifiedAt: number; disposition?: CategoricalClassification["disposition"];
  sentiment?: CategoricalClassification["sentiment"]; profile?: "v1" | "v2"; receipt?: boolean;
  modelReturned?: string; serviceTier?: string | null; receiptInputTokens?: number; accountingRoute?: "api_key" | "chatgpt_plan";
  company?: Company; title?: string; snippet?: string; scoped?: boolean;
  sourceTime?: number | null;
}) {
  const selectedCompany = input.company ?? company;
  const adapterVersion = "google_news_rss/1";
  let deliveryId: string | undefined;
  if (input.receipt !== false) {
    deliveryId = db.recordDelivery({
      collector: "google_news_rss", companyId: selectedCompany.id, requestKey: `request-${input.id}`,
      startedAt: input.classifiedAt - 10, completedAt: input.classifiedAt - 8, result: "success",
      parsedItemCount: 1, adapterVersion,
    });
  }
  const observationId = db.insertObservation({ ...sourceInput(input.id, input.classifiedAt, deliveryId, input), adapterVersion }).observationId;
  const profile = input.profile ?? "v1";
  const promptSha256 = profile === "v1" ? promptSha : "c".repeat(64);
  const schemaSha256 = profile === "v1" ? schemaSha : "d".repeat(64);
  const profileSha256 = profile === "v1" ? "e".repeat(64) : "f".repeat(64);
  const requestSha = createHash("sha256").update(`request-${input.id}`).digest("hex");
  const accountingRoute = input.accountingRoute ?? "api_key";
  const claim = db.claimForScoringWithBudget({
    id: observationId, now: input.classifiedAt - 3, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-02",
    requestBytes: 400, requestSha256: requestSha, requestedModel: "gpt-6-luna", rubricSha256: profileSha256,
    maxRequests: 100, maxRequestBytes: 100_000, provider: "openai_luna", accountingRoute,
    ...(accountingRoute === "api_key" ? { maxDailyCostMicros: 100_000, reservedCostMicros: 500, requestedServiceTier: "default" as const, maxOutputTokens: 700 } : {}),
    schemaSha256, promptSha256,
  });
  if (claim.kind !== "claimed") throw new Error(`Luna test claim failed: ${claim.kind}`);
  expect(db.recordJevDispatchIntent(claim.attemptId, input.classifiedAt - 2)).toBe(true);
  const responseId = `resp_${input.id}`;
  const category: CategoricalClassification = {
    provider: "openai_luna", accountingRoute, modelRequested: "gpt-6-luna", modelReturned: input.modelReturned ?? "gpt-6-luna",
    serviceTierRequested: accountingRoute === "api_key" ? "default" : null,
    serviceTier: input.serviceTier === undefined ? accountingRoute === "api_key" ? "default" : "priority" : input.serviceTier,
    promptVersion: profile === "v1" ? "luna-prompt/1" : "luna-prompt/2",
    promptSha256,
    schemaVersion: profile === "v1" ? "luna-schema/1" : "luna-schema/2",
    schemaSha256, profileSha256,
    sentiment: input.sentiment === undefined ? "positive" : input.sentiment,
    eventType: "results", takeaway: "reported_change", about: true, material: true, investorRelevant: true,
    evidenceSufficient: true, summary: "A real-source test record.", supportingExcerpt: input.title ?? `Acme update ${input.id}`,
    disposition: input.disposition ?? (input.sentiment === null ? "review_required" : "classified"),
    responseId, responseSha256: createHash("sha256").update(responseId).digest("hex"),
    inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 30, reasoningTokens: 0,
    totalTokens: 130, estimatedCostUsd: accountingRoute === "api_key" ? 0.00002 : null, latencyMs: 12, classifiedAt: input.classifiedAt,
  };
  db.recordCategoricalClassification(observationId, category, {
    attemptId: claim.attemptId, outcome: "response", occurredAt: input.classifiedAt, httpStatus: 200,
    inputTokens: input.receiptInputTokens ?? 100, outputTokens: 30, resolvedModel: category.modelReturned, latencyMs: 12, errorCategory: null,
    cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 130,
    responseId, responseSha256: category.responseSha256, estimatedCostUsd: category.estimatedCostUsd,
    responseServiceTier: category.serviceTier,
  });
  return observationId;
}

describe("Luna categorical trend and source bucket", () => {
  it("includes source-linked ChatGPT-plan Luna classifications in the chart without inventing tier or USD cost", () => {
    const db = openDesk();
    const classifiedAt = now - 30_000;
    const id = insertClassified(db, { id: "plan-positive", classifiedAt, accountingRoute: "chatgpt_plan" });
    const noTierId = insertClassified(db, { id: "plan-neutral-no-tier", classifiedAt: classifiedAt + 1, accountingRoute: "chatgpt_plan", sentiment: "neutral", serviceTier: null });
    const row = db.mentionsForCompany(company.id, 0, 10).find((mention) => mention.id === id);
    expect(row?.classification).toMatchObject({
      provider: "openai_luna", accountingRoute: "chatgpt_plan", serviceTierRequested: null,
      serviceTier: "priority", estimatedCostUsd: null, sentiment: "positive", attemptId: expect.any(String),
    });
    expect(db.mentionsForCompany(company.id, 0, 10).find((mention) => mention.id === noTierId)?.classification)
      .toMatchObject({ accountingRoute: "chatgpt_plan", serviceTierRequested: null, serviceTier: null, estimatedCostUsd: null });
    expect(db.categoricalTrendSnapshot(company.id, 24, now).counts).toMatchObject({ total: 2, positive: 1, neutral: 1, negative: 0 });
    expect(db.planUsageSince(0)).toMatchObject({ requests: 2, requestBytes: 800, classifiedItems: 2, unknownOutcomes: 0 });
    expect(db.classifierUsageSince(0)).toMatchObject({ requests: 0, reservedRequests: 0, estimatedCostUsd: 0, reservedCostUsd: 0 });
  });

  it("withholds stored Luna categories when a later issuer correction invalidates acronym identity", () => {
    const db = openDesk();
    const amd: Company = {
      id: "amd", name: "AMD", ticker: "AMD", sector: "Semiconductors",
      aliases: ["AMD", "Advanced Micro Devices", "Lisa Su", "Ryzen", "Instinct"], color: "#fb923c", ambiguous: false,
    };
    db.seedCompanies([amd]);
    const classifiedAt = now - 20_000;
    insertClassified(db, {
      id: "dry-amd-medical-story", classifiedAt, company: amd,
      title: "Bausch + Lomb stock rises on dry AMD trial",
      snippet: "A dry age-related macular degeneration trial drew attention.",
    });
    db.seedCompanies([{ ...amd, ambiguous: true }]);
    const snapshot = db.categoricalTrendSnapshot(amd.id, 24, now);
    expect(snapshot).toMatchObject({ candidateClassificationCount: 1, eligibleObservationCount: 0, withheldInvalidCount: 1 });
    expect(snapshot.counts).toMatchObject({ total: 0, positive: 0, neutral: 0, negative: 0, reviewRequired: 0 });
  });

  it("withholds an older Luna classification when the current rule excludes a consumer promotion", () => {
    const db = openDesk();
    const apple: Company = {
      id: "apple", name: "Apple", ticker: "AAPL", sector: "Consumer Electronics",
      aliases: ["iPhone", "Tim Cook", "Macbook"], color: "#cbd5e1", ambiguous: true,
    };
    db.seedCompanies([apple]);
    const classifiedAt = now - 20_000;
    const observationId = insertClassified(db, {
      id: "old-apple-shopping-promo",
      classifiedAt,
      company: apple,
      title: "Save an incredible $500 on the powerful 2026 Apple MacBook Pro on Amazon",
      snippet: "A discount for shoppers.",
    });

    const snapshot = db.categoricalTrendSnapshot(apple.id, 24, now);
    expect(snapshot).toMatchObject({
      candidateClassificationCount: 1,
      eligibleObservationCount: 0,
      plottedObservationCount: 0,
      withheldInvalidCount: 1,
      counts: { total: 0 },
      lineages: [],
    });
    const sourceTime = classifiedAt - 60_000;
    const evidence = db.categoricalBucketEvidence({
      companyId: apple.id,
      snapshotKey: snapshot.snapshotKey,
      bucketStartMs: Math.floor(sourceTime / bucketMs) * bucketMs,
      limit: 10,
      cursor: null,
    });
    expect(evidence.counts.total).toBe(0);
    expect(evidence.items.map((item) => item.id)).not.toContain(observationId);
  });

  it("rebuilds a v17 categorical table to allow a null requested tier while preserving old rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-v17-luna-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    const db = openDesk(path);
    const classifiedAt = now - 40_000;
    const id = insertClassified(db, { id: "v17-row", classifiedAt });
    const raw = (db as unknown as { db: DatabaseSync }).db;
    raw.exec("DROP TRIGGER IF EXISTS categorical_classifications_profile_guard; DROP TRIGGER IF EXISTS categorical_classifications_no_update; DROP TRIGGER IF EXISTS categorical_classifications_no_delete;");
    raw.exec("ALTER TABLE categorical_classifications RENAME TO categorical_classifications_current");
    raw.exec(`CREATE TABLE categorical_classifications (
      observation_id TEXT PRIMARY KEY REFERENCES source_observations(id), attempt_id TEXT REFERENCES jev_request_attempts(id),
      provider TEXT NOT NULL, model_requested TEXT NOT NULL, model_returned TEXT NOT NULL,
      requested_service_tier TEXT NOT NULL, service_tier TEXT, prompt_version TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
      schema_version TEXT NOT NULL, schema_sha256 TEXT NOT NULL, profile_sha256 TEXT, sentiment TEXT, event_type TEXT,
      takeaway TEXT, about INTEGER, material INTEGER, investor_relevant INTEGER, evidence_sufficient INTEGER NOT NULL,
      summary TEXT, supporting_excerpt TEXT, disposition TEXT NOT NULL, response_id TEXT NOT NULL, response_sha256 TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER, total_tokens INTEGER NOT NULL, estimated_cost_usd REAL, latency_ms INTEGER NOT NULL, classified_at INTEGER NOT NULL
    )`);
    raw.exec(`INSERT INTO categorical_classifications SELECT observation_id,attempt_id,provider,model_requested,model_returned,
      requested_service_tier,service_tier,prompt_version,prompt_sha256,schema_version,schema_sha256,profile_sha256,sentiment,
      event_type,takeaway,about,material,investor_relevant,evidence_sufficient,summary,supporting_excerpt,disposition,response_id,
      response_sha256,input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,estimated_cost_usd,
      latency_ms,classified_at FROM categorical_classifications_current`);
    raw.exec("DROP TABLE categorical_classifications_current; PRAGMA user_version=17");
    desks.splice(desks.indexOf(db), 1);
    db.close();

    const reopened = openDesk(path);
    const reopenedRaw = (reopened as unknown as { db: DatabaseSync }).db;
    expect(reopenedRaw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
    expect(reopenedRaw.prepare("SELECT accounting_route, requested_service_tier, sentiment FROM categorical_classifications WHERE observation_id=?").get(id))
      .toEqual({ accounting_route: "api_key", requested_service_tier: "default", sentiment: "positive" });
    expect(reopened.mentionsForCompany(company.id, 0, 10).find((mention) => mention.id === id)?.classification?.accountingRoute).toBe("api_key");
  });

  it("upgrades version 9 and binds a categorical row to its exact saved attempt and receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-luna-profile-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    const db = openDesk(path);
    const classifiedAt = now - 20_000;
    const sourceId = insertClassified(db, { id: "profile-source", classifiedAt });
    const openDeskDb = (db as unknown as { db: DatabaseSync }).db;
    openDeskDb.exec("DROP TRIGGER IF EXISTS categorical_classifications_profile_guard");
    openDeskDb.exec("DROP VIEW IF EXISTS mentions");
    openDeskDb.exec("ALTER TABLE jev_request_attempts DROP COLUMN prompt_sha256");
    openDeskDb.exec("ALTER TABLE categorical_classifications DROP COLUMN profile_sha256");
    openDeskDb.exec("ALTER TABLE categorical_classifications DROP COLUMN attempt_id");
    openDeskDb.exec("PRAGMA user_version = 9");
    desks.splice(desks.indexOf(db), 1);
    db.close();

    const reopened = openDesk(path);
    const raw = (reopened as unknown as { db: DatabaseSync }).db;
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
    expect(raw.prepare("SELECT profile_sha256, attempt_id FROM categorical_classifications WHERE observation_id = ?")
      .get(sourceId)).toEqual({ profile_sha256: null, attempt_id: null });

    const deliveryId = reopened.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: "profile-target-delivery",
      startedAt: classifiedAt + 1, completedAt: classifiedAt + 2, result: "success", parsedItemCount: 1,
      adapterVersion: "google_news_rss/1",
    });
    const targetId = reopened.insertObservation({
      ...sourceInput("profile-target", classifiedAt + 3, deliveryId), adapterVersion: "google_news_rss/1",
    }).observationId;
    const responseId = "resp_profile-target";
    const responseSha256 = createHash("sha256").update(responseId).digest("hex");
    const requestSha256 = createHash("sha256").update("profile-target-request").digest("hex");
    const profileSha256 = "e".repeat(64);
    const claim = reopened.claimForScoringWithBudget({
      id: targetId, now: classifiedAt + 4, allowedCollectors: ["google_news_rss"], utcDay: "2026-10-02",
      requestBytes: 400, requestSha256, requestedModel: "gpt-6-luna", rubricSha256: profileSha256,
      maxRequests: 100, maxRequestBytes: 100_000, provider: "openai_luna", maxDailyCostMicros: 100_000,
      reservedCostMicros: 500, requestedServiceTier: "default", maxOutputTokens: 700,
      schemaSha256: schemaSha, promptSha256: promptSha,
    });
    if (claim.kind !== "claimed") throw new Error(`Luna profile test claim failed: ${claim.kind}`);
    expect(reopened.recordJevDispatchIntent(claim.attemptId, classifiedAt + 5)).toBe(true);
    reopened.recordJevAttemptReceipt({
      attemptId: claim.attemptId, outcome: "response", occurredAt: classifiedAt + 6, httpStatus: 200,
      inputTokens: 100, outputTokens: 30, resolvedModel: "gpt-6-luna", latencyMs: 12, errorCategory: null,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 130,
      responseId, responseSha256, estimatedCostUsd: 0.00002, responseServiceTier: "default",
    });

    const insertRaw = (modelReturned: string, serviceTier: string, options: {
      requestedTier?: string; prompt?: string; profile?: string; schema?: string; responseId?: string; receiptSha?: string;
      attemptId?: string;
      inputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; outputTokens?: number;
      reasoningTokens?: number; totalTokens?: number; estimatedCostUsd?: number; latencyMs?: number;
    } = {}) => raw.prepare(`
      INSERT INTO categorical_classifications
        (observation_id, attempt_id, provider, model_requested, model_returned, requested_service_tier, service_tier,
         prompt_version, prompt_sha256, schema_version, schema_sha256, profile_sha256, sentiment, event_type, takeaway,
         about, material, investor_relevant, evidence_sufficient, summary, supporting_excerpt, disposition,
         response_id, response_sha256, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
         reasoning_tokens, total_tokens, estimated_cost_usd, latency_ms, classified_at)
      VALUES (?, ?, 'openai_luna', 'gpt-6-luna', ?, ?, ?, 'luna-prompt/1', ?, 'luna-schema/1', ?, ?,
        'positive', 'results', 'reported_change', 1, 1, 1, 1, 'Saved categorical evidence', ?, 'classified',
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(targetId, options.attemptId ?? claim.attemptId, modelReturned, options.requestedTier ?? "default", serviceTier,
      options.prompt ?? promptSha, options.schema ?? schemaSha, options.profile ?? profileSha256,
      "Acme update profile-target", options.responseId ?? responseId, options.receiptSha ?? responseSha256,
      options.inputTokens ?? 100, options.cachedInputTokens ?? 0, options.cacheWriteTokens ?? 0,
      options.outputTokens ?? 30, options.reasoningTokens ?? 0, options.totalTokens ?? 130,
      options.estimatedCostUsd ?? 0.00002, options.latencyMs ?? 12, classifiedAt + 7);

    expect(() => insertRaw("gpt-6-luna-unexpected", "default")).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "flex")).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { receiptSha: "f".repeat(64) })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { requestedTier: "auto" })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { prompt: "9".repeat(64) })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { profile: "f".repeat(64) })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { schema: "f".repeat(64) })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { attemptId: "00000000-0000-4000-8000-000000000000" })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { inputTokens: 99 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { responseId: "resp_other" })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { cachedInputTokens: 1 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { cacheWriteTokens: 1 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { outputTokens: 31 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { reasoningTokens: 1 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { totalTokens: 131 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { estimatedCostUsd: 0.00003 })).toThrow(/categorical classification profile/i);
    expect(() => insertRaw("gpt-6-luna", "default", { latencyMs: 13 })).toThrow(/categorical classification profile/i);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM categorical_classifications WHERE observation_id = ?")
      .get(targetId)).toEqual({ count: 0 });
    expect(() => insertRaw("gpt-6-luna", "default")).not.toThrow();
    expect(raw.prepare("SELECT attempt_id, model_returned, service_tier FROM categorical_classifications WHERE observation_id = ?")
      .get(targetId)).toEqual({ attempt_id: claim.attemptId, model_returned: "gpt-6-luna", service_tier: "default" });
    expect(raw.prepare("SELECT observation_id FROM categorical_classifications WHERE observation_id = ?")
      .get(sourceId)).toBeDefined();
    const snapshot = reopened.categoricalTrendSnapshot(company.id, 1, now);
    expect(snapshot.counts.total).toBe(1);
    expect(snapshot.candidateClassificationCount).toBe(2);
    expect(snapshot.withheldInvalidCount).toBe(1);
    expect(snapshot.lineages).toMatchObject([{ profileSha256, promptSha256: promptSha, schemaSha256: schemaSha }]);
    expect(reopened.mentionsForCompany(company.id, 0, 10).find((row) => row.id === targetId)?.classification?.attemptId)
      .toBe(claim.attemptId);
  });

  it("rejects classifications whose returned model or service tier differs from the Luna profile", () => {
    const db = openDesk();

    expect(() => insertClassified(db, {
      id: "wrong-model", classifiedAt: now - 1_000, modelReturned: "gpt-6-luna-unexpected",
    })).toThrow("does not match the required GPT-6 Luna profile");
    expect(() => insertClassified(db, {
      id: "wrong-tier", classifiedAt: now - 500, serviceTier: "flex",
    })).toThrow("does not match the required GPT-6 Luna profile");
    expect(() => insertClassified(db, {
      id: "wrong-usage-receipt", classifiedAt: now - 250, receiptInputTokens: 99,
    })).toThrow("does not match the required GPT-6 Luna profile");

    const rows = db.mentionsForCompany(company.id, 0, 10);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.status)).toEqual(["scoring", "scoring", "scoring"]);
    expect(db.categoricalTrendSnapshot(company.id, 24, now).counts.total).toBe(0);
  });

  it("keeps five reachable outcomes separate, sends missing direction to review, and freezes receipt-linked pages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const db = openDesk();
    const firstBucket = now - 60 * 60_000;
    insertClassified(db, { id: "positive", classifiedAt: firstBucket + 60_000, sentiment: "positive" });
    insertClassified(db, { id: "neutral", classifiedAt: firstBucket + 120_000, sentiment: "neutral" });
    insertClassified(db, { id: "negative", classifiedAt: firstBucket + bucketMs + 60_000, sentiment: "negative" });
    insertClassified(db, { id: "uncertain", classifiedAt: firstBucket + bucketMs + 120_000, sentiment: null });
    insertClassified(db, { id: "inconsistent-classified-null", classifiedAt: firstBucket + bucketMs + 150_000, sentiment: null, disposition: "classified" });
    insertClassified(db, { id: "review", classifiedAt: firstBucket + bucketMs + 180_000, disposition: "review_required", sentiment: "negative" });
    insertClassified(db, { id: "excluded", classifiedAt: firstBucket + 2 * bucketMs + 60_000, disposition: "excluded", sentiment: "positive" });
    insertClassified(db, { id: "unreceipted", classifiedAt: firstBucket + 90_000, receipt: false });
    insertClassified(db, { id: "at-window-end", classifiedAt: now, sentiment: "negative" });

    const snapshot = db.categoricalTrendSnapshot(company.id, 1, now);
    expect(snapshot.counts).toEqual({ positive: 1, neutral: 1, negative: 2, reviewRequired: 3, excluded: 1, total: 8 });
    expect(snapshot.eligibleObservationCount).toBe(8);
    expect(snapshot.candidateClassificationCount).toBe(9);
    expect(snapshot.withheldInvalidCount).toBe(1);
    expect(snapshot.latestClassifiedAt).toBe(now);
    expect(snapshot.lineages).toHaveLength(1);
    expect(snapshot.aggregates.reduce((sum, row) => sum + row.counts.total, 0)).toBe(8);

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
    expect(uncertainBucket.counts).toMatchObject({ negative: 1, reviewRequired: 3, total: 4 });
    expect(() => db.categoricalBucketEvidence({
      companyId: "other-company", snapshotKey: snapshot.snapshotKey, bucketStartMs: firstBucket, limit: 1, cursor: null,
    })).toThrow("categorical_snapshot_unavailable");
  });

  it("charts by validated source time, reports untimed rows, and freezes the known-at classification snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const db = openDesk();
    const oldSourceTime = now - 55 * 60_000;
    const oldButInWindowId = insertClassified(db, { id: "old-source-classified-now", classifiedAt: now - 1_000, sourceTime: oldSourceTime });
    const untimedId = insertClassified(db, { id: "untimed-classified-now", classifiedAt: now - 500, sourceTime: null });
    insertClassified(db, { id: "outside-source-window-classified-now", classifiedAt: now - 200, sourceTime: now - 3 * 60 * 60_000 });

    const snapshot = db.categoricalTrendSnapshot(company.id, 1, now);
    expect(snapshot).toMatchObject({
      eligibleObservationCount: 2, plottedObservationCount: 1, untimedObservationCount: 1,
      candidateClassificationCount: 2, withheldInvalidCount: 0,
    });
    expect(snapshot.counts.total).toBe(1);
    expect(snapshot.aggregates).toEqual([{ bucketStartMs: Math.floor(oldSourceTime / bucketMs) * bucketMs, counts: expect.objectContaining({ total: 1 }) }]);
    const bucket = db.categoricalBucketEvidence({ companyId: company.id, snapshotKey: snapshot.snapshotKey,
      bucketStartMs: Math.floor(oldSourceTime / bucketMs) * bucketMs, limit: 10, cursor: null });
    expect(bucket.items.map((item) => item.id)).toEqual([oldButInWindowId]);
    expect(bucket.items[0]?.classification?.classifiedAt).toBe(now - 1_000);
    expect(bucket.items.some((item) => item.id === untimedId)).toBe(false);

    insertClassified(db, { id: "saved-after-known-at", classifiedAt: now - 100, sourceTime: oldSourceTime });
    const reopenedBucket = db.categoricalBucketEvidence({ companyId: company.id, snapshotKey: snapshot.snapshotKey,
      bucketStartMs: Math.floor(oldSourceTime / bucketMs) * bucketMs, limit: 10, cursor: null });
    expect(reopenedBucket.counts.total).toBe(1);
    expect(reopenedBucket.items.map((item) => item.id)).toEqual([oldButInWindowId]);
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
    expect(result).toMatchObject({ companyId: "acme", timeBasis: "validated_source_time", countBasis: "immutable_source_observation", eligibleObservationCount: 1, plottedObservationCount: 1, untimedObservationCount: 0 });
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
