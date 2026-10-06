import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TestDesk as Desk } from "./test-desk.js";
import { rowToDTO } from "../server/db.js";
import { parseRss } from "../server/sources/rss.js";
import type { CollectorId, RawMention } from "../server/types.js";
import { summarizeScoreBucketCoverage } from "../shared/score-bucket-coverage.js";
import { MentionCard } from "../web/src/components/MentionCard.js";
import { MentionDrawer } from "../web/src/components/MentionDrawer.js";
import type { Mention } from "../web/src/lib/api.js";
import { retryAvailabilityFor } from "../web/src/lib/retryAvailability.js";

const feedAt = Date.parse("2026-10-05T08:00:00Z");
const retrievedAt = feedAt + 60_000;
const company = { id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function source(collector: CollectorId = "google_news_rss"): RawMention & { aggregatorPublishedAt: number | null } {
  return {
    companyId: company.id, collector, kind: "rss", sourceName: "Reuters", publisherName: "Reuters",
    publisherDomain: "reuters.com", sourceUrl: "https://example.com/story", sourceItemId: "story-1",
    title: "Acme reports quarterly results", snippet: "Revenue increased.", tier: "wire",
    publishedAt: null, aggregatorPublishedAt: feedAt, retrievedAt, adapterVersion: `${collector}/3`,
  };
}

function seedLegacyRss(db: Desk, collector: CollectorId): string {
  const m = source(collector);
  const identityMaterial = `${m.companyId}\u0000${collector}\u0000${m.sourceItemId}`;
  const digest = createHash("sha256").update(JSON.stringify({ title: m.title, snippet: m.snippet, url: m.sourceUrl,
    publisherPublishedAt: feedAt, filedAt: null })).digest("hex");
  const id = `${m.companyId}:${createHash("sha256").update(`${identityMaterial}\u0000${digest}`).digest("hex")}`;
  db.testDb.prepare(`INSERT INTO source_observations
    (id, company_id, identity_key, revision_digest, collector, channel, publisher_name, publisher_domain,
     source_item_id, source_name, source_url, source_kind, source_tier, title, snippet,
     publisher_published_at, retrieved_at, ingested_at, time_basis, adapter_version)
    VALUES (?, ?, ?, ?, ?, 'news', ?, ?, ?, ?, ?, 'rss', 'wire', ?, ?, ?, ?, ?, 'publisher_declared', ?)`)
    .run(id, company.id, createHash("sha256").update(identityMaterial).digest("hex"), digest, collector,
      m.publisherName!, m.publisherDomain!, m.sourceItemId!, m.sourceName, m.sourceUrl,
      m.title, m.snippet, feedAt, retrievedAt, retrievedAt + 1, m.adapterVersion!);
  db.testDb.prepare("INSERT INTO jev_judgments(id, observation_id, status) VALUES (?, ?, 'pending')").run(id, id);
  return id;
}

describe("RSS feed clocks", () => {
  it("keeps pubDate as an aggregator declaration and missing pubDate unknown", () => {
    const items = parseRss(`<rss><channel>
      <item><title>Acme results</title><link>https://example.com/story</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
      <item><title>Acme update</title><link>https://example.com/update</link></item>
    </channel></rss>`);
    expect(items[0]).toMatchObject({ publishedAt: null, aggregatorPublishedAt: feedAt });
    expect(items[1]).toMatchObject({ publishedAt: null, aggregatorPublishedAt: null });
  });

  it.each(["google_news_rss", "yahoo_finance_rss"] as const)("projects immutable old %s rows and preserves revision identity", (collector) => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const id = seedLegacyRss(db, collector);
      const before = db.testDb.prepare("SELECT * FROM source_observations WHERE id = ?").get(id);
      expect(rowToDTO(db.mentionRow(id)!)).toMatchObject({
        publishedAt: null, aggregatorPublishedAt: feedAt, providerObservedAt: null, timeBasis: "aggregator_declared", retrievedAt,
      });
      expect(db.insertObservation(source(collector))).toEqual({ inserted: false, observationId: id });
      expect(db.testDb.prepare("SELECT * FROM source_observations WHERE id = ?").get(id)).toEqual(before);
      expect(() => db.testDb.prepare("UPDATE source_observations SET publisher_published_at = NULL WHERE id = ?").run(id)).toThrow("immutable");
    } finally { db.close(); }
  });

  it("adds the feed column on reopen while preserving original source values", () => {
    const folder = mkdtempSync(join(tmpdir(), "rss-clock-migration-")); folders.push(folder);
    const path = join(folder, "desk.db");
    const db = new Desk(path);
    db.seedCompanies([company]);
    const id = seedLegacyRss(db, "google_news_rss");
    const before = db.testDb.prepare("SELECT id, revision_digest, publisher_published_at, time_basis, retrieved_at FROM source_observations WHERE id = ?").get(id);
    db.close();
    const old = new DatabaseSync(path);
    old.exec("DROP VIEW mentions");
    const columns = old.prepare("PRAGMA table_info(source_observations)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "aggregator_published_at")) old.exec("ALTER TABLE source_observations DROP COLUMN aggregator_published_at");
    old.close();
    const reopened = new Desk(path);
    try {
      expect(reopened.testDb.prepare("PRAGMA table_info(source_observations)").all()).toContainEqual(expect.objectContaining({ name: "aggregator_published_at" }));
      expect(reopened.testDb.prepare("SELECT id, revision_digest, publisher_published_at, time_basis, retrieved_at FROM source_observations WHERE id = ?").get(id)).toEqual(before);
      expect(rowToDTO(reopened.mentionRow(id)!)).toMatchObject({ publishedAt: null, aggregatorPublishedAt: feedAt, timeBasis: "aggregator_declared" });
    } finally { reopened.close(); }
  });

  it("persists separate feed time and uses retrieval time for RSS chronology and windows", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const rss = db.insertObservation({ ...source(), aggregatorPublishedAt: retrievedAt + 1_000_000 });
      const direct = db.insertObservation({ ...source("finnhub"), kind: "finnhub", sourceItemId: "direct-1", publishedAt: retrievedAt + 1, aggregatorPublishedAt: null });
      expect(db.testDb.prepare("SELECT publisher_published_at, aggregator_published_at, provider_observed_at, time_basis FROM source_observations WHERE id = ?").get(rss.observationId))
        .toEqual({ publisher_published_at: null, aggregator_published_at: retrievedAt + 1_000_000, provider_observed_at: null, time_basis: "aggregator_declared" });
      expect(db.mentionsForCompany(company.id, 0, 10).map((m) => m.id)).toEqual([direct.observationId, rss.observationId]);
      expect(db.mentionsForCompany(company.id, retrievedAt + 1, 10).map((m) => m.id)).toEqual([direct.observationId]);
    } finally { db.close(); }
  });

  it("preserves SEC acceptance as publisher-declared time", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const id = db.insertObservation({ ...source("sec_edgar"), kind: "sec", publishedAt: feedAt, aggregatorPublishedAt: null }).observationId;
      expect(rowToDTO(db.mentionRow(id)!)).toMatchObject({ publishedAt: feedAt, aggregatorPublishedAt: null, timeBasis: "publisher_declared" });
    } finally { db.close(); }
  });

  it.each(["google_news_rss", "yahoo_finance_rss"] as const)("attributes %s time in cards and pending details with retrieval separate", (collector) => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const id = db.insertObservation(source(collector)).observationId;
      const mention = rowToDTO(db.mentionRow(id)!) as Mention;
      const label = collector === "google_news_rss" ? "Google News feed time" : "Yahoo Finance feed time";
      for (const html of [
        renderToStaticMarkup(createElement(MentionCard, { m: mention })),
        renderToStaticMarkup(createElement(MentionDrawer, { mention, onClose: () => {}, retryAvailability: retryAvailabilityFor(null) })),
      ]) {
        expect(html).toContain(label);
        expect(html).toContain("Article publication unknown");
        expect(html).toContain(new Date(feedAt).toISOString());
        expect(html).toContain(new Date(retrievedAt).toISOString());
        expect(html).not.toContain("provider observed");
      }
    } finally { db.close(); }
  });

  it("counts aggregator declarations separately from verified publisher and unknown clocks", () => {
    const summary = summarizeScoreBucketCoverage([
      { title: "RSS", scoredAt: retrievedAt, timeBasis: "aggregator_declared", publisherPublishedAt: null, aggregatorPublishedAt: feedAt, providerObservedAt: null, deliveryId: null },
      { title: "Unknown RSS", scoredAt: retrievedAt, timeBasis: "unknown", publisherPublishedAt: null, providerObservedAt: null, deliveryId: null },
      { title: "SEC", scoredAt: retrievedAt, timeBasis: "publisher_declared", publisherPublishedAt: feedAt, providerObservedAt: null, deliveryId: null },
    ]);
    expect(summary.sourceTimes).toMatchObject({
      aggregatorDeclared: { recordCount: 1, timestampedRecordCount: 1, range: { earliestAtMs: feedAt, latestAtMs: feedAt } },
      publisherDeclared: { recordCount: 1, timestampedRecordCount: 1 }, unknownRecordCount: 1,
    });
  });
});
