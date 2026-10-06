import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertDeliveryStatus, DeskHealthDisclosure, HealthPanel } from "../web/src/components/HealthPanel.js";
import type { HealthDTO, SourceHealth } from "../web/src/lib/api.js";
import { operationsAttentionCount } from "../web/src/lib/operations-attention.js";

const sourceHealth: SourceHealth = {
  enabled: false,
  ok: 0,
  fail: 0,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
};

const blockedHealth: HealthDTO = {
  ok: true,
  externalRequestsEnabled: true,
  opportunityRadarEnabled: false,
  version: "test",
  runtimeId: "runtime-test",
  uptimeSec: 1,
  sseClients: 0,
  dbSizeBytes: null,
  storage: {
    state: "ready", canStartExternalWork: true, writesAllowed: true, reason: null,
    mainBytes: 1024, walBytes: 0, shmBytes: 0, journalBytes: 0, familyBytes: 1024,
    allocatedBytes: 1024, availableBytes: 8 * 1024 ** 3, pageCount: 1, pageSize: 4096,
    logicalDatabaseBytes: 4096,
    maxPageCount: 524288, maxDatabaseBytes: 2 * 1024 ** 3, maxFamilyBytes: 5 * 1024 ** 3,
    minimumFreeBytes: 1024 ** 3, writeHeadroomBytes: 128 * 1024 ** 2, checkedAt: 10_000,
  },
  alertDelivery: { configured: false, enabled: false, counts: { pending: 0, sending: 0, retrying: 0, failed: 0, paused: 0 }, recent: [], nextCursor: null },
  health: {
    externalRequestsEnabled: true,
    sourceApproval: {
      requestedCollectors: ["finnhub"],
      approvedCollectors: [],
      blockedRequestedCollectors: ["finnhub"],
      typesafeAccountUseApproved: false,
      jevAllowedCollectors: [],
    },
    rss: sourceHealth,
    gdelt: sourceHealth,
    x: sourceHealth,
    quotes: sourceHealth,
    sec: sourceHealth,
    finnhub: sourceHealth,
    reddit: sourceHealth,
    jev: { ...sourceHealth, model: "jev-latest" },
  },
  deliveries: [],
  deliveryHealth: [],
  usage: { judgedItems: 0, inputTokens: 0, outputTokens: 0, estimatedInputCostUsd: 0 },
  events: [],
};

describe("HealthPanel source approval disclosure", () => {
  it("flags blocked sources and incomplete classifier accounting in the collapsed operations count", () => {
    const health = { ...blockedHealth, classifierUsage: {
      requests: 2, reservedRequests: 1, inputTokens: null, cachedInputTokens: null,
      cacheWriteInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null,
      estimatedCostUsd: null, knownCostSubtotalUsd: 0, reservedCostUsd: 0.2,
      unpricedAttempts: 2, usageIncompleteAttempts: 2, unknownOutcomes: 1,
    } };
    expect(operationsAttentionCount(health)).toBe(3);
    const html = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health }));
    expect(html).toContain("3 signals");
  });
  it("surfaces storage pressure as an operational signal and keeps saved evidence available", () => {
    const health: HealthDTO = { ...blockedHealth, storage: {
      ...blockedHealth.storage, state: "checkpoint_blocked", canStartExternalWork: false,
      writesAllowed: true, reason: "Close long-running database readers and retry.",
    } };
    expect(operationsAttentionCount(health)).toBe(2);
    const html = renderToStaticMarkup(createElement(HealthPanel, { health }));
    expect(html).toContain("checkpoint blocked");
    expect(html).toContain("New external requests are paused; saved evidence remains available.");
    expect(html).toContain("Close long-running database readers and retry.");
    expect(html).toContain("1.00 GB</span>");
    expect(html).toContain("128.0 MB");
    expect(html).toContain("2.00 GB hard SQLite page ceiling");
    expect(html).toContain("hard SQLite page ceiling");
    expect(html).toContain("not guaranteed completion reserves");
  });
  it("separates a known Luna cost subtotal from an incomplete daily estimate", () => {
    const html = renderToStaticMarkup(createElement(HealthPanel, { health: {
      ...blockedHealth,
      classifierUsage: { requests: 2, reservedRequests: 1, inputTokens: null,
        cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null,
        reasoningTokens: null, totalTokens: null, estimatedCostUsd: null,
        knownCostSubtotalUsd: 0.1, reservedCostUsd: 0.2, unpricedAttempts: 1,
        usageIncompleteAttempts: 1, unknownOutcomes: 0 },
    } }));
    expect(html).toContain("unknown / $0.200");
    expect(html).toContain("$0.100 · 1 unpriced request(s)");
    expect(html).toContain("Incomplete token receipts");
    expect(html).not.toContain("$0.00 / $0.20");
  });
  it("distinguishes loading operations from an unavailable response", () => {
    const loading = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health: null, loadState: "loading" }));
    const failed = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health: null, loadState: "failed" }));

    expect(loading).toContain("Checking source, classifier, and webhook status");
    expect(loading).not.toContain("Operations status unavailable");
    expect(failed).toContain("Operations status unavailable");
    expect(failed).not.toContain("Checking source");
    expect(failed).toContain('role="status"');
    expect(failed).not.toContain("2xl:hidden");
  });

  it("marks a failed refresh while retaining the last received operations evidence", () => {
    const html = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health: blockedHealth, loadState: "failed" }));

    expect(html).toContain("Operations refresh failed.");
    expect(html).toContain("Showing the last received");
    expect(html).toContain("1 requested blocked");
  });

  it("shows an unapproved requested collector and blocks Jev without account-use attestation", () => {
    const html = renderToStaticMarkup(createElement(HealthPanel, { health: blockedHealth }));

    expect(html).toContain("source-use approvals");
    expect(html).toContain("1 requested blocked");
    expect(html).toContain("finnhub");
    expect(html).toContain("Jev account-use flag");
    expect(html).toContain("missing · dispatch blocked");
    expect(html).toContain("operator attestations");
  });

  it("provides detailed desk health within ordinary desktop and mobile layouts", () => {
    const html = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health: blockedHealth }));

    expect(html).toContain("2xl:hidden");
    expect(html).toContain("Desk health");
    expect(html).toContain("source-use approvals");
  });

  it("signals partial or overdue collection and a Jev error while the disclosure is collapsed", () => {
    const health: HealthDTO = {
      ...blockedHealth,
      health: {
        ...blockedHealth.health,
        jev: { ...sourceHealth, fail: 1, lastErrorAt: 5_000, lastError: "timeout", model: "jev-latest" },
      },
      deliveryHealth: [{
        collector: "google_news_rss", enabled: true, state: "partial", intervalSeconds: 60,
        targetCount: 24, coverageCount: 12, latestDeliveryAt: 4_000, latestResult: "partial",
        latestItemCount: 12, latestError: "partial response", adapterVersion: "rss-v1",
        latestIngestionRequired: false, latestIngestionState: null, latestIngestionExpectedCount: null,
        latestIngestionProcessedCount: null, latestIngestionInsertedCount: null, latestObservationAt: 3_000,
        latestObservationBasis: "provider_observed", latestObservationRetrievedAt: 3_500,
      }, {
        collector: "yahoo_quote", enabled: true, state: "overdue", intervalSeconds: 60,
        targetCount: 24, coverageCount: 0, latestDeliveryAt: null, latestResult: null,
        latestItemCount: null, latestError: null, adapterVersion: null,
        latestIngestionRequired: false, latestIngestionState: null, latestIngestionExpectedCount: null,
        latestIngestionProcessedCount: null, latestIngestionInsertedCount: null, latestObservationAt: null,
        latestObservationBasis: null, latestObservationRetrievedAt: null,
      }],
    };
    const html = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health }));

    expect(html).toContain("4 signals");
    expect(html).toContain("external requests enabled");
  });

  it("keeps the last failed delivery outcome visible while saved-data mode pauses the collector", () => {
    const html = renderToStaticMarkup(createElement(HealthPanel, { health: {
      ...blockedHealth,
      externalRequestsEnabled: false,
      deliveryHealth: [{
        collector: "gdelt_doc_api", enabled: false, state: "disabled", intervalSeconds: 60,
        targetCount: 24, coverageCount: 24, latestDeliveryAt: 1_790_000_000_000,
        latestResult: "rate_limited", latestItemCount: 0, latestError: null, adapterVersion: "gdelt-v1",
        latestIngestionRequired: false, latestIngestionState: null, latestIngestionExpectedCount: null,
        latestIngestionProcessedCount: null, latestIngestionInsertedCount: null, latestObservationAt: null,
        latestObservationBasis: null, latestObservationRetrievedAt: null,
      }],
    } }));

    expect(html).toContain("gdelt doc api");
    expect(html).toContain("disabled");
    expect(html).toContain("Last recorded outcome: rate limited");
    expect(html).not.toContain("Last recorded outcome: success");
  });

  it("explains alert uncertainty and names successful delivery as endpoint acceptance", () => {
    const html = renderToStaticMarkup(createElement(AlertDeliveryStatus, {
      delivery: {
        configured: true,
        enabled: true,
        counts: { pending: 0, sending: 0, retrying: 1, failed: 0, paused: 0 },
        nextCursor: null,
        recent: [{
          alertId: "alert-1",
          observationId: "observation-1", companyId: "acme", ticker: "ACME", title: "Acme expands production",
          state: "retrying", attemptCount: 2, createdAt: 1_000, expiresAt: 100_000, nextAttemptAt: Date.now() + 60_000,
          lastOutcome: "ambiguous", lastHttpStatus: null, lastAttemptAt: 2_000, lastErrorCategory: "transport_ambiguous",
        }],
      },
      onOpenEvidence: async () => true,
    }));

    expect(html).toContain("delivery uncertain");
    expect(html).toContain("repeated sends may occur");
    expect(html).toContain("does not confirm downstream processing");
    expect(html).not.toContain("webhook URL");
  });

  it("shows when webhook alerts are not configured before any alerts exist", () => {
    const html = renderToStaticMarkup(createElement(AlertDeliveryStatus, {
      delivery: {
        configured: false,
        enabled: false,
        counts: { pending: 0, sending: 0, retrying: 0, failed: 0, paused: 0 },
        nextCursor: null,
        recent: [],
      },
      onOpenEvidence: async () => true,
    }));

    expect(html).toContain("Webhook alerts");
    expect(html).toContain("webhook not configured");
    expect(html).toContain("No qualifying observation has created an alert.");
  });

  it("keeps older alert failures visible even when newer intents succeeded", () => {
    const html = renderToStaticMarkup(createElement(AlertDeliveryStatus, {
      delivery: {
        configured: true,
        enabled: true,
        counts: { pending: 0, sending: 0, retrying: 0, failed: 1, paused: 0 },
        nextCursor: null,
        recent: [{
          alertId: "alert-old",
          observationId: "old-failure", companyId: "acme", ticker: "ACME", title: "Older delivery failure",
          state: "failed", attemptCount: 5, createdAt: 1_000, expiresAt: 100_000, nextAttemptAt: 100_000,
          lastOutcome: "failed", lastHttpStatus: 400, lastAttemptAt: 2_000, lastErrorCategory: "http_client_error",
        }, {
          alertId: "alert-new",
          observationId: "new-success", companyId: "acme", ticker: "ACME", title: "Newer successful alert",
          state: "delivered", attemptCount: 1, createdAt: 9_000, expiresAt: 100_000, nextAttemptAt: 9_000,
          lastOutcome: "delivered", lastHttpStatus: 204, lastAttemptAt: 9_100, lastErrorCategory: null,
        }],
      },
      onOpenEvidence: async () => true,
    }));

    expect(html).toContain("1 alert need attention");
    expect(html).toContain("1 terminal failure");
    expect(html.indexOf("Older delivery failure")).toBeLessThan(html.indexOf("Newer successful alert"));
  });
});
