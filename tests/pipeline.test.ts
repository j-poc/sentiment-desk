import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk } from "../server/db.js";
import { intersectJevSourceAllowlist } from "../server/collector-policy.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevError } from "../server/jev.js";
import { Pipeline } from "../server/pipeline.js";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";
import type { CollectorId, Company, JevState, RawMention } from "../server/types.js";

const directories: string[] = [];
const company: Company = {
  id: "acme", name: "Acme Incorporated", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};

afterEach(() => {
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
  judge: ((state: JevState) => Promise<{ answers: Record<string, unknown>; model: string; inputTokens: number; outputTokens: number; latencyMs: number }>) | null,
  options: {
    allowedCollectors?: ReadonlySet<CollectorId>;
    dailyBudget?: { utcDay: () => string; maxRequests: number; maxRequestBytes: number };
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-pipeline-"));
  directories.push(directory);
  const db = new Desk(join(directory, "desk.db"));
  db.seedCompanies([company]);
  const health = new HealthTracker(true, judge !== null, "jev-latest");
  const pipeline = new Pipeline({
    db, judge, hub: new Hub(), health,
    engineLabel: "jev-latest", inputPricePerMTok: 0.042, concurrency: 1,
    allowedCollectors: options.allowedCollectors ?? new Set(["google_news_rss"]),
    dailyBudget: options.dailyBudget ?? {
      utcDay: () => "2026-09-28", maxRequests: 100, maxRequestBytes: 1_000_000,
    },
  });
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
  return { db, pipeline, source, health };
}

describe("Jev pipeline recovery", () => {
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
      expect(failed.error).toContain("rate limited");
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
      expect(result.error).toContain("outcome is unknown");
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
