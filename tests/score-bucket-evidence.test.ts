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
    bucketAt: 1_100,
    expectedCount: 2,
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
    ...overrides,
  }));
}

describe("score bucket evidence lineage copy", () => {
  it("describes the loading query as source-identified rather than receipt-linked", () => {
    const markup = render({ loading: true });
    expect(markup).toContain("Loading saved, source-identified scored records");
    expect(markup).not.toContain("lineage-qualified");
  });

  it("reports receipt-linked and unlinked historical counts for only the loaded records", () => {
    const markup = render({ mentions: [
      { ...mention("linked", "delivery-1"), title: "Repeated source headline" },
      { ...mention("historical", null), title: "Repeated source headline" },
    ] });
    expect(markup).toContain("Loaded 2 source records from this bucket");
    expect(markup).toContain("The latest chart count is 2.");
    expect(markup).toContain("1 receipt-linked; 1 unlinked historical without a receipt");
    expect(markup).toContain("class=\"exact-title-group\" open=\"\"");
  });

  it("keeps a changing chart count distinct from loaded source rows and exposes reconnect retry", () => {
    const markup = render({
      mentions: [mention("current", null)],
      expectedCount: 2,
      expectedCountFreshness: "refreshing",
      refreshWarning: true,
    });
    expect(markup).toContain("Updating chart count · last confirmed 2 records");
    expect(markup).toContain("Loaded 1 source record from this bucket");
    expect(markup).toContain("The chart bucket count is updating.");
    expect(markup).toContain("role=\"alert\"");
    expect(markup).toContain("Retry refresh");
    expect(markup).not.toContain("Loaded 1 of 2 chart records");
  });
});
