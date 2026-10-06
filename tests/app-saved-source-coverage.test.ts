import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppDeps } from "../server/app.js";
import { loadCompanies } from "../server/config.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function makeApp() {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-source-coverage-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new Desk(dbPath);
  const companies = loadCompanies();
  db.seedCompanies(companies);
  const app = createApp({
    db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
  });
  return { db, app, companies };
}

function saveNews(db: Desk, input: {
  companyId: string; key: string; title: string; snippet: string; publishedAt: number; retrievedAt: number;
}) {
  return db.insertObservation({
    companyId: input.companyId, kind: "rss", sourceName: "Google News RSS",
    sourceUrl: `https://news.google.com/rss/articles/${input.key}`, tier: "major",
    title: input.title, snippet: input.snippet, publishedAt: input.publishedAt,
    retrievedAt: input.retrievedAt, collector: "google_news_rss", publisherName: "Publisher",
    publisherDomain: "example.com", sourceItemId: input.key, scoped: false,
  }).observationId;
}

describe("saved-source company coverage", () => {
  it("balances bounded real-source rows by issuer and keeps weak matches visible only as review gaps", async () => {
    const { db, app, companies } = makeApp();
    try {
      const apple = companies.find((company) => company.ticker === "AAPL")!;
      const adobe = companies.find((company) => company.ticker === "ADBE")!;
      const now = Date.now();
      const appleOld = saveNews(db, {
        companyId: apple.id, key: "apple-old", title: "Apple iPhone demand strengthens",
        snippet: "Saved publisher result.", publishedAt: now - 10_000, retrievedAt: now - 1_000,
      });
      const appleLatest = saveNews(db, {
        companyId: apple.id, key: "apple-latest", title: "AAPL supplier raises its outlook",
        snippet: "An identified AAPL supplier raised its outlook.", publishedAt: now - 1_000, retrievedAt: now - 30_000,
      });
      const weakApple = saveNews(db, {
        companyId: apple.id, key: "apple-pie", title: "McDonald's Apple Pie Tree Statue Is Back",
        snippet: "A seasonal dessert returns.", publishedAt: now - 500, retrievedAt: now - 400,
      });
      const adobeOnly = saveNews(db, {
        companyId: adobe.id, key: "adobe-only", title: "ADBE shares rise after product update",
        snippet: "ADBE shares rose after a product update.", publishedAt: now - 700, retrievedAt: now - 600,
      });

      const response = await app.request("/api/saved-source-coverage");
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot).toMatchObject({
        trackedCompanyCount: 24,
        companiesWithIdentityGatePasses: 2,
        identityGatePassCount: 3,
        identityReviewCount: 1,
        itemsPerCompany: 3,
      });
      const appleCoverage = snapshot.companies.find((company: { ticker: string }) => company.ticker === "AAPL");
      const adobeCoverage = snapshot.companies.find((company: { ticker: string }) => company.ticker === "ADBE");
      expect(appleCoverage).toMatchObject({ identityGatePassCount: 2, identityReviewCount: 1 });
      expect(appleCoverage.items.map((item: { id: string }) => item.id)).toEqual([appleLatest, appleOld]);
      expect(adobeCoverage).toMatchObject({ identityGatePassCount: 1, identityReviewCount: 0 });
      expect(adobeCoverage.items.map((item: { id: string }) => item.id)).toEqual([adobeOnly]);
      expect(JSON.stringify(snapshot)).not.toContain(weakApple);
      expect(snapshot.companies.every((company: { items: unknown[] }) => company.items.length <= 3)).toBe(true);
      expect(snapshot.companies.some((company: { identityGatePassCount: number }) => company.identityGatePassCount === 0)).toBe(true);
    } finally { db.close(); }
  });

  it("returns an honest empty archive and enforces the per-company bound", async () => {
    const { db, app } = makeApp();
    try {
      const response = await app.request("/api/saved-source-coverage");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        companiesWithIdentityGatePasses: 0, identityGatePassCount: 0, identityReviewCount: 0, companies: expect.any(Array),
      });
      expect(() => db.savedSourceCoverage(0)).toThrow("invalid_saved_source_coverage_request");
      expect(() => db.savedSourceCoverage(9)).toThrow("invalid_saved_source_coverage_request");
    } finally { db.close(); }
  });
});
