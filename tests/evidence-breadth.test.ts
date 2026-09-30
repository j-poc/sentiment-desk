import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Mention, Sentiment } from "../web/src/lib/api.js";
import { summarizeEvidenceBreadth } from "../web/src/lib/evidence-breadth.js";
import { EvidenceBreadth } from "../web/src/components/EvidenceBreadth.js";

function mention(
  id: string,
  title: string,
  sentiment: Sentiment,
  publisherDomain: string,
  status: Mention["status"] = "scored",
): Mention {
  return {
    id,
    companyId: "acme",
    source: { name: publisherDomain, url: `https://${publisherDomain}/${id}`, kind: "rss", tier: "major", collector: "google_news_rss", publisher: publisherDomain, publisherDomain },
    title,
    snippet: "Saved provider observation",
    publishedAt: 1_000,
    providerObservedAt: null,
    retrievedAt: 1_000,
    ingestedAt: 1_000,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: publisherDomain,
    publisherDomain,
    status,
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: status === "scored" ? {
      sentiment, pPos: 0.5, pNeu: 0.2, pNeg: 0.3, confidence: 0.7,
      about: 1, material: 0.8, novel: 0.8, credible: 0.8, eventType: "other",
      takeaway: "fixture", magnitude: 0.5, surprise: 0, eventScore: 50, impact: 20,
      weight: 0.5, engine: "test", inputTokens: 1, outputTokens: 1,
      estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "fixture", scoredAt: 1_000,
    } : null,
    error: null,
  };
}

describe("evidence breadth summary", () => {
  it("offers a direct retry when the saved evidence request fails", () => {
    const markup = renderToStaticMarkup(createElement(EvidenceBreadth, {
      mentions: [], hours: 24, loaded: false, error: true, hasMore: false, now: 1_000,
      refreshWarning: false, onRetry: () => undefined, onRetryRefresh: () => undefined,
      onShowRecords: () => undefined, onOpenMention: () => undefined,
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Retry loading evidence summary"');
  });

  it("states prominently when window counts cover only the loaded first page", () => {
    const markup = renderToStaticMarkup(createElement(EvidenceBreadth, {
      mentions: [mention("sample", "Acme wins contract", "positive", "wire.example")],
      hours: 24, loaded: true, error: false, hasMore: true, now: 1_000,
      refreshWarning: false, onRetry: () => undefined, onRetryRefresh: () => undefined,
      onShowRecords: () => undefined, onOpenMention: () => undefined,
    }));

    expect(markup).toContain("Counts below cover only these loaded rows, not the full 24H window");
    expect(markup).toContain("Positive 1 of 1");
  });

  it("counts repeated exact titles, mixed Jev labels, and publisher labels without equating them to independent sources", () => {
    const summary = summarizeEvidenceBreadth([
      mention("a", "Acme wins contract", "positive", "wire.example"),
      mention("b", "  ACME   WINS CONTRACT ", "negative", "paper.example"),
      mention("c", "Acme wins contract", "positive", "wire.example"),
      mention("d", "Acme opens office", "neutral", "local.example"),
      mention("e", "Acme opens office", "neutral", "community.example"),
      mention("f", "Acme opens office", "neutral", "pending.example", "pending"),
    ]);

    expect(summary).toEqual({
      sourceRecordCount: 6,
      scoredRecordCount: 5,
      latestSourceAt: 1_000,
      latestSourceTimeBasis: "publisher",
      latestScoreAt: 1_000,
      publisherLabelCount: 4,
      exactHeadlineCount: 2,
      repeatedHeadlineGroupCount: 2,
      recordsInRepeatedHeadlineGroups: 5,
      mixedJevLabelGroupCount: 1,
      sentiment: { positive: 2, neutral: 2, negative: 1 },
    });
  });

  it("does not collapse punctuation variants or count unscored rows as Jev evidence", () => {
    const failed = mention("c", "Acme reports", "positive", "three.example", "failed");
    failed.publishedAt = null;
    failed.providerObservedAt = 1_500;
    const summary = summarizeEvidenceBreadth([
      mention("a", "Acme reports", "positive", "one.example"),
      mention("b", "Acme reports!", "negative", "two.example"),
      failed,
    ]);

    expect(summary.exactHeadlineCount).toBe(2);
    expect(summary.repeatedHeadlineGroupCount).toBe(0);
    expect(summary.recordsInRepeatedHeadlineGroups).toBe(0);
    expect(summary.scoredRecordCount).toBe(2);
    expect(summary.sourceRecordCount).toBe(3);
    expect(summary.latestSourceAt).toBe(1_500);
    expect(summary.latestSourceTimeBasis).toBe("provider observed");
    expect(summary.latestScoreAt).toBe(1_000);
  });
});
