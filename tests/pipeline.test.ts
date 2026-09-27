import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevError } from "../server/jev.js";
import { Pipeline } from "../server/pipeline.js";
import { demoJudge } from "../server/demo.js";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";
import { parseJudgment } from "../server/scoring.js";
import type { Company, JevState, RawMention } from "../server/types.js";

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

function setup(judge: (state: JevState) => Promise<{ answers: Record<string, unknown>; model: string; inputTokens: number; outputTokens: number; latencyMs: number }>) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-pipeline-"));
  directories.push(directory);
  const db = new Desk(join(directory, "desk.db"));
  db.seedCompanies([company]);
  const pipeline = new Pipeline({
    db, judge, hub: new Hub(), health: new HealthTracker(true, false, "jev-latest"),
    engineLabel: "jev-latest", inputPricePerMTok: 0.042, concurrency: 1,
  });
  const source: RawMention = {
    companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/acme",
    tier: "wire", title: "Acme announces a product launch", snippet: "A new product is available.",
    publishedAt: Date.now() - 5_000, retrievedAt: Date.now(), collector: "google_news_rss",
    sourceItemId: "reuters-acme-product", publisherName: "Reuters", publisherDomain: "reuters.com",
  };
  return { db, pipeline, source };
}

describe("Jev pipeline recovery", () => {
  it("keeps the synthetic demo generator valid under the same strict rubric parser", async () => {
    const result = await demoJudge({
      company: { id: company.id, name: company.name, ticker: company.ticker, sector: company.sector },
      mention: {
        title: "Acme announces a product launch",
        snippet: "A new product is available.",
        source: { name: "Reuters", url: "https://reuters.com/acme", tier: "wire" },
        publishedAt: new Date().toISOString(),
      },
    });
    expect(parseJudgment(result.answers).eventType).toBe("product");
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("persists bounded retries after explicit 429 rejection and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { db, pipeline, source } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new JevError("rate limited", 429, true);
      return { answers: fixtureAnswers(), model: "jev-latest", inputTokens: 100, outputTokens: 20, latencyMs: 10 };
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
      answers: fixtureAnswers(), model: "jev-latest", inputTokens: 1, outputTokens: 1, latencyMs: 1,
    }));
    try {
      const { observationId } = db.insertObservation(source);
      expect(db.claimForScoring(observationId, Date.now())?.status).toBe("scoring");
      expect(db.claimForScoring(observationId, Date.now())).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
