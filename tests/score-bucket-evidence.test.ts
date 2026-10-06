import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { ScoreBucketEvidence } from "../web/src/components/ScoreBucketEvidence.js";

function mention(id: string, deliveryId: string | null): Mention {
  return {
    id,
    companyId: "adobe",
    source: {
      name: "Publisher", url: `https://example.com/${id}`, kind: "rss", tier: "major",
      collector: "google_news_rss", publisher: "Publisher", publisherDomain: "example.com", deliveryId,
    },
    title: `Saved record ${id}`,
    snippet: "Test-only source text.",
    publishedAt: 1_000,
    providerObservedAt: null,
    retrievedAt: 1_000,
    ingestedAt: 1_001,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: "Publisher",
    publisherDomain: "example.com",
    status: "scored",
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: {
      sentiment: "neutral", pPos: 0.3, pNeu: 0.4, pNeg: 0.3, confidence: 0.4,
      about: 1, material: 0.5, novel: 0.5, credible: 0.8, eventType: "news",
      takeaway: "context", magnitude: 0.5, surprise: 0.2, eventScore: 40,
      impact: 0, weight: 0.5, engine: "jev-test", inputTokens: 1, outputTokens: 1,
      estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "fixture", scoredAt: 1_100,
    },
    error: null,
  };
}

function render(overrides: Partial<Parameters<typeof ScoreBucketEvidence>[0]> = {}): string {
  return renderToStaticMarkup(createElement(ScoreBucketEvidence, {
    bucketFromMs: 0,
    bucketThroughMs: 900_000,
    expectedCount: 2,
    recordCount: 2,
    matchingRecordCount: 2,
    impactBin: null,
    weightedMeanImpact: 15,
    recordImpactMin: -10,
    recordImpactMax: 40,
    coverageSummary: {
      exactNormalizedTitleCount: 2,
      repeatedTitleRecordCount: 0,
      untitledRecordCount: 0,
      scoreCompletionTime: { earliestAtMs: 1_100, latestAtMs: 1_100 },
      sourceTimes: {
        publisherDeclared: { recordCount: 2, timestampedRecordCount: 2, range: { earliestAtMs: 1_000, latestAtMs: 1_000 } },
        providerObserved: { recordCount: 0, timestampedRecordCount: 0, range: null },
        unknownRecordCount: 0,
        legacyUnknownRecordCount: 0,
      },
      receiptLinkedRecordCount: 1,
    },
    impactDistribution: Array.from({ length: 20 }, (_, index) => ({
      from: -100 + index * 10, through: -90 + index * 10, includeThrough: index === 19,
      count: index === 9 ? 1 : index === 14 ? 1 : 0,
    })),
    snapshotStale: false,
    selectionExpired: false,
    expectedCountFreshness: "current",
    mentions: [],
    loading: false,
    loadingMore: false,
    error: false,
    loadMoreError: false,
    hasMore: false,
    headingRef: createRef<HTMLHeadingElement>(),
    onClose: () => undefined,
    onOpenMention: () => undefined,
    onRetry: () => undefined,
    refreshWarning: false,
    onRetryRefresh: () => undefined,
    onLoadMore: () => undefined,
    onSelectImpactBin: () => undefined,
    ...overrides,
  }));
}

describe("score bucket evidence lineage copy", () => {
  it("prints both full interval endpoints in UTC with millisecond precision and an exclusive end", () => {
    const markup = render({
      bucketFromMs: Date.parse("2026-09-28T09:45:00.123Z"),
      bucketThroughMs: Date.parse("2026-09-28T10:00:00.456Z"),
    });
    const interval = markup.match(/<span>([^<]+)<\/span>/)?.[1] ?? "";
    const endpoints = interval.split(" – ");

    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toMatch(/2026/);
    expect(endpoints[0]).toMatch(/[.,]123/);
    expect(endpoints[0]).toContain("UTC");
    expect(endpoints[1]).toMatch(/2026/);
    expect(endpoints[1]).toMatch(/[.,]456/);
    expect(endpoints[1]).toContain("UTC");
    expect(interval).toContain("end exclusive");
  });

  it("describes the loading query as source-identified rather than receipt-linked", () => {
    const markup = render({ loading: true, coverageSummary: null });
    expect(markup).toContain("Loading saved, source-identified scored records");
    expect(markup).not.toContain("lineage-qualified");
  });

  it("reports receipt-linked and unlinked historical counts for only the loaded records", () => {
    const markup = render({ mentions: [
      { ...mention("linked", "delivery-1"), title: "Repeated source headline" },
      { ...mention("historical", null), title: "Repeated source headline" },
    ] });
    expect(markup).toContain("Loaded 2 of 2 matching source records");
    expect(markup).toContain("Chart count 2.");
    expect(markup).toContain("1 receipt-linked; 1 unlinked historical without a receipt");
    expect(markup).toContain("class=\"exact-title-group\" open=\"\"");
  });

  it("shows full-bucket title, source-clock, and receipt coverage separately from the loaded page", () => {
    const markup = render({
      recordCount: 74,
      matchingRecordCount: 6,
      mentions: [mention("one-loaded-row", null)],
      coverageSummary: {
        exactNormalizedTitleCount: 52,
        repeatedTitleRecordCount: 36,
        untitledRecordCount: 0,
        scoreCompletionTime: { earliestAtMs: Date.parse("2026-09-28T09:50:24Z"), latestAtMs: Date.parse("2026-09-28T09:56:24Z") },
        sourceTimes: {
          publisherDeclared: { recordCount: 72, timestampedRecordCount: 72, range: { earliestAtMs: Date.parse("2026-09-27T15:00:00Z"), latestAtMs: Date.parse("2026-09-28T09:43:32Z") } },
          aggregatorDeclared: { recordCount: 2, timestampedRecordCount: 1, range: { earliestAtMs: Date.parse("2026-09-27T15:12:00Z"), latestAtMs: Date.parse("2026-09-27T15:12:00Z") } },
          providerObserved: { recordCount: 0, timestampedRecordCount: 0, range: null },
          unknownRecordCount: 0,
          legacyUnknownRecordCount: 0,
        },
        receiptLinkedRecordCount: 0,
      },
    });

    expect(markup).toContain("52 exact normalized titles");
    expect(markup).toContain("36 records in repeated-title groups");
    expect(markup).toContain("Jev score completion");
    expect(markup).toContain("not a 15-minute measure of publication volume or investor activity");
    expect(markup).toContain("Publisher-declared publication time: 72 of 72 records timestamped");
    expect(markup).toContain("Aggregator-declared RSS feed time: 1 of 2 records timestamped");
    expect(markup).toContain("Article publication time is unknown.");
    expect(markup).toContain("0 of 74 records link to a delivery receipt");
    expect(markup).toContain("All counts cover the full interval and stay fixed while filtering or paging source rows");
  });

  it("keeps a changing chart count distinct from loaded source rows and exposes reconnect retry", () => {
    const markup = render({
      mentions: [mention("current", null)],
      expectedCount: 2,
      expectedCountFreshness: "refreshing",
      refreshWarning: true,
    });
    expect(markup).toContain("Chart count updating · last confirmed 2.");
    expect(markup).toContain("Loaded 1 of 2 matching source records");
    expect(markup).toContain("role=\"alert\"");
    expect(markup).toContain("Retry refresh");
    expect(markup).toContain("Full 20-bin distribution · 2 of 2 records · unweighted record counts");
  });

  it("withholds a distribution and source rows when snapshot membership changes", () => {
    const markup = render({ mentions: [mention("stale", null)], snapshotStale: true });
    expect(markup).toContain("Saved records or full-bucket coverage could not be reconciled to this chart snapshot");
    expect(markup).not.toContain("Full 20-bin distribution");
    expect(markup).not.toContain("Saved record stale");
  });

  it("prevents duplicate stale-bucket reloads while the refreshed series is loading", () => {
    const markup = render({ snapshotStale: true, expectedCountFreshness: "refreshing" });
    expect(markup).toContain("Refreshing this interval");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("aria-busy=\"true\"");
  });

  it("explains when a stale bucket has left the selected chart window", () => {
    const markup = render({ snapshotStale: true, selectionExpired: true });
    expect(markup).toContain("This interval has left the selected window");
    expect(markup).toContain("choose a bucket from the refreshed chart");
    expect(markup).not.toContain("Reload this interval");
  });

  it("keeps the full-bucket histogram distinct from a partially loaded source page", () => {
    const markup = render({
      expectedCount: 55,
      recordCount: 55,
      matchingRecordCount: 55,
      impactDistribution: Array.from({ length: 20 }, (_, index) => ({
        from: -100 + index * 10, through: -90 + index * 10, includeThrough: index === 19,
        count: index === 10 ? 55 : 0,
      })),
      mentions: [mention("page-one", null), mention("page-two", "delivery")],
      hasMore: true,
    });
    expect(markup).toContain("Full 20-bin distribution · 55 of 55 records · unweighted record counts");
    expect(markup).toContain("Loaded 2 of 55 matching source records · more available");
  });

  it("offers keyboard-accessible impact-band filtering while preserving the full histogram counts", () => {
    const markup = render({
      recordCount: 74,
      matchingRecordCount: 6,
      impactBin: 1,
      mentions: [mention("filtered-row", null)],
      impactDistribution: Array.from({ length: 20 }, (_, index) => ({
        from: -100 + index * 10, through: -90 + index * 10, includeThrough: index === 19,
        count: index === 1 ? 6 : index === 5 ? 68 : 0,
      })),
    });
    expect(markup).toContain("Filter source rows by impact band");
    expect(markup).toContain("-90 to -80 · 6 records");
    expect(markup).toContain("Loaded 1 of 6 matching source records");
    expect(markup).toContain("6 matching source records");
    expect(markup).toContain("Full 20-bin distribution · 74 of 74 records");
  });

  it("exposes a real retry control when a later evidence page fails", () => {
    const markup = render({ loadMoreError: true, hasMore: true });
    expect(markup).toContain("The next source page could not be loaded");
    expect(markup).toContain(">Retry</button>");
  });

  it("shows an initial bucket-load failure without claiming an unseen distribution failed reconciliation", () => {
    const markup = render({
      expectedCount: 74,
      recordCount: 74,
      impactDistribution: [],
      error: true,
    });

    expect(markup).toContain("The saved records for this interval could not be loaded.");
    expect(markup).not.toContain("Full interval coverage");
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("74 saved scored records");
    expect(markup).not.toContain("weighted mean unavailable");
    expect(markup).not.toContain("full-bucket distribution did not reconcile");
  });
});
