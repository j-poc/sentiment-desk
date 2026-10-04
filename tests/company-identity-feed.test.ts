import { afterEach, describe, expect, it } from "vitest";
import { loadCompanies } from "../server/config.js";
import type { MentionScore } from "../server/types.js";
import { TestDesk as Desk } from "./test-desk.js";
import { includesWeakIssuerMatches, visibleInWorkingScan } from "../web/src/lib/analyst-feed.js";

const apple = loadCompanies().find((company) => company.ticker === "AAPL")!;
const openDesks: Desk[] = [];

function excludedScore(): MentionScore {
  return {
    sentiment: "neutral", pPos: 0.1, pNeu: 0.8, pNeg: 0.1, confidence: 0.7,
    about: 0.2, material: 0.1, novel: 0.1, credible: 0.5, investorRelevant: 0.1,
    eventType: "other", takeaway: "routine", magnitude: 0.1, surprise: 0.1,
    eventScore: 10, impact: 0, weight: 0.2, engine: "test-fixture", inputTokens: 10,
    outputTokens: 5, estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "test-fixture", scoredAt: Date.now(),
  };
}

afterEach(() => {
  while (openDesks.length) openDesks.pop()!.close();
});

function insertGoogleMatch(db: Desk, input: { id: string; title: string; publishedAt: number }) {
  return db.insertObservation({
    companyId: apple.id,
    kind: "rss",
    sourceName: "Google News RSS",
    sourceUrl: `https://news.google.com/rss/articles/${input.id}`,
    tier: "major",
    title: input.title,
    snippet: "Saved publisher result.",
    publishedAt: input.publishedAt,
    retrievedAt: input.publishedAt + 10,
    collector: "google_news_rss",
    publisherName: "Publisher",
    publisherDomain: "example.com",
    sourceItemId: input.id,
    scoped: false,
  }).observationId;
}

describe("ambiguous issuer matches in the selected-company scan", () => {
  it("filters weak matches before pagination and keeps them reviewable in saved history", () => {
    const db = new Desk(":memory:");
    openDesks.push(db);
    db.seedCompanies([apple]);
    const now = Date.now();
    const weakId = insertGoogleMatch(db, {
      id: "apple-pie-tree",
      title: "McDonald's Apple Pie Tree Statue Is Back",
      publishedAt: now,
    });
    const aliasId = insertGoogleMatch(db, {
      id: "iphone-product",
      title: "Apple iPhone demand strengthens",
      publishedAt: now - 1_000,
    });
    const tickerId = insertGoogleMatch(db, {
      id: "aapl-ticker",
      title: "AAPL supplier raises its outlook",
      publishedAt: now - 2_000,
    });
    const savedCount = db.realObservationCount();

    const first = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: now - 24 * 60 * 60 * 1000,
      limit: 1, cursor: null, filter: "all",
    });
    expect(first.items.map((item) => item.id)).toEqual([aliasId]);
    expect(first.items[0]?.issuerIdentityStrong).toBe(true);
    expect(first.issuerIdentityReviewCount).toBe(1);
    expect(first.nextCursor).not.toBeNull();

    const second = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: now - 24 * 60 * 60 * 1000,
      limit: 1, cursor: first.nextCursor, filter: "all",
    });
    expect(second.items.map((item) => item.id)).toEqual([tickerId]);
    expect(second.nextCursor).toBeNull();

    const history = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 10, cursor: null, filter: "history",
    });
    expect(history.items.map((item) => item.id)).toContain(weakId);
    expect(history.items.find((item) => item.id === weakId)?.issuerIdentityStrong).toBe(false);
    expect(db.mentionsByIds(apple.id, [weakId])[0]?.issuerIdentityStrong).toBe(false);
    expect(db.recentVisible(10).some((item) => item.id === weakId)).toBe(true);
    expect(db.realObservationCount()).toBe(savedCount);
  });

  it("keeps weak matches visible in recovery and explicit off-target review filters", () => {
    const db = new Desk(":memory:");
    openDesks.push(db);
    db.seedCompanies([apple]);
    const pendingId = insertGoogleMatch(db, {
      id: "ambiguous-pending",
      title: "Apple tree planting draws local volunteers",
      publishedAt: Date.now(),
    });
    const offTargetId = insertGoogleMatch(db, {
      id: "ambiguous-offtarget",
      title: "Apple tree planting raises funds for local park",
      publishedAt: Date.now() - 1_000,
    });
    db.markScored(offTargetId, excludedScore(), true);
    const failed = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 10, cursor: null, filter: "failed",
    });
    const offTarget = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 10, cursor: null, filter: "offtarget",
    });
    const identityReview = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 10, cursor: null, filter: "identity_review",
    });
    expect(failed.items.some((item) => item.id === pendingId)).toBe(true);
    expect(offTarget.items.some((item) => item.id === offTargetId && item.issuerIdentityStrong === false)).toBe(true);
    expect(identityReview.items.map((item) => item.id)).toEqual(expect.arrayContaining([pendingId, offTargetId]));
  });

  it("paginates only weak rows across retained history and scopes set-aside counts to identity mode", () => {
    const db = new Desk(":memory:");
    openDesks.push(db);
    db.seedCompanies([apple]);
    const now = Date.now();
    const recentWeak = insertGoogleMatch(db, {
      id: "identity-review-recent", title: "Apple orchard volunteers plant trees", publishedAt: now,
    });
    const oldWeak = insertGoogleMatch(db, {
      id: "identity-review-old", title: "Apple tree statue returned to local park", publishedAt: now - 9 * 24 * 60 * 60 * 1_000,
    });
    const oldStrong = insertGoogleMatch(db, {
      id: "identity-review-strong", title: "AAPL announces quarterly results", publishedAt: now - 10 * 24 * 60 * 60 * 1_000,
    });
    db.markFailed(oldWeak, "Fixture failure", false);
    db.saveAnalystSourceReview({
      observationId: recentWeak, companyId: apple.id, disposition: "dismissed", nextQuestion: "Already reviewed.",
    });
    const retainedCount = db.realObservationCount();

    const recentAll = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: now - 24 * 60 * 60 * 1_000,
      limit: 10, cursor: null, filter: "all",
    });
    expect(recentAll.items.map((item) => item.id)).not.toContain(recentWeak);
    expect(recentAll.issuerIdentityReviewCount).toBe(0); // dismissed rows are set aside from the working scan

    const first = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 1, cursor: null, filter: "identity_review",
    });
    expect(first.items.map((item) => item.id)).toEqual([oldWeak]);
    expect(first.items[0]).toMatchObject({ status: "failed", issuerIdentityStrong: false });
    expect(first.issuerIdentityReviewCount).toBe(1);
    expect(first.setAsideCount).toBe(1);
    expect(first.nextCursor).toBeNull();

    const withDismissed = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 1, cursor: null, filter: "identity_review", includeDismissed: true,
    });
    expect(withDismissed.issuerIdentityReviewCount).toBe(2);
    expect(withDismissed.setAsideCount).toBe(1);
    expect(withDismissed.nextCursor).not.toBeNull();
    const second = db.mentionsForCompanyPage({
      companyId: apple.id, sinceMs: 0, limit: 1, cursor: withDismissed.nextCursor,
      filter: "identity_review", includeDismissed: true,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(withDismissed.items[0]?.id);
    expect(second.items[0]?.issuerIdentityStrong).toBe(false);
    expect(second.nextCursor).toBeNull();

    for (const filter of ["bull", "bear", "material"] as const) {
      const page = db.mentionsForCompanyPage({
        companyId: apple.id, sinceMs: 0, limit: 10, cursor: null, filter,
      });
      expect(page.items.every((item) => item.issuerIdentityStrong !== false)).toBe(true);
    }
    expect(db.mentionsForCompanyPage({ companyId: apple.id, sinceMs: 0, limit: 10, cursor: null, filter: "history", includeDismissed: true })
      .items.map((item) => item.id)).toEqual(expect.arrayContaining([recentWeak, oldWeak, oldStrong]));
    expect(db.recentVisible(20).find((item) => item.id === oldWeak)?.issuerIdentityStrong).toBe(false);
    expect(db.mentionsForCompany(apple.id, 0, 20).find((item) => item.id === oldWeak)?.issuerIdentityStrong).toBe(false);
    expect(db.realObservationCount()).toBe(retainedCount);
  });

  it("uses a clear history boundary in the working-scan visibility rule", () => {
    const weak = { id: "weak", issuerIdentityStrong: false };
    const overrides = new Map();
    expect(includesWeakIssuerMatches("all")).toBe(false);
    expect(visibleInWorkingScan(weak, false, overrides, includesWeakIssuerMatches("all"))).toBe(false);
    expect(visibleInWorkingScan(weak, false, overrides, includesWeakIssuerMatches("history"))).toBe(true);
    expect(visibleInWorkingScan(weak, false, overrides, includesWeakIssuerMatches("failed"))).toBe(true);
  });
});
