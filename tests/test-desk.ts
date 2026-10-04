import { Desk } from "../server/db.js";
import type { StorageLimits } from "../server/storage-capacity.js";

export const TEST_STORAGE_LIMITS: Readonly<StorageLimits> = Object.freeze({
  maxDatabaseBytes: 64 * 1024 * 1024,
  maxFamilyBytes: 128 * 1024 * 1024,
  minimumFreeBytes: 1024 * 1024,
  writeHeadroomBytes: 1024 * 1024,
});

export class TestDesk extends Desk {
  constructor(databasePath: string, limits: Readonly<StorageLimits> = TEST_STORAGE_LIMITS) {
    super(databasePath, limits);
  }
}
