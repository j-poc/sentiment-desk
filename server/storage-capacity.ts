import { existsSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type StorageState = "ready" | "capacity_paused" | "disk_pressure" | "checkpoint_blocked" | "measurement_failed";

export interface StorageLimits {
  maxDatabaseBytes: number;
  maxFamilyBytes: number;
  minimumFreeBytes: number;
  writeHeadroomBytes: number;
}

export interface StorageStatus {
  state: StorageState;
  canStartExternalWork: boolean;
  writesAllowed: boolean;
  reason: string | null;
  mainBytes: number | null;
  walBytes: number | null;
  shmBytes: number | null;
  journalBytes: number | null;
  familyBytes: number | null;
  allocatedBytes: number | null;
  availableBytes: number | null;
  logicalDatabaseBytes: number | null;
  pageCount: number | null;
  pageSize: number | null;
  maxPageCount: number | null;
  maxDatabaseBytes: number;
  maxFamilyBytes: number;
  minimumFreeBytes: number;
  writeHeadroomBytes: number;
  checkedAt: number;
}

const MIB = 1024 * 1024;
export const DEFAULT_STORAGE_LIMITS: Readonly<StorageLimits> = Object.freeze({
  maxDatabaseBytes: 2_048 * MIB,
  maxFamilyBytes: 5_120 * MIB,
  minimumFreeBytes: 1_024 * MIB,
  writeHeadroomBytes: 128 * MIB,
});

type FileMeasurement = Pick<StorageStatus,
  "mainBytes" | "walBytes" | "shmBytes" | "journalBytes" | "familyBytes" | "allocatedBytes" | "availableBytes">;

function numberFromBigInt(value: bigint): number | null {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function fileSize(filePath: string): { logical: bigint; allocated: bigint } {
  try {
    const stat = statSync(filePath, { bigint: true });
    return { logical: stat.size, allocated: stat.blocks * 512n };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { logical: 0n, allocated: 0n };
    throw error;
  }
}

function measureFiles(databasePath: string): FileMeasurement {
  const main = fileSize(databasePath);
  const wal = fileSize(`${databasePath}-wal`);
  const shm = fileSize(`${databasePath}-shm`);
  const journal = fileSize(`${databasePath}-journal`);
  const disk = statfsSync(path.dirname(databasePath), { bigint: true });
  return {
    mainBytes: numberFromBigInt(main.logical),
    walBytes: numberFromBigInt(wal.logical),
    shmBytes: numberFromBigInt(shm.logical),
    journalBytes: numberFromBigInt(journal.logical),
    familyBytes: numberFromBigInt(main.logical + wal.logical + shm.logical + journal.logical),
    allocatedBytes: numberFromBigInt(main.allocated + wal.allocated + shm.allocated + journal.allocated),
    availableBytes: numberFromBigInt(disk.bavail * disk.bsize),
  };
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function numericRow(db: DatabaseSync, pragma: string, field: string): number | null {
  const value = (db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number | bigint> | undefined)?.[field];
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Bounds the app-owned SQLite file family and reserves headroom before new work. */
export class StorageCapacity {
  private blockedCheckpoint = false;
  private readOnlyReason: string | null = null;
  private readOnlyState: StorageState = "capacity_paused";
  private expectedMaxPageCount: number | null = null;

  constructor(readonly databasePath: string, readonly limits: Readonly<StorageLimits> = DEFAULT_STORAGE_LIMITS) {
    positiveSafeInteger(limits.maxDatabaseBytes, "maxDatabaseBytes");
    positiveSafeInteger(limits.maxFamilyBytes, "maxFamilyBytes");
    positiveSafeInteger(limits.minimumFreeBytes, "minimumFreeBytes");
    positiveSafeInteger(limits.writeHeadroomBytes, "writeHeadroomBytes");
    if (limits.maxFamilyBytes <= limits.maxDatabaseBytes || limits.maxDatabaseBytes <= limits.writeHeadroomBytes) {
      throw new Error("storage family and database limits must leave positive write headroom");
    }
  }

  hasDatabaseFile(): boolean {
    return existsSync(this.databasePath);
  }

  /** Read-only filesystem preflight, used before opening or migrating a database. */
  preflight(startup = false, db?: DatabaseSync, requireFullDatabaseReserve = startup): StorageStatus {
    try {
      const pageCount = db ? numericRow(db, "page_count", "page_count") : null;
      const pageSize = db ? numericRow(db, "page_size", "page_size") : null;
      const maxPageCount = db ? numericRow(db, "max_page_count", "max_page_count") : null;
      if (db && (pageCount == null || pageSize == null || maxPageCount == null)) {
        return this.failureStatus(Date.now(), "SQLite logical database size could not be measured; collection and migration remain paused.");
      }
      return this.buildStatus(
        measureFiles(this.databasePath), Date.now(), pageCount, pageSize, false, startup, maxPageCount,
        requireFullDatabaseReserve,
      );
    } catch {
      return this.failureStatus(Date.now(), "The database volume could not be measured; collection and classification remain paused.");
    }
  }

  /** Applies and verifies SQLite's hard logical-page ceiling before schema work. */
  configurePageLimit(db: DatabaseSync): void {
    const pageSize = numericRow(db, "page_size", "page_size");
    if (pageSize == null || pageSize < 512) throw new Error("SQLite returned an invalid page size");
    const maxPageCount = Math.floor(this.limits.maxDatabaseBytes / pageSize);
    if (maxPageCount < 1) throw new Error("SQLite storage limit is smaller than one database page");
    this.expectedMaxPageCount = maxPageCount;
    db.exec(`PRAGMA max_page_count = ${maxPageCount}`);
    const applied = numericRow(db, "max_page_count", "max_page_count");
    if (applied !== maxPageCount) {
      throw new Error(`SQLite database already exceeds the configured ${this.limits.maxDatabaseBytes}-byte page ceiling`);
    }
    db.exec("PRAGMA wal_autocheckpoint = 256");
    db.exec("PRAGMA journal_size_limit = 8388608");
  }

  status(db: DatabaseSync, readOnly = false): StorageStatus {
    let pageCount: number | null = null;
    let pageSize: number | null = null;
    let maxPageCount: number | null = null;
    try {
      pageCount = numericRow(db, "page_count", "page_count");
      pageSize = numericRow(db, "page_size", "page_size");
      maxPageCount = numericRow(db, "max_page_count", "max_page_count");
    } catch {
      return this.failureStatus(Date.now(), "SQLite storage limits could not be read");
    }
    if (pageCount == null || pageSize == null || maxPageCount == null) {
      return this.failureStatus(Date.now(), "SQLite storage limits could not be read");
    }
    let disk: FileMeasurement;
    try {
      disk = measureFiles(this.databasePath);
    } catch {
      return this.failureStatus(Date.now(), "The database volume could not be measured; collection and classification remain paused.");
    }
    const result = this.buildStatus(disk, Date.now(), pageCount, pageSize, readOnly, false, maxPageCount);
    if (this.blockedCheckpoint && result.state === "ready") {
      return { ...result, state: "checkpoint_blocked", canStartExternalWork: false, reason: "A WAL checkpoint could not complete; close long-running database readers and retry." };
    }
    if (this.readOnlyReason) {
      return { ...result, state: this.readOnlyState, canStartExternalWork: false, writesAllowed: false, reason: this.readOnlyReason };
    }
    return result;
  }

  canWrite(readOnly = false): boolean {
    if (readOnly) return false;
    try {
      const disk = measureFiles(this.databasePath);
      return disk.mainBytes != null && disk.familyBytes != null && disk.availableBytes != null
        && disk.mainBytes < this.limits.maxDatabaseBytes
        && disk.familyBytes < this.limits.maxFamilyBytes
        && disk.availableBytes >= this.limits.minimumFreeBytes;
    } catch {
      return false;
    }
  }

  assertWriteAllowed(db: DatabaseSync, readOnly = false): void {
    const status = this.status(db, readOnly);
    if (status.writesAllowed) return;
    throw new StorageCapacityError(status);
  }

  /** Checkpoint existing WAL frames, then require headroom before any new external work. */
  prepareExternalWork(db: DatabaseSync, readOnly = false): StorageStatus {
    if (readOnly) return this.status(db, true);
    if (db.isTransaction) {
      this.blockedCheckpoint = true;
      return { ...this.status(db), state: "checkpoint_blocked", canStartExternalWork: false, reason: "A database transaction is still active; new external work was paused." };
    }
    try {
      const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number; log?: number; checkpointed?: number } | undefined;
      if (!result || result.busy !== 0 || (typeof result.log === "number" && result.log > 0
        && typeof result.checkpointed === "number" && result.checkpointed < result.log)) {
        this.blockedCheckpoint = true;
        const status = this.status(db);
        return { ...status, state: "checkpoint_blocked", canStartExternalWork: false, reason: "A WAL checkpoint could not truncate the journal; close long-running database readers and retry." };
      }
      this.blockedCheckpoint = false;
      return this.status(db);
    } catch {
      this.blockedCheckpoint = true;
      const status = this.status(db);
      return { ...status, state: "checkpoint_blocked", canStartExternalWork: false, reason: "The WAL checkpoint failed; saved evidence remains readable, but new external work is paused." };
    }
  }

  private buildStatus(
    disk: FileMeasurement,
    checkedAt: number,
    pageCount: number | null,
    pageSize: number | null,
    readOnly: boolean,
    startup: boolean,
    maxPageCount: number | null = this.expectedMaxPageCount,
    requireFullDatabaseReserve = startup,
  ): StorageStatus {
    const measurable = disk.mainBytes != null && disk.familyBytes != null && disk.availableBytes != null && disk.allocatedBytes != null;
    const mainBytes = disk.mainBytes;
    const familyBytes = disk.familyBytes;
    const availableBytes = disk.availableBytes;
    const logicalDatabaseBytes = pageCount == null || pageSize == null || pageCount > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)
      ? null : pageCount * pageSize;
    const logicalMeasurable = pageCount == null || pageSize == null || logicalDatabaseBytes != null;
    const allMeasurable = measurable && logicalMeasurable;
    const hardWriteAllowed = measurable && !readOnly && mainBytes! < this.limits.maxDatabaseBytes
      && (logicalDatabaseBytes == null || logicalDatabaseBytes < this.limits.maxDatabaseBytes)
      && familyBytes! < this.limits.maxFamilyBytes && availableBytes! >= this.limits.minimumFreeBytes;
    let state: StorageState = "ready";
    let reason: string | null = null;
    if (!allMeasurable) {
      state = "measurement_failed";
      reason = "Storage capacity could not be measured; collection and classification remain paused.";
    } else if (availableBytes! < this.limits.minimumFreeBytes + this.limits.writeHeadroomBytes
      + (requireFullDatabaseReserve ? this.limits.maxDatabaseBytes : 0)) {
      state = "disk_pressure";
      const requiredFreeBytes = this.limits.minimumFreeBytes + this.limits.writeHeadroomBytes
        + (requireFullDatabaseReserve ? this.limits.maxDatabaseBytes : 0);
      const operation = requireFullDatabaseReserve
        ? "full startup migrations or collection resume"
        : startup ? "additive schema migrations or collection resume" : "collection resume";
      reason = `Free at least ${requiredFreeBytes} bytes on the data volume before ${operation}.`;
    } else if (mainBytes! + this.limits.writeHeadroomBytes >= this.limits.maxDatabaseBytes
      || (logicalDatabaseBytes != null && logicalDatabaseBytes + this.limits.writeHeadroomBytes >= this.limits.maxDatabaseBytes)
      || familyBytes! + this.limits.writeHeadroomBytes >= this.limits.maxFamilyBytes
      || (pageCount != null && pageSize != null && maxPageCount != null
        && (pageCount + Math.ceil(this.limits.writeHeadroomBytes / pageSize) >= maxPageCount))) {
      state = "capacity_paused";
      reason = "Database capacity is near its configured limit. Archive or expand the database limit after a verified backup, then restart.";
    }
    const pageLimitMismatch = pageCount != null && maxPageCount != null && this.expectedMaxPageCount != null
      && maxPageCount !== this.expectedMaxPageCount;
    if (pageLimitMismatch) {
      state = "capacity_paused";
      reason = "The configured SQLite page limit could not be applied to this database; new collection is paused.";
    }
    return {
      state,
      canStartExternalWork: state === "ready" && !readOnly,
      writesAllowed: hardWriteAllowed,
      reason: readOnly && reason == null ? this.readOnlyReason ?? "Database opened read-only due to storage pressure." : reason,
      ...disk,
      logicalDatabaseBytes,
      pageCount,
      pageSize,
      maxPageCount,
      maxDatabaseBytes: this.limits.maxDatabaseBytes,
      maxFamilyBytes: this.limits.maxFamilyBytes,
      minimumFreeBytes: this.limits.minimumFreeBytes,
      writeHeadroomBytes: this.limits.writeHeadroomBytes,
      checkedAt,
    };
  }

  setReadOnlyReason(reason: string, state: StorageState = "capacity_paused"): void {
    this.readOnlyReason = reason;
    this.readOnlyState = state;
  }

  private failureStatus(checkedAt: number, reason: string): StorageStatus {
    return {
      state: "measurement_failed", canStartExternalWork: false, writesAllowed: false, reason,
      mainBytes: null, walBytes: null, shmBytes: null, journalBytes: null, familyBytes: null,
      allocatedBytes: null, availableBytes: null, logicalDatabaseBytes: null, pageCount: null, pageSize: null, maxPageCount: null,
      maxDatabaseBytes: this.limits.maxDatabaseBytes, maxFamilyBytes: this.limits.maxFamilyBytes,
      minimumFreeBytes: this.limits.minimumFreeBytes, writeHeadroomBytes: this.limits.writeHeadroomBytes, checkedAt,
    };
  }
}

export class StorageCapacityError extends Error {
  readonly code = "storage_capacity_paused";

  constructor(readonly status: StorageStatus) {
    super(status.reason ?? "Storage capacity is paused");
    this.name = "StorageCapacityError";
  }
}
