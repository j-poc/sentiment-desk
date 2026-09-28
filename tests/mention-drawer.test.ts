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
    url: "https://example.com/story",
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

function renderDrawer(retryAvailability: RetryAvailability): string {
  return renderToStaticMarkup(createElement(MentionDrawer, {
    mention: failedMention,
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
      expect(html).not.toContain(">Retry Jev</button>");
      expect(html).not.toContain("Send new Jev request");
    }
  });

  it("shows the acknowledged retry entry point when Jev and external requests are enabled", () => {
    const availability = retryAvailabilityFor({ externalRequestsEnabled: true, health: { jev: { enabled: true } } });
    const html = renderDrawer(availability);

    expect(availability.kind).toBe("available");
    expect(html).toContain(">Retry Jev</button>");
    expect(html).not.toContain("Retry is unavailable.");
  });
});
