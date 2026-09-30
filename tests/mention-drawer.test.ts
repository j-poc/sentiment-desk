import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentionDrawer } from "../web/src/components/MentionDrawer.js";
import type { Mention } from "../web/src/lib/api.js";
import { retryAvailabilityFor, type RetryAvailability } from "../web/src/lib/retryAvailability.js";

// This rendering fixture stays inside the test process and is never persisted or served.
const failedMention = {
  id: "source-item-1",
  companyId: "company-1",
  source: {
    name: "Example publisher",
    url: "https://news.google.com/rss/articles/example",
    kind: "rss",
    tier: "major",
    collector: "google_news_rss",
    publisher: "Example publisher",
    publisherDomain: "example.com",
  },
  title: "A saved source item",
  snippet: "A real saved item with a failed judgment.",
  publishedAt: null,
  providerObservedAt: null,
  retrievedAt: 1_790_000_000_000,
  ingestedAt: 1_790_000_000_001,
  timeBasis: "unknown",
  collector: "google_news_rss",
  publisherName: "Example publisher",
  publisherDomain: "example.com",
  status: "failed",
  scoreRetryAt: null,
  usageCheckRequired: true,
  score: null,
  error: "Provider unavailable",
} satisfies Mention;

function renderDrawer(retryAvailability: RetryAvailability, mention: Mention = failedMention): string {
  return renderToStaticMarkup(createElement(MentionDrawer, {
    mention,
    onClose: () => undefined,
    retryAvailability,
  }));
}

describe("MentionDrawer retry availability", () => {
  it("hides retry for unknown health, paused external requests, and disabled Jev", () => {
    const unavailableStates = [
      retryAvailabilityFor(null),
      retryAvailabilityFor({ externalRequestsEnabled: false, health: { jev: { enabled: false } } }),
      retryAvailabilityFor({ externalRequestsEnabled: true, health: { jev: { enabled: false } } }),
    ];

    for (const availability of unavailableStates) {
      expect(availability.kind).toBe("unavailable");
      if (availability.kind !== "unavailable") continue;
      const html = renderDrawer(availability);
      expect(html).toContain(availability.reason);
      expect(html).toContain("source request receipt");
      expect(html).toContain("unlinked · historical record");
      expect(html).not.toContain(">Retry Jev</button>");
      expect(html).not.toContain("Send new Jev request");
    }
  });

  it("separates the most likely class from positive probability-difference impact", () => {
    const mention = {
      ...failedMention,
      status: "scored",
      score: {
        sentiment: "neutral", pPos: 0.42, pNeu: 0.58, pNeg: 0, confidence: 0.58,
        about: 1, material: 0.6, novel: 0.4, magnitude: 0.4,
        surprise: 0.3, credible: 0.8, eventType: "other", takeaway: "routine",
        eventScore: 45, impact: 42, weight: 0.7, engine: "jev-test", inputTokens: 10,
        outputTokens: 4, estimatedInputCostUsd: 0.00001, latencyMs: 20, rubricSha: "test-rubric",
        scoredAt: 1_790_000_000_100,
      },
    } satisfies Mention;
    const availability = retryAvailabilityFor({ externalRequestsEnabled: false, health: { jev: { enabled: false } } });
    const html = renderDrawer(availability, mention);

    expect(html).toContain("directional impact");
    expect(html).toContain("Open Google News result");
    expect(html).not.toContain("Open original source");
    expect(html).toContain("reported publisher");
    expect(html).toContain("reported domain");
    expect(html).toContain("collector");
    expect(html).toContain("saved link host");
    expect(html).toContain("Example publisher");
    expect(html).toContain("example.com");
    expect(html).toContain("Google News RSS");
    expect(html).toContain("news.google.com");
    expect(html).toContain("not independent verification");
    expect(html).toContain("most likely class · NEUTRAL");
    expect(html).toContain("Impact is 100 × [P(positive) − P(negative)] impact points");
    expect(html).toContain("A neutral class can still carry directional impact.");
  });

  it("shows the acknowledged retry entry point when Jev and external requests are enabled", () => {
    const availability = retryAvailabilityFor({ externalRequestsEnabled: true, health: { jev: { enabled: true } } });
    const html = renderDrawer(availability);

    expect(availability.kind).toBe("available");
    expect(html).toContain(">Retry Jev</button>");
    expect(html).not.toContain("Retry is unavailable.");
  });
});
