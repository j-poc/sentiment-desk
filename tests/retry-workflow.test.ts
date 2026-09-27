import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevError } from "../server/jev.js";
import { MarketData } from "../server/market.js";
import { Pipeline } from "../server/pipeline.js";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";
import type { Company, JevState, RawMention } from "../server/types.js";

const directories: string[] = [];
const company: Company = {
  id: "retry-fixture",
  name: "Retry Fixture Labs",
  ticker: "RFL",
  sector: "Synthetic",
  aliases: [],
  color: "#34d399",
};

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function answers(): Record<string, unknown> {
  const choice = (values: readonly string[], selected: string) => ({
    type: "choice",
    choice: selected,
    confidence: 0.9,
    probabilities: Object.fromEntries(values.map((value) => [value, value === selected ? 0.9 : 0.1 / (values.length - 1)])),
  });
  return {
    sentiment: choice(["negative", "neutral", "positive"], "positive"),
    about: { type: "noul", noul: 0.95 },
    investor_relevant: { type: "noul", noul: 0.9 },
    material: { type: "noul", noul: 0.8 },
    novel: { type: "noul", noul: 0.8 },
    credible: { type: "noul", noul: 0.8 },
    event_type: choice(EVENT_TYPES, "product"),
    magnitude: { type: "noul", noul: 0.7 },
    surprise: { type: "noul", noul: 0.6 },
    takeaway: choice(TAKEAWAY_KEYS, "product_win"),
  };
}

function setup(judge: (state: JevState) => Promise<{
  answers: Record<string, unknown>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}>) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-retry-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new Desk(dbPath);
  db.seedCompanies([company]);
  const hub = new Hub();
  const health = new HealthTracker(false, true, "jev-latest");
  const pipeline = new Pipeline({
    db,
    judge,
    hub,
    health,
    engineLabel: "jev-latest",
    inputPricePerMTok: 0.042,
    concurrency: 1,
  });
  const market = new MarketData({ companies: [company], indices: [], hub, health, db });
  const app = createApp({
    db,
    dbPath,
    pipeline,
    market,
    hub,
    health,
    demo: false,
    version: "retry-test",
    deliverySources: [],
  });
  const source: RawMention = {
    companyId: company.id,
    kind: "rss",
    sourceName: "Synthetic fixture",
    sourceUrl: "https://example.invalid/retry-fixture",
    tier: "major",
    title: "Synthetic fixture reports a product improvement",
    snippet: "Fictional test data; not market news.",
    publishedAt: Date.now(),
    retrievedAt: Date.now(),
    collector: "google_news_rss",
    sourceItemId: "retry-fixture-item",
    publisherName: "Synthetic fixture",
    publisherDomain: "example.invalid",
  };
  const postRetry = (id: string, body: unknown) => app.fetch(new Request(
    `http://127.0.0.1/api/mentions/${id}/retry`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ));
  return { db, pipeline, app, source, postRetry };
}

describe("operator Jev retry API", () => {
  it("requires a charge acknowledgement and usage review before retrying an unknown outcome", async () => {
    let calls = 0;
    const { db, pipeline, source, postRetry } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new JevError("HTTP 503; provider outcome is unknown", 503, false, true);
      return { answers: answers(), model: "jev-1.13.0", inputTokens: 200, outputTokens: 40, latencyMs: 20 };
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const failed = db.mentionsForCompany(company.id, 0, 5)[0]!;

      const noChargeAck = await postRetry(failed.id, { reviewedProviderUsage: true });
      expect(noChargeAck.status).toBe(400);
      const noUsageReview = await postRetry(failed.id, { confirmNewCharge: true, reviewedProviderUsage: false });
      expect(noUsageReview.status).toBe(409);
      expect(calls).toBe(1);
      expect(db.mentionsForCompany(company.id, 0, 5)[0]?.status).toBe("failed");

      const accepted = await postRetry(failed.id, { confirmNewCharge: true, reviewedProviderUsage: true });
      expect(accepted.status).toBe(202);
      await pipeline.waitForIdle();
      const recovered = db.mentionsForCompany(company.id, 0, 5)[0]!;
      expect(calls).toBe(2);
      expect(recovered.status).toBe("scored");
      expect(recovered.score).toMatchObject({ sentiment: "positive", eventType: "product", engine: "jev-1.13.0" });
      expect(recovered.error).toBeNull();
    } finally {
      db.close();
    }
  });

  it("atomically accepts at most one retry when two operator submissions race", async () => {
    let calls = 0;
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const { db, pipeline, source, postRetry } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new JevError("HTTP 503; provider outcome is unknown", 503, false, true);
      await retryGate;
      return { answers: answers(), model: "jev-1.13.0", inputTokens: 200, outputTokens: 40, latencyMs: 20 };
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const failed = db.mentionsForCompany(company.id, 0, 5)[0]!;
      const body = { confirmNewCharge: true, reviewedProviderUsage: true };
      const responses = await Promise.all([postRetry(failed.id, body), postRetry(failed.id, body)]);

      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      expect(calls).toBe(2);
      releaseRetry?.();
      await pipeline.waitForIdle();
      expect(db.mentionsForCompany(company.id, 0, 5)[0]?.status).toBe("scored");
    } finally {
      releaseRetry?.();
      db.close();
    }
  });

  it("rejects retry requests after the item has already recovered", async () => {
    const { db, pipeline, source, postRetry } = setup(async () => ({
      answers: answers(), model: "jev-1.13.0", inputTokens: 200, outputTokens: 40, latencyMs: 20,
    }));
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const scored = db.mentionsForCompany(company.id, 0, 5)[0]!;
      const response = await postRetry(scored.id, { confirmNewCharge: true, reviewedProviderUsage: true });
      expect(response.status).toBe(409);
      expect(db.mentionsForCompany(company.id, 0, 5)[0]?.status).toBe("scored");
    } finally {
      db.close();
    }
  });

  it("requires usage review after a submitted request is rejected", async () => {
    let calls = 0;
    const { db, pipeline, source, postRetry } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new JevError("HTTP 401; request was rejected", 401, false, false);
      return { answers: answers(), model: "jev-1.13.0", inputTokens: 200, outputTokens: 40, latencyMs: 20 };
    });
    try {
      pipeline.ingest(source);
      await pipeline.waitForIdle();
      const failed = db.mentionsForCompany(company.id, 0, 5)[0]!;
      expect(failed.status).toBe("failed");
      expect(failed.usageCheckRequired).toBe(true);

      const noUsageReview = await postRetry(failed.id, { confirmNewCharge: true, reviewedProviderUsage: false });
      expect(noUsageReview.status).toBe(409);
      expect(calls).toBe(1);

      const accepted = await postRetry(failed.id, { confirmNewCharge: true, reviewedProviderUsage: true });
      expect(accepted.status).toBe(202);
      await pipeline.waitForIdle();
      expect(calls).toBe(2);
      expect(db.mentionsForCompany(company.id, 0, 5)[0]?.status).toBe("scored");
    } finally {
      db.close();
    }
  });
});
