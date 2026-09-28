import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Desk } from "../server/db.js";
import {
  clearProviderRateLimit,
  parseRetryAfterMs,
  providerCoolingDown,
  providerRetryAt,
  recordProviderRateLimit,
} from "../server/provider-cooldown.js";

describe("provider cooldowns", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs("Mon, 28 Sep 2026 12:03:00 GMT", now)).toBe(180_000);
    expect(parseRetryAfterMs("not a date", now)).toBeUndefined();
  });

  it("persists Retry-After and bounded exponential fallback across restarts", () => {
    const db = new Desk(":memory:");
    const first = recordProviderRateLimit({ db, provider: "yahoo", minDelayMs: 30_000, now: 1_000 });
    expect(first).toBe(31_000);
    expect(providerCoolingDown(db, "yahoo", 30_999)).toBe(true);
    expect(providerCoolingDown(db, "yahoo", first)).toBe(false);

    const second = recordProviderRateLimit({ db, provider: "yahoo", minDelayMs: 30_000, now: first });
    expect(second).toBe(first + 60_000);
    const providerRequested = recordProviderRateLimit({
      db, provider: "yahoo", minDelayMs: 30_000, retryAfterMs: 240_000, now: second,
    });
    expect(providerRequested).toBe(second + 240_000);
    db.close();
  });

  it("never shortens a longer cooldown when overlapping 429s complete out of order", () => {
    const db = new Desk(":memory:");
    const longRetryAt = recordProviderRateLimit({
      db, provider: "yahoo", minDelayMs: 1_000, retryAfterMs: 600_000, now: 1_000,
    });
    const shorterRetryAt = recordProviderRateLimit({
      db, provider: "yahoo", minDelayMs: 1_000, retryAfterMs: 1_000, now: 61_000,
    });
    expect(longRetryAt).toBe(601_000);
    expect(shorterRetryAt).toBe(longRetryAt);
    expect(providerRetryAt(db, "yahoo", 62_000)).toBe(longRetryAt);
    expect(db.getKv("provider-cooldown:yahoo:failures")).toBe("2");
    db.close();
  });

  it("retains cooldown state when SQLite is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-provider-cooldown-"));
    const path = join(directory, "desk.db");
    try {
      const first = new Desk(path);
      recordProviderRateLimit({ db: first, provider: "finnhub", minDelayMs: 90_000, now: 1_000 });
      first.close();

      const restarted = new Desk(path);
      try {
        expect(providerRetryAt(restarted, "finnhub", 2_000)).toBe(91_000);
        expect(providerCoolingDown(restarted, "finnhub", 2_000)).toBe(true);
      } finally {
        restarted.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps Retry-After and fails closed on corrupt persisted state", () => {
    const db = new Desk(":memory:");
    const retryAt = recordProviderRateLimit({
      db, provider: "sec", minDelayMs: 1_000, retryAfterMs: Number.MAX_SAFE_INTEGER, now: 5_000,
    });
    expect(retryAt).toBe(5_000 + 24 * 60 * 60 * 1_000);
    db.setKv("provider-cooldown:reddit:retry-at", "corrupt");
    expect(providerRetryAt(db, "reddit", 10_000)).toBe(10_000 + 24 * 60 * 60 * 1_000);
    expect(providerCoolingDown(db, "reddit", 10_000)).toBe(true);
    db.setKv("provider-cooldown:x:retry-at", "corrupt");
    clearProviderRateLimit(db, "x");
    expect(providerRetryAt(db, "x", 10_000)).toBe(10_000 + 24 * 60 * 60 * 1_000);
    db.close();
  });

  it("clears both cooldown and consecutive-failure state after a successful request", () => {
    const db = new Desk(":memory:");
    recordProviderRateLimit({ db, provider: "google_news", minDelayMs: 5_000, now: 1_000 });
    clearProviderRateLimit(db, "google_news", 2_000);
    expect(providerCoolingDown(db, "google_news", 2_000)).toBe(true);
    clearProviderRateLimit(db, "google_news", 6_000);
    expect(providerCoolingDown(db, "google_news", 6_000)).toBe(false);
    expect(db.getKv("provider-cooldown:google_news:failures")).toBe("0");
    db.close();
  });
});
