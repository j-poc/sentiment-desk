import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { loadCompanies } from "../server/config.js";

const company = loadCompanies().find((candidate) => candidate.ticker === "AAPL")!;
const openDesks: Desk[] = [];
const openHubs: Hub[] = [];
const directories: string[] = [];

afterEach(() => {
  while (openDesks.length) openDesks.pop()!.close();
  while (openHubs.length) openHubs.pop()!.closeAll();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function makeApp(title = "iPhone quarterly operating update") {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-analyst-review-api-"));
  directories.push(directory);
  const db = new Desk(join(directory, "desk.sqlite"));
  db.seedCompanies([company]);
  openDesks.push(db);
  const hub = new Hub();
  openHubs.push(hub);
  const app = createApp({
    db, dbPath: join(directory, "desk.sqlite"), pipeline: {} as AppDeps["pipeline"],
    market: {} as AppDeps["market"], hub, health: new HealthTracker(false, false, "unconfigured"),
    version: "test", deliverySources: [],
  });
  const source = db.insertObservation({
    companyId: company.id, kind: "rss", sourceName: "Example Publisher",
    sourceUrl: "https://news.google.com/rss/articles/api-review", tier: "major",
    title, snippet: "Isolated API-test fixture.",
    publishedAt: Date.now() - 1_000, retrievedAt: Date.now(), collector: "google_news_rss",
    publisherName: "Example Publisher", publisherDomain: "example.com", sourceItemId: "api-review",
  });
  return { app, db, hub, observationId: source.observationId };
}

describe("analyst source-review API", () => {
  it("reports weak company-name matches and returns the exact row in saved history", async () => {
    const { app, observationId } = makeApp("Apple Pie Tree statue draws crowds");
    const working = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=all&hours=24`);
    expect(await working.json()).toMatchObject({ items: [], issuerIdentityReviewCount: 1 });

    const history = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=history`);
    expect(await history.json()).toMatchObject({
      items: [{ id: observationId, issuerIdentityStrong: false }],
      issuerIdentityReviewCount: 0,
    });
  });

  it("exposes a paginated identity-review filter across retained history", async () => {
    const { app, db } = makeApp();
    const oldPublishedAt = Date.now() - 9 * 24 * 60 * 60 * 1_000;
    const oldWeakId = db.insertObservation({
      companyId: company.id, kind: "rss", sourceName: "Example Publisher",
      sourceUrl: "https://news.google.com/rss/articles/old-weak", tier: "major",
      title: "Apple tree statue returns to local park", snippet: "Ambiguous company-name match.",
      publishedAt: oldPublishedAt, retrievedAt: oldPublishedAt + 1_000, collector: "google_news_rss",
      publisherName: "Example Publisher", publisherDomain: "example.com", sourceItemId: "old-weak",
    }).observationId;
    db.markFailed(oldWeakId, "Fixture failure", false);
    const recentWeakId = db.insertObservation({
      companyId: company.id, kind: "rss", sourceName: "Example Publisher",
      sourceUrl: "https://news.google.com/rss/articles/recent-weak", tier: "major",
      title: "Apple tree planting event grows", snippet: "Ambiguous company-name match.",
      publishedAt: Date.now() - 2_000, retrievedAt: Date.now(), collector: "google_news_rss",
      publisherName: "Example Publisher", publisherDomain: "example.com", sourceItemId: "recent-weak",
    }).observationId;
    const strongOldId = db.insertObservation({
      companyId: company.id, kind: "rss", sourceName: "Example Publisher",
      sourceUrl: "https://news.google.com/rss/articles/old-strong", tier: "major",
      title: "AAPL quarterly results beat estimates", snippet: "Issuer-specific symbol match.",
      publishedAt: oldPublishedAt - 1_000, retrievedAt: oldPublishedAt, collector: "google_news_rss",
      publisherName: "Example Publisher", publisherDomain: "example.com", sourceItemId: "old-strong",
    }).observationId;
    const beforeCount = db.realObservationCount();

    const working = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=all&hours=24`);
    expect(await working.json()).toMatchObject({ issuerIdentityReviewCount: 1 });

    const firstResponse = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=identity_review&limit=1`);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      items: Array<{ id: string; status: string; issuerIdentityStrong?: boolean }>;
      nextCursor: { orderAt: number; ingestedAt: number; id: string } | null;
      issuerIdentityReviewCount: number;
    };
    expect(first.items[0]).toMatchObject({ id: recentWeakId, status: "pending", issuerIdentityStrong: false });
    expect(first.issuerIdentityReviewCount).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const next = await app.request(
      `/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=identity_review&limit=1&cursor=${encodeURIComponent(JSON.stringify(first.nextCursor))}`,
    );
    expect(await next.json()).toMatchObject({
      items: [{ id: oldWeakId, status: "failed", issuerIdentityStrong: false }],
      nextCursor: null,
      issuerIdentityReviewCount: 2,
    });
    const history = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=history`);
    expect(await history.json()).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ id: oldWeakId, issuerIdentityStrong: false }),
      expect.objectContaining({ id: strongOldId, issuerIdentityStrong: true }),
    ]) });
    expect(db.realObservationCount()).toBe(beforeCount);
  });

  it("serves saved real-source records, persists edits and set-aside, and makes no external requests", async () => {
    const { app, db, hub, observationId } = makeApp();
    const events: Array<{ event: string; data: string }> = [];
    hub.add((event, data) => { events.push({ event, data }); });
    const initial = await app.request(`/api/mentions/${encodeURIComponent(observationId)}/research-review`);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ review: null });

    const save = async (disposition: "investigate" | "dismissed", nextQuestion: string) => app.request(
      `/api/mentions/${encodeURIComponent(observationId)}/research-review`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ disposition, nextQuestion }) },
    );
    expect((await save("investigate", "Open the original filing.")).status).toBe(200);
    expect(await (await app.request("/api/research-queue")).json()).toMatchObject({ items: [{
      observationId, companyId: company.id, ticker: company.ticker,
      mention: { id: observationId, title: "iPhone quarterly operating update", source: { deliveryId: null } },
      nextQuestion: "Open the original filing.",
    }] });

    expect((await save("dismissed", "Open the original filing.")).status).toBe(200);
    expect(await (await app.request("/api/research-queue")).json()).toEqual({ items: [] });
    const hiddenPage = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=history`);
    expect(await hiddenPage.json()).toMatchObject({ items: [], setAsideCount: 1 });
    const reviewPage = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?filter=history&includeDismissed=true`);
    expect(await reviewPage.json()).toMatchObject({
      items: [{ id: observationId, analystResearchDisposition: "dismissed" }], setAsideCount: 1,
    });
    expect((await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions-page?includeDismissed=yes`)).status).toBe(400);
    const lookup = await app.request(`/api/companies/${encodeURIComponent(company.id)}/mentions/lookup`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [observationId] }),
    });
    expect(await lookup.json()).toMatchObject({ items: [{ id: observationId, analystResearchDisposition: "dismissed" }] });
    expect((await save("investigate", "Compare with the next report.")).status).toBe(200);
    expect(await (await app.request(`/api/mentions/${encodeURIComponent(observationId)}/research-review`)).json()).toMatchObject({
      review: { observationId, disposition: "investigate", nextQuestion: "Compare with the next report." },
    });
    expect(db.realObservationCount()).toBe(1);
    expect(events.filter((entry) => entry.event === "research_review").map((entry) => JSON.parse(entry.data))).toEqual([
      { observationId, companyId: company.id, disposition: "investigate", updatedAt: expect.any(Number) },
      { observationId, companyId: company.id, disposition: "dismissed", updatedAt: expect.any(Number) },
      { observationId, companyId: company.id, disposition: "investigate", updatedAt: expect.any(Number) },
    ]);
    expect(events.filter((entry) => entry.event === "research_review").every((entry) => !entry.data.includes("nextQuestion"))).toBe(true);
  });

  it("rejects malformed, oversized, unknown, and non-object review requests", async () => {
    const { app, observationId } = makeApp();
    const send = (id: string, body: unknown) => app.request(`/api/mentions/${encodeURIComponent(id)}/research-review`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await send("missing", { disposition: "investigate", nextQuestion: "Check." })).status).toBe(404);
    expect((await send(observationId, { disposition: "unknown", nextQuestion: "Check." })).status).toBe(400);
    expect((await send(observationId, { disposition: "investigate", nextQuestion: "q".repeat(1001) })).status).toBe(400);
    expect((await send(observationId, null)).status).toBe(400);
    const read = await app.request(`/api/mentions/${encodeURIComponent(observationId)}/research-review`);
    expect(await read.json()).toEqual({ review: null });
  });
});
