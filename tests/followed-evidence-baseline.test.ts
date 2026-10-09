import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { FollowedBaselineConflictError } from "../server/db.js";
import { TestDesk as Desk } from "./test-desk.js";
import type { Company, RawMention } from "../server/types.js";

const directories: string[] = [];
const company: Company = {
  id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};
const adapterVersion = "test-source/1";
const migrationLimits = {
  maxDatabaseBytes: 64 * 1024 * 1024,
  maxFamilyBytes: 128 * 1024 * 1024,
  minimumFreeBytes: 1,
  writeHeadroomBytes: 1,
};

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function observationInput(id: string, times: {
  publishedAt: number | null; retrievedAt: number; providerObservedAt?: number | null;
}, deliveryId?: string): RawMention {
  return {
    companyId: company.id,
    kind: "finnhub",
    sourceName: "Test publisher",
    sourceUrl: `https://publisher.example/research/${id}`,
    tier: "major",
    title: `Source item ${id}`,
    snippet: `Isolated database fixture ${id}`,
    publishedAt: times.publishedAt,
    retrievedAt: times.retrievedAt,
    providerObservedAt: times.providerObservedAt ?? undefined,
    collector: "finnhub",
    sourceItemId: id,
    publisherName: "Test publisher",
    publisherDomain: "publisher.example",
    adapterVersion,
    deliveryId,
  };
}

function persistReceiptBackedObservation(db: Desk, id: string, options: {
  deliveryResult?: "success" | "partial";
  ingestionStatus?: "success" | "partial" | "failed";
  publishedAt?: number | null;
  retrievedAt?: number;
} = {}): string {
  const now = Date.now();
  const deliveryId = db.recordDelivery({
    collector: "finnhub",
    companyId: company.id,
    requestKey: `fixture-${id}`,
    startedAt: now - 10,
    completedAt: now - 5,
    result: options.deliveryResult ?? "success",
    parsedItemCount: 1,
    adapterVersion,
    processingRequired: true,
  });
  db.startDeliveryIngestion(deliveryId, 1, now - 4);
  const inserted = db.insertObservation(observationInput(id, {
    publishedAt: options.publishedAt === undefined ? now - 1 : options.publishedAt,
    retrievedAt: options.retrievedAt ?? now - 1,
    providerObservedAt: now - 2,
  }, deliveryId));
  db.finishDeliveryIngestion(deliveryId, {
    status: options.ingestionStatus ?? "success",
    processedCount: 1,
    insertedCount: 1,
    completedAt: now,
  });
  return inserted.observationId;
}

function persistProcessingObservation(db: Desk, id: string): { observationId: string; deliveryId: string } {
  const now = Date.now();
  const deliveryId = db.recordDelivery({
    collector: "finnhub", companyId: company.id, requestKey: `fixture-processing-${id}`,
    startedAt: now - 10, completedAt: now - 5, result: "success", parsedItemCount: 1,
    adapterVersion, processingRequired: true,
  });
  db.startDeliveryIngestion(deliveryId, 1, now - 4);
  const inserted = db.insertObservation(observationInput(id, {
    publishedAt: now - 3, retrievedAt: now - 2, providerObservedAt: now - 3,
  }, deliveryId));
  return { observationId: inserted.observationId, deliveryId };
}

function persistReceiptWithoutRequiredIngestion(db: Desk, id: string): string {
  const now = Date.now();
  const deliveryId = db.recordDelivery({
    collector: "finnhub", companyId: company.id, requestKey: `fixture-no-processing-${id}`,
    startedAt: now - 10, completedAt: now - 5, result: "success", parsedItemCount: 1,
    adapterVersion, processingRequired: false,
  });
  return db.insertObservation(observationInput(id, {
    publishedAt: now - 3, retrievedAt: now - 2, providerObservedAt: now - 3,
  }, deliveryId)).observationId;
}

describe("followed-company evidence baseline", () => {
  it("captures exact receipt-backed terminal ingestion IDs and labels late evidence without judging materiality", () => {
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-04T08:00:00.000Z");
    vi.setSystemTime(t0);
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    try {
      const eligibleSuccess = persistReceiptBackedObservation(db, "baseline-success");
      const eligiblePartial = persistReceiptBackedObservation(db, "baseline-partial", {
        deliveryResult: "partial", ingestionStatus: "partial",
      });
      const unlinked = db.insertObservation(observationInput("unlinked-history", {
        publishedAt: t0 - 30_000, retrievedAt: t0 - 10_000,
      })).observationId;
      const failedIngestion = persistReceiptBackedObservation(db, "failed-ingestion", { ingestionStatus: "failed" });
      const stillProcessing = persistProcessingObservation(db, "processing-at-capture");
      const noRequiredIngestion = persistReceiptWithoutRequiredIngestion(db, "ingestion-not-required");

      const captureKey = randomUUID();
      const captured = db.captureFollowedCompanyBaseline({ companyId: company.id, captureKey, expectedBaselineId: null });
      expect(captured.reused).toBe(false);
      expect(captured.baseline).toMatchObject({ version: 1, eligibleObservationCount: 2, policyVersion: "receipt-ingestion-success/1" });
      expect(db.captureFollowedCompanyBaseline({ companyId: company.id, captureKey, expectedBaselineId: null }))
        .toMatchObject({ reused: true, baseline: { id: captured.baseline.id } });

      const raw = (db as unknown as { db: DatabaseSync }).db;
      const exactIds = raw.prepare(
        "SELECT observation_id AS id FROM followed_company_baseline_items WHERE baseline_id = ? ORDER BY observation_id",
      ).all(captured.baseline.id) as Array<{ id: string }>;
      expect(exactIds.map((row) => row.id).sort()).toEqual([eligibleSuccess, eligiblePartial].sort());
      expect(exactIds.map((row) => row.id)).not.toContain(unlinked);
      expect(exactIds.map((row) => row.id)).not.toContain(failedIngestion);
      expect(exactIds.map((row) => row.id)).not.toContain(stillProcessing.observationId);
      expect(exactIds.map((row) => row.id)).not.toContain(noRequiredIngestion);

      vi.setSystemTime(t0 + 15_000);
      db.finishDeliveryIngestion(stillProcessing.deliveryId, {
        status: "success", processedCount: 1, insertedCount: 1, completedAt: t0 + 15_000,
      });
      vi.setSystemTime(t0 + 60_000);
      const lateId = persistReceiptBackedObservation(db, "late-published", {
        publishedAt: t0 - 5_000,
        retrievedAt: t0 + 30_000,
      });
      const page = db.followedCompanyEvidence({ companyId: company.id, limit: 10, cursor: null });
      expect(page).toMatchObject({
        baseline: { id: captured.baseline.id },
        eligibleObservationsNow: 4,
        withheldFromBaseline: 3,
        newEvidenceCount: 2,
      });
      expect(page.items[0]).toMatchObject({
        id: lateId, publishedAt: t0 - 5_000, retrievedAt: t0 + 30_000,
        providerObservedAt: t0 + 59_998, publishedBeforeBaseline: true,
      });
      expect(page.items[0]?.status).toBe("pending");
      expect(page.items[0]?.source.deliveryId).toBeTruthy();
      const delayed = page.items.find((item) => item.id === stillProcessing.observationId);
      expect(delayed).toMatchObject({ ingestionFinalizedAfterBaseline: true, ingestionCompletedAt: t0 + 15_000 });
    } finally {
      db.close();
    }
  });

  it("paginates a fixed read snapshot, then invalidates the cursor after a new baseline version", () => {
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-04T09:00:00.000Z");
    vi.setSystemTime(t0);
    const db = new Desk(":memory:");
    db.seedCompanies([company]);
    try {
      persistReceiptBackedObservation(db, "before-baseline");
      const firstBaseline = db.captureFollowedCompanyBaseline({
        companyId: company.id, captureKey: randomUUID(), expectedBaselineId: null,
      }).baseline;
      vi.setSystemTime(t0 + 10_000);
      const olderNewId = persistReceiptBackedObservation(db, "new-older");
      vi.setSystemTime(t0 + 20_000);
      const newerNewId = persistReceiptBackedObservation(db, "newer");
      const firstPage = db.followedCompanyEvidence({ companyId: company.id, limit: 1, cursor: null });
      expect(firstPage.items.map((item) => item.id)).toEqual([newerNewId]);
      expect(firstPage.newEvidenceCount).toBe(2);
      expect(firstPage.nextCursor).not.toBeNull();

      vi.setSystemTime(t0 + 30_000);
      const laterRowId = persistReceiptBackedObservation(db, "after-first-page");
      db.insertObservation(observationInput("unlinked-after-first-page", {
        publishedAt: t0 + 25_000, retrievedAt: t0 + 25_001,
      }));
      const secondPage = db.followedCompanyEvidence({ companyId: company.id, limit: 1, cursor: firstPage.nextCursor });
      expect(secondPage.items.map((item) => item.id)).toEqual([olderNewId]);
      expect(secondPage.newEvidenceCount).toBe(2);
      expect(secondPage.eligibleObservationsNow).toBe(3);
      expect(secondPage.withheldFromBaseline).toBe(0);
      expect(secondPage.items.map((item) => item.id)).not.toContain(laterRowId);
      expect(secondPage.nextCursor).toBeNull();

      const secondBaseline = db.captureFollowedCompanyBaseline({
        companyId: company.id, captureKey: randomUUID(), expectedBaselineId: firstBaseline.id,
      }).baseline;
      expect(secondBaseline.version).toBe(2);
      expect(secondBaseline.eligibleObservationCount).toBe(4);
      expect(db.followedCompanyEvidence({ companyId: company.id, limit: 10, cursor: null })).toMatchObject({ newEvidenceCount: 0, items: [] });
      expect(() => db.followedCompanyEvidence({ companyId: company.id, limit: 1, cursor: firstPage.nextCursor }))
        .toThrow(FollowedBaselineConflictError);
      expect(() => db.captureFollowedCompanyBaseline({
        companyId: company.id, captureKey: randomUUID(), expectedBaselineId: firstBaseline.id,
      })).toThrow(FollowedBaselineConflictError);

      const raw = (db as unknown as { db: DatabaseSync }).db;
      expect(raw.prepare("SELECT version FROM followed_company_baselines WHERE company_id = ? ORDER BY version").all(company.id))
        .toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      db.close();
    }
  });

  it("keeps exact IDs across restart and rejects edits to captured baseline records", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-followed-baseline-restart-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path, migrationLimits);
    db.seedCompanies([company]);
    const observationId = persistReceiptBackedObservation(db, "persistent-baseline-item");
    const baseline = db.captureFollowedCompanyBaseline({
      companyId: company.id, captureKey: randomUUID(), expectedBaselineId: null,
    }).baseline;
    const raw = (db as unknown as { db: DatabaseSync }).db;
    expect(() => raw.prepare("UPDATE followed_company_baselines SET captured_at = 0 WHERE id = ?").run(baseline.id))
      .toThrow("followed company baselines are immutable");
    expect(() => raw.prepare("DELETE FROM followed_company_baseline_items WHERE baseline_id = ?").run(baseline.id))
      .toThrow("followed company baseline items are immutable");
    db.close();

    db = new Desk(path, migrationLimits);
    try {
      expect(db.followedCompanyEvidence({ companyId: company.id, limit: 10, cursor: null })).toMatchObject({
        baseline: { id: baseline.id, version: 1, eligibleObservationCount: 1 },
        eligibleObservationsNow: 1, newEvidenceCount: 0, items: [],
      });
      const persistedItems = ((db as unknown as { db: DatabaseSync }).db).prepare(
        "SELECT observation_id AS id FROM followed_company_baseline_items WHERE baseline_id = ?",
      ).all(baseline.id) as Array<{ id: string }>;
      expect(persistedItems).toEqual([{ id: observationId }]);
    } finally {
      db.close();
    }
  });

  it("migrates a saved v13 database additively and refuses to downgrade a future schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-followed-baseline-migration-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    let db = new Desk(path, migrationLimits);
    db.seedCompanies([company]);
    const existingId = db.insertObservation(observationInput("kept-across-migration", {
      publishedAt: Date.now() - 1000, retrievedAt: Date.now() - 500,
    })).observationId;
    db.close();

    const priorVersion = new DatabaseSync(path);
    priorVersion.exec(`
      ALTER TABLE sec_fundamental_facts DROP COLUMN reported_precision_status;
      ALTER TABLE sec_fundamental_facts DROP COLUMN reported_decimals;
      PRAGMA user_version = 13;
    `);
    priorVersion.close();

    db = new Desk(path, migrationLimits);
    try {
      expect(db.mentionRow(existingId)).toBeTruthy();
      const upgraded = (db as unknown as { db: DatabaseSync }).db;
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='followed_company_baseline_items'").get())
        .toEqual({ name: "followed_company_baseline_items" });
      const factColumns = new Map((upgraded.prepare("PRAGMA table_info(sec_fundamental_facts)").all() as Array<{ name: string; dflt_value: string | null }>)
        .map((column) => [column.name, column.dflt_value]));
      expect(factColumns.has("reported_decimals")).toBe(true);
      expect(factColumns.get("reported_precision_status")).toBe("'missing'");
    } finally {
      db.close();
    }

    const future = new DatabaseSync(path);
    future.exec("PRAGMA user_version = 18");
    future.close();
    expect(() => new Desk(path, migrationLimits)).toThrow("unsupported_database_schema_version_18");
    const preserved = new DatabaseSync(path);
    expect(preserved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    preserved.close();
  });
});
