import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { CollectorId, Company } from "../server/types.js";

const directories: string[] = [];
const company: Company = { id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeDesk(health = new HealthTracker(false, false, "unconfigured")) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-first-run-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new Desk(dbPath);
  db.seedCompanies([company]);
  const app = createApp({
    db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health, version: "test", deliverySources: [],
  });
  return { db, app, directory };
}

describe("first-run evidence API", () => {
  it("returns the separate verified archive only when no eligible source history exists", async () => {
    const { db, app, directory } = makeDesk();
    try {
      const empty = await app.request("/api/first-run-evidence");
      expect(empty.status).toBe(200);
      const body = await empty.json();
      expect(body.eligibleObservationCount).toBe(0);
      expect(body.secCollectorEnabled).toBe(false);
      expect(body.jevSecScoringEnabled).toBe(false);
      expect(body.archivedRun).toMatchObject({
        ticker: "TSLA", sentiment: "neutral", eventType: "corporate_action", model: "jev-1.13.0",
        receiptId: "dca6b627-8b86-4288-bc01-6e88bf3bd072",
        sourceUrl: "https://www.sec.gov/Archives/edgar/data/1318605/000162828026063820/tsla-20260929.htm",
        sourceTitle: "8-K 1.01 — Material Definitive Agreement (+2 more)",
        filedAt: 1790640000000,
        sourcePublishedAt: 1790714330000,
        collectedAt: 1790847689506,
        scoredAt: 1790847689800,
        receiptDigest: "695a0b359e553f25b39d47b4d9e96bf35df72f8ae9d373f7d5e938e5c84466ee",
        requestDigest: "4af7c9e7f2d0e2d5fbfc943ecf87c0a883eb1f082c07da6e504df597fefc70ee",
        confidence: 0.54,
      });
      expect(JSON.stringify(body)).not.toContain("snippet");
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(join(directory, "desk.db"));
      try {
        raw.exec("PRAGMA query_only=ON");
        for (const table of ["source_observations", "source_deliveries", "jev_request_attempts"]) {
          expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
        }
      } finally {
        raw.close();
      }

      db.insertObservation({
        companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/acme",
        tier: "wire", title: "Historical Acme report", snippet: "", publishedAt: Date.now() - 60 * 86_400_000,
        retrievedAt: Date.now() - 60 * 86_400_000, collector: "google_news_rss", sourceItemId: "stale-real-row",
      });
      const stale = await app.request("/api/first-run-evidence");
      expect(await stale.json()).toMatchObject({ eligibleObservationCount: 1, archivedRun: null });
    } finally {
      db.close();
    }
  });

  it("does not count quarantined demo or legacy-unknown rows as real research history", async () => {
    const { db, app, directory } = makeDesk();
    // Exercise the legacy/quarantined filter against persisted view rows without
    // making these records through the production ingestion API.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(directory, "desk.db"));
    try {
      raw.exec(`INSERT INTO source_observations (id,company_id,identity_key,revision_digest,collector,channel,publisher_name,source_name,source_url,source_kind,source_tier,title,snippet,retrieved_at,ingested_at,time_basis,adapter_version)
        VALUES ('demo','acme','demo','demo','demo_simulation','news','demo','demo','https://example.test','rss','blog','demo','',1,1,'unknown','test'),
               ('legacy','acme','legacy','legacy','legacy_unknown','news','legacy','legacy','https://example.test','rss','blog','legacy','',1,1,'legacy_unknown','test')`);
      raw.exec(`INSERT INTO jev_judgments (id,observation_id,status) VALUES ('demo','demo','pending'),('legacy','legacy','pending')`);
      const response = await app.request("/api/first-run-evidence");
      expect(await response.json()).toMatchObject({ eligibleObservationCount: 0, archivedRun: { ticker: "TSLA" } });
    } finally {
      raw.close();
      db.close();
    }
  });

  it("reports Jev readiness specifically for SEC instead of another enabled collector", async () => {
    const health = new HealthTracker(
      false,
      true,
      "jev-latest",
      true,
      false,
      false,
      true,
      new Set<CollectorId>(["sec_edgar"]),
      {
        requestedCollectors: ["sec_edgar"],
        approvedCollectors: ["sec_edgar"],
        blockedRequestedCollectors: [],
        typesafeAccountUseApproved: true,
        jevAllowedCollectors: ["google_news_rss"],
      },
    );
    const { db, app } = makeDesk(health);
    try {
      const response = await app.request("/api/first-run-evidence");
      expect(await response.json()).toMatchObject({ secCollectorEnabled: true, jevSecScoringEnabled: false });
    } finally {
      db.close();
    }
  });
});
