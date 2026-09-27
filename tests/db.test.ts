import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Desk } from "../server/db.js";
import type { Company, MentionScore, RawMention } from "../server/types.js";

const directories: string[] = [];
const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function score(eventType: string): MentionScore {
  return {
    sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
    about: 1, material: 0.8, novel: 0.8, credible: 0.9, investorRelevant: 0.9,
    eventType, takeaway: "positive update", magnitude: 0.5, surprise: 0.2,
    eventScore: 70, impact: 56, weight: 0.8, engine: "test", inputTokens: 10,
    outputTokens: 8, costUsd: 0.00001, latencyMs: 1, rubricSha: "test-rubric", scoredAt: Date.now(),
  };
}

function mention(overrides: Partial<RawMention> = {}): RawMention {
  return {
    companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://reuters.com/a",
    tier: "wire", title: "Acme expands manufacturing capacity", snippet: "New plant announced",
    publishedAt: Date.now() - 60_000, retrievedAt: Date.now(), collector: "google_news_rss",
    sourceItemId: "reuters-a", publisherName: "Reuters", publisherDomain: "reuters.com",
    ...overrides,
  };
}

describe("Desk observation and judgment storage", () => {
  it("keeps collector-specific records, dedupes exact replays, and only indexes known source times", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-db-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      db.seedCompanies([company]);
      const publishedAt = Date.now() - 60_000;
      const first = mention({ publishedAt });
      const stored = db.insertObservation(first);
      expect(stored.inserted).toBe(true);
      expect(db.insertObservation(first)).toEqual({ ...stored, inserted: false });
      db.markScored(stored.observationId, score("results"), false);

      const second = mention({
        collector: "gdelt_doc_api", sourceItemId: "https://apnews.com/a",
        sourceName: "AP News", publisherName: "Associated Press", publisherDomain: "apnews.com",
        sourceUrl: "https://apnews.com/a", publishedAt: publishedAt + 1_000,
      });
      const secondStored = db.insertObservation(second);
      expect(secondStored.inserted).toBe(true);
      db.markScored(secondStored.observationId, score("results"), false);

      const missingTime = db.insertObservation(mention({
        sourceItemId: "no-time", publishedAt: null,
        sourceName: "Example", publisherName: "Example", sourceUrl: "https://example.com/no-time",
        publisherDomain: "example.com",
      }));
      db.markScored(missingTime.observationId, score("other"), false);

      const providerObservedAt = publishedAt + 5_000;
      const providerItem = mention({
        sourceItemId: "gdelt-seen-item", collector: "gdelt_doc_api", sourceName: "GDELT",
        sourceUrl: "https://example.com/provider-item", publisherName: "Example Publisher",
        publisherDomain: "example.com", title: "Acme product launch reported",
        snippet: "Publisher timestamp absent", publishedAt: null, providerObservedAt,
      });
      const observed = db.insertObservation(providerItem);
      expect(observed.inserted).toBe(true);
      db.markScored(observed.observationId, score("product"), false);
      expect(db.insertObservation({ ...providerItem, providerObservedAt: providerObservedAt + 60_000 }).inserted).toBe(false);
      const revised = db.insertObservation({ ...providerItem, snippet: "Updated source excerpt" });
      expect(revised.inserted).toBe(true);
      expect(revised.observationId).not.toBe(observed.observationId);
      db.markScored(revised.observationId, score("product"), true);

      const events = db.scoredMentionEvents(publishedAt - 1);
      expect(events.map((event) => event.eventType)).toEqual(["results", "results"]);
      expect(events.every((event) => event.ticker === "ACME")).toBe(true);
      const rows = db.mentionsForCompany(company.id, Date.now() - 5 * 60_000, 20);
      expect(rows).toHaveLength(5);
      expect(rows.find((row) => row.id === missingTime.observationId)?.publishedAt).toBeNull();
      const providerDto = rows.find((row) => row.id === observed.observationId)!;
      expect(providerDto.publishedAt).toBeNull();
      expect(providerDto.providerObservedAt).toBe(providerObservedAt);
      expect(providerDto.timeBasis).toBe("provider_observed");
      const excludedDto = rows.find((row) => row.id === revised.observationId)!;
      expect(excludedDto.status).toBe("off_target");
      expect(excludedDto.score).not.toBeNull();
      expect(rows.filter((row) => row.publisherDomain === "reuters.com" || row.publisherDomain === "apnews.com")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("persists successful empty and failed deliveries across a restart without exposing request keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-delivery-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const startedAt = Date.now();
    db.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: "private-query-phrase",
      startedAt, completedAt: startedAt + 10, result: "empty", parsedItemCount: 0,
      adapterVersion: "google-news/2",
    });
    db.recordDelivery({
      collector: "google_news_rss", companyId: company.id, requestKey: "private-query-phrase",
      startedAt, completedAt: startedAt + 10, result: "failed", parsedItemCount: 0,
      adapterVersion: "google-news/2", error: "upstream unavailable",
    });
    db.close();

    db = new Desk(path);
    try {
      const rows = db.deliverySummary();
      expect(rows.map((row) => row.result)).toEqual(["failed", "empty"]);
      expect(rows[0]?.error).toBe("upstream unavailable");
      expect(JSON.stringify(rows)).not.toContain("private-query-phrase");
      const [state] = db.deliveryHealth([
        { collector: "google_news_rss", enabled: true, intervalSeconds: 30, targetCount: 1 },
        { collector: "reddit", enabled: false, intervalSeconds: 180, targetCount: 1 },
      ], startedAt + 100);
      expect(state?.state).toBe("failed");
      expect(state?.coverageCount).toBe(0);
      expect(db.deliveryHealth([
        { collector: "google_news_rss", enabled: true, intervalSeconds: 30, targetCount: 1 },
      ], startedAt + 181_000)[0]?.state).toBe("overdue");
      expect(db.deliveryHealth([
        { collector: "reddit", enabled: false, intervalSeconds: 180, targetCount: 1 },
      ], startedAt + 100)[0]?.state).toBe("disabled");
    } finally {
      db.close();
    }
  });

  it("migrates v1 scores once, preserves the old table, and marks uncertain dates honestly", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, ticker TEXT NOT NULL, sector TEXT NOT NULL, aliases TEXT NOT NULL, color TEXT NOT NULL, ambiguous INTEGER NOT NULL DEFAULT 0);
      INSERT INTO companies VALUES ('acme','Acme','ACME','Technology','["Acme"]','#123456',0);
      CREATE TABLE mentions (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL,
        source_kind TEXT NOT NULL, source_tier TEXT NOT NULL, title TEXT NOT NULL, snippet TEXT NOT NULL,
        published_at INTEGER NOT NULL, retrieved_at INTEGER NOT NULL, filed_at INTEGER, scoped INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', sentiment TEXT, confidence REAL, p_pos REAL, p_neu REAL, p_neg REAL,
        about REAL, material REAL, novel REAL, credible REAL, investor_relevant REAL, event_type TEXT,
        takeaway TEXT, magnitude REAL, surprise REAL, event_score REAL, impact REAL, weight REAL,
        exclude INTEGER NOT NULL DEFAULT 0, engine TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cost_usd REAL, latency_ms INTEGER, rubric_sha TEXT, score_error TEXT, scored_at INTEGER
      );
      INSERT INTO mentions VALUES ('acme:old','acme','Reuters','https://reuters.com/a','rss','wire','Old result','Excerpt',1700000000000,1700000000100,NULL,0,'scored','positive',0.8,0.8,0.1,0.1,1,0.8,0.7,0.9,0.8,'results','positive update',0.5,0.2,70,56,0.8,0,'jev-latest',100,50,0.0001,321,'old-rubric',NULL,1700000000200);
      INSERT INTO mentions (id,company_id,source_name,source_url,source_kind,source_tier,title,snippet,published_at,retrieved_at,status,sentiment)
        VALUES ('acme:broken','acme','Unknown','https://example.com/b','rss','blog','Broken old score','',1700000000000,1700000000100,'scored','positive');
    `);
    old.close();

    let db = new Desk(path);
    try {
      const migrated = db.mentionRow("acme:old")!;
      expect(migrated.status).toBe("scored");
      expect(migrated.cost_usd).toBe(0.0001);
      expect(migrated.rubric_sha).toBe("old-rubric");
      expect(migrated.scored_at).toBe(1700000000200);
      expect(migrated.published_at).toBeNull();
      expect(migrated.time_basis).toBe("legacy_unknown");
      expect(db.mentionRow("acme:broken")?.status).toBe("corrupt");
      const dto = db.mentionsForCompany("acme", 0, 10).find((row) => row.id === "acme:broken");
      expect(dto?.score).toBeNull();
      expect(dto?.status).toBe("corrupt");
    } finally {
      db.close();
    }
    const migratedFile = new DatabaseSync(path);
    try {
      expect((migratedFile.prepare("SELECT COUNT(*) AS n FROM mentions_legacy_v1").get() as { n: number }).n).toBe(2);
    } finally {
      migratedFile.close();
    }

    db = new Desk(path);
    try {
      expect(db.mentionsForCompany("acme", 0, 10)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("migrates v2 retry fields and holds interrupted scoring as unknown instead of resubmitting", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-v2-retry-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const { observationId } = db.insertObservation(mention());
    const claimed = db.claimForScoring(observationId, Date.now());
    expect(claimed?.status).toBe("scoring");
    expect(claimed?.score_attempts).toBe(1);
    db.close();

    const priorVersion = new DatabaseSync(path);
    priorVersion.exec(`
      DROP VIEW mentions;
      ALTER TABLE jev_judgments DROP COLUMN score_retry_at;
      ALTER TABLE jev_judgments DROP COLUMN score_attempts;
      PRAGMA user_version = 2;
      CREATE VIEW mentions AS SELECT id FROM jev_judgments;
    `);
    priorVersion.close();

    db = new Desk(path);
    try {
      const recovered = db.mentionRow(observationId)!;
      expect(recovered.status).toBe("failed");
      expect(recovered.score_error).toContain("outcome is unknown");
      expect(recovered.score_retry_at).toBeNull();
      expect(db.pendingIds(10)).toEqual([]);
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("failed");
    } finally {
      db.close();
    }
  });
});
