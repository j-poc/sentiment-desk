import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertDeliveryStatus, DeskHealthDisclosure, HealthPanel } from "../web/src/components/HealthPanel.js";
import type { HealthDTO, SourceHealth } from "../web/src/lib/api.js";

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
  it("distinguishes loading operations from an unavailable response", () => {
    const loading = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health: null, loadState: "loading" }));
    const failed = renderToStaticMarkup(createElement(DeskHealthDisclosure, { health: null, loadState: "failed" }));

    expect(loading).toContain("Checking source, Jev, and webhook status");
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
