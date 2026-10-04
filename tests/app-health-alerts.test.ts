import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { type AlertIntent } from "../server/db.js";
import { TEST_STORAGE_LIMITS, TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { Company, MentionScore } from "../server/types.js";

const directories: string[] = [];
const company: Company = { id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" };
const judged: MentionScore = {
  sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
  about: 1, material: 0.8, novel: 0.8, credible: 0.9, investorRelevant: 0.9,
  eventType: "results", takeaway: "positive update", magnitude: 0.5, surprise: 0.2,
  eventScore: 70, impact: 56, weight: 0.8, engine: "test", inputTokens: 10,
  outputTokens: 8, estimatedInputCostUsd: 0.00001, latencyMs: 1, rubricSha: "test-rubric", scoredAt: 10_000,
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("health alert status API", () => {
  it("reports aggregate unresolved counts and prioritizes an old failure in the recent list", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-alert-health-"));
    directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new Desk(dbPath);
    db.seedCompanies([company]);
    const destination = "e".repeat(64);

    const addAlert = (sourceItemId: string, createdAt: number): string => {
      const observationId = db.insertObservation({
        companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/acme",
        tier: "wire", title: sourceItemId, snippet: "Saved test row", publishedAt: createdAt, retrievedAt: createdAt,
        collector: "google_news_rss", sourceItemId,
      }).observationId;
      const intent: AlertIntent = {
        observationId, ruleVersion: "test-rule", payload: "{}", policy: "{}", destinationFingerprint: destination,
        createdAt, expiresAt: 1_000_000,
      };
      db.markScored(observationId, judged, false, intent);
      return observationId;
    };

    const oldFailure = addAlert("old-failure", 1_000);
    const failedClaim = db.claimAlert(1_001, destination, 10_000, 5);
    if (!failedClaim) throw new Error("expected failure alert claim");
    db.completeAlert(failedClaim, "failed", 1_002, 400, "http_client_error", 1_003);
    for (let index = 0; index < 11; index += 1) {
      addAlert(`new-delivery-${index}`, 2_000 + index);
      const claim = db.claimAlert(2_100 + index, destination, 10_000, 5);
      if (!claim) throw new Error("expected recent alert claim");
      db.completeAlert(claim, "delivered", 2_101 + index, 204, null, 0);
    }

    const app = createApp({
      db, dbPath, pipeline: { alertDeliveryConfigured: true, alertDeliveryEnabled: true } as AppDeps["pipeline"],
      market: {} as AppDeps["market"], hub: new Hub(), health: new HealthTracker(false, false, "unconfigured"),
      version: "test", deliverySources: [],
    });
    try {
      const response = await app.request("/api/health");
      expect(response.status).toBe(200);
      const body = await response.json() as {
        storage: { state: string; mainBytes: number | null; maxDatabaseBytes: number; canStartExternalWork: boolean };
        alertDelivery: { counts: Record<string, number>; recent: Array<{ alertId: string; observationId: string; state: string }>; nextCursor: string | null };
      };
      expect(body.storage).toMatchObject({ state: "ready", maxDatabaseBytes: TEST_STORAGE_LIMITS.maxDatabaseBytes, canStartExternalWork: true });
      expect(body.storage.mainBytes).toBeGreaterThan(0);
      expect(body.alertDelivery.counts).toEqual({ pending: 0, sending: 0, retrying: 0, failed: 1, paused: 0 });
      expect(body.alertDelivery.recent[0]).toMatchObject({ observationId: oldFailure, state: "failed" });
      expect(body.alertDelivery.recent).toHaveLength(10);
      expect(body.alertDelivery.nextCursor).not.toBeNull();

      const pageResponse = await app.request(`/api/alerts?limit=10&cursor=${encodeURIComponent(body.alertDelivery.nextCursor!)}`);
      expect(pageResponse.status).toBe(200);
      const page = await pageResponse.json() as { items: Array<{ alertId: string }>; nextCursor: string | null };
      expect(page.items).toHaveLength(2);
      expect(page.items.some((item) => body.alertDelivery.recent.some((recent) => recent.alertId === item.alertId))).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect((await app.request("/api/alerts?cursor=not-json")).status).toBe(400);
    } finally {
      db.close();
    }
  });
});
