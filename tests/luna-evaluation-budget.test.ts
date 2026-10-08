import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestDesk } from "./test-desk.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const budget = {
  utcDay: "2026-10-08",
  requests: 2,
  requestBytes: 1_000,
  costMicros: 250_000,
  maxRequests: 4,
  maxRequestBytes: 2_000,
  maxDailyCostMicros: 500_000,
};

describe("Luna evaluation shared daily budget", () => {
  it("persists requests, bytes, and worst-case cost across restart and refuses partial over-budget updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "luna-evaluation-budget-")); directories.push(directory);
    const dbPath = join(directory, "desk.sqlite");
    let first = new TestDesk(dbPath);
    try {
      expect(first.reserveOpenAIEvaluationBudget(budget)).toEqual({ reserved: true });
    } finally { first.close(); }
    first = new TestDesk(dbPath);
    try {
      expect(first.getKv("openai:budget:2026-10-08:requests")).toBe("2");
      expect(first.getKv("openai:budget:2026-10-08:request-bytes")).toBe("1000");
      expect(first.getKv("openai:budget:2026-10-08:cost-micros")).toBe("250000");
      expect(first.reserveOpenAIEvaluationBudget({ ...budget, requests: 3 })).toEqual({ reserved: false, reason: "exhausted" });
      expect(first.getKv("openai:budget:2026-10-08:requests")).toBe("2");
      expect(first.getKv("openai:budget:2026-10-08:request-bytes")).toBe("1000");
      expect(first.getKv("openai:budget:2026-10-08:cost-micros")).toBe("250000");
    } finally { first.close(); }
  });

  it("fails closed for invalid, closed, or exhausted reservations without partially spending counters", () => {
    const db = new TestDesk(":memory:");
    try {
      expect(db.reserveOpenAIEvaluationBudget({ ...budget, requests: 0 })).toEqual({ reserved: false, reason: "invalid" });
      expect(db.getKv("openai:budget:2026-10-08:requests")).toBeUndefined();
      db.setKv("openai:budget:2026-10-08:closed", "1");
      expect(db.reserveOpenAIEvaluationBudget(budget)).toEqual({ reserved: false, reason: "closed" });
      expect(db.getKv("openai:budget:2026-10-08:requests")).toBeUndefined();
      db.setKv("openai:budget:2026-10-08:closed", "0");
      expect(db.reserveOpenAIEvaluationBudget({ ...budget, requestBytes: 2_001 })).toEqual({ reserved: false, reason: "exhausted" });
      expect(db.getKv("openai:budget:2026-10-08:requests")).toBeUndefined();
      expect(db.getKv("openai:budget:2026-10-08:request-bytes")).toBeUndefined();
      expect(db.getKv("openai:budget:2026-10-08:cost-micros")).toBeUndefined();
    } finally { db.close(); }
  });
});
