import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { MentionFeed } from "../web/src/components/MentionFeed.js";

function savedScore(id: string, sentiment: "positive" | "negative"): Mention {
  return {
    id,
    companyId: "acme",
    source: {
      name: "Publisher", url: `https://example.com/${id}`, kind: "rss", tier: "major",
      collector: "google_news_rss", publisher: "Publisher", publisherDomain: "example.com",
    },
    title: "Acme expands manufacturing capacity",
    snippet: "Isolated UI fixture source text",
    publishedAt: 1_000,
    providerObservedAt: null,
    retrievedAt: 1_000,
    ingestedAt: 1_000,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: "Publisher",
    publisherDomain: "example.com",
    status: "scored",
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: {
      sentiment, pPos: sentiment === "positive" ? 0.8 : 0.1,
      pNeu: 0.1, pNeg: sentiment === "negative" ? 0.8 : 0.1, confidence: 0.8,
      about: 1, material: 0.8, novel: 0.8, credible: 0.9, eventType: "results",
      takeaway: "context", magnitude: 0.5, surprise: 0.1, eventScore: 60,
      impact: sentiment === "positive" ? 70 : -70, weight: 0.8, engine: "test-fixture",
      inputTokens: 1, outputTokens: 1, estimatedInputCostUsd: 0, latencyMs: 1,
      rubricSha: "fixture", scoredAt: 1_000,
    },
    error: null,
  };
}

function pendingMention(id: string): Mention {
  return {
    ...savedScore(id, "positive"),
    title: "Acme expands manufacturing capacity",
    status: "pending",
    score: null,
  };
}

describe("mention feed disclosure states", () => {
  it("does not describe an unfinished or failed group lookup as an empty result", () => {
    const mention = savedScore("one", "positive");
    const render = (props: { loaded: boolean; loading: boolean; error: boolean }) => renderToStaticMarkup(createElement(MentionFeed, {
      mentions: [mention], onOpen: () => undefined, groupFilter: "mixed", ...props,
      onClearGroupFilter: () => undefined, onRetry: () => undefined,
    }));

    expect(render({ loaded: false, loading: true, error: false })).toContain("Loading saved scored records");
    expect(render({ loaded: false, loading: false, error: true })).toContain("The saved feed could not be loaded");
    expect(render({ loaded: false, loading: false, error: true })).not.toContain("No mixed-label exact-title groups");
  });

  it("includes the full repeated headline in the group's accessible name", () => {
    const markup = renderToStaticMarkup(createElement(MentionFeed, {
      mentions: [savedScore("one", "positive"), savedScore("two", "negative")],
      onOpen: () => undefined,
    }));

    expect(markup).toContain("aria-label=\"Exact title group “Acme expands manufacturing capacity”");
  });

  it("groups pending exact-title rows while keeping their unclassified status and caveat visible", () => {
    const markup = renderToStaticMarkup(createElement(MentionFeed, {
      mentions: [pendingMention("one"), pendingMention("two")],
      onOpen: () => undefined,
    }));

    expect(markup).toContain("Unclassified exact title group");
    expect(markup).toContain("2 loaded pending rows");
    expect(markup).toContain("counts cover loaded rows");
    expect(markup).toContain("duplicate cue only, not proof of independent reports or investors");
    expect(markup).toContain("Review 2 rows");
  });

  it("offers a direct retry when the normal feed request fails", () => {
    const markup = renderToStaticMarkup(createElement(MentionFeed, {
      mentions: [],
      onOpen: () => undefined,
      loaded: false,
      loading: false,
      error: true,
      onRetry: () => undefined,
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Retry loading saved feed"');
  });
});
