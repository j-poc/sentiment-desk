import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { TestDesk as Desk } from "./test-desk.js";
import { StorageCapacityError, type StorageLimits } from "../server/storage-capacity.js";
import { HealthTracker } from "../server/health.js";
import { startRssPoller } from "../server/schedule.js";
import { installExternalRequestGate } from "../server/external-request-gate.js";
import type { Company } from "../server/types.js";

const directories: string[] = [];
const databases: Desk[] = [];
const readers: DatabaseSync[] = [];
const company: Company = { id: "acme", name: "Acme Corporation", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };

const testStorageLimits: StorageLimits = {
  maxDatabaseBytes: 16 * 1024 * 1024,
  maxFamilyBytes: 32 * 1024 * 1024,
  minimumFreeBytes: 1024 * 1024,
  writeHeadroomBytes: 1024 * 1024,
};

function temporaryDatabase(limits?: Readonly<StorageLimits>): { path: string; db: Desk } {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-storage-capacity-"));
  directories.push(directory);
  const path = join(directory, "desk.db");
  const db = new Desk(path, limits ?? testStorageLimits);
  databases.push(db);
  return { path, db };
}

const tightLimits = testStorageLimits;

function fillUntilCollectionPauses(db: Desk): number {
  const value = "x".repeat(64 * 1024);
  for (let index = 0; index < 1_000; index += 1) {
    db.setKv(`capacity-fixture:${index}`, value);
    if (!db.canStartExternalWork()) return index;
  }
  throw new Error("temporary SQLite database did not reach its test capacity");
}

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("SQLite storage capacity boundary", () => {
  it("initializes a fresh database without reserving its entire future size ceiling", () => {
    const largeDatabaseLimits: StorageLimits = {
      maxDatabaseBytes: 8 * 1024 ** 3,
      maxFamilyBytes: 9 * 1024 ** 3,
      minimumFreeBytes: 1,
      writeHeadroomBytes: 1,
    };
    const { db } = temporaryDatabase(largeDatabaseLimits);
    expect(db.storageCapacity()).toMatchObject({ state: "ready", canStartExternalWork: true, writesAllowed: true });
  });

  it("pauses new collection at the reserve, allows bounded completion, and serves saved rows", async () => {
    const { db } = temporaryDatabase(tightLimits);
    db.seedCompanies([company]);
    const lastFixture = fillUntilCollectionPauses(db);
    const paused = db.storageCapacity();
    expect(paused.state).toBe("capacity_paused");
    expect(paused.canStartExternalWork).toBe(false);
    expect(paused.writesAllowed).toBe(true);
    expect(paused.maxPageCount).toBe(Math.floor(tightLimits.maxDatabaseBytes / paused.pageSize!));
    expect(paused.logicalDatabaseBytes).toBe(paused.pageCount! * paused.pageSize!);
    expect(db.getKv("capacity-fixture:0")).toBe("x".repeat(64 * 1024));

    const fetchFeed = vi.fn(async () => ({ items: [], providerItemCount: 0, malformedItemCount: 0 }));
    const poller = startRssPoller({
      companies: [company], db, pipeline: {} as never, health: new HealthTracker(false, false, "unconfigured"),
      intervalSeconds: 60, concurrency: 1, fetchFeed,
    });
    await poller.stop();
    expect(fetchFeed).not.toHaveBeenCalled();
    expect(db.deliverySummary()).toHaveLength(0);

    db.logEvent("info", "storage-test", "finish already-admitted work");
    expect(db.getKv(`capacity-fixture:${lastFixture}`)).toBe("x".repeat(64 * 1024));
    expect(db.storageCapacity().state).toBe("capacity_paused");
  });

  it("records the first HTTP hop when storage pauses before a same-origin redirect follow-up", async () => {
    const { db } = temporaryDatabase();
    db.seedCompanies([company]);
    const transport = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "/redirected-feed" },
    }));
    vi.stubGlobal("fetch", transport as typeof fetch);
    let admissionChecks = 0;
    const uninstall = installExternalRequestGate(() => ++admissionChecks === 1);
    const poller = startRssPoller({
      companies: [company], db, pipeline: {} as never, health: new HealthTracker(false, false, "unconfigured"),
      intervalSeconds: 60, concurrency: 1, enabledCollectors: new Set(["google_news_rss"]),
      fetchFeed: async (url) => {
        await fetch(url);
        return { items: [], providerItemCount: 0, malformedItemCount: 0 };
      },
    });
    try {
      await poller.stop();
      expect(admissionChecks).toBe(2);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(db.deliverySummary()).toMatchObject([{
        collector: "google_news_rss", result: "failed", parsedItemCount: 0,
        error: expect.stringContaining("1 request hop(s) were sent"),
      }]);
      expect(db.deliveryHealth([
        { collector: "google_news_rss", enabled: true, intervalSeconds: 60, targetCount: 1 },
      ])[0]).toMatchObject({ state: "failed", latestResult: "failed" });
    } finally {
      uninstall();
      vi.unstubAllGlobals();
    }
  });

  it("translates the hard SQLite page ceiling and reopens the full database read-only", () => {
    const { path, db } = temporaryDatabase(tightLimits);
    db.seedCompanies([company]);
    db.setKv("retained-before-full", "readable");
    fillUntilCollectionPauses(db);

    let fullError: unknown;
    for (let index = 1_000; index < 2_000; index += 1) {
      try {
        db.setKv(`capacity-hard-limit:${index}`, "y".repeat(64 * 1024));
      } catch (error) {
        fullError = error;
        break;
      }
    }
    expect(fullError).toBeInstanceOf(StorageCapacityError);
    expect((fullError as StorageCapacityError).status.mainBytes).toBeLessThan(tightLimits.maxDatabaseBytes);
    expect((fullError as StorageCapacityError).status.logicalDatabaseBytes).toBeLessThanOrEqual(tightLimits.maxDatabaseBytes);
    expect((fullError as StorageCapacityError).status.maxPageCount).toBe(Math.floor(tightLimits.maxDatabaseBytes / 4096));
    expect(db.getKv("retained-before-full")).toBe("readable");

    db.close();
    const readOnly = new Desk(path, tightLimits);
    databases.push(readOnly);
    expect(readOnly.storageCapacity()).toMatchObject({ state: "capacity_paused", canStartExternalWork: false, writesAllowed: false });
    expect(readOnly.getKv("retained-before-full")).toBe("readable");
    expect(() => readOnly.setKv("must-not-write", "blocked")).toThrow(StorageCapacityError);
  });

  it("holds external work when a reader prevents WAL truncation, then recovers after release", () => {
    const { path, db } = temporaryDatabase();
    expect(db.prepareExternalWork()).toBe(true);
    const reader = new DatabaseSync(path);
    readers.push(reader);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM kv").get();
    db.setKv("written-after-reader-snapshot", "value");

    expect(db.prepareExternalWork()).toBe(false);
    expect(db.storageCapacity()).toMatchObject({ state: "checkpoint_blocked", canStartExternalWork: false });
    reader.exec("ROLLBACK");
    expect(db.prepareExternalWork()).toBe(true);
    expect(db.storageCapacity().state).toBe("ready");
  });

  it("opens a competing Desk read-only and holds one SQLite writer lock across processes and symlink aliases", () => {
    const { path, db } = temporaryDatabase();
    db.setKv("writer-owner", "saved");
    const competing = new Desk(path, tightLimits);
    databases.push(competing);
    expect(competing.storageCapacity()).toMatchObject({ state: "capacity_paused", canStartExternalWork: false, writesAllowed: false });
    expect(competing.storageCapacity().reason).toContain("Another Sentiment Desk process owns the database writer lock");
    expect(competing.getKv("writer-owner")).toBe("saved");
    expect(() => competing.setKv("second-writer", "blocked")).toThrow(StorageCapacityError);

    const alias = join(dirname(path), "desk-alias.db");
    symlinkSync(path, alias);
    const linked = new Desk(alias, tightLimits);
    databases.push(linked);
    expect(linked.storageCapacity().canStartExternalWork).toBe(false);
    const linkedDatabase = (linked as unknown as { db: DatabaseSync }).db;
    expect((linkedDatabase.prepare("PRAGMA database_list").get() as { file: string }).file).toBe(realpathSync(path));
    expect(linked.getKv("writer-owner")).toBe("saved");

    const childScript = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{timeout:0}); try { db.exec('BEGIN EXCLUSIVE'); db.exec('ROLLBACK'); process.exitCode=1; } catch (e) { process.exitCode=((e.errcode||0)&255)===5 ? 0 : 2; } finally { db.close(); }`;
    const childWhileOwned = spawnSync(process.execPath, ["-e", childScript, `${path}.writer-lock.sqlite`], { encoding: "utf8", timeout: 5_000 });
    expect(childWhileOwned.status, childWhileOwned.stderr).toBe(0);

    competing.close();
    linked.close();
    db.close();
    const childAfterRelease = spawnSync(process.execPath, ["-e", childScript, `${path}.writer-lock.sqlite`], { encoding: "utf8", timeout: 5_000 });
    expect(childAfterRelease.status, childAfterRelease.stderr).toBe(1);
  });

  it("uses logical WAL-backed pages during startup and leaves an oversized compatible database readable", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-wal-preflight-"));
    directories.push(directory);
    const path = join(directory, "desk.db");
    const largerLimits: StorageLimits = { ...tightLimits, maxDatabaseBytes: 64 * 1024 * 1024, maxFamilyBytes: 128 * 1024 * 1024 };
    const owner = new Desk(path, largerLimits);
    databases.push(owner);
    owner.setKv("wal-marker", "before reader");
    const reader = new DatabaseSync(path, { readOnly: true });
    readers.push(reader);
    reader.exec("BEGIN");
    reader.prepare("SELECT value FROM kv WHERE key='wal-marker'").get();
    for (let index = 0; index < 300; index += 1) owner.setKv(`wal-page:${index}`, "w".repeat(64 * 1024));

    const beforeClose = owner.storageCapacity();
    expect(beforeClose.logicalDatabaseBytes).toBeGreaterThan(tightLimits.maxDatabaseBytes);
    expect(beforeClose.mainBytes).toBeLessThan(tightLimits.maxDatabaseBytes);
    owner.close();

    const limited = new Desk(path, tightLimits);
    databases.push(limited);
    const measured = limited.storageCapacity();
    expect(measured).toMatchObject({ state: "capacity_paused", canStartExternalWork: false, writesAllowed: false });
    expect(measured.logicalDatabaseBytes).toBeGreaterThan(tightLimits.maxDatabaseBytes);
    expect(limited.getKv("wal-page:299")).toBe("w".repeat(64 * 1024));
  });
});
