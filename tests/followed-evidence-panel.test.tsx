import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FollowedEvidenceBaselineView } from "../web/src/components/FollowedEvidenceBaseline.js";
import type { FollowedEvidenceItem, FollowedEvidencePage } from "../web/src/lib/api.js";

const baselineAt = Date.parse("2026-10-04T10:00:00.000Z");
const item: FollowedEvidenceItem = {
  id: "fixture-observation-1",
  companyId: "acme",
  source: {
    name: "Reuters", url: "https://www.reuters.com/example", kind: "rss", tier: "major",
    collector: "google_news_rss", publisher: "Reuters", publisherDomain: "reuters.com", deliveryId: "fixture-receipt-1",
  },
  title: "A dated public-source observation",
  snippet: "Fixture-only UI record used to verify visible source lineage.",
  publishedAt: baselineAt - 3_600_000,
  providerObservedAt: baselineAt + 1_000,
  retrievedAt: baselineAt + 2_000,
  ingestedAt: baselineAt + 3_000,
  timeBasis: "publisher_declared",
  collector: "google_news_rss",
  publisherName: "Reuters",
  publisherDomain: "reuters.com",
  status: "pending",
  scoreRetryAt: null,
  usageCheckRequired: false,
  score: null,
  classification: null,
  error: null,
  publishedBeforeBaseline: true,
  ingestionCompletedAt: baselineAt + 4_000,
  ingestionFinalizedAfterBaseline: false,
};

const baseProps = {
  companyId: "acme",
  companyName: "Acme (ACME)",
  loading: false,
  loadError: false,
  refreshError: false,
  loadingMore: false,
  loadMoreError: false,
  captureBusy: false,
  captureError: null,
  resetArmed: false,
  onRetry: vi.fn(),
  onRetryPage: vi.fn(),
  onLoadMore: vi.fn(),
  onCapture: vi.fn(),
  onCancelReset: vi.fn(),
  onOpenEvidence: vi.fn(),
};

describe("followed evidence baseline panel", () => {
  it("distinguishes a missing baseline from a confirmed empty source set", () => {
    const page: FollowedEvidencePage = {
      companyId: "acme", baseline: null, asOfAt: baselineAt,
      eligibleObservationsNow: 0, withheldFromBaseline: 2, newEvidenceCount: 0,
      items: [], nextCursor: null,
    };
    const missing = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, { ...baseProps, page }));
    expect(missing).toContain("No baseline saved");
    expect(missing).toContain("2 real-history rows withheld");
    expect(missing).toContain("Start following from saved evidence");

    const empty = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, {
      ...baseProps,
      page: { ...page, baseline: { id: "fixture-baseline", companyId: "acme", version: 1, capturedAt: baselineAt, eligibleObservationCount: 0, policyVersion: "receipt-ingestion-success/1" } },
    }));
    expect(empty).toContain("No newly eligible, receipt-verified source evidence");
    expect(empty).toContain("This is not a materiality or trading signal");
  });

  it("keeps pending and late-arriving source times visible with a reviewable source link", () => {
    const page: FollowedEvidencePage = {
      companyId: "acme",
      baseline: { id: "fixture-baseline", companyId: "acme", version: 2, capturedAt: baselineAt, eligibleObservationCount: 5, policyVersion: "receipt-ingestion-success/1" },
      asOfAt: baselineAt + 10_000,
      eligibleObservationsNow: 6,
      withheldFromBaseline: 1,
      newEvidenceCount: 1,
      items: [item],
      nextCursor: null,
    };
    const html = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, { ...baseProps, page }));
    expect(html).toContain("aria-label=\"New saved source evidence\"");
    expect(html).toContain("Published before baseline · retrieved after");
    expect(html).toContain("Publisher:");
    expect(html).toContain("Provider observed:");
    expect(html).toContain("Retrieved:");
    expect(html).toContain("Saved:");
    expect(html).toContain("pending");
    expect(html).toContain("receipt linked");
    expect(html).toContain("href=\"https://www.reuters.com/example\" target=\"_blank\" rel=\"noreferrer\"");
    expect(html).toContain("Review record");
    expect(html).toContain("Set new baseline");
    expect(html).not.toContain("material change");
  });

  it("distinguishes a source retrieved before baseline whose ingestion completed later", () => {
    const page: FollowedEvidencePage = {
      companyId: "acme",
      baseline: { id: "fixture-baseline", companyId: "acme", version: 1, capturedAt: baselineAt, eligibleObservationCount: 0, policyVersion: "receipt-ingestion-success/1" },
      asOfAt: baselineAt + 10_000,
      eligibleObservationsNow: 1,
      withheldFromBaseline: 0,
      newEvidenceCount: 1,
      items: [{ ...item, retrievedAt: baselineAt - 1_000, ingestedAt: baselineAt - 500, publishedBeforeBaseline: false,
        ingestionCompletedAt: baselineAt + 4_000, ingestionFinalizedAfterBaseline: true }],
      nextCursor: null,
    };
    const html = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, { ...baseProps, page }));
    expect(html).toContain("Ingestion completed after baseline · source was already retrieved");
    expect(html).not.toContain("Published before baseline · retrieved after");
  });

  it("renders failed refresh separately from loading and confirms native keyboard controls", () => {
    const loading = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, { ...baseProps, page: null, loading: true }));
    expect(loading).toContain("Loading the saved comparison");
    expect(loading).toContain("role=\"status\"");

    const failed = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, { ...baseProps, page: null, loading: false, loadError: true }));
    expect(failed).toContain("role=\"alert\"");
    expect(failed).toContain("Retry");

    const stalePage: FollowedEvidencePage = {
      companyId: "acme",
      baseline: { id: "fixture-baseline", companyId: "acme", version: 1, capturedAt: baselineAt, eligibleObservationCount: 0, policyVersion: "receipt-ingestion-success/1" },
      asOfAt: baselineAt + 1_000, eligibleObservationsNow: 0, withheldFromBaseline: 0,
      newEvidenceCount: 0, items: [], nextCursor: null,
    };
    const stale = renderToStaticMarkup(createElement(FollowedEvidenceBaselineView, { ...baseProps, page: stalePage, refreshError: true }));
    expect(stale).toContain("Refresh failed. Showing the last saved comparison");
    expect(stale).toContain("<button");
    expect(stale).toContain("aria-busy=\"false\"");
  });
});
