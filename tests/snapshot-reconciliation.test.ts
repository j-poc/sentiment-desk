import { describe, expect, it } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import {
  hasUnrefreshedRecord,
  reconcileDrawerMentionOnReconnect,
  reconcileMentionPageOnReconnect,
  reconcileScoreBucketOnMention,
  reconcileScoreBucketOnReconnect,
  remainingLookupFailuresAfterStream,
  type ReconnectableMentionPage,
  type ReconnectableScoreBucket,
} from "../web/src/lib/snapshot-reconciliation.js";

function mention(id: string, title = id, companyId = "acme"): Mention {
  return {
    id,
    companyId,
    source: {
      name: "Publisher", url: `https://example.com/${id}`, kind: "rss", tier: "major",
      collector: "google_news_rss", publisher: "Publisher", publisherDomain: "example.com",
    },
    title,
    snippet: "Saved source record used by the isolated test.",
    publishedAt: 1_000,
    providerObservedAt: null,
    retrievedAt: 1_000,
    ingestedAt: 1_001,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: "Publisher",
    publisherDomain: "example.com",
    status: "off_target",
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: null,
    error: null,
  };
}

function scoredMention(id: string, scoredAt: number, title = id): Mention {
  return {
    ...mention(id, title),
    status: "scored",
    score: {
      sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
      about: 1, material: 1, novel: 0, credible: 1, eventType: "product", takeaway: "Saved score",
      magnitude: 0.8, surprise: 0.8, eventScore: 0.8, impact: 80, weight: 1, engine: "jev",
      inputTokens: 0, outputTokens: 0, estimatedInputCostUsd: 0, latencyMs: 0, rubricSha: "saved",
      scoredAt,
    },
  };
}

describe("same-runtime snapshot reconciliation", () => {
  it("scopes reconnect warnings to IDs whose lookup batches failed", () => {
    const failedIds = new Set(["bucket-record", "drawer-record"]);
    expect(hasUnrefreshedRecord([{ id: "bucket-record" }, { id: "current-record" }], failedIds)).toBe(true);
    expect(hasUnrefreshedRecord([{ id: "current-record" }], failedIds)).toBe(false);
  });

  it("clears a failed lookup warning when a newer stream row arrived during reconnect", () => {
    const result = remainingLookupFailuresAfterStream(
      new Set(["bucket-record", "still-stale"]),
      new Map([
        ["bucket-record", { sequence: 11, mention: mention("bucket-record", "Latest stream row") }],
        ["older-stream", { sequence: 9, mention: mention("older-stream") }],
      ]),
      10,
    );

    expect(result).toEqual(new Set(["still-stale"]));
  });

  it("preserves loaded older pages and their cursor while reconciling refreshed records", () => {
    const cursor = { publishedAt: 42, id: "page-205" };
    const items = Array.from({ length: 205 }, (_, index) => mention(`page-${index}`));
    items[1] = mention("page-1", "Before reconnect");
    const page: ReconnectableMentionPage & { filter: string; loadingMore: boolean } = {
      companyId: "acme",
      filter: "all",
      items,
      nextCursor: cursor,
      loaded: true,
      loadingMore: false,
    };
    const latest = new Map([
      ["page-2", { sequence: 9, mention: mention("page-2", "Streamed before snapshot") }],
      ["new-after-snapshot", { sequence: 11, mention: mention("new-after-snapshot", "Arrived after snapshot") }],
    ]);

    const result = reconcileMentionPageOnReconnect(
      page,
      [mention("page-1", "Updated by snapshot"), mention("page-3", "No longer matches")],
      latest,
      10,
      (row) => row.id !== "page-3",
    );

    expect(result.items).toHaveLength(205);
    expect(result.items.find((row) => row.id === "page-0")?.title).toBe("page-0");
    expect(result.items.find((row) => row.id === "page-1")?.title).toBe("Updated by snapshot");
    expect(result.items.find((row) => row.id === "page-2")?.title).toBe("page-2");
    expect(result.items.find((row) => row.id === "page-3")).toBeUndefined();
    expect(result.items.find((row) => row.id === "new-after-snapshot")?.title).toBe("Arrived after snapshot");
    expect(result.nextCursor).toBe(cursor);
    expect(result.loadingMore).toBe(false);
  });

  it("lets post-snapshot stream updates override stale status in filtered pages and the open drawer", () => {
    const failed = { ...mention("a"), status: "failed" as const, error: "temporary scoring error" };
    const scored = scoredMention("a", 2_000, "Latest scored record");
    const page = {
      companyId: "acme", items: [failed], nextCursor: null, loaded: true,
      filter: "failed", loadingMore: false,
    };
    const postSnapshot = new Map([["a", { sequence: 11, mention: scored }]]);

    const failedPage = reconcileMentionPageOnReconnect(
      page,
      [failed],
      postSnapshot,
      10,
      (row) => row.status === "failed",
    );
    const allRows = reconcileMentionPageOnReconnect(
      { ...page, filter: "all", items: [failed] },
      [failed],
      postSnapshot,
      10,
      () => true,
    );

    expect(failedPage.items).toEqual([]);
    expect(allRows.items).toEqual([scored]);
    expect(reconcileDrawerMentionOnReconnect(failed, [failed], false, postSnapshot, 10)).toEqual(scored);
  });

  it("removes loaded records confirmed missing by the reconnect lookup", () => {
    const page = {
      companyId: "acme", items: [mention("removed")], nextCursor: null, loaded: true,
    };
    const result = reconcileMentionPageOnReconnect(
      page,
      [],
      new Map(),
      10,
      () => true,
      new Set(["removed"]),
    );

    expect(result.items).toEqual([]);
    expect(reconcileDrawerMentionOnReconnect(
      mention("removed"), [], false, new Map(), 10, new Set(["removed"]),
    )).toBeNull();
  });

  it("keeps an open score bucket current as streamed rows enter, leave, or move across its boundary", () => {
    const first = scoredMention("first", 1_500);
    const moved = scoredMention("moved", 1_900);
    const bucket: ReconnectableScoreBucket & { expectedCount: number; loading: boolean } = {
      companyId: "acme", bucketFromMs: 1_000, bucketThroughMs: 2_000,
      expectedCount: 2, items: [first, moved], loading: false, expectedCountFreshness: "current" as const,
    };
    const demoted = { ...first, status: "off_target" as const, score: null };
    const outside = scoredMention("moved", 2_001);
    const entering = scoredMention("entering", 1_800);
    const afterDemotion = reconcileScoreBucketOnMention(bucket, demoted);
    const afterMove = reconcileScoreBucketOnMention(afterDemotion, outside);
    const afterArrival = reconcileScoreBucketOnMention(afterMove, entering);

    expect(afterDemotion?.items.map((row) => row.id)).toEqual(["moved"]);
    expect(afterMove?.items).toEqual([]);
    expect(afterArrival?.items.map((row) => row.id)).toEqual(["entering"]);
    // The chart remains the authority for the displayed bucket count.
    expect(afterArrival?.expectedCount).toBe(2);
    expect(afterArrival?.expectedCountFreshness).toBe("refreshing");
  });

  it("reconciles an open bucket from reconnect lookups and post-request events", () => {
    const old = scoredMention("old", 1_500);
    const latest = scoredMention("old", 1_750, "Newer event version");
    const bucket = {
      companyId: "acme", bucketFromMs: 1_000, bucketThroughMs: 2_000, items: [old], expectedCount: 1,
    };
    const result = reconcileScoreBucketOnReconnect(
      bucket,
      [old],
      new Set(["old", "removed"]),
      new Map([
        ["old", { sequence: 11, mention: latest }],
        ["removed", { sequence: 11, mention: scoredMention("removed", 1_700) }],
      ]),
      10,
    );

    expect(result?.items.map((row) => [row.id, row.title])).toEqual([["old", "Newer event version"], ["removed", "removed"]]);
  });

  it("retains an older open record on reconnect, refreshes a matching record, and clears it after a runtime change", () => {
    const older = mention("older-than-tape");
    const current = reconcileDrawerMentionOnReconnect(older, [mention("latest")], false, new Map(), 0);
    expect(current).toBe(older);

    const refreshed = mention(older.id, "Refreshed saved record");
    expect(reconcileDrawerMentionOnReconnect(older, [refreshed], false, new Map(), 0)?.title)
      .toBe("Refreshed saved record");
    expect(reconcileDrawerMentionOnReconnect(older, [mention("latest")], true, new Map(), 0)).toBeNull();
  });
});
