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
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-source-search-"));
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

function saveRecord(db: Desk, input: {
  companyId: string; key: string; title: string; snippet: string; publisher: string; publishedAt: number | null; retrievedAt: number;
}) {
  return db.insertObservation({
    companyId: input.companyId, kind: "rss", sourceName: input.publisher,
    sourceUrl: `https://news.example.test/${input.key}`, tier: "trade",
    title: input.title, snippet: input.snippet, publishedAt: input.publishedAt,
    retrievedAt: input.retrievedAt, collector: "yahoo_finance_rss", publisherName: input.publisher,
    publisherDomain: `${input.publisher.toLocaleLowerCase().replaceAll(" ", "-")}.example.test`, sourceItemId: input.key, scoped: false,
  }).observationId;
}

function searchUrl(input: Record<string, string>): string {
  return `/api/saved-source-search?${new URLSearchParams(input).toString()}`;
}

describe("saved-source archive search", () => {
  it("finds excerpt-only records across companies and pages a fixed retained snapshot", async () => {
    const { db, app, companies } = makeApp();
    try {
      const apple = companies.find((company) => company.ticker === "AAPL")!;
      const amd = companies.find((company) => company.ticker === "AMD")!;
      const now = Date.now();
      const jefferies = saveRecord(db, {
        companyId: apple.id, key: "hk-jefferies", title: "Jefferies Sees Softer iPhone Demand in Resale Pricing",
        snippet: "Resale pricing in Hong Kong is below levels recorded for comparable models last year.",
        publisher: "Jefferies", publishedAt: now - 50_000, retrievedAt: now - 10_000,
      });
      const appleSecond = saveRecord(db, {
        companyId: apple.id, key: "hk-apple-second", title: "Asia Smartphone Resale Check",
        snippet: "A second report cites Hong Kong resale pricing data.", publisher: "Market Ledger",
        publishedAt: now - 40_000, retrievedAt: now - 9_000,
      });
      const dismissed = saveRecord(db, {
        companyId: apple.id, key: "hk-dismissed", title: "Hong Kong consumer check",
        snippet: "A retained article excerpt mentions Hong Kong households.", publisher: "Desk Wire",
        publishedAt: now - 30_000, retrievedAt: now - 8_000,
      });
      const amdRecord = saveRecord(db, {
        companyId: amd.id, key: "hk-amd", title: "Server Chip Orders",
        snippet: "A supplier describes demand from Hong Kong customers.", publisher: "Jefferies",
        publishedAt: now - 20_000, retrievedAt: now - 7_000,
      });
      db.saveAnalystSourceReview({ observationId: dismissed, companyId: apple.id, disposition: "dismissed", nextQuestion: "" });

      const before = db.realObservationCount();
      const firstResponse = await app.request(searchUrl({ q: "Hong Kong", limit: "1" }));
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect(first).toMatchObject({ query: "Hong Kong", totalCount: 3, items: expect.any(Array), reviewRevision: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.items[0].id).toBe(amdRecord);
      expect(first.items[0].title).toBe("Server Chip Orders");
      expect(first.items[0].snippet).toContain("Hong Kong");
      expect(first.items[0].status).toBe("pending");
      expect(first.items[0].source.url).toContain("news.example.test/hk-amd");
      expect(first.nextCursor).toMatchObject({ query: "Hong Kong", snapshotAt: first.snapshotAt });

      const appleFiltered = await app.request(searchUrl({ q: "Hong Kong", companyId: apple.id, limit: "5" }));
      expect((await appleFiltered.json()).items.map((item: { id: string }) => item.id)).toEqual([appleSecond, jefferies]);
      const publisherFiltered = await app.request(searchUrl({ q: "Hong Kong", publisher: "jeff", limit: "5" }));
      expect((await publisherFiltered.json()).items.map((item: { id: string }) => item.id)).toEqual([amdRecord, jefferies]);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const lateArrival = saveRecord(db, {
        companyId: apple.id, key: "hk-late", title: "Late imported Hong Kong article",
        snippet: "Its source date predates the search, but its Desk ingestion follows the search cutoff.",
        publisher: "Market Ledger", publishedAt: first.snapshotAt - 5_000, retrievedAt: first.snapshotAt - 1_000,
      });
      const nextResponse = await app.request(searchUrl({
        q: "Hong Kong", limit: "1", snapshotAt: String(first.snapshotAt), cursor: JSON.stringify(first.nextCursor),
      }));
      expect(nextResponse.status).toBe(200);
      const second = await nextResponse.json();
      expect(second.totalCount).toBe(3);
      expect(second.items.map((item: { id: string }) => item.id)).toEqual([appleSecond]);
      expect(second.items.some((item: { id: string }) => item.id === first.items[0].id)).toBe(false);
      expect(second.items.some((item: { id: string }) => item.id === lateArrival)).toBe(false);

      const finalResponse = await app.request(searchUrl({
        q: "Hong Kong", limit: "1", snapshotAt: String(first.snapshotAt), cursor: JSON.stringify(second.nextCursor),
      }));
      const final = await finalResponse.json();
      expect(final.items.map((item: { id: string }) => item.id)).toEqual([jefferies]);
      expect(final.nextCursor).toBeNull();

      const dismissedHidden = await app.request(searchUrl({ q: "Hong Kong", includeDismissed: "false", snapshotAt: String(first.snapshotAt), limit: "10" }));
      const dismissedIncluded = await app.request(searchUrl({ q: "Hong Kong", includeDismissed: "true", snapshotAt: String(first.snapshotAt), limit: "10" }));
      expect((await dismissedHidden.json()).totalCount).toBe(3);
      expect((await dismissedIncluded.json()).totalCount).toBe(4);
      expect(db.realObservationCount()).toBe(before + 1);
    } finally { db.close(); }
  });

  it("orders RSS results by the visible feed clock and invalidates paging after a review changes", async () => {
    const { db, app, companies } = makeApp();
    try {
      const apple = companies.find((company) => company.ticker === "AAPL")!;
      const now = Date.now();
      const feedLatestButRetrievedEarlier = saveRecord(db, {
        companyId: apple.id, key: "clock-feed-latest", title: "Hong Kong device demand update",
        snippet: "Feed time is newest although this record was retrieved first.", publisher: "Clock Journal",
        publishedAt: now - 1_000, retrievedAt: now - 30_000,
      });
      const feedOlderButRetrievedLater = saveRecord(db, {
        companyId: apple.id, key: "clock-feed-older", title: "Hong Kong device demand recap",
        snippet: "Feed time is older although this record was retrieved later.", publisher: "Clock Journal",
        publishedAt: now - 10_000, retrievedAt: now - 1_000,
      });
      const unknownSourceClock = saveRecord(db, {
        companyId: apple.id, key: "clock-feed-unknown", title: "Hong Kong device coverage note",
        snippet: "No source clock is available; retrieval is shown separately.", publisher: "Clock Journal",
        publishedAt: null, retrievedAt: now - 100,
      });

      const ordered = await (await app.request(searchUrl({ q: "Hong Kong", limit: "10" }))).json();
      expect(ordered.items.map((item: { id: string }) => item.id))
        .toEqual([feedLatestButRetrievedEarlier, feedOlderButRetrievedLater, unknownSourceClock]);

      const firstResponse = await app.request(searchUrl({ q: "Hong Kong", limit: "1" }));
      const first = await firstResponse.json();
      expect(first.items.map((item: { id: string }) => item.id)).toEqual([feedLatestButRetrievedEarlier]);
      expect(first.nextCursor).toMatchObject({ sourceTimeUnknown: false, reviewRevision: 0 });

      db.saveAnalystSourceReview({
        observationId: feedOlderButRetrievedLater, companyId: apple.id, disposition: "dismissed", nextQuestion: "",
      });
      const changedResponse = await app.request(searchUrl({
        q: "Hong Kong", limit: "1", snapshotAt: String(first.snapshotAt),
        reviewRevision: String(first.reviewRevision), cursor: JSON.stringify(first.nextCursor),
      }));
      expect(changedResponse.status).toBe(409);
      await expect(changedResponse.json()).resolves.toMatchObject({ error: "saved_source_search_snapshot_changed" });
    } finally { db.close(); }
  });

  it("rejects malformed, out-of-scope and too-short searches without returning plausible empty results", async () => {
    const { db, app, companies } = makeApp();
    try {
      expect((await app.request(searchUrl({ q: "x" }))).status).toBe(400);
      expect((await app.request(searchUrl({ q: "test", companyId: "missing-company" }))).status).toBe(404);
      expect((await app.request(searchUrl({ q: "test", includeDismissed: "yes" }))).status).toBe(400);

      const apple = companies.find((company) => company.ticker === "AAPL")!;
      const now = Date.now();
      saveRecord(db, { companyId: apple.id, key: "cursor-scope", title: "Hong Kong report", snippet: "Apple excerpt", publisher: "Publisher", publishedAt: now - 1000, retrievedAt: now - 900 });
      saveRecord(db, { companyId: apple.id, key: "cursor-scope-second", title: "Hong Kong second report", snippet: "Apple follow-up", publisher: "Publisher", publishedAt: now - 900, retrievedAt: now - 800 });
      const first = await (await app.request(searchUrl({ q: "Hong Kong", limit: "1" }))).json();
      expect(first.nextCursor).toMatchObject({ searchSemanticsVersion: 2 });
      const mismatched = await app.request(searchUrl({ q: "resale", cursor: JSON.stringify(first.nextCursor), snapshotAt: String(first.snapshotAt) }));
      expect(mismatched.status).toBe(400);
      const staleVersion = await app.request(searchUrl({ q: "Hong Kong", cursor: JSON.stringify({ ...first.nextCursor, searchSemanticsVersion: 1 }), snapshotAt: String(first.snapshotAt) }));
      expect(staleVersion.status).toBe(400);
      const invalidCursor = await app.request(searchUrl({ q: "Hong Kong", cursor: "%7Bbad%7D" }));
      expect(invalidCursor.status).toBe(400);
    } finally { db.close(); }
  });

  it("treats short investor terms as words so AI does not match Taiwan or daily", async () => {
    const { db, app, companies } = makeApp();
    try {
      const apple = companies.find((company) => company.ticker === "AAPL")!;
      const now = Date.now();
      const trueMatch = saveRecord(db, {
        companyId: apple.id, key: "ai-token", title: "AI accelerator demand rises",
        snippet: "Suppliers discuss AI-driven product demand.", publisher: "Market Ledger", publishedAt: now - 1_000, retrievedAt: now - 500,
      });
      saveRecord(db, {
        companyId: apple.id, key: "taiwan-only", title: "Taiwan supplier outlook improves",
        snippet: "The daily production update covers Asian capacity.", publisher: "Market Ledger", publishedAt: now - 900, retrievedAt: now - 400,
      });

      const response = await app.request(searchUrl({ q: "AI", limit: "10" }));
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page.totalCount).toBe(1);
      expect(page.items.map((item: { id: string }) => item.id)).toEqual([trueMatch]);
    } finally { db.close(); }
  });
});
