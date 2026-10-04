import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { Company } from "../server/types.js";

const directories: string[] = [];
const company: Company = { id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Jev request history API", () => {
  it("returns bounded safe attempt metadata for identified observations only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-jev-history-api-"));
    directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new Desk(dbPath);
    db.seedCompanies([company]);
    const observationId = db.insertObservation({
      companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/acme",
      tier: "wire", title: "Acme expands production", snippet: "Saved source text is not part of request history.",
      publishedAt: Date.now(), retrievedAt: Date.now(), collector: "google_news_rss", sourceItemId: "jev-history-api",
    }).observationId;
    const claim = db.claimForScoringWithBudget({
      id: observationId, now: Date.now(), allowedCollectors: ["google_news_rss"], utcDay: "2026-09-28",
      requestBytes: 160, requestSha256: "a".repeat(64), requestedModel: "jev-latest", rubricSha256: "b".repeat(64),
      maxRequests: 5, maxRequestBytes: 10_000,
    });
    if (claim.kind !== "claimed") throw new Error("expected a persisted Jev attempt");
    db.recordJevDispatchIntent(claim.attemptId, Date.now());
    db.recordJevAttemptReceipt({
      attemptId: claim.attemptId, outcome: "response", occurredAt: Date.now(), httpStatus: 200,
      inputTokens: 10, outputTokens: 4, resolvedModel: "jev-1.13.0", latencyMs: 250, errorCategory: null,
    });
    const app = createApp({
      db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
      health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
    });
    try {
      const response = await app.request(`/api/mentions/${observationId}/jev-attempts`);
      expect(response.status).toBe(200);
      const body = JSON.stringify(await response.json());
      expect(body).toContain("a".repeat(64));
      expect(body).toContain("jev-1.13.0");
      expect(body).not.toContain("Saved source text");
      expect(body).not.toContain("payload");
      expect((await app.request("/api/mentions/not-a-real-id/jev-attempts")).status).toBe(404);
    } finally {
      db.close();
    }
  });
});
