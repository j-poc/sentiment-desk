import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AnalystResearchQueueItem } from "../web/src/lib/api.js";
import { AnalystResearchQueueView } from "../web/src/components/AnalystResearchQueueView.js";

const source = {
  observationId: "apple:immutable-source-id",
  companyId: "apple",
  disposition: "investigate",
  nextQuestion: "Does the primary filing confirm the reported change?",
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_100,
  companyName: "Apple Inc.",
  ticker: "AAPL",
  mention: {
    id: "apple:immutable-source-id",
    companyId: "apple",
    source: {
      name: "Reuters", url: "https://www.reuters.com/business/example", kind: "finnhub", tier: "wire",
      collector: "finnhub", publisher: "Reuters", publisherDomain: "reuters.com", deliveryId: "receipt-1",
    },
    title: "Supplier reports component delay",
    snippet: "The source-reported claim remains unverified.",
    publishedAt: 1_790_000_000_000,
    providerObservedAt: null,
    retrievedAt: 1_790_000_000_100,
    ingestedAt: 1_790_000_000_101,
    timeBasis: "publisher_declared",
    collector: "finnhub",
    publisherName: "Reuters",
    publisherDomain: "reuters.com",
    status: "pending",
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: null,
    error: null,
  },
} satisfies AnalystResearchQueueItem;

function html(state: "loading" | "ready" | "failed", items: readonly AnalystResearchQueueItem[] = []) {
  return renderToStaticMarkup(createElement(AnalystResearchQueueView, {
    items, state, error: null, dismissBusyId: null,
    onOpenEvidence: vi.fn(), onDismiss: vi.fn(), onRetry: vi.fn(),
  }));
}

describe("My Research queue usability", () => {
  it("shows a source-linked next check, original judgment status and receipt timing without a ranking claim", () => {
    const markup = html("ready", [source]);
    expect(markup).toContain("Supplier reports component delay");
    expect(markup).toContain("Reuters");
    expect(markup).toContain("Judgment pending");
    expect(markup).toContain("receipt linked");
    expect(markup).toContain("Does the primary filing confirm the reported change?");
    expect(markup).toContain("Review source record");
    expect(markup).toContain("Open saved source link");
    expect(markup).toContain("not by company merit");
    expect(markup).toContain("not verified findings, rankings, materiality judgments");
  });

  it("distinguishes loading, empty, and failed states and preserves the user's work on failure", () => {
    expect(html("loading")).toContain('role="status">Loading your saved research');
    expect(html("ready")).toContain("Your queue is empty.");
    expect(html("failed")).toContain("Your saved source records have not been changed.");
    expect(html("failed")).toContain("Retry loading queue");
  });

  it("keeps RSS feed time distinct from publisher publication time in the saved queue", () => {
    const rssItem: AnalystResearchQueueItem = {
      ...source,
      mention: {
        ...source.mention,
        source: { ...source.mention.source, kind: "rss", collector: "google_news_rss" },
        publishedAt: null,
        aggregatorPublishedAt: 1_790_000_000_000,
        providerObservedAt: null,
        timeBasis: "aggregator_declared",
        collector: "google_news_rss",
      },
    };
    const markup = html("ready", [rssItem]);
    expect(markup).toContain("Google News feed time");
    expect(markup).not.toContain("Publisher time");
  });
});
