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

function renderDrawer(
  retryAvailability: RetryAvailability,
  mention: Mention = failedMention,
  onOpenOperations?: () => void,
): string {
  return renderToStaticMarkup(createElement(MentionDrawer, {
    mention,
    onClose: () => undefined,
    retryAvailability,
    onOpenOperations,
  }));
}

describe("MentionDrawer retry availability", () => {
  it("puts SEC status and lineage before a collapsed saved excerpt", () => {
    const excerpt = "Quarterly results excerpt with revenue and margin details.";
    const context = {
      version: "sec-document-context/1" as const, cik: "2488", accessionNo: "0000002488-26-000121",
      primaryUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm",
      acceptedAt: 1_790_000_000_000, filedAt: 1_789_900_000_000,
      classificationInputStatus: "ready" as const, selectionReason: "unique_exhibit_selected" as const,
      item202Link: { kind: "linked" as const, itemCode: "2.02" as const, exhibitNumber: "99.1" as const, supportingText: "The results release is attached as Exhibit 99.1." },
      selectedRole: "earnings_exhibit_99_1" as const,
      selectedUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/q22026991.htm",
      documents: [
        { role: "8k_primary" as const, url: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm", startedAt: 1, completedAt: 2, retrievedAt: 2, httpStatus: 200, outcome: "success" as const, bodyBytes: 300, bodySha256: "a".repeat(64), excerpt: "The parent filing excerpt.", errorCode: null },
        { role: "earnings_exhibit_99_1" as const, url: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/q22026991.htm", startedAt: 3, completedAt: 4, retrievedAt: 4, httpStatus: 200, outcome: "success" as const, bodyBytes: 400, bodySha256: "b".repeat(64), excerpt, errorCode: null },
      ],
    };
    const mention = {
      ...failedMention,
      status: "pending" as const,
      snippet: excerpt,
      source: { ...failedMention.source, kind: "sec" as const, url: context.selectedUrl, collector: "sec_edgar" as const, deliveryId: "receipt-123" },
      collector: "sec_edgar" as const,
      filedAt: context.filedAt,
      secDocumentContext: context,
    } satisfies Mention;
    const html = renderDrawer(retryAvailabilityFor(null), mention, () => undefined);
    const lineageIndex = html.indexOf("Open selected Exhibit 99.1");
    const excerptDisclosureIndex = html.indexOf("Read the selected SEC excerpt");
    const excerptIndex = html.indexOf(excerpt);

    expect(html).toContain("Judgment pending");
    expect(html).toContain("Judgment status");
    expect(html).toContain("source input ready");
    expect(html).toContain("See why judgment is pending");
    expect(html).toContain('aria-controls="desk-operations"');
    expect(html).toContain('dateTime="1970-01-01T00:00:00.002Z"');
    expect(html).toContain('dateTime="1970-01-01T00:00:00.004Z"');
    expect(html).toContain("Parent 8-K filing");
    expect(lineageIndex).toBeGreaterThan(-1);
    expect(excerptDisclosureIndex).toBeGreaterThan(lineageIndex);
    expect(excerptIndex).toBeGreaterThan(html.indexOf("</summary>", excerptDisclosureIndex));
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it("keeps non-SEC source snippets directly visible", () => {
    const html = renderDrawer(retryAvailabilityFor(null));
    expect(html).toContain("A real saved item with a failed judgment.");
  });

  it("discloses selected Exhibit 99.1 and parent 8-K provenance from the saved filing operation", () => {
    const context = {
      version: "sec-document-context/1" as const, cik: "2488", accessionNo: "0000002488-26-000121",
      primaryUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm",
      acceptedAt: 1_790_000_000_000, filedAt: 1_789_900_000_000,
      classificationInputStatus: "ready" as const, selectionReason: "unique_exhibit_selected" as const,
      item202Link: { kind: "linked" as const, itemCode: "2.02" as const, exhibitNumber: "99.1" as const, supportingText: "Press release & attached as Exhibit 99.1 <script>" },
      selectedRole: "earnings_exhibit_99_1" as const,
      selectedUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/q22026991.htm",
      documents: [
        { role: "8k_primary" as const, url: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm", startedAt: 1, completedAt: 2, retrievedAt: 2, httpStatus: 200, outcome: "success" as const, bodyBytes: 300, bodySha256: "a".repeat(64), excerpt: "The parent 8-K excerpt", errorCode: null },
        { role: "earnings_exhibit_99_1" as const, url: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/q22026991.htm", startedAt: 3, completedAt: 4, retrievedAt: 4, httpStatus: 200, outcome: "success" as const, bodyBytes: 400, bodySha256: "b".repeat(64), excerpt: "The exhibit excerpt", errorCode: null },
      ],
    };
    const mention = {
      ...failedMention, source: { ...failedMention.source, kind: "sec" as const, url: context.selectedUrl, collector: "sec_edgar" as const, deliveryId: "receipt-123" },
      collector: "sec_edgar" as const, publisherName: "SEC EDGAR", publisherDomain: "sec.gov",
      filedAt: context.filedAt, secDocumentContext: context,
    } satisfies Mention;
    const html = renderDrawer(retryAvailabilityFor(null), mention);
    expect(html).toContain("filing-evidence operation");
    expect(html).toContain("Text source: Exhibit 99.1");
    expect(html).toContain("Parent 8-K filing");
    expect(html).toContain("The parent 8-K excerpt");
    expect(html).toContain("Item 2.02 attachment statement");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("body SHA-256");
    expect(html).toContain("Earnings release selected from Item 2.02");
    expect(html).not.toContain("unique_exhibit_selected");
  });

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
      expect(html).toContain("Classifier request history");
      expect(html).toContain("Loading request history");
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
    expect(html).toContain("One historical model output, not a share-price move or an independent investor opinion.");
    expect(html).toContain("Jev quality and confidence calibration are unverified; this source has no linked delivery receipt.");
  });

  it("shows the acknowledged retry entry point when Jev and external requests are enabled", () => {
    const availability = retryAvailabilityFor({ externalRequestsEnabled: true, health: { jev: { enabled: true } } });
    const html = renderDrawer(availability);

    expect(availability.kind).toBe("available");
    expect(html).toContain(">Retry Jev</button>");
    expect(html).not.toContain("Retry is unavailable.");
  });
});
