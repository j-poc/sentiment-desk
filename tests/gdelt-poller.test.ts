import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { Pipeline } from "../server/pipeline.js";
import { startGdeltPoller } from "../server/schedule.js";
import { GdeltHttpError, type GdeltArticle } from "../server/sources/gdelt.js";
import type { Company } from "../server/types.js";

const directories: string[] = [];
const databases: Desk[] = [];
const company = (id: string, ticker: string): Company => ({
  id,
  name: `${ticker} Corporation`,
  ticker,
  sector: "Technology",
  aliases: [ticker],
  color: "#123456",
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-gdelt-"));
  directories.push(directory);
  const db = new Desk(join(directory, "desk.db"));
  databases.push(db);
  const companies = [company("acme", "ACME"), company("bravo", "BRAV")];
  db.seedCompanies(companies);
  const health = new HealthTracker(false, false, "jev-latest", false, false, false, true, new Set(["gdelt_doc_api"]));
  const pipeline = new Pipeline({
    db,
    judge: null,
    hub: new Hub(),
    health,
    engineLabel: "unconfigured",
    inputPricePerMTok: 0,
    concurrency: 1,
    allowedCollectors: new Set(),
    dailyBudget: { utcDay: () => "2026-09-28", maxRequests: 0, maxRequestBytes: 0 },
  });
  return { db, companies, health, pipeline };
}

async function runImmediatePoll(deps: Parameters<typeof startGdeltPoller>[0]): Promise<void> {
  const control = startGdeltPoller(deps);
  await vi.advanceTimersByTimeAsync(0);
  await control.stop();
}

describe("GDELT source-wide 429 cooldown", () => {
  it("stops the current company sweep, survives restart, and resumes after cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const { db, companies, health, pipeline } = setup();
    const firstFetch = vi.fn(async () => { throw new GdeltHttpError(429); });

    await runImmediatePoll({
      companies,
      pipeline,
      db,
      health,
      intervalSeconds: 60,
      fetchArticles: firstFetch,
      now: () => Date.now(),
      pause: async () => {},
    });
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(health.snapshot().gdelt).toMatchObject({ enabled: true, ok: 0, fail: 1 });
    expect(health.snapshot().rss).toMatchObject({ enabled: false, ok: 0, fail: 0 });
    expect(db.getKv("gdelt:rate-limit:consecutive")).toBe("1");
    const retryAt = Number(db.getKv("gdelt:rate-limit:retry-at"));
    expect(retryAt).toBe(Date.now() + 60_000);

    const restartedFetch = vi.fn(async (): Promise<GdeltArticle[]> => []);
    await runImmediatePoll({
      companies,
      pipeline,
      db,
      health,
      intervalSeconds: 60,
      fetchArticles: restartedFetch,
      now: () => Date.now(),
      pause: async () => {},
    });
    expect(restartedFetch).not.toHaveBeenCalled();

    vi.setSystemTime(retryAt);
    await runImmediatePoll({
      companies,
      pipeline,
      db,
      health,
      intervalSeconds: 60,
      fetchArticles: restartedFetch,
      now: () => Date.now(),
      pause: async () => {},
    });
    expect(restartedFetch).toHaveBeenCalledTimes(2);
    expect(health.snapshot().gdelt).toMatchObject({ ok: 2, fail: 1 });
    expect(health.snapshot().rss).toMatchObject({ ok: 0, fail: 0 });
    expect(db.getKv("gdelt:rate-limit:consecutive")).toBe("0");
    expect(db.getKv("gdelt:rate-limit:retry-at")).toBe("0");
  });

  it("increases fallback delay exponentially and caps it at one hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const { db, companies, health, pipeline } = setup();
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const startedAt = Date.now();
      await runImmediatePoll({
        companies: companies.slice(0, 1),
        pipeline,
        db,
        health,
        intervalSeconds: 60,
        fetchArticles: async () => { throw new GdeltHttpError(429); },
        now: () => Date.now(),
        pause: async () => {},
      });
      const retryAt = Number(db.getKv("gdelt:rate-limit:retry-at"));
      delays.push(retryAt - startedAt);
      vi.setSystemTime(retryAt);
    }

    expect(delays.slice(0, 7)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
    expect(delays.slice(7)).toEqual([3_600_000, 3_600_000]);
    expect(db.getKv("gdelt:rate-limit:consecutive")).toBe("9");
  });

  it("never retries earlier than a provider Retry-After value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const { db, companies, health, pipeline } = setup();
    await runImmediatePoll({
      companies: companies.slice(0, 1),
      pipeline,
      db,
      health,
      intervalSeconds: 60,
      fetchArticles: async () => { throw new GdeltHttpError(429, 240_000); },
      now: () => Date.now(),
      pause: async () => {},
    });

    expect(Number(db.getKv("gdelt:rate-limit:retry-at"))).toBe(Date.now() + 240_000);
  });

  it("fails closed for a corrupt persisted cooldown instead of calling GDELT", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const { db, companies, health, pipeline } = setup();
    db.setKv("gdelt:rate-limit:retry-at", "not-a-timestamp");
    const fetchArticles = vi.fn(async (): Promise<GdeltArticle[]> => []);

    await runImmediatePoll({
      companies,
      pipeline,
      db,
      health,
      intervalSeconds: 60,
      fetchArticles,
      now: () => Date.now(),
      pause: async () => {},
    });

    expect(fetchArticles).not.toHaveBeenCalled();
    expect(Number(db.getKv("gdelt:rate-limit:retry-at"))).toBe(Date.now() + 3_600_000);
  });
});
