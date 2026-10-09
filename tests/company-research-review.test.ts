import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalystResearchQueueLimitError } from "../server/db.js";
import { loadCompanies } from "../server/config.js";
import type { MentionScore } from "../server/types.js";
import { TestDesk as Desk } from "./test-desk.js";

const directories: string[] = [];
const company = loadCompanies().find((candidate) => candidate.ticker === "AAPL")!;

afterEach(() => {
  vi.useRealTimers();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function insertSource(db: Desk, suffix: string) {
  return db.insertObservation({
    companyId: company.id,
    kind: "rss",
    sourceName: "Example Publisher",
    sourceUrl: `https://news.google.com/rss/articles/${suffix}`,
    tier: "major",
    title: `iPhone company update ${suffix}`,
    snippet: "Source-shaped fixture, isolated to a temporary test database.",
    publishedAt: 1_790_000_000_000,
    retrievedAt: 1_790_000_000_100,
    collector: "google_news_rss",
    publisherName: "Example Publisher",
    publisherDomain: "example.com",
    sourceItemId: suffix,
  }).observationId;
}

function savedScore(): MentionScore {
  return {
    sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
    about: 1, material: 0.8, novel: 0.8, credible: 0.9, investorRelevant: 0.9,
    eventType: "results", takeaway: "Fixture judgment", magnitude: 0.5, surprise: 0.2,
    eventScore: 70, impact: 56, weight: 0.8, engine: "test-fixture", inputTokens: 10,
    outputTokens: 8, estimatedInputCostUsd: 0.00001, latencyMs: 1, rubricSha: "fixture", scoredAt: Date.now(),
  };
}

describe("analyst research review persistence", () => {
  it("keeps set-aside source rows out of the default scan and available on request", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const queuedId = insertSource(db, "scan-queued");
      const setAsideId = insertSource(db, "scan-set-aside");
      db.markScored(queuedId, savedScore(), false);
      const chartEventsBefore = db.scoredMentionEvents(0);
      const sourceActivityBefore = db.sourceActivity24h(0).get(company.id);
      db.saveAnalystSourceReview({ observationId: queuedId, companyId: company.id, disposition: "investigate", nextQuestion: "Check the filing." });
      db.saveAnalystSourceReview({ observationId: setAsideId, companyId: company.id, disposition: "dismissed", nextQuestion: "Not relevant." });

      const scan = (includeDismissed: boolean, cursor: { orderAt: number; ingestedAt: number; id: string } | null = null) => db.mentionsForCompanyPage({
        companyId: company.id, sinceMs: 0, limit: 1, cursor, filter: "all", includeDismissed,
      });
      const working = scan(false);
      expect(working.items.map((item) => item.id)).toEqual([queuedId]);
      expect(working.items[0]?.analystResearchDisposition).toBe("investigate");
      expect(working.setAsideCount).toBe(1);
      expect(working.nextCursor).toBeNull();

      const visible = scan(true);
      expect(visible.items[0]).toMatchObject({ id: setAsideId, analystResearchDisposition: "dismissed" });
      expect(visible.setAsideCount).toBe(1);
      expect(visible.nextCursor).not.toBeNull();
      const next = scan(true, visible.nextCursor);
      expect(next.items).toHaveLength(1);
      expect(next.items[0]).toMatchObject({ id: queuedId, analystResearchDisposition: "investigate" });
      expect(next.nextCursor).toBeNull();
      expect(db.realObservationCount()).toBe(2);
      expect(db.sourceActivity24h(0).get(company.id)).toEqual(sourceActivityBefore);
      expect(db.scoredMentionEvents(0)).toEqual(chartEventsBefore);
    } finally { db.close(); }
  });

  it("keeps a source-bound note through restart, preserves no-op order, and supports reversible set-aside", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-analyst-queue-"));
    directories.push(directory);
    const path = join(directory, "desk.sqlite");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const id = insertSource(db, "queue-source-a");
    const saved = db.saveAnalystSourceReview({
      observationId: id, companyId: company.id, disposition: "investigate", nextQuestion: "Does the original filing confirm this?",
    });
    expect(saved).toMatchObject({ observationId: id, companyId: company.id, disposition: "investigate" });
    expect(db.analystResearchQueue()).toHaveLength(1);
    expect(db.analystResearchQueue()[0]).toMatchObject({
      observationId: id, ticker: company.ticker, mention: { id, title: "iPhone company update queue-source-a" },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const unchanged = db.saveAnalystSourceReview({
      observationId: id, companyId: company.id, disposition: "investigate", nextQuestion: "Does the original filing confirm this?",
    });
    expect(unchanged?.updatedAt).toBe(saved?.updatedAt);

    const dismissed = db.saveAnalystSourceReview({
      observationId: id, companyId: company.id, disposition: "dismissed", nextQuestion: "Does the original filing confirm this?",
    });
    expect(dismissed?.updatedAt).toBeGreaterThan(saved!.updatedAt);
    expect(db.analystResearchQueue()).toHaveLength(0);
    db.close();

    vi.useRealTimers();
    db = new Desk(path);
    db.seedCompanies([company]);
    expect(db.analystSourceReview(id)).toMatchObject({ disposition: "dismissed", nextQuestion: "Does the original filing confirm this?" });
    expect(db.saveAnalystSourceReview({
      observationId: id, companyId: company.id, disposition: "investigate", nextQuestion: "Check the next filing.",
    })).toMatchObject({ disposition: "investigate", nextQuestion: "Check the next filing." });
    expect(db.analystResearchQueue()).toHaveLength(1);
    db.close();
  });

  it("rejects unknown IDs and over-limit/control text without partial writes", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      expect(db.saveAnalystSourceReview({ observationId: "missing", companyId: company.id, disposition: "investigate", nextQuestion: "Check source." })).toBeNull();
      const id = insertSource(db, "queue-validation");
      expect(() => db.saveAnalystSourceReview({ observationId: id, companyId: company.id, disposition: "investigate", nextQuestion: "q".repeat(1001) })).toThrow("invalid_analyst_research_question");
      expect(() => db.saveAnalystSourceReview({ observationId: id, companyId: company.id, disposition: "investigate", nextQuestion: "bad\u0000text" })).toThrow("invalid_analyst_research_question");
      expect(db.analystSourceReview(id)).toBeNull();
      expect(() => db.insertObservation({
        companyId: company.id, kind: "rss", sourceName: "Unidentified", sourceUrl: "https://example.com/legacy",
        tier: "major", title: "Unidentified", snippet: "Not eligible", publishedAt: null, retrievedAt: 1,
        collector: "legacy_unknown", sourceItemId: "legacy",
      })).toThrow("Source collector provenance is required before ingesting an observation");
    } finally { db.close(); }
  });

  it("adds the queue table and source guards when upgrading a v14 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-analyst-queue-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.sqlite");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const id = insertSource(db, "queue-v14-upgrade");
    const raw = (db as unknown as { db: DatabaseSync }).db;
    raw.exec(`
      DROP TRIGGER analyst_source_reviews_real_source_insert;
      DROP TRIGGER analyst_source_reviews_real_source_update;
      DROP TRIGGER analyst_source_reviews_identity_immutable;
      DROP TABLE analyst_source_reviews;
      PRAGMA user_version = 14;
    `);
    db.close();

    db = new Desk(path);
    db.seedCompanies([company]);
    expect((db as unknown as { db: DatabaseSync }).db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 17 });
    expect(db.analystResearchQueue()).toEqual([]);
    expect(db.saveAnalystSourceReview({ observationId: id, companyId: company.id, disposition: "investigate", nextQuestion: "Check source." }))
      .toMatchObject({ observationId: id, disposition: "investigate" });
    db.close();
  });

  it("enforces the active queue bound atomically", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      let lastId = "";
      for (let index = 0; index < 500; index += 1) {
        lastId = insertSource(db, `capacity-${index}`);
        db.saveAnalystSourceReview({ observationId: lastId, companyId: company.id, disposition: "investigate", nextQuestion: "Check source." });
      }
      const overflowId = insertSource(db, "capacity-overflow");
      expect(() => db.saveAnalystSourceReview({ observationId: overflowId, companyId: company.id, disposition: "investigate", nextQuestion: "Check source." }))
        .toThrow(AnalystResearchQueueLimitError);
      expect(db.analystResearchQueue()).toHaveLength(500);
      expect(db.analystSourceReview(overflowId)).toBeNull();
      expect((db as unknown as { db: DatabaseSync }).db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 17 });
    } finally { db.close(); }
  });
});
