import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TestDesk as Desk } from "./test-desk.js";
import { intersectJevSourceAllowlist } from "../server/collector-policy.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevError } from "../server/jev.js";
import { OpenAIClassifierError, type OpenAIClassifierResult } from "../server/openai-classifier.js";
import { Pipeline } from "../server/pipeline.js";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";
import { RUBRIC_SHA } from "../server/rubric.js";
import type { CollectorId, Company, JevState, RawMention } from "../server/types.js";

const directories: string[] = [];
const pipelines: Pipeline[] = [];
const company: Company = {
  id: "acme", name: "Acme Incorporated", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};

afterEach(() => {
  for (const pipeline of pipelines.splice(0)) pipeline.stop();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureAnswers(): Record<string, unknown> {
  const choice = (choices: readonly string[], selected: string) => ({
    type: "choice",
    choice: selected,
    confidence: 0.8,
    probabilities: Object.fromEntries(choices.map((key) => [key, key === selected ? 0.8 : (0.2 / (choices.length - 1))])),
  });
  return {
    sentiment: choice(["negative", "neutral", "positive"], "positive"),
    about: { type: "noul", noul: 0.9 },
    investor_relevant: { type: "noul", noul: 0.9 },
    material: { type: "noul", noul: 0.7 },
    novel: { type: "noul", noul: 0.7 },
    credible: { type: "noul", noul: 0.9 },
    event_type: choice(EVENT_TYPES, "product"),
    magnitude: { type: "noul", noul: 0.5 },
    surprise: { type: "noul", noul: 0.5 },
    takeaway: choice(TAKEAWAY_KEYS, "product_win"),
  };
}

function setup(
  judge: ((state: JevState, prepared?: unknown) => Promise<{ answers: Record<string, unknown>; model: string; inputTokens: number; outputTokens: number; latencyMs: number }>) | null,
  options: {
    allowedCollectors?: ReadonlySet<CollectorId>;
    externalRequestsEnabled?: boolean;
    dailyBudget?: { utcDay: () => string; maxRequests: number; maxRequestBytes: number };
    concurrency?: number;
    alert?: { webhookUrl: string; eventScore: number; impact: number; freshMinutes: number };
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-pipeline-"));
  directories.push(directory);
  const db = new Desk(join(directory, "desk.db"));
  db.seedCompanies([company]);
  const health = new HealthTracker(true, judge !== null, "jev-latest");
  const hub = new Hub();
  const pipeline = new Pipeline({
    db, judge: judge ? async (state, prepared) => ({ ...(await judge(state, prepared)), httpStatus: 200 }) : null,
    provider: "typesafe", hub, health,
    engineLabel: "jev-latest", inputPricePerMTok: 0.042, concurrency: options.concurrency ?? 1,
    allowedCollectors: options.allowedCollectors ?? new Set([options.alert ? "finnhub" : "google_news_rss"]),
    externalRequestsEnabled: options.externalRequestsEnabled,
    dailyBudget: options.dailyBudget ?? {
      utcDay: () => "2026-09-28", maxRequests: 100, maxRequestBytes: 1_000_000,
    },
    alert: options.alert,
  });
  pipelines.push(pipeline);
  const sourceCollector = options.alert ? "finnhub" : "google_news_rss";
  const source: RawMention = {
    companyId: company.id, kind: options.alert ? "finnhub" : "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/acme",
    tier: "wire", title: "Acme announces a product launch", snippet: "A new product is available.",
    publishedAt: options.alert ? Date.now() - 5_000 : null,
    aggregatorPublishedAt: options.alert ? null : Date.now() - 5_000,
    retrievedAt: Date.now(), collector: sourceCollector,
    sourceItemId: "reuters-acme-product", publisherName: "Reuters", publisherDomain: "reuters.com",
    adapterVersion: `${sourceCollector}/1`,
  };
  source.deliveryId = db.recordDelivery({
    collector: sourceCollector, companyId: company.id, requestKey: "test:source-receipt",
    startedAt: source.retrievedAt - 1_000, completedAt: source.retrievedAt + 1_000,
    result: "success", parsedItemCount: 1, responseDigest: "fixture-only", adapterVersion: `${sourceCollector}/1`,
  });
  return { db, pipeline, source, health, hub, dbPath: join(directory, "desk.db") };
}

describe("Jev pipeline recovery", () => {
  it("fails closed to Luna when provider selection is omitted instead of defaulting to TypeSafe", () => {
    const db = new Desk(":memory:");
    const judge = vi.fn(async () => ({
      answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 10, outputTokens: 2, latencyMs: 1, httpStatus: 200,
    }));
    const pipeline = new Pipeline({
      db, judge, hub: new Hub(), health: new HealthTracker(false, false, "jev-latest"),
      engineLabel: "test", inputPricePerMTok: 0, concurrency: 1,
      allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-04", maxRequests: 1, maxRequestBytes: 10_000 },
    });
    try {
      expect(pipeline.retryFailed("not-found", true)).toBe("classifier_not_configured");
      expect(judge).not.toHaveBeenCalled();
    } finally {
      pipeline.stop();
      db.close();
    }
  });
  it("streams newly persisted pending evidence and coalesces company count updates", async () => {
    vi.useFakeTimers();
    const { db, pipeline, source, hub } = setup(null, { externalRequestsEnabled: false });
    const otherCompany: Company = {
      id: "other", name: "Other Incorporated", ticker: "OTHR", sector: "Technology", aliases: ["Other"], color: "#654321",
    };
    db.seedCompanies([otherCompany]);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    hub.add((event, data) => { events.push({ event, data: JSON.parse(data) as Record<string, unknown> }); });
    const sharedSnapshotRead = vi.spyOn(pipeline, "snapshots");
    try {
      const secondReceipt = db.recordDelivery({
        collector: "google_news_rss", companyId: company.id, requestKey: "test:second-receipt",
        startedAt: source.retrievedAt + 1, completedAt: source.retrievedAt + 2,
        result: "success", parsedItemCount: 1, responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
      });
      const otherReceipt = db.recordDelivery({
        collector: "google_news_rss", companyId: otherCompany.id, requestKey: "test:other-receipt",
        startedAt: source.retrievedAt + 3, completedAt: source.retrievedAt + 4,
        result: "success", parsedItemCount: 1, responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
      });
      expect(pipeline.ingest(source)).toBe(true);
      expect(pipeline.ingest({
        ...source, deliveryId: secondReceipt, sourceItemId: "second-acme-product",
        title: "Acme expands the product launch",
      })).toBe(true);
      expect(pipeline.ingest({
        ...source, companyId: otherCompany.id, deliveryId: otherReceipt,
        sourceItemId: "other-company-news", title: "Other reports a product launch",
      })).toBe(true);
      expect(pipeline.ingest(source)).toBe(false);

      const mentionEvents = events.filter((item) => item.event === "mention");
      expect(mentionEvents).toHaveLength(3);
      expect(mentionEvents.map((item) => item.data.status)).toEqual(["pending", "pending", "pending"]);
      const firstPersisted = db.mentionRow(String(mentionEvents[0]?.data.id));
      expect(mentionEvents[0]?.data).toMatchObject({
        id: firstPersisted?.id,
        companyId: company.id,
        title: source.title,
        publishedAt: source.publishedAt,
        aggregatorPublishedAt: source.aggregatorPublishedAt,
        retrievedAt: source.retrievedAt,
        status: "pending",
      });
      expect(events.filter((item) => item.event === "company")).toHaveLength(0);

      vi.spyOn(db, "insertObservation").mockImplementation(() => { throw new Error("simulated rejected insert"); });
      expect(() => pipeline.ingest({ ...source, sourceItemId: "rejected-observation" })).toThrow("simulated rejected insert");
      expect(events.filter((item) => item.event === "mention")).toHaveLength(3);

      await vi.advanceTimersByTimeAsync(50);
      const companyEvents = events.filter((item) => item.event === "company");
      expect(companyEvents).toHaveLength(2);
      expect(companyEvents.map((item) => item.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: company.id, sourceRecords24h: 2 }),
        expect.objectContaining({ id: otherCompany.id, sourceRecords24h: 1 }),
      ]));
      expect(sharedSnapshotRead).toHaveBeenCalledTimes(1);
      expect(db.mentionsForCompany(company.id, 0, 10)).toHaveLength(2);
      expect(db.mentionsForCompany(otherCompany.id, 0, 10)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("cancels a deferred company update on stop while retaining the saved count", async () => {
    vi.useFakeTimers();
    const { db, pipeline, source, hub } = setup(null, { externalRequestsEnabled: false });
    const events: string[] = [];
    hub.add((event) => { events.push(event); });
    try {
      expect(pipeline.ingest(source)).toBe(true);
      pipeline.stop();
      await vi.runAllTimersAsync();
      expect(events).toEqual(["mention"]);
      expect(pipeline.snapshot(company.id).sourceRecords24h).toBe(1);
    } finally { db.close(); }
  });

  it("keeps both Jev and webhook requests paused when external requests are disabled", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const judge = vi.fn(async () => ({ answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 }));
    const { db, pipeline, source } = setup(judge, {
      externalRequestsEnabled: false,
      alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 },
    });
    try {
      expect(pipeline.alertDeliveryConfigured).toBe(true);
      expect(pipeline.alertDeliveryEnabled).toBe(false);
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      await pipeline.dispatchAlerts();
      expect(judge).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("pending");
    } finally { db.close(); vi.unstubAllGlobals(); }
  });

  it("does not call Jev if the durable dispatch-intent write fails", async () => {
    const judge = vi.fn(async () => ({ answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 }));
    const { db, pipeline, source } = setup(judge);
    vi.spyOn(db, "recordJevDispatchIntent").mockImplementation(() => { throw new Error("simulated sqlite write failure"); });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const mention = db.mentionsForCompany(company.id, 0, 10)[0];
      expect(judge).not.toHaveBeenCalled();
      expect(mention?.status).toBe("failed");
      expect(db.jevAttemptHistory(mention!.id)).toMatchObject([{ outcome: "not_sent", errorCategory: "dispatch_intent_not_recorded" }]);
    } finally { db.close(); }
  });

  it("dispatches a persisted qualifying alert with a stable idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), { alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 } });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.headers?.["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("scored");
    } finally { db.close(); vi.unstubAllGlobals(); }
  });

  it("resumes a persisted alert retry after restart at its saved due time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source, health, dbPath } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), { alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 } });
    pipeline.ingest(source);
    await pipeline.waitForIdle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.alertDeliverySummary()[0]).toMatchObject({ state: "retrying", attemptCount: 1 });
    pipeline.stop();
    db.close();

    const restartedDb = new Desk(dbPath);
    const restartedPipeline = new Pipeline({
      db: restartedDb, judge: null, hub: new Hub(), health, engineLabel: "jev-latest", inputPricePerMTok: 0.042,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-09-28", maxRequests: 100, maxRequestBytes: 1_000_000 },
      alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 },
    });
    pipelines.push(restartedPipeline);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(restartedDb.alertDeliverySummary()[0]).toMatchObject({ state: "delivered", attemptCount: 2, lastOutcome: "delivered" });
    } finally { restartedPipeline.stop(); restartedDb.close(); vi.unstubAllGlobals(); }
  });

  it("continues draining other ready alerts after a permanent webhook rejection", async () => {
    let releaseRejectedResponse!: () => void;
    let announceFirstSend!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => { announceFirstSend = resolve; });
    const blockedResponse = new Promise<void>((resolve) => { releaseRejectedResponse = resolve; });
    const fetch = vi.fn()
      .mockImplementationOnce(async () => { announceFirstSend(); await blockedResponse; return new Response(null, { status: 400 }); })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), { concurrency: 2, alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 } });
    try {
      pipeline.ingest(source);
      pipeline.ingest({ ...source, sourceItemId: "second-independent-alert", title: "Acme announces a second product launch" });
      await firstSendStarted;
      await vi.waitFor(() => expect(db.mentionsForCompany(company.id, 0, 10).filter((row) => row.status === "scored")).toHaveLength(2));
      releaseRejectedResponse();
      await pipeline.waitForIdle();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(db.alertDeliverySummary()).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: "failed", lastHttpStatus: 400 }),
        expect.objectContaining({ state: "delivered", lastHttpStatus: 204 }),
      ]));
    } finally { pipeline.stop(); db.close(); vi.unstubAllGlobals(); }
  });

  it("keeps a successful Jev judgment scored when the alert outbox fails", async () => {
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), { alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 } });
    vi.spyOn(pipeline, "dispatchAlerts").mockRejectedValue(new Error("simulated alert storage failure"));
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const saved = db.mentionsForCompany(company.id, 0, 10)[0];
      expect(saved?.status).toBe("scored");
      expect(db.jevAttemptHistory(saved!.id)).toMatchObject([{ outcome: "response" }]);
    } finally { pipeline.stop(); db.close(); }
  });

  it("persists the exact model request once before reserving budget and sending it", async () => {
    const answers = fixtureAnswers();
    let prepared: unknown;
    const { db, pipeline, source } = setup(async (_state, request) => {
      prepared = request;
      return { answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(prepared).toMatchObject({
        requestedModel: "jev-latest",
        rubricSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        body: expect.any(String),
        payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        requestBytes: expect.any(Number),
      });
      const request = prepared as { body: string; requestBytes: number; payloadSha256: string };
      expect(request.requestBytes).toBe(Buffer.byteLength(request.body, "utf8"));
      expect(request.payloadSha256).toBe(createHash("sha256").update(request.body, "utf8").digest("hex"));
      const mention = db.mentionsForCompany(company.id, 0, 10).find((item) => item.status === "scored");
      expect(mention).toBeDefined();
      expect(db.jevAttemptHistory(mention!.id)).toMatchObject([{
        requestSha256: request.payloadSha256,
        requestBytes: request.requestBytes,
        rubricSha256: RUBRIC_SHA,
        requestedModel: "jev-latest",
        outcome: "response",
        httpStatus: 200,
        resolvedModel: "jev-1.13.0",
      }]);
    } finally { db.close(); }
  });

  it("does not dispatch a queued intent after its publisher freshness expires", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({ answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 }), {
      alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 },
    });
    const markScored = db.markScored.bind(db);
    vi.useFakeTimers();
    vi.spyOn(db, "markScored").mockImplementation((id, score, excluded, alert, receipt) => {
      markScored(id, score, excluded, alert, receipt);
      vi.setSystemTime(source.publishedAt! + 15 * 60_000 + 1);
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("scored");
      expect(fetch).not.toHaveBeenCalled();
    } finally { db.close(); vi.unstubAllGlobals(); }
  });

  it("does not treat a fresh RSS feed date as article publication freshness for alerts", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), {
      allowedCollectors: new Set(["google_news_rss"]),
      alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 },
    });
    const retrievedAt = Date.now();
    const feedReceipt = db.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: "test:rss-alert-source",
      startedAt: retrievedAt - 1_000, completedAt: retrievedAt, result: "success", parsedItemCount: 1,
      adapterVersion: "google_news_rss/1",
    });
    try {
      pipeline.ingest({
        ...source, kind: "rss", collector: "google_news_rss", sourceItemId: "rss-feed-clock-alert",
        publishedAt: null, aggregatorPublishedAt: retrievedAt - 5_000, retrievedAt,
        adapterVersion: "google_news_rss/1", deliveryId: feedReceipt,
      });
      await pipeline.waitForIdle();
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("scored");
      expect(fetch).not.toHaveBeenCalled();
    } finally { db.close(); vi.unstubAllGlobals(); }
  });

  it.each([
    ["HTTP rejection", () => Promise.resolve(new Response("private response body", { status: 503 }))],
    ["transport failure", () => Promise.reject(new Error("private transport detail"))],
  ])("records %s and leaves bounded retry work durable", async (_label, send) => {
    const fetch = vi.fn().mockImplementation(send);
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({ answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 }), {
      alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 },
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(fetch).toHaveBeenCalledTimes(1);
      await pipeline.dispatchAlerts();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("scored");
    } finally { db.close(); vi.unstubAllGlobals(); }
  });

  it("does not send a webhook for a judgment excluded from investor research", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.about = { type: "noul", noul: 0.1 };
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), { alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 } });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();

      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("off_target");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      db.close();
      vi.unstubAllGlobals();
    }
  });

  it("does not send a webhook for a source timestamp in the future", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const answers = fixtureAnswers();
    answers.material = { type: "noul", noul: 1 };
    answers.magnitude = { type: "noul", noul: 1 };
    answers.surprise = { type: "noul", noul: 1 };
    const { db, pipeline, source } = setup(async () => ({
      answers, model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }), { alert: { webhookUrl: "https://alerts.invalid/hook", eventScore: 65, impact: 55, freshMinutes: 15 } });
    source.publishedAt = Date.now() + 60_000;
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();

      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("scored");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      db.close();
      vi.unstubAllGlobals();
    }
  });

  it("keeps history freshness when the selected chart window has no score arrivals", async () => {
    const scoreAt = Date.parse("2026-09-28T10:00:00.000Z");
    const now = Date.parse("2026-09-30T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(scoreAt);
    const { db, pipeline, source } = setup(async () => ({
      answers: fixtureAnswers(), model: "jev-latest", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }));
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      vi.setSystemTime(now);

      const activity = pipeline.snapshot(company.id);
      const series = pipeline.series(company.id, 24);
      expect(activity.sourceRecords24h).toBe(0);
      expect(activity.latestSourceCollectedAt).toBe(scoreAt);
      expect(series.latestScoreAvailableAt).toBe(scoreAt);
      expect(series.metric).toBe("weighted_mean_impact");
      expect(series.loadedRecordCount).toBe(0);
      expect(series.populatedBucketCount).toBe(0);
      expect(series.points.some((point) => point.n > 0)).toBe(false);
      expect(series.points.some((point) => point.v != null)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("passes publisher identity separately from a Google News collection redirect", async () => {
    const judgedStates: JevState[] = [];
    const { db, pipeline, source } = setup(async (state) => {
      judgedStates.push(state);
      return { answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
    });
    source.sourceUrl = "https://news.google.com/rss/articles/example";
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();

      expect(judgedStates.at(-1)?.mention.source).toEqual({
        collector: "google_news_rss",
        collectionUrl: "https://news.google.com/rss/articles/example",
        tier: "wire",
        publisherName: "Reuters",
        publisherDomain: "reuters.com",
      });
    } finally {
      db.close();
    }
  });

  it("requires a matching persisted source receipt before queuing a live observation", async () => {
    const { db, pipeline, source } = setup(null);
    try {
      const { deliveryId: _deliveryId, ...unlinked } = source;
      expect(() => pipeline.ingest(unlinked)).toThrow(/delivery receipt is required/i);
      expect(pipeline.ingest(source)).toBe(true);
      const stored = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(stored.source.deliveryId).toBe(source.deliveryId);
    } finally {
      db.close();
    }
  });

  it("reports the source-record window used by the company gauge, including its 24-hour fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
    const { db, pipeline, source } = setup(async () => ({
      answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }));
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(pipeline.snapshot(company.id)).toMatchObject({
        indexWindow: "3h",
        indexRecordCount: 1,
      });

      vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
      expect(pipeline.snapshot(company.id)).toMatchObject({
        indexWindow: "24h",
        indexRecordCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it("keeps real observations pending without treating disabled Jev as a failure", async () => {
    const { db, pipeline, source, health } = setup(null);
    try {
      expect(pipeline.ingest(source)).toBe(true);
      await pipeline.waitForIdle();

      const pending = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(pending.status).toBe("pending");
      expect(pending.score).toBeNull();
      expect(pending.error).toBeNull();
      expect(pipeline.drainPending(10)).toBe(0);
      expect(health.snapshot().jev).toMatchObject({ enabled: false, ok: 0, fail: 0, lastError: null });
    } finally {
      db.close();
    }
  });

  it("keeps observations pending when their collector is outside the explicit Jev allowlist", async () => {
    let calls = 0;
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      return { answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
    }, { allowedCollectors: new Set(["sec_edgar"]) });
    try {
      pipeline.ingest(source);
      expect(pipeline.drainPending(10)).toBe(0);
      await pipeline.waitForIdle();
      expect(calls).toBe(0);
      expect(db.getKv("jev:budget:2026-09-28:requests")).toBeUndefined();
      expect(db.mentionsForCompany(company.id, 0, 10)[0]).toMatchObject({
        status: "pending",
        score: null,
        error: null,
      });
    } finally {
      db.close();
    }
  });

  it("does not drain retained publishers outside the active source allowlist", async () => {
    let calls = 0;
    const jevAllowlist = new Set<CollectorId>(["google_news_rss", "sec_edgar"]);
    const externalAllowlist = new Set<CollectorId>(["sec_edgar"]);
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      return { answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
    }, { allowedCollectors: intersectJevSourceAllowlist(jevAllowlist, externalAllowlist, new Set(["sec_edgar"])) });
    try {
      pipeline.ingest(source);
      expect(pipeline.drainPending(10)).toBe(0);
      await pipeline.waitForIdle();
      expect(calls).toBe(0);
      expect(db.mentionsForCompany(company.id, 0, 10)[0]).toMatchObject({
        status: "pending",
        score: null,
        error: null,
      });
    } finally {
      db.close();
    }
  });

  it("does not attempt to retry an ID hidden by the real-source view", async () => {
    const { db, pipeline } = setup(async () => ({
      answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10,
    }));
    const requeue = vi.spyOn(db, "requeueFailed");
    try {
      expect(pipeline.retryFailed("hidden-legacy-row", true)).toBe("not_retryable");
      expect(requeue).not.toHaveBeenCalled();
      expect(db.getKv("jev:budget:2026-09-28:requests")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("leaves an admitted observation pending when the finite request budget is exhausted", async () => {
    let calls = 0;
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      return { answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
    }, {
      dailyBudget: { utcDay: () => "2026-09-28", maxRequests: 0, maxRequestBytes: 0 },
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(calls).toBe(0);
      expect(db.getKv("jev:budget:2026-09-28:requests")).toBeUndefined();
      expect(db.mentionsForCompany(company.id, 0, 10)[0]).toMatchObject({
        status: "pending",
        score: null,
        error: null,
      });
    } finally {
      db.close();
    }
  });

  it.each([429, 529])("persists bounded retries after explicit HTTP %s rejection and succeeds on the next attempt", async (status) => {
    vi.useFakeTimers();
    let calls = 0;
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new JevError("overloaded", status, true);
      return { answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      expect(calls).toBe(1);

      const persisted = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(persisted.status).toBe("retrying");
      expect(persisted.scoreRetryAt).toBeGreaterThan(Date.now());
      expect(persisted.error).toContain("retry 2 of 3");
      expect(pipeline.drainPending(10)).toBe(0);

      vi.setSystemTime(persisted.scoreRetryAt! + 1);
      expect(pipeline.drainPending(10)).toBe(1);
      await pipeline.waitForIdle();
      const scored = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(calls).toBe(2);
      expect(scored.status).toBe("scored");
      expect(scored.score).toMatchObject({ sentiment: "positive", eventType: "product", inputTokens: 100 });
      expect(scored.scoreRetryAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("never schedules an explicit Jev retry earlier than a valid Retry-After delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const { db, pipeline, source } = setup(async () => {
      throw new JevError("rate limited", 429, true, false, 120_000);
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const persisted = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(persisted.scoreRetryAt).toBe(Date.now() + 120_000);
      expect(persisted.status).toBe("retrying");
    } finally {
      db.close();
    }
  });

  it("stops after three 429 attempts and never retries an ambiguous provider outcome", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      throw new JevError("rate limited", 429, true);
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      for (let attempt = 1; attempt < 3; attempt += 1) {
        const retryAt = db.mentionsForCompany(company.id, 0, 10)[0]!.scoreRetryAt!;
        vi.setSystemTime(retryAt + 1);
        pipeline.drainPending(10);
        await pipeline.waitForIdle();
      }
      const failed = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(calls).toBe(3);
      expect(failed.status).toBe("failed");
      expect(failed.scoreRetryAt).toBeNull();
      expect(failed.error).toBe("TypeSafe request failed (HTTP 429)");
      expect(failed.error).not.toContain("rate limited");
    } finally {
      db.close();
    }

    let ambiguousCalls = 0;
    const ambiguous = setup(async () => {
      ambiguousCalls += 1;
      throw new JevError("socket timeout", undefined, false, true);
    });
    try {
      ambiguous.pipeline.ingest(ambiguous.source);
      await ambiguous.pipeline.waitForIdle();
      const result = ambiguous.db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(ambiguousCalls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("TypeSafe request outcome is unknown");
      expect(result.error).not.toContain("socket timeout");
      expect(ambiguous.pipeline.drainPending(10)).toBe(0);
    } finally {
      ambiguous.db.close();
    }
  });

  it("rejects a second claim while the first attempt is in progress", () => {
    const { db, source } = setup(async () => ({
      answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 1, outputTokens: 1, latencyMs: 1,
    }));
    try {
      const { observationId } = db.insertObservation(source);
      expect(db.claimForScoring(observationId, Date.now())?.status).toBe("scoring");
      expect(db.claimForScoring(observationId, Date.now())).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("persists the resolved Jev model ID with the new observation's judgment", async () => {
    let calls = 0;
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      return { answers: fixtureAnswers(), model: "jev-1.13.0", inputTokens: 700, outputTokens: 20, latencyMs: 84 };
    });
    try {
      expect(pipeline.ingest(source)).toBe(true);
      await pipeline.waitForIdle();

      const scored = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(calls).toBe(1);
      expect(scored.status).toBe("scored");
      expect(scored.score).toMatchObject({ engine: "jev-1.13.0", sentiment: "positive", eventType: "product" });
      expect(scored.score?.estimatedInputCostUsd).toBeCloseTo(0.0000294, 10);
      expect(pipeline.drainPending(10)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("ChatGPT-plan classifier preflight recovery", () => {
  it("does not send text-only acronym matches to Luna when issuer identity is unresolved", async () => {
    const fixture = setup(null, { externalRequestsEnabled: false });
    fixture.pipeline.stop();
    const amd: Company = {
      id: "amd", name: "AMD", ticker: "AMD", sector: "Semiconductors",
      aliases: ["AMD", "Advanced Micro Devices", "Lisa Su", "Ryzen", "Instinct"], color: "#fb923c", ambiguous: true,
    };
    fixture.db.seedCompanies([amd]);
    const classifier = vi.fn(async () => { throw new Error("weak issuer match must not reach Luna"); });
    const pipeline = new Pipeline({
      db: fixture.db, judge: null, classifier, accountingRoute: "chatgpt_plan", provider: "openai_luna",
      hub: fixture.hub, health: fixture.health, engineLabel: "gpt-6-luna", inputPricePerMTok: 0,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-09", maxRequests: 1, maxRequestBytes: 260_000 },
    });
    pipelines.push(pipeline);
    const now = Date.now();
    const deliveryId = fixture.db.recordDelivery({
      collector: "google_news_rss", companyId: amd.id, requestKey: "test:amd-medical-acronym",
      startedAt: now - 2_000, completedAt: now - 1_000, result: "success", parsedItemCount: 1,
      responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
    });
    try {
      pipeline.ingest({
        ...fixture.source, companyId: amd.id, deliveryId, sourceItemId: "amd-medical-acronym",
        title: "How Investors Are Reacting To Bausch + Lomb (BLCO) FDA Backs Dry AMD Study",
        snippet: "FDA backs a dry age-related macular degeneration study.",
      });
      await pipeline.waitForIdle();
      const mention = fixture.db.mentionsForCompany(amd.id, 0, 10)[0]!;
      expect(classifier).not.toHaveBeenCalled();
      expect(mention).toMatchObject({ status: "pending", issuerIdentityStrong: false });
      expect(fixture.db.getKv("chatgpt-plan:budget:2026-10-09:requests")).toBeUndefined();
      expect(fixture.db.categoricalTrendSnapshot(amd.id, 24, Date.now()).candidateClassificationCount).toBe(0);
      expect(fixture.db.mentionsForCompanyPage({ companyId: amd.id, sinceMs: 0, limit: 10, cursor: null, filter: "identity_review" })
        .items.map((item) => item.id)).toContain(mention.id);
    } finally {
      pipeline.stop();
      fixture.db.close();
    }
  });

  it("skips weak newest acronym matches when draining a capped Luna queue", async () => {
    const fixture = setup(null, { externalRequestsEnabled: false });
    fixture.pipeline.stop();
    const amd: Company = {
      id: "amd", name: "AMD", ticker: "AMD", sector: "Semiconductors",
      aliases: ["AMD", "Advanced Micro Devices", "Lisa Su", "Ryzen", "Instinct"], color: "#fb923c", ambiguous: true,
    };
    fixture.db.seedCompanies([amd]);
    const now = Date.now();
    const strongTitle = "AMD warns of weaker demand";
    const weakTitle = "Bausch + Lomb stock rises on dry AMD trial";
    const insert = (sourceItemId: string, title: string, snippet: string, retrievedAt: number) => {
      const deliveryId = fixture.db.recordDelivery({
        collector: "google_news_rss", companyId: amd.id, requestKey: `test:${sourceItemId}`,
        startedAt: retrievedAt - 2_000, completedAt: retrievedAt - 1_000, result: "success", parsedItemCount: 1,
        responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
      });
      return fixture.db.insertObservation({
        ...fixture.source, companyId: amd.id, deliveryId, sourceItemId,
        sourceUrl: `https://news.example/${sourceItemId}`, title, snippet, retrievedAt, scoped: false,
      }).observationId;
    };
    const strongId = insert("older-company-signal", strongTitle, "AMD reports weaker demand from customers.", now - 60_000);
    const weakId = insert("newer-medical-acronym", weakTitle, "A dry age-related macular degeneration trial drew attention.", now);
    const receivedTitles: string[] = [];
    const classifier = vi.fn(async (prepared) => {
      const request = JSON.parse(prepared.body) as { input: Array<{ role: string; content: string }> };
      const userInput = request.input.find((entry) => entry.role === "user");
      if (userInput) receivedTitles.push((JSON.parse(userInput.content) as { source: { title: string } }).source.title);
      throw new OpenAIClassifierError("model catalog unavailable", null, false, false, null, null, null, null, null, null, null, false);
    });
    const pipeline = new Pipeline({
      db: fixture.db, judge: null, classifier, accountingRoute: "chatgpt_plan", provider: "openai_luna",
      hub: fixture.hub, health: fixture.health, engineLabel: "gpt-6-luna", inputPricePerMTok: 0,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-09", maxRequests: 1, maxRequestBytes: 260_000 },
    });
    pipelines.push(pipeline);
    try {
      expect(pipeline.drainPending(10)).toBe(1);
      await pipeline.waitForIdle();
      const rows = fixture.db.mentionsForCompany(amd.id, 0, 10);
      expect(receivedTitles, JSON.stringify({ rows: rows.map(({ id, status, error }) => ({ id, status, error })), events: fixture.db.recentEvents(10) }))
        .toEqual([strongTitle]);
      expect(rows.find((row) => row.id === strongId)?.status).toBe("retrying");
      expect(rows.find((row) => row.id === weakId)).toMatchObject({ status: "pending", issuerIdentityStrong: false });
      expect(fixture.db.mentionsForCompanyPage({ companyId: amd.id, sinceMs: 0, limit: 10, cursor: null, filter: "identity_review" })
        .items.map((item) => item.id)).toContain(weakId);
    } finally {
      pipeline.stop();
      fixture.db.close();
    }
  });

  it("skips old consumer deals when a capped Luna queue selects business evidence", async () => {
    const fixture = setup(null, { externalRequestsEnabled: false });
    fixture.pipeline.stop();
    const apple: Company = {
      id: "apple", name: "Apple Inc.", ticker: "AAPL", sector: "Technology",
      aliases: ["Apple", "Apple Inc."], color: "#a3a3a3",
    };
    fixture.db.seedCompanies([apple]);
    const now = Date.now();
    const insert = (sourceItemId: string, title: string, snippet: string, retrievedAt: number, tier: "blog" | "trade" | "wire") => {
      const deliveryId = fixture.db.recordDelivery({
        collector: "google_news_rss", companyId: apple.id, requestKey: `test:${sourceItemId}`,
        startedAt: retrievedAt - 2_000, completedAt: retrievedAt - 1_000, result: "success", parsedItemCount: 1,
        responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
      });
      return fixture.db.insertObservation({
        ...fixture.source, companyId: apple.id, deliveryId, sourceItemId,
        sourceName: tier === "blog" ? "9to5Toys" : tier === "trade" ? "Yahoo Finance" : "Reuters",
        publisherName: tier === "blog" ? "9to5Toys" : tier === "trade" ? "Yahoo Finance" : "Reuters",
        publisherDomain: tier === "blog" ? "9to5toys.com" : tier === "trade" ? "finance.yahoo.com" : "reuters.com",
        sourceUrl: `https://news.example/${sourceItemId}`, tier, title, snippet, retrievedAt, scoped: false,
      }).observationId;
    };
    const dealId = insert(
      "apple-shopping-deal",
      "This weekend's best Apple deals: AirPods, Mac mini, MacBook Air and Mac Studio $200 off, Series 12, more",
      "The latest discounts on Apple products.",
      now,
      "blog",
    );
    const optionId = insert(
      "aapl-option-contract",
      "AAPL Oct 2026 345.000 call (AAPL261009C00345000) Stock Price, News, Quote & History",
      "",
      now - 10_000,
      "trade",
    );
    const businessTitle = "Apple warns of weaker iPhone demand";
    const businessId = insert(
      "apple-demand-update",
      businessTitle,
      "Apple reports weaker demand for iPhone devices.",
      now - 60_000,
      "wire",
    );
    const receivedTitles: string[] = [];
    const classifier = vi.fn(async (prepared) => {
      const request = JSON.parse(prepared.body) as { input: Array<{ role: string; content: string }> };
      const userInput = request.input.find((entry) => entry.role === "user");
      if (userInput) receivedTitles.push((JSON.parse(userInput.content) as { source: { title: string } }).source.title);
      throw new OpenAIClassifierError("model catalog unavailable", null, false, false, null, null, null, null, null, null, null, false);
    });
    const pipeline = new Pipeline({
      db: fixture.db, judge: null, classifier, accountingRoute: "chatgpt_plan", provider: "openai_luna",
      hub: fixture.hub, health: fixture.health, engineLabel: "gpt-6-luna", inputPricePerMTok: 0,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-09", maxRequests: 1, maxRequestBytes: 260_000 },
    });
    pipelines.push(pipeline);
    try {
      expect(pipeline.drainPending(10)).toBe(1);
      await pipeline.waitForIdle();
      expect(receivedTitles).toEqual([businessTitle]);
      expect(fixture.db.mentionRow(dealId)?.status).toBe("pending");
      expect(fixture.db.mentionRow(optionId)?.status).toBe("pending");
      expect(fixture.db.mentionRow(businessId)?.status).toBe("retrying");
    } finally {
      pipeline.stop();
      fixture.db.close();
    }
  });

  it("keeps a known-unsent source retryable, releases its reservation, then persists one successful classification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const fixture = setup(null, { externalRequestsEnabled: false });
    fixture.pipeline.stop();
    let calls = 0;
    const classification = {
      sentiment: "positive" as const, eventType: "product" as const, takeaway: "product_win" as const,
      about: true, material: true, investorRelevant: true, evidenceSufficient: true,
      summary: "Acme announces a new product.", supportingExcerpt: "Acme announces a product launch",
    };
    const result = {
      classification, modelReturned: "gpt-6-luna", serviceTier: null, accountingRoute: "chatgpt_plan" as const,
      responseId: "resp-once", responseSha256: "b".repeat(64),
      usage: { inputTokens: 20, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: 10,
        reasoningTokens: null, totalTokens: 30, estimatedCostUsd: null }, latencyMs: 20, httpStatus: 200,
    } as OpenAIClassifierResult;
    const classifier = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new OpenAIClassifierError("GPT-6 Luna model catalog is unavailable", null, false, false, null, null, null, null, null, null, null, false);
      return result;
    });
    const pipeline = new Pipeline({
      db: fixture.db, judge: null, classifier, accountingRoute: "chatgpt_plan", provider: "openai_luna",
      hub: fixture.hub, health: fixture.health, engineLabel: "gpt-6-luna", inputPricePerMTok: 0,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-08", maxRequests: 1, maxRequestBytes: 260_000 },
    });
    pipelines.push(pipeline);
    try {
      pipeline.ingest(fixture.source);
      await pipeline.waitForIdle();
      let persisted = fixture.db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(calls).toBe(1);
      expect(persisted.status).toBe("retrying");
      expect(persisted.scoreRetryAt).toBeGreaterThan(Date.now());
      expect(persisted.error).toContain("no request was sent");
      expect(fixture.db.getKv("chatgpt-plan:budget:2026-10-08:requests")).toBe("0");
      expect(fixture.db.getKv("chatgpt-plan:budget:2026-10-08:request-bytes")).toBe("0");
      expect(fixture.db.categoricalTrendSnapshot(company.id, 24, Date.now()).counts.total).toBe(0);

      vi.setSystemTime(persisted.scoreRetryAt! + 1);
      expect(pipeline.drainPending(10)).toBe(1);
      await pipeline.waitForIdle();
      persisted = fixture.db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(calls).toBe(2);
      expect(persisted.status, `${persisted.error}; ${JSON.stringify(fixture.db.recentEvents(5))}`).toBe("classified");
      expect(Number((fixture.db.testDb.prepare("SELECT COUNT(*) AS count FROM categorical_classifications").get() as { count: number }).count)).toBe(1);
      expect(persisted.classification).toMatchObject({ responseId: "resp-once", sentiment: "positive" });
      expect(fixture.db.planUsageSince(new Date("2026-10-08T00:00:00.000Z").getTime())).toMatchObject({ requests: 1 });
    } finally {
      pipeline.stop();
      fixture.db.close();
    }
  });

  it("keeps an unknown dispatched result failed and blocks automatic duplicate dispatch", async () => {
    const fixture = setup(null, { externalRequestsEnabled: false });
    fixture.pipeline.stop();
    const classifier = vi.fn(async () => {
      throw new OpenAIClassifierError("connection lost after dispatch", null, false, true);
    });
    const pipeline = new Pipeline({
      db: fixture.db, judge: null, classifier, accountingRoute: "chatgpt_plan", provider: "openai_luna",
      hub: fixture.hub, health: fixture.health, engineLabel: "gpt-6-luna", inputPricePerMTok: 0,
      concurrency: 1, allowedCollectors: new Set(["google_news_rss"]), externalRequestsEnabled: true,
      dailyBudget: { utcDay: () => "2026-10-09", maxRequests: 1, maxRequestBytes: 260_000 },
    });
    pipelines.push(pipeline);
    try {
      pipeline.ingest(fixture.source);
      await pipeline.waitForIdle();
      const persisted = fixture.db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(classifier).toHaveBeenCalledTimes(1);
      expect(persisted.status).toBe("failed");
      expect(persisted.error).toContain("outcome is unknown");
      expect(pipeline.drainPending(10)).toBe(0);
    } finally {
      pipeline.stop();
      fixture.db.close();
    }
  });
});
