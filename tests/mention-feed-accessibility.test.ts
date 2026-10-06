import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { MentionFeed } from "../web/src/components/MentionFeed.js";
import { MentionCard } from "../web/src/components/MentionCard.js";

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
  it("keeps publisher, source time, retrieval age, and historical impact visible and named in narrow cards", () => {
    const mention = {
      ...savedScore("narrow-metadata", "positive"),
      source: { ...savedScore("nested-source", "positive").source, name: "Wire Service", publisher: "Wire publisher" },
      publisherName: "Wire publisher",
      publishedAt: Date.UTC(2026, 9, 5, 12, 34),
      retrievedAt: Date.UTC(2026, 9, 5, 12, 40),
    };
    const markup = renderToStaticMarkup(createElement(MentionCard, { m: mention }));

    expect(markup).toContain('class="mention-card-meta');
    expect(markup).toContain('aria-label="Publisher: Wire publisher"');
    expect(markup).toContain('aria-label="publisher time:');
    expect(markup).toContain('class="mention-card-meta-label">Retrieved</span>');
    expect(markup).toContain('aria-label="Retrieved 2026-10-05T12:40:00.000Z;');
    expect(markup).toContain('aria-label="Jev directional impact');
    expect(markup).not.toContain('truncate');
  });

  it("identifies historical Jev material as a model output on the scan card", () => {
    const markup = renderToStaticMarkup(createElement(MentionCard, {
      m: savedScore("jev-material", "positive"),
    }));

    expect(markup).toContain("JEV MATERIAL");
    expect(markup).toContain("Historical Jev model material score meets its 0.60 display threshold");
    expect(markup).toContain("not an independently validated materiality finding");
  });

  it("shows a title and retained-link issuer caution before opening the retained WMT/McDonald's row", () => {
    const mention = {
      ...savedScore("wmt-mcdonalds", "positive"),
      companyId: "walmart",
      issuerIdentityStrong: true,
      title: "McDonald's AI wants to know how much you're willing to pay",
      snippet: "Walmart’s CEO just put in writing that his stores won’t do this. Many of its rivals haven’t.",
      source: {
        ...savedScore("wmt-mcdonalds-source", "positive").source,
        url: "https://www.thestreet.com/retail/walmart-makes-a-pricing-promise-other-retailers-havent?.tsrc=rss",
      },
    };
    const markup = renderToStaticMarkup(createElement(MentionFeed, {
      mentions: [mention], onOpen: () => undefined,
      companyNameOf: () => "Walmart Inc.",
      tickerOf: () => "WMT",
      knownTickers: ["WMT", "MCD"],
    }));

    expect(markup).toContain("Headline leads with McDonald; excerpt and URL path name Walmart Inc. · check title/link");
    expect(markup).toContain("the path does not verify page contents");
  });

  it("recognizes Lilly as Eli Lilly and does not flag FDA or BTK as tickers", () => {
    const mention = {
      ...savedScore("lly-clinical", "positive"),
      companyId: "lilly",
      title: "Lilly's Jaypirca receives an expanded indication from U.S. FDA",
      snippet: "Eli Lilly and Company (NYSE: LLY) announced today that the U.S. Food and Drug Administration (FDA) approved Jaypirca, a non-covalent Bruton tyrosine kinase (BTK) inhibitor.",
    };
    const markup = renderToStaticMarkup(createElement(MentionCard, {
      m: mention,
      companyNameOf: () => "Eli Lilly",
      tickerOf: () => "LLY",
      knownTickers: ["LLY", "WMT"],
    }));

    expect(markup).not.toContain("verify issuer relevance");
    expect(markup).not.toContain("Headline leads with");
  });

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

  it("labels set-aside records when an analyst explicitly reveals them", () => {
    const markup = renderToStaticMarkup(createElement(MentionFeed, {
      mentions: [{ ...pendingMention("set-aside"), analystResearchDisposition: "dismissed" }],
      onOpen: () => undefined,
    }));

    expect(markup).toContain("Set aside by you");
    expect(markup).toContain("source remains saved");
  });
});
