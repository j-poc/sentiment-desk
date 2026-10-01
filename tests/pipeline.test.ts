import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Desk } from "../server/db.js";
import { intersectJevSourceAllowlist } from "../server/collector-policy.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevError } from "../server/jev.js";
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
  const pipeline = new Pipeline({
    db, judge: judge ? async (state, prepared) => ({ ...(await judge(state, prepared)), httpStatus: 200 }) : null, hub: new Hub(), health,
    engineLabel: "jev-latest", inputPricePerMTok: 0.042, concurrency: options.concurrency ?? 1,
    allowedCollectors: options.allowedCollectors ?? new Set(["google_news_rss"]),
    externalRequestsEnabled: options.externalRequestsEnabled,
    dailyBudget: options.dailyBudget ?? {
      utcDay: () => "2026-09-28", maxRequests: 100, maxRequestBytes: 1_000_000,
    },
    alert: options.alert,
  });
  pipelines.push(pipeline);
  const source: RawMention = {
    companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/acme",
    tier: "wire", title: "Acme announces a product launch", snippet: "A new product is available.",
    publishedAt: Date.now() - 5_000, retrievedAt: Date.now(), collector: "google_news_rss",
    sourceItemId: "reuters-acme-product", publisherName: "Reuters", publisherDomain: "reuters.com",
    adapterVersion: "google_news_rss/1",
  };
  source.deliveryId = db.recordDelivery({
    collector: "google_news_rss", companyId: company.id, requestKey: "test:source-receipt",
    startedAt: source.retrievedAt - 1_000, completedAt: source.retrievedAt + 1_000,
    result: "success", parsedItemCount: 1, responseDigest: "fixture-only", adapterVersion: "google_news_rss/1",
  });
  return { db, pipeline, source, health, dbPath: join(directory, "desk.db") };
}

describe("Jev pipeline recovery", () => {
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
      expect(series.points.some((point) => point.n > 0)).toBe(false);
      expect(series.points.some((point) => point.v != null)).toBe(true);
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
