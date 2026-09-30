import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { RelatedHeadlineCandidates } from "../web/src/components/RelatedHeadlineCandidates.js";
import { findRelatedHeadlineCandidates } from "../web/src/lib/related-headline-candidates.js";
import type { Mention } from "../web/src/lib/api.js";

const mention: Mention = {
  id: "record-one",
  companyId: "company-a",
  source: { name: "Wire", url: "https://wire.example/record-one", kind: "rss", tier: "major", collector: "google_news_rss", publisher: "Wire", publisherDomain: "wire.example" },
  title: "Acme Q3 revenue beats analyst estimates after cloud demand rises",
  snippet: "Saved source record",
  publishedAt: 1_000,
  providerObservedAt: null,
  retrievedAt: 1_000,
  ingestedAt: 1_000,
  timeBasis: "publisher_declared",
  collector: "google_news_rss",
  publisherName: "Wire",
  publisherDomain: "wire.example",
  status: "scored",
  scoreRetryAt: null,
  usageCheckRequired: false,
  score: {
    sentiment: "positive", pPos: 0.7, pNeu: 0.2, pNeg: 0.1, confidence: 0.7,
    about: 1, material: 0.8, novel: 0.8, credible: 0.8, eventType: "other",
    takeaway: "context", magnitude: 0.6, surprise: 0.2, eventScore: 60, impact: 60,
    weight: 0.7, engine: "test", inputTokens: 1, outputTokens: 1,
    estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "fixture", scoredAt: 1_000,
  },
  error: null,
};

describe("related headline review UI", () => {
  it("labels candidate matching as unvalidated and explains that it does not affect the chart", () => {
    const candidates = findRelatedHeadlineCandidates([
      mention,
      {
        ...mention,
        id: "record-two",
        title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates",
        source: { ...mention.source, name: "Paper", url: "https://paper.example/record-two", publisher: "Paper", publisherDomain: "paper.example" },
        publisherName: "Paper",
        publisherDomain: "paper.example",
      },
    ]);
    const html = renderToStaticMarkup(
      <RelatedHeadlineCandidates candidates={candidates} loaded now={2_000} onOpenMention={() => undefined} />,
    );

    assert.match(html, /Similar-title candidates/);
    assert.match(html, /unvalidated/);
    assert.match(html, /40% Jaccard overlap/);
    assert.match(html, /never change the chart or rankings/);
    assert.match(html, /Open saved evidence record from Wire/);
    assert.match(html, /wire\.example/);
    assert.match(html, /google_news_rss/);
    assert.match(html, /full span/);
    assert.match(html, /anchor \+ this title full span/);
  });

  it("does not present an empty sample as proof that repeated stories do not exist", () => {
    const html = renderToStaticMarkup(
      <RelatedHeadlineCandidates candidates={[]} loaded now={2_000} onOpenMention={() => undefined} />,
    );

    assert.match(html, /No candidates meet this rule in the loaded sample/);
    assert.match(html, /does not show that no stories were repeated/);
  });
});
