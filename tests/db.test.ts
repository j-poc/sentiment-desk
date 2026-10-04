import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AlertIntent } from "../server/db.js";
import { TestDesk as Desk } from "./test-desk.js";
import type { Company, MentionScore, RawMention } from "../server/types.js";

const directories: string[] = [];
// Migration fixtures are tiny and should exercise schema behavior without
// requiring the host to reserve the production database's full 2 GiB ceiling.
const migrationTestLimits = {
  maxDatabaseBytes: 64 * 1024 * 1024,
  maxFamilyBytes: 128 * 1024 * 1024,
  minimumFreeBytes: 1,
  writeHeadroomBytes: 1,
};
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
    outputTokens: 8, estimatedInputCostUsd: 0.00001, latencyMs: 1, rubricSha: "test-rubric", scoredAt: Date.now(),
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
  it("counts only ticker-scoped legacy_unknown price rows and keeps them outside priceWindow", () => {
    const db = new Desk(":memory:");
    const raw = (db as unknown as { db: DatabaseSync }).db;
    try {
      db.seedCompanies([company]);
      raw.prepare("INSERT INTO price_points (ticker, t, price, collector, currency, retrieved_at, adapter_version, delivery_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("ACME", 1000, 12.5, "legacy_unknown", null, null, "legacy-unknown", null);
      raw.prepare("INSERT INTO price_points (ticker, t, price, collector, currency, retrieved_at, adapter_version, delivery_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("ACME", 2000, 13.5, "legacy_unknown", "USD", 2000, "legacy-unknown", null);
      raw.prepare("INSERT INTO price_points (ticker, t, price, collector, currency, retrieved_at, adapter_version, delivery_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("ACME", 3000, 14.5, "yahoo_quote", "USD", 3000, "quote/1", null);
      raw.prepare("INSERT INTO price_points (ticker, t, price, collector, currency, retrieved_at, adapter_version, delivery_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("OTHER", 1000, 22.5, "legacy_unknown", null, null, "legacy-unknown", null);
      raw.prepare(`INSERT INTO source_deliveries
        (id, collector, company_id, request_key_hash, started_at, completed_at, result, parsed_item_count, adapter_version)
        VALUES ('price-delivery', 'yahoo_chart', NULL, 'test', 1, 2, 'success', 1, 'yahoo-chart/1')`).run();
      raw.prepare("INSERT INTO price_points (ticker, t, price, collector, currency, retrieved_at, adapter_version, delivery_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("ACME", 4000, 15.5, "yahoo_chart", "USD", 5000, "yahoo-chart/1", "price-delivery");

      expect(db.legacyUnknownPriceRowCount("ACME")).toBe(2);
      expect(db.legacyUnknownPriceRowCount("OTHER")).toBe(1);
      expect(db.priceWindow("ACME", 0, 6000)).toEqual([{
        t: 4000, price: 15.5, currency: "USD", collector: "yahoo_chart",
        retrievedAt: 5000, adapterVersion: "yahoo-chart/1", deliveryId: "price-delivery",
      }]);
    } finally { db.close(); }
  });

  it("binds a Jev receipt to the immutable request and rejects a terminal receipt before dispatch", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const id = db.insertObservation(mention({ sourceItemId: "jev-request-trace" })).observationId;
      const claim = db.claimForScoringWithBudget({
        id, now: 1_000, allowedCollectors: ["google_news_rss"], utcDay: "2026-09-28",
        requestBytes: 128, requestSha256: "a".repeat(64), requestedModel: "jev-latest", rubricSha256: "b".repeat(64),
        maxRequests: 10, maxRequestBytes: 10_000,
      });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") throw new Error("expected scoring claim");
      expect(() => db.recordJevAttemptReceipt({
        attemptId: claim.attemptId, outcome: "response", occurredAt: 1_001, httpStatus: 200,
        inputTokens: 10, outputTokens: 5, resolvedModel: "jev-1.13.0", latencyMs: 20, errorCategory: null,
      })).toThrow(/dispatch-intent/);
      expect(db.recordJevDispatchIntent(claim.attemptId, 1_001)).toBe(true);
      db.recordJevAttemptReceipt({
        attemptId: claim.attemptId, outcome: "response", occurredAt: 1_010, httpStatus: 200,
        inputTokens: 10, outputTokens: 5, resolvedModel: "jev-1.13.0", latencyMs: 20, errorCategory: null,
      });
      expect(db.jevAttemptHistory(id)).toMatchObject([{
        requestSha256: "a".repeat(64), requestBytes: 128, requestedModel: "jev-latest", rubricSha256: "b".repeat(64),
        dispatchAt: 1_001, outcome: "response", httpStatus: 200, inputTokens: 10, outputTokens: 5,
        resolvedModel: "jev-1.13.0", latencyMs: 20,
      }]);
      expect(() => db.recordJevAttemptReceipt({
        attemptId: claim.attemptId, outcome: "unknown", occurredAt: 1_020, httpStatus: null,
        inputTokens: null, outputTokens: null, resolvedModel: null, latencyMs: null, errorCategory: "transport_outcome_unknown",
      })).toThrow();
    } finally { db.close(); }
  });

  it("recovers interrupted Jev attempts as unknown after dispatch and not-sent before it", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-jev-recovery-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const dispatchedId = db.insertObservation(mention({ sourceItemId: "jev-dispatched-interrupt" })).observationId;
    const reservedId = db.insertObservation(mention({ sourceItemId: "jev-reserved-interrupt" })).observationId;
    const claim = (id: string) => db.claimForScoringWithBudget({
      id, now: 1_000, allowedCollectors: ["google_news_rss"], utcDay: "2026-09-28",
      requestBytes: 128, requestSha256: "c".repeat(64), requestedModel: "jev-latest", rubricSha256: "d".repeat(64),
      maxRequests: 10, maxRequestBytes: 10_000,
    });
    const dispatched = claim(dispatchedId);
    const reserved = claim(reservedId);
    if (dispatched.kind !== "claimed" || reserved.kind !== "claimed") throw new Error("expected scoring claims");
    expect(db.recordJevDispatchIntent(dispatched.attemptId, 1_001)).toBe(true);
    const observer = new Desk(path);
    expect(observer.mentionRow(dispatchedId)?.status).toBe("scoring");
    expect(observer.jevAttemptHistory(dispatchedId)).toMatchObject([{ outcome: "dispatch_intent" }]);
    observer.close();
    db.close();
    db = new Desk(path);
    try {
      expect(db.jevAttemptHistory(dispatchedId)).toMatchObject([{ outcome: "unknown", errorCategory: "interrupted_after_dispatch" }]);
      expect(db.jevAttemptHistory(reservedId)).toMatchObject([{ outcome: "not_sent", errorCategory: "interrupted_before_dispatch" }]);
    } finally { db.close(); }
  });

  it("releases a known-unsent Luna reservation after restart and allows retry without usage review", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-luna-reservation-recovery-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const id = db.insertObservation(mention({ sourceItemId: "luna-reserved-interrupt", collector: "sec_edgar" })).observationId;
    const claim = db.claimForScoringWithBudget({
      id, now: 1_000, allowedCollectors: ["sec_edgar"], utcDay: "2026-09-28",
      requestBytes: 128, requestSha256: "e".repeat(64), requestedModel: "gpt-6-luna", rubricSha256: "f".repeat(64),
      maxRequests: 10, maxRequestBytes: 10_000, provider: "openai_luna", maxDailyCostMicros: 1_000_000,
      reservedCostMicros: 250_000, requestedServiceTier: "default", maxOutputTokens: 128,
      schemaSha256: "a".repeat(64), promptSha256: "b".repeat(64),
    });
    if (claim.kind !== "claimed") throw new Error("expected a bounded Luna claim");
    expect(db.getKv("openai:budget:2026-09-28:requests")).toBe("1");
    expect(db.getKv("openai:budget:2026-09-28:request-bytes")).toBe("128");
    expect(db.getKv("openai:budget:2026-09-28:cost-micros")).toBe("250000");
    db.close();

    db = new Desk(path);
    try {
      expect(db.jevAttemptHistory(id)).toMatchObject([{ outcome: "not_sent", dispatchAt: null, errorCategory: "interrupted_before_dispatch" }]);
      expect(db.getKv("openai:budget:2026-09-28:requests")).toBe("0");
      expect(db.getKv("openai:budget:2026-09-28:request-bytes")).toBe("0");
      expect(db.getKv("openai:budget:2026-09-28:cost-micros")).toBe("0");
      expect(db.classifierUsageSince(0)).toMatchObject({ requests: 0, unpricedAttempts: 0, reservedCostUsd: 0 });
      expect(db.requeueFailed(id, false)).toBe("queued");
    } finally { db.close(); }
  });

  it("commits a qualified alert intent with the score and preserves immutable claims and receipts", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const id = db.insertObservation(mention({ sourceItemId: "alert-outbox" })).observationId;
      const intent: AlertIntent = { observationId: id, ruleVersion: "rule-1", payload: '{"text":"x"}', policy: '{"threshold":65}', destinationFingerprint: "a".repeat(64), createdAt: 1000, expiresAt: 100_000 };
      db.markScored(id, score("results"), false, intent);
      const claim = db.claimAlert(1001, intent.destinationFingerprint, 10_000, 5)!;
      expect(claim).toMatchObject({ payload: intent.payload, attempt: 1 });
      expect(db.claimAlert(1002, intent.destinationFingerprint, 10_000, 5)).toBeNull();
      expect(db.completeAlert(claim, "delivered", 1003, 204, null, 0)).toBe(true);
      expect(db.alertDeliverySummary()).toMatchObject([{
        observationId: id,
        ticker: "ACME",
        title: "Acme expands manufacturing capacity",
        state: "delivered",
        attemptCount: 1,
        lastOutcome: "delivered",
        lastHttpStatus: 204,
        lastErrorCategory: null,
      }]);
      expect(() => db.completeAlert(claim, "failed", 1004, 500, "http_server_error", 2000)).not.toThrow();
      expect(db.claimAlert(1005, intent.destinationFingerprint, 10_000, 5)).toBeNull();
    } finally { db.close(); }
  });

  it("records a storage-paused webhook as not sent and returns its attempt budget", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const id = db.insertObservation(mention({ sourceItemId: "alert-storage-pause" })).observationId;
      const intent: AlertIntent = { observationId: id, ruleVersion: "rule-1", payload: "{}", policy: "{}",
        destinationFingerprint: "9".repeat(64), createdAt: 1_000, expiresAt: 100_000 };
      db.markScored(id, score("results"), false, intent);
      const claim = db.claimAlert(1_001, intent.destinationFingerprint, 10_000, 5)!;
      expect(db.deferAlertBeforeDispatch(claim, 1_002, 30_000)).toBe(true);
      expect(db.alertDeliverySummary()).toMatchObject([{ state: "pending", attemptCount: 0,
        lastOutcome: "not_sent", lastErrorCategory: "storage_paused", lastHttpStatus: null }]);
      expect(db.claimAlert(1_003, intent.destinationFingerprint, 10_000, 5)).toBeNull();
      expect(db.claimAlert(30_000, intent.destinationFingerprint, 10_000, 5)).toMatchObject({ attempt: 1 });
    } finally { db.close(); }
  });

  it("surfaces unresolved alert failures ahead of newer deliveries and reports aggregate counts", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const destination = "f".repeat(64);
      const makeAlert = (sourceItemId: string, createdAt: number) => {
        const id = db.insertObservation(mention({ sourceItemId })).observationId;
        const intent: AlertIntent = {
          observationId: id, ruleVersion: "rule-1", payload: "{}", policy: "{}",
          destinationFingerprint: destination, createdAt, expiresAt: 1_000_000,
        };
        db.markScored(id, score("results"), false, intent);
        return id;
      };

      const failureId = makeAlert("old-terminal-failure", 1_000);
      const failedClaim = db.claimAlert(1_001, destination, 10_000, 5);
      if (!failedClaim) throw new Error("expected failure alert to be claimed");
      expect(db.completeAlert(failedClaim, "failed", 1_002, 400, "http_client_error", 1_003)).toBe(true);
      for (let index = 0; index < 11; index += 1) {
        makeAlert(`newer-success-${index}`, 2_000 + index);
        const claim = db.claimAlert(2_100 + index, destination, 10_000, 5);
        if (!claim) throw new Error("expected recent alert to be claimed");
        expect(db.completeAlert(claim, "delivered", 2_101 + index, 204, null, 0)).toBe(true);
      }

      expect(db.alertDeliverySummary(10)[0]).toMatchObject({ observationId: failureId, state: "failed" });
      expect(db.alertDeliveryCounts()).toEqual({ pending: 0, sending: 0, retrying: 0, failed: 1, paused: 0 });
    } finally { db.close(); }
  });

  it("excludes off-target rows, pauses destination mismatches, expires intents, and recovers expired leases", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const makeIntent = (observationId: string, destinationFingerprint: string, expiresAt = 100_000): AlertIntent => ({ observationId, ruleVersion: "r", payload: "{}", policy: "{}", destinationFingerprint, createdAt: 1000, expiresAt });
      const off = db.insertObservation(mention({ sourceItemId: "alert-off" })).observationId;
      db.markScored(off, score("results"), true, makeIntent(off, "a".repeat(64)));
      expect(db.claimAlert(1001, "a".repeat(64), 10, 5)).toBeNull();
      const id = db.insertObservation(mention({ sourceItemId: "alert-recovery" })).observationId;
      db.markScored(id, score("results"), false, makeIntent(id, "b".repeat(64)));
      expect(db.claimAlert(1001, "c".repeat(64), 10, 5)).toBeNull();
      expect(db.claimAlert(1002, "b".repeat(64), 10, 5)?.attempt).toBe(1);
      const recoveryId = db.insertObservation(mention({ sourceItemId: "alert-lease" })).observationId;
      db.markScored(recoveryId, score("results"), false, makeIntent(recoveryId, "e".repeat(64)));
      db.claimAlert(1010, "e".repeat(64), 10, 5);
      const recovered = db.claimAlert(1020, "e".repeat(64), 10, 5);
      expect(recovered?.attempt).toBe(2);
      expect(db.alertDeliverySummary().find((record) => record.observationId === recoveryId)).toMatchObject({
        state: "sending", attemptCount: 2, lastOutcome: "ambiguous",
      });
      const expiring = db.insertObservation(mention({ sourceItemId: "alert-expiry" })).observationId;
      db.markScored(expiring, score("results"), false, makeIntent(expiring, "d".repeat(64), 2000));
      expect(db.claimAlert(2000, "d".repeat(64), 10, 5)).toBeNull();
    } finally { db.close(); }
  });
  it("keeps the latest saved collection time visible when the 24-hour count is zero", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const collectedAt = Date.now() - 48 * 60 * 60_000;
      db.insertObservation(mention({
        sourceItemId: "saved-two-days-ago",
        publishedAt: collectedAt,
        retrievedAt: collectedAt,
      }));

      expect(db.sourceActivity24h(Date.now() - 24 * 60 * 60_000).get(company.id)).toEqual({
        sourceRecords24h: 0,
        latestCollectedAt: collectedAt,
      });
    } finally {
      db.close();
    }
  });

  it("requires a known collector before storing new source observations", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-provenance-required-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      db.seedCompanies([company]);
      expect(() => db.insertObservation(mention({ collector: "legacy_unknown" })))
        .toThrow(/Source collector provenance is required/);
      expect(() => db.insertObservation(mention({ collector: undefined })))
        .toThrow(/Source collector provenance is required/);
    } finally {
      db.close();
    }
  });

  it("does not report the Google News redirect host as the publisher domain for retained observations", () => {
    const db = new Desk(":memory:");
    try {
      db.seedCompanies([company]);
      const stored = db.insertObservation(mention({
        sourceItemId: "google-redirect-domain",
        sourceUrl: "https://news.google.com/rss/articles/abc123",
        publisherName: "Reuters",
        publisherDomain: "news.google.com",
      }));
      db.markScored(stored.observationId, score("results"), false);

      const listed = db.mentionsForCompany(company.id, Date.now() - 5 * 60_000, 20)
        .find((row) => row.id === stored.observationId);
      const radar = db.radarEvidence(company.id, Date.now() - 5 * 60_000, Date.now())
        .find((row) => row.id === stored.observationId);

      expect(listed?.publisherName).toBe("Reuters");
      expect(listed?.publisherDomain).toBeNull();
      expect(listed?.source.publisherDomain).toBeNull();
      expect(radar?.publisherDomain).toBeNull();
    } finally {
      db.close();
    }
  });

  it("quarantines migrated unverified observations from operational usage totals", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-unverified-legacy-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const scoredId = db.insertObservation(mention({ sourceItemId: "unverified-scored" })).observationId;
    db.markScored(scoredId, score("results"), false);
    const failedId = db.insertObservation(mention({ sourceItemId: "unverified-failed" })).observationId;
    db.markFailed(failedId, "old source provenance unavailable", true);
    const pendingId = db.insertObservation(mention({ sourceItemId: "unverified-pending" })).observationId;
    db.close();

    const oldRuntime = new DatabaseSync(path);
    oldRuntime.exec("DROP TRIGGER source_observations_no_update");
    for (const id of [scoredId, failedId, pendingId]) {
      oldRuntime.prepare("UPDATE source_observations SET collector = 'legacy_unknown' WHERE id = ?").run(id);
    }
    oldRuntime.prepare(
      `INSERT INTO source_deliveries
       (id, collector, company_id, request_key_hash, started_at, completed_at, result,
        parsed_item_count, response_digest, adapter_version, error)
       VALUES ('legacy-delivery', 'legacy_unknown', NULL, 'digest', 1, 2, 'success', 1, NULL, 'legacy-v1', NULL)`,
    ).run();
    oldRuntime.close();

    db = new Desk(path);
    try {
      expect(db.mentionRow(scoredId)).toBeUndefined();
      expect(db.mentionsForCompany(company.id, 0, 10)).toEqual([]);
      expect(db.recentVisible(10)).toEqual([]);
      expect(db.radarEvidence(company.id, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
      expect(db.radarUncounted(company.id, 0, Number.MAX_SAFE_INTEGER)).toEqual({ untimedScored: 0, unjudged: 0 });
      expect(db.pendingIds(10, ["google_news_rss"])).toEqual([]);
      expect(db.claimForScoring(pendingId, Date.now())).toBeUndefined();
      expect(db.requeueFailed(failedId, true)).toBe("not_retryable");
      expect(db.scoredMentions(0)).toEqual([]);
      expect(db.scoredMentionEvents(0)).toEqual([]);
      expect(db.sourceActivity24h(0).size).toBe(0);
      const identifiedId = db.insertObservation(mention({ sourceItemId: "identified-source" })).observationId;
      db.markScored(identifiedId, score("results"), false);
      expect(db.usageSince(0)).toEqual({
        judgedItems: 1, inputTokens: 10, outputTokens: 8, estimatedInputCostUsd: 0.00001,
      });
      expect(db.deliverySummary()).toEqual([]);
      expect(() => db.recordDelivery({
        collector: "legacy_unknown", companyId: null, requestKey: "unknown", startedAt: 1,
        completedAt: 2, result: "success", parsedItemCount: 1, adapterVersion: "legacy-v1",
      })).toThrow(/Source collector provenance is required/);
    } finally {
      db.close();
    }
  });

  it("rejects new synthetic input and keeps previously stored simulation rows out of every research view", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-real-only-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const source = mention();
    const { observationId } = db.insertObservation(source);
    db.markScored(observationId, score("results"), false);
    const { observationId: engineOnlyId } = db.insertObservation(mention({
      title: "Legacy simulated judgment with a source collector",
      sourceUrl: "https://reuters.com/acme/legacy-sim-judgment",
      sourceItemId: "legacy-sim-judgment",
    }));
    expect(() => db.insertObservation(mention({ collector: "demo_simulation" }))).toThrow(/Synthetic mentions/);
    db.close();

    const oldRuntime = new DatabaseSync(path);
    oldRuntime.exec("DROP TRIGGER source_observations_no_update");
    oldRuntime.prepare("UPDATE source_observations SET collector = 'demo_simulation' WHERE id = ?").run(observationId);
    oldRuntime.prepare("UPDATE jev_judgments SET engine = 'demo-sim' WHERE observation_id = ?").run(observationId);
    oldRuntime.prepare("UPDATE jev_judgments SET engine = 'demo-sim' WHERE observation_id = ?").run(engineOnlyId);
    oldRuntime.close();

    db = new Desk(path);
    try {
      expect(db.mentionRow(observationId)).toBeUndefined();
      expect(db.mentionRow(engineOnlyId)).toBeUndefined();
      expect(db.mentionsForCompany(company.id, 0, 10)).toEqual([]);
      expect(db.recentVisible(10)).toEqual([]);
      expect(db.radarEvidence(company.id, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
      expect(db.radarUncounted(company.id, 0, Number.MAX_SAFE_INTEGER)).toEqual({ untimedScored: 0, unjudged: 0 });
      expect(db.pendingIds(10, ["google_news_rss"])).toEqual([]);
      expect(db.claimForScoring(engineOnlyId, Date.now())).toBeUndefined();
      expect(db.scoredMentions(0)).toEqual([]);
      expect(db.scoredMentionEvents(0)).toEqual([]);
      expect(db.sourceActivity24h(0).size).toBe(0);
      expect(db.usageSince(0)).toEqual({
        judgedItems: 0, inputTokens: 0, outputTokens: 0, estimatedInputCostUsd: 0,
      });
    } finally {
      db.close();
    }
  });

  it("does not allow an operator retry to mutate a hidden legacy simulation row", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-hidden-retry-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path);
    db.seedCompanies([company]);
    const { observationId } = db.insertObservation(mention());
    db.markFailed(observationId, "fixture failure", true);
    db.close();

    const oldRuntime = new DatabaseSync(path);
    oldRuntime.exec("DROP TRIGGER source_observations_no_update");
    oldRuntime.prepare("UPDATE source_observations SET collector = 'demo_simulation' WHERE id = ?").run(observationId);
    oldRuntime.prepare("UPDATE jev_judgments SET engine = 'demo-sim' WHERE observation_id = ?").run(observationId);
    oldRuntime.close();

    db = new Desk(path);
    try {
      expect(db.requeueFailed(observationId, true)).toBe("not_retryable");
      expect(db.mentionRow(observationId)).toBeUndefined();
      expect(db.pendingIds(10, ["google_news_rss"])).toEqual([]);
    } finally {
      db.close();
    }

    const verify = new DatabaseSync(path);
    try {
      const status = verify.prepare("SELECT status FROM jev_judgments WHERE observation_id = ?").get(observationId) as { status: string };
      expect(status.status).toBe("failed");
    } finally {
      verify.close();
    }
  });

  it("requires provider-usage review for an attempted legacy failure even when its saved flag is false", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-legacy-retry-review-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      db.seedCompanies([company]);
      const { observationId } = db.insertObservation(mention({ sourceItemId: "legacy-mismatch" }));
      expect(db.claimForScoring(observationId, Date.now())).toBeDefined();
      db.markFailed(observationId, "TypeSafe response model mismatch; request outcome is unknown", false);

      const visible = db.mentionsForCompany(company.id, 0, 10)[0]!;
      expect(visible).toMatchObject({ status: "failed", usageCheckRequired: true });
      expect(db.requeueFailed(observationId, false)).toBe("usage_review_required");
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("failed");
      expect(db.requeueFailed(observationId, true)).toBe("queued");
    } finally {
      db.close();
    }
  });

  it("pages older unscored observations without skipping when a newer item gets scored", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-unscored-pages-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      db.seedCompanies([company]);
      const now = Date.now();
      const scoredId = db.insertObservation(mention({ sourceItemId: "newest-scored", publishedAt: now - 1_000 })).observationId;
      db.markScored(scoredId, score("results"), false);
      const firstId = db.insertObservation(mention({ sourceItemId: "first-pending", publishedAt: now - 2_000 })).observationId;
      const failedId = db.insertObservation(mention({ sourceItemId: "older-failed", publishedAt: now - 3_000 })).observationId;
      expect(db.claimForScoring(failedId, now)).toBeDefined();
      db.markFailed(failedId, "request outcome unknown", false);
      const lastId = db.insertObservation(mention({ sourceItemId: "oldest-pending", publishedAt: now - 4_000 })).observationId;

      const first = db.mentionsForCompanyPage({ companyId: company.id, sinceMs: 0, limit: 1, cursor: null, filter: "failed" });
      expect(first.items[0]?.id).toBe(firstId);
      db.markScored(firstId, score("results"), false);
      const second = db.mentionsForCompanyPage({ companyId: company.id, sinceMs: 0, limit: 1, cursor: first.nextCursor, filter: "failed" });
      const third = db.mentionsForCompanyPage({ companyId: company.id, sinceMs: 0, limit: 1, cursor: second.nextCursor, filter: "failed" });

      expect(second).toMatchObject({ items: [{ id: failedId, status: "failed", usageCheckRequired: true }] });
      expect(second.nextCursor).toMatchObject({ id: failedId });
      expect(third).toEqual({ items: [expect.objectContaining({ id: lastId, status: "pending" })], nextCursor: null, setAsideCount: 0, issuerIdentityReviewCount: 0 });
    } finally {
      db.close();
    }
  });

  it("finds matching scored items past the first hundred unmatched observations", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-filtered-pages-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      db.seedCompanies([company]);
      const now = Date.now();
      for (let index = 0; index < 105; index += 1) {
        db.insertObservation(mention({
          sourceItemId: `pending-${index}`,
          publishedAt: now - index * 1_000,
        }));
      }
      const olderBullish = db.insertObservation(mention({
        sourceItemId: "older-bullish",
        title: "Older bullish result beyond first page",
        publishedAt: now - 106_000,
      }));
      db.markScored(olderBullish.observationId, score("results"), false);

      const page = db.mentionsForCompanyPage({
        companyId: company.id,
        sinceMs: now - 168 * 60 * 60 * 1000,
        limit: 100,
        cursor: null,
        filter: "bull",
      });

      expect(page.items.map((item) => item.title)).toEqual(["Older bullish result beyond first page"]);
      expect(page.items[0]?.score?.sentiment).toBe("positive");
      expect(page.nextCursor).toBeNull();
    } finally {
      db.close();
    }
  });

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
      expect(events).toHaveLength(4);
      expect(events.filter((event) => event.eventType === "results")).toHaveLength(2);
      expect(events.every((event) => event.availableAt >= Date.now() - 60_000)).toBe(true);
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

  it("returns every eligible publisher-timed reaction event beyond the recent-feed page size", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-reaction-events-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      db.seedCompanies([company]);
      const since = Date.now() - 10 * 60_000;
      for (let i = 0; i < 205; i += 1) {
        const stored = db.insertObservation(mention({
          sourceItemId: `reaction-${i}`,
          sourceUrl: `https://reuters.com/reaction/${i}`,
          publishedAt: since + i * 100,
        }));
        db.markScored(stored.observationId, score("results"), false);
      }

      const events = db.scoredReactionEventsForCompany(company.id, since);

      expect(events).toHaveLength(205);
      expect(events[0]?.eventScore).toBe(70);
      expect(events.every((event) => event.availableAt >= since && event.availableAt <= Date.now())).toBe(true);
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

  it("keeps health latest-per-group ordering and quarantined receipts exact", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-health-groups-"));
    directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new Desk(dbPath);
    const now = 10_000_000;
    const startedAt = now - 1_000;
    const add = (input: Parameters<Desk["recordDelivery"]>[0]) => db.recordDelivery(input);
    try {
      db.seedCompanies([company, {
        id: "beta", name: "Beta", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321",
      }]);
      add({
        collector: "google_news_rss", companyId: null, requestKey: "null-tie-first", startedAt,
        completedAt: startedAt + 1, result: "success", parsedItemCount: 1, adapterVersion: "rss/1",
      });
      add({
        collector: "google_news_rss", companyId: null, requestKey: "null-tie-later", startedAt,
        completedAt: startedAt + 1, result: "partial", parsedItemCount: 2, adapterVersion: "rss/1",
      });
      add({
        collector: "sec_edgar", companyId: company.id, requestKey: "acme-sec", startedAt,
        completedAt: startedAt + 2, result: "success", parsedItemCount: 1, adapterVersion: "sec-submissions/1",
      });
      add({
        collector: "sec_edgar", companyId: "beta", requestKey: "beta-sec", startedAt,
        completedAt: startedAt + 3, result: "empty", parsedItemCount: 0, adapterVersion: "sec-submissions/1",
      });
      add({
        collector: "sec_edgar", companyId: null, requestKey: "sec-directory", startedAt,
        completedAt: startedAt + 4, result: "failed", parsedItemCount: 0, adapterVersion: "sec-company-tickers/1",
        error: "global bootstrap failure",
      });
      add({
        collector: "sec_edgar", companyId: company.id, requestKey: "sec-fundamentals-companyfacts", startedAt,
        completedAt: startedAt + 6, result: "success", parsedItemCount: 4,
        adapterVersion: "sec-fundamentals-companyfacts/2",
      });
      add({
        collector: "finnhub", companyId: company.id, requestKey: "finnhub-news", startedAt,
        completedAt: startedAt + 2, result: "success", parsedItemCount: 1, adapterVersion: "finnhub-news/1",
      });
      add({
        collector: "finnhub", companyId: company.id, requestKey: "finnhub-earnings", startedAt,
        completedAt: startedAt + 5, result: "failed", parsedItemCount: 0, adapterVersion: "finnhub-earnings/1",
        error: "auxiliary failure",
      });

      const legacy = new DatabaseSync(dbPath);
      legacy.prepare(
        `INSERT INTO source_deliveries
         (id, collector, company_id, request_key_hash, started_at, completed_at, result,
          parsed_item_count, adapter_version, error)
         VALUES (?, ?, NULL, 'test', ?, ?, 'success', 99, 'quarantined/1', NULL)`,
      ).run("quarantined-demo", "demo_simulation", startedAt, now);
      legacy.prepare(
        `INSERT INTO source_deliveries
         (id, collector, company_id, request_key_hash, started_at, completed_at, result,
          parsed_item_count, adapter_version, error)
         VALUES (?, ?, NULL, 'test', ?, ?, 'failed', 99, 'quarantined/1', 'legacy error')`,
      ).run("quarantined-legacy", "legacy_unknown", startedAt, now);
      legacy.close();

      const health = db.deliveryHealth([
        { collector: "google_news_rss", enabled: true, intervalSeconds: 60, targetCount: 1 },
        { collector: "sec_edgar", enabled: true, intervalSeconds: 60, targetCount: 2, healthCompanyOnly: true,
          healthAdapterVersions: ["sec-ticker-mapping/1", "sec-company-tickers/1", "sec-submissions/1", "sec-filing-evidence/1"] },
        {
          collector: "finnhub", enabled: true, intervalSeconds: 60, targetCount: 1,
          healthAdapterVersions: ["finnhub-news/1"],
        },
      ], now);
      expect(health).toMatchObject([
        { collector: "google_news_rss", state: "partial", latestResult: "partial", latestItemCount: 2 },
        { collector: "sec_edgar", state: "current", latestResult: "empty", latestDeliveryAt: startedAt + 3, coverageCount: 2 },
        { collector: "finnhub", state: "current", latestResult: "success", latestDeliveryAt: startedAt + 2 },
      ]);
      expect(db.deliverySummary().map((row) => row.collector)).not.toContain("demo_simulation");
      expect(db.deliverySummary().map((row) => row.collector)).not.toContain("legacy_unknown");
    } finally {
      db.close();
    }
  });

  it("keeps the rowid tie winner when the delivery summary limit cuts through a tied key", () => {
    const db = new Desk(":memory:");
    const now = 10_000_000;
    try {
      for (let i = 0; i < 58; i += 1) {
        db.recordDelivery({
          collector: "gdelt_doc_api", companyId: null, requestKey: `summary-newer-${i}`,
          startedAt: now - 3_000, completedAt: now - i - 1, result: "success",
          parsedItemCount: 100 + i, adapterVersion: "gdelt/1",
        });
      }
      for (let i = 1; i <= 4; i += 1) {
        db.recordDelivery({
          collector: "gdelt_doc_api", companyId: null, requestKey: `summary-tie-${i}`,
          startedAt: now - 2_000, completedAt: now - 1_000, result: "success",
          parsedItemCount: i, adapterVersion: "gdelt/1",
        });
      }

      const summary = db.deliverySummary();
      expect(summary).toHaveLength(60);
      expect(summary.slice(-2).map(({ parsedItemCount }) => parsedItemCount)).toEqual([4, 3]);
    } finally {
      db.close();
    }
  });

  it("keeps transport success separate from an incomplete observation-ingestion outcome", () => {
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    const startedAt = Date.now() - 100;
    const schedule = [{ collector: "google_news_rss" as const, enabled: true, intervalSeconds: 120, targetCount: 1 }];
    try {
      const deliveryId = db.recordDelivery({
        collector: "google_news_rss", companyId: company.id, requestKey: "test-feed",
        startedAt, completedAt: startedAt + 1, result: "success", parsedItemCount: 2,
        adapterVersion: "google_news_rss/2", processingRequired: true,
      });
      expect(db.deliveryHealth(schedule, startedAt + 2)[0]).toMatchObject({
        state: "failed", coverageCount: 0, latestResult: "success",
        latestIngestionRequired: true, latestIngestionState: null,
        latestError: "Observation ingestion did not start",
      });

      db.startDeliveryIngestion(deliveryId, 2, startedAt + 2);
      expect(db.deliveryHealth(schedule, startedAt + 3)[0]).toMatchObject({
        state: "processing", coverageCount: 0, latestIngestionState: "processing",
        latestIngestionExpectedCount: 2, latestIngestionProcessedCount: 0,
      });
      expect(db.deliveryHealth(schedule, startedAt + 500_000)[0]).toMatchObject({
        state: "failed", latestIngestionState: "processing",
        latestError: "Observation ingestion stopped before completion",
      });

      db.finishDeliveryIngestion(deliveryId, {
        status: "partial", processedCount: 1, insertedCount: 1,
        completedAt: startedAt + 4, error: "second item could not be saved",
      });
      expect(db.deliveryHealth(schedule, startedAt + 5)[0]).toMatchObject({
        state: "partial", coverageCount: 0, latestResult: "success",
        latestIngestionState: "partial", latestIngestionExpectedCount: 2,
        latestIngestionProcessedCount: 1, latestIngestionInsertedCount: 1,
        latestError: "second item could not be saved",
      });
      expect(() => db.finishDeliveryIngestion(deliveryId, {
        status: "success", processedCount: 2, insertedCount: 2,
      })).toThrow(/no active ingestion/);
    } finally {
      db.close();
    }
  });

  it("quarantines migrated RSS rows until their source collector is verified", () => {
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

    let db = new Desk(path, migrationTestLimits);
    try {
      expect(db.mentionRow("acme:old")).toBeUndefined();
      expect(db.mentionRow("acme:broken")).toBeUndefined();
      expect(db.mentionsForCompany("acme", 0, 10)).toEqual([]);
    } finally {
      db.close();
    }
    const migratedFile = new DatabaseSync(path);
    try {
      expect((migratedFile.prepare("SELECT COUNT(*) AS n FROM mentions_legacy_v1").get() as { n: number }).n).toBe(2);
      expect(migratedFile.prepare(
        "SELECT collector, time_basis FROM source_observations WHERE id = 'acme:old'",
      ).get()).toEqual({ collector: "legacy_unknown", time_basis: "legacy_unknown" });
      expect(migratedFile.prepare(
        "SELECT status, cost_usd, rubric_sha, scored_at FROM jev_judgments WHERE observation_id = 'acme:old'",
      ).get()).toEqual({ status: "scored", cost_usd: 0.0001, rubric_sha: "old-rubric", scored_at: 1700000000200 });
      expect((migratedFile.prepare(
        "SELECT status FROM jev_judgments WHERE observation_id = 'acme:broken'",
      ).get() as { status: string }).status).toBe("corrupt");
    } finally {
      migratedFile.close();
    }

    db = new Desk(path, migrationTestLimits);
    try {
      expect(db.mentionsForCompany("acme", 0, 10)).toEqual([]);
      expect(db.usageSince(0).judgedItems).toBe(0);
    } finally {
      db.close();
    }
  });

  it("migrates v2 retry fields and holds interrupted scoring as unknown instead of resubmitting", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-v2-retry-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path, migrationTestLimits);
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

    db = new Desk(path, migrationTestLimits);
    try {
      const recovered = db.mentionRow(observationId)!;
      expect(recovered.status).toBe("failed");
      expect(recovered.score_error).toContain("outcome is unknown");
      expect(recovered.score_retry_at).toBeNull();
      expect(db.pendingIds(10, ["google_news_rss"])).toEqual([]);
      expect(db.mentionsForCompany(company.id, 0, 10)[0]?.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("adds the delivery lineage column before creating its index on an older database", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-v5-lineage-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    const current = new Desk(path, migrationTestLimits);
    current.close();

    const priorVersion = new DatabaseSync(path);
    priorVersion.exec(`
      DROP VIEW mentions;
      DROP INDEX observations_delivery;
      DROP TRIGGER source_observations_no_update;
      DROP TRIGGER source_observations_no_delete;
      ALTER TABLE source_observations DROP COLUMN delivery_id;
      PRAGMA user_version = 5;
    `);
    priorVersion.close();

    const migrated = new Desk(path, migrationTestLimits);
    try {
      const columns = migrated.mentionRow("missing") ?? null;
      expect(columns).toBeNull();
    } finally {
      migrated.close();
    }

    const verify = new DatabaseSync(path);
    try {
      expect(verify.prepare("PRAGMA table_info(source_observations)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "delivery_id" })]));
      expect(verify.prepare("PRAGMA index_list(source_observations)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "observations_delivery" })]));
    } finally {
      verify.close();
    }
  });

  it("does not count a global bootstrap receipt as company delivery coverage", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-delivery-coverage-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    const beta: Company = {
      id: "beta", name: "Beta", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321",
    };
    const startedAt = Date.now() - 100;
    const source = { collector: "sec_edgar" as const, intervalSeconds: 60, targetCount: 2, enabled: true };
    try {
      db.seedCompanies([company, beta]);
      db.recordDelivery({
        collector: "sec_edgar", companyId: null, requestKey: "ticker-directory", startedAt,
        completedAt: startedAt + 1, result: "success", parsedItemCount: 2,
        adapterVersion: "sec-company-tickers/1",
      });
      db.recordDelivery({
        collector: "sec_edgar", companyId: company.id, requestKey: "acme-submissions", startedAt,
        completedAt: startedAt + 2, result: "empty", parsedItemCount: 0,
        adapterVersion: "sec-submissions/1",
      });

      expect(db.deliveryHealth([source], startedAt + 50)[0])
        .toMatchObject({ state: "partial", coverageCount: 1, targetCount: 2 });

      db.recordDelivery({
        collector: "sec_edgar", companyId: company.id, requestKey: "acme-submissions-repeat", startedAt,
        completedAt: startedAt + 3, result: "empty", parsedItemCount: 0,
        adapterVersion: "sec-submissions/1",
      });
      expect(db.deliveryHealth([source], startedAt + 50)[0])
        .toMatchObject({ state: "partial", coverageCount: 1, targetCount: 2 });

      db.recordDelivery({
        collector: "sec_edgar", companyId: beta.id, requestKey: "beta-submissions", startedAt,
        completedAt: startedAt + 4, result: "empty", parsedItemCount: 0,
        adapterVersion: "sec-submissions/1",
      });
      expect(db.deliveryHealth([source], startedAt + 50)[0])
        .toMatchObject({ state: "current", coverageCount: 2, targetCount: 2 });
    } finally {
      db.close();
    }
  });

  it("exposes the latest recent degradation when a later company delivery succeeded", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-degraded-error-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    const beta: Company = {
      id: "beta", name: "Beta", ticker: "BETA", sector: "Technology", aliases: ["Beta"], color: "#654321",
    };
    const startedAt = Date.now() - 100;
    try {
      db.seedCompanies([company, beta]);
      db.recordDelivery({
        collector: "sec_edgar", companyId: company.id, requestKey: "alpha-failure", startedAt,
        completedAt: startedAt + 1, result: "failed", parsedItemCount: 0,
        adapterVersion: "sec-submissions/1", error: "Alpha SEC request failed",
      });
      db.recordDelivery({
        collector: "sec_edgar", companyId: beta.id, requestKey: "beta-success", startedAt,
        completedAt: startedAt + 2, result: "empty", parsedItemCount: 0,
        adapterVersion: "sec-submissions/1",
      });

      expect(db.deliveryHealth([{
        collector: "sec_edgar", enabled: true, intervalSeconds: 60, targetCount: 1,
      }], startedAt + 50)[0]).toMatchObject({
        state: "failed", latestResult: "empty", latestError: "Alpha SEC request failed",
      });
    } finally {
      db.close();
    }
  });

  it("does not count Finnhub earnings receipts as company-news coverage", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-finnhub-coverage-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    const startedAt = Date.now() - 100;
    const source = {
      collector: "finnhub" as const,
      intervalSeconds: 60,
      targetCount: 1,
      enabled: true,
      healthAdapterVersions: ["finnhub-news/1"],
    };
    try {
      db.seedCompanies([company]);
      db.recordDelivery({
        collector: "finnhub", companyId: null, requestKey: "earnings-calendar", startedAt,
        completedAt: startedAt + 1, result: "success", parsedItemCount: 0,
        adapterVersion: "finnhub-calendar/1",
      });
      db.recordDelivery({
        collector: "finnhub", companyId: company.id, requestKey: "earnings-history", startedAt,
        completedAt: startedAt + 2, result: "success", parsedItemCount: 2,
        adapterVersion: "finnhub-earnings/1",
      });
      expect(db.deliveryHealth([source], startedAt + 50)[0])
        .toMatchObject({ state: "never", coverageCount: 0, targetCount: 1 });

      db.recordDelivery({
        collector: "finnhub", companyId: company.id, requestKey: "company-news", startedAt,
        completedAt: startedAt + 3, result: "empty", parsedItemCount: 0,
        adapterVersion: "finnhub-news/1",
      });
      expect(db.deliveryHealth([source], startedAt + 50)[0])
        .toMatchObject({ state: "current", coverageCount: 1, targetCount: 1 });

      db.recordDelivery({
        collector: "finnhub", companyId: null, requestKey: "earnings-calendar-error", startedAt,
        completedAt: startedAt + 4, result: "failed", parsedItemCount: 0,
        adapterVersion: "finnhub-calendar/1", error: "test-only failure",
      });
      db.recordDelivery({
        collector: "finnhub", companyId: company.id, requestKey: "earnings-history-partial", startedAt,
        completedAt: startedAt + 5, result: "partial", parsedItemCount: 1,
        adapterVersion: "finnhub-earnings/1", error: "test-only partial",
      });
      expect(db.deliveryHealth([source], startedAt + 50)[0])
        .toMatchObject({ state: "current", coverageCount: 1, latestResult: "empty" });
    } finally {
      db.close();
    }
  });

  it("keeps failed auxiliary Yahoo receipts out of company quote health", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-yahoo-coverage-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    const startedAt = Date.now() - 100;
    try {
      db.seedCompanies([company]);
      db.recordDelivery({
        collector: "yahoo_quote", companyId: company.id, requestKey: "company-quote", startedAt,
        completedAt: startedAt + 1, result: "success", parsedItemCount: 1,
        adapterVersion: "yahoo-chart/1",
      });
      db.recordDelivery({
        collector: "yahoo_quote", companyId: null, requestKey: "index-quote", startedAt,
        completedAt: startedAt + 2, result: "failed", parsedItemCount: 0,
        adapterVersion: "yahoo-chart/1", error: "index unavailable",
      });

      expect(db.deliveryHealth([{
        collector: "yahoo_quote", enabled: true, intervalSeconds: 60, targetCount: 1,
        healthCompanyOnly: true,
      }], startedAt + 50)[0]).toMatchObject({
        state: "current", coverageCount: 1, latestResult: "success", latestError: null,
      });
    } finally {
      db.close();
    }
  });
});
