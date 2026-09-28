import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk } from "../server/db.js";
import type { Company } from "../server/types.js";

const directories: string[] = [];
const databases: Desk[] = [];
const company: Company = {
  id: "acme", name: "Acme Corporation", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456",
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openDatabase(): { db: Desk; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-jev-budget-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new Desk(dbPath);
  databases.push(db);
  return { db, dbPath };
}

function insertObservation(db: Desk, sourceItemId: string): string {
  return db.insertObservation({
    companyId: company.id,
    kind: "rss",
    sourceName: "Publisher",
    sourceUrl: `https://publisher.example/${sourceItemId}`,
    tier: "major",
    title: "Acme expands production capacity",
    snippet: "The company announced a new facility.",
    publishedAt: Date.now(),
    retrievedAt: Date.now(),
    collector: "google_news_rss",
    sourceItemId,
  }).observationId;
}

function claim(db: Desk, id: string, limits: {
  utcDay: string;
  requestBytes: number;
  maxRequests: number;
  maxRequestBytes: number;
}) {
  return db.claimForScoringWithBudget({
    id,
    now: Date.now(),
    allowedCollectors: ["google_news_rss"],
    ...limits,
  });
}

describe("persistent Jev request budget", () => {
  it("enforces both daily request and request-byte caps across database restart", () => {
    const { db, dbPath } = openDatabase();
    db.seedCompanies([company]);
    const first = insertObservation(db, "capacity-1");
    const second = insertObservation(db, "capacity-2");
    const third = insertObservation(db, "capacity-3");
    const limits = { utcDay: "2026-09-28", maxRequests: 2, maxRequestBytes: 200 };

    expect(db.remainingJevRequests(limits)).toBe(2);
    expect(claim(db, first, { ...limits, requestBytes: 60 }).kind).toBe("claimed");
    expect(db.remainingJevRequests(limits)).toBe(1);
    expect(claim(db, second, { ...limits, requestBytes: 50 }).kind).toBe("claimed");
    expect(db.getKv("jev:budget:2026-09-28:requests")).toBe("2");
    expect(db.getKv("jev:budget:2026-09-28:request-bytes")).toBe("110");

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const restarted = new Desk(dbPath);
    databases.push(restarted);
    expect(restarted.remainingJevRequests(limits)).toBe(0);
    expect(claim(restarted, third, { ...limits, requestBytes: 1 }).kind).toBe("budget_exhausted");
    expect(claim(restarted, third, {
      utcDay: "2026-09-29", maxRequests: 1, maxRequestBytes: 100, requestBytes: 100,
    }).kind).toBe("claimed");
  });

  it("fails closed on corrupt counters or unbounded configuration", () => {
    const { db } = openDatabase();
    db.seedCompanies([company]);
    const first = insertObservation(db, "bad-counter");
    const second = insertObservation(db, "zero-budget");
    db.setKv("jev:budget:2026-09-28:requests", "not-a-counter");
    expect(claim(db, first, {
      utcDay: "2026-09-28", requestBytes: 1, maxRequests: 1, maxRequestBytes: 10,
    }).kind).toBe("budget_exhausted");
    expect(claim(db, second, {
      utcDay: "2026-09-29", requestBytes: 1, maxRequests: 0, maxRequestBytes: 10,
    }).kind).toBe("budget_exhausted");
  });

  it("claims a judgment and reserves budget atomically so duplicate claims do not spend twice", () => {
    const { db } = openDatabase();
    db.seedCompanies([company]);
    const observationId = insertObservation(db, "acme-capacity");

    const request = { utcDay: "2026-09-28", requestBytes: 100, maxRequests: 1, maxRequestBytes: 200 };
    expect(claim(db, observationId, request).kind).toBe("claimed");
    expect(claim(db, observationId, request).kind).toBe("not_claimed");
    expect(db.getKv("jev:budget:2026-09-28:requests")).toBe("1");
    expect(db.getKv("jev:budget:2026-09-28:request-bytes")).toBe("100");
  });

  it("does not claim or consume budget when the request-byte limit is exhausted", () => {
    const { db } = openDatabase();
    db.seedCompanies([company]);
    const observationId = insertObservation(db, "byte-limit");

    expect(claim(db, observationId, {
      utcDay: "2026-09-28",
      requestBytes: 100,
      maxRequests: 1,
      maxRequestBytes: 99,
    }).kind).toBe("budget_exhausted");
    expect(db.mentionRow(observationId)?.status).toBe("pending");
    expect(db.getKv("jev:budget:2026-09-28:requests")).toBeUndefined();
    expect(db.remainingJevRequests({ utcDay: "2026-09-28", maxRequests: 1, maxRequestBytes: 99 })).toBe(0);
  });
});
