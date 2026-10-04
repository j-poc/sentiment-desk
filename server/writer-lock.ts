import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A second compatible Desk process may read the database, but only one may write. */
export class WriterAlreadyOwnedError extends Error {
  constructor() {
    super("Another Sentiment Desk process owns the database writer lock; this process must open read-only.");
    this.name = "WriterAlreadyOwnedError";
  }
}

export function canonicalDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:") return databasePath;
  const absolute = resolve(databasePath);
  const parent = realpathSync(dirname(absolute));
  const candidate = `${parent}/${basename(absolute)}`;
  if (!existsSync(candidate)) return candidate;
  const actual = realpathSync(candidate);
  const stat = statSync(actual);
  if (stat.nlink > 1) throw new Error("Hard-linked Desk databases are unsupported because writer ownership cannot be shared safely.");
  return actual;
}

/**
 * Uses SQLite's kernel file locking on a stable sibling database. The lock
 * connection holds BEGIN EXCLUSIVE for the lifetime of the Desk writer; SQLite
 * releases it automatically if the process exits unexpectedly.
 */
export class DeskWriterLock {
  private released = false;

  private constructor(private readonly lockDb: DatabaseSync, readonly databasePath: string) {}

  static acquire(databasePath: string): DeskWriterLock | null {
    if (databasePath === ":memory:") return null;
    const canonical = canonicalDatabasePath(databasePath);
    const lockDb = new DatabaseSync(`${canonical}.writer-lock.sqlite`, { timeout: 0 });
    try {
      lockDb.exec("BEGIN EXCLUSIVE");
      return new DeskWriterLock(lockDb, canonical);
    } catch (error) {
      lockDb.close();
      const sqliteError = error as { errcode?: number; code?: string };
      if (((sqliteError.errcode ?? -1) & 0xff) === 5 || ((sqliteError.errcode ?? -1) & 0xff) === 6
        || sqliteError.code === "ERR_SQLITE_BUSY" || sqliteError.code === "ERR_SQLITE_LOCKED") {
        throw new WriterAlreadyOwnedError();
      }
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (this.lockDb.isTransaction) this.lockDb.exec("ROLLBACK");
    } finally {
      this.lockDb.close();
    }
  }
}
