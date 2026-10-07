import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { EvidenceQuickAccess } from "../web/src/components/EvidenceQuickAccess.js";

const now = Date.UTC(2026, 9, 6, 12);

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: "a1",
    companyId: "c1",
    source: { name: "Publisher", url: "https://example.com/story", kind: "rss", tier: "major", collector: "google_news_rss", publisher: "example.com", publisherDomain: "example.com" },
    title: "Real saved source row",
    snippet: "Saved source content",
    publishedAt: now - 86_400_000,
    providerObservedAt: null,
    retrievedAt: now - 80_000_000,
    ingestedAt: now - 80_000_000,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: "Publisher",
    publisherDomain: "example.com",
    status: "pending",
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: null,
    classification: null,
    error: null,
    ...overrides,
  };
}

describe("evidence quick access", () => {
  it("shows saved-row count, Luna coverage, source clock, and a direct review action", () => {
    const html = renderToStaticMarkup(createElement(EvidenceQuickAccess, {
      mentions: [mention(), mention({ id: "a2", classification: {
        attemptId: "attempt-2", provider: "openai_luna", modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna",
        serviceTierRequested: "default", serviceTier: "default", promptVersion: "p1", promptSha256: "sha", profileSha256: null,
        schemaVersion: "s1", schemaSha256: "sha", sentiment: "neutral", eventType: "other", takeaway: "A real review",
        about: true, investorRelevant: true, material: false, evidenceSufficient: true, summary: "Review", supportingExcerpt: "Excerpt",
        disposition: "classified", responseId: "resp-2", responseSha256: "sha", inputTokens: 1, cachedInputTokens: null,
        cacheWriteInputTokens: null, outputTokens: 1, reasoningTokens: null, totalTokens: 2, estimatedCostUsd: 0,
        latencyMs: 1, classifiedAt: now,
      } })],
      hours: 168,
      loaded: true,
      error: false,
      hasMore: false,
      now,
      onReview: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(html).toContain("7D evidence · 2 saved rows · 1 unclassified by Luna");
    expect(html).toContain("latest 1d ago · publisher time");
    expect(html).toContain('aria-label="7D: 2 loaded saved source rows; 1 has no Luna classification');
    expect(html).toContain(">Review 2 saved source records ↓</button>");
  });

  it("does not imply coverage when only a limited loaded sample is visible", () => {
    const html = renderToStaticMarkup(createElement(EvidenceQuickAccess, {
      mentions: [mention()], hours: 72, loaded: true, error: false, hasMore: true, now,
      onReview: vi.fn(), onRetry: vi.fn(),
    }));

    expect(html).toContain("3D evidence · 1 latest loaded row");
    expect(html).toContain("older rows available");
    expect(html).toContain("1 unclassified by Luna");
    expect(html).toContain(">Review latest 1 saved source record ↓</button>");
  });

  it("offers recovery for failed evidence loads and reports empty windows plainly", () => {
    const failed = renderToStaticMarkup(createElement(EvidenceQuickAccess, {
      mentions: [], hours: 24, loaded: false, error: true, hasMore: false, now,
      onReview: vi.fn(), onRetry: vi.fn(),
    }));
    const empty = renderToStaticMarkup(createElement(EvidenceQuickAccess, {
      mentions: [], hours: 24, loaded: true, error: false, hasMore: false, now,
      onReview: vi.fn(), onRetry: vi.fn(),
    }));

    expect(failed).toContain("Saved 24H evidence is unavailable.");
    expect(failed).toContain(">Retry</button>");
    expect(empty).toContain("No saved source-timed rows in 24H.");
    expect(empty).not.toContain("Review latest");
  });
});
