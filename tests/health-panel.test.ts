import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthPanel } from "../web/src/components/HealthPanel.js";
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
  it("shows an unapproved requested collector and blocks Jev without account-use attestation", () => {
    const html = renderToStaticMarkup(createElement(HealthPanel, { health: blockedHealth }));

    expect(html).toContain("source-use approvals");
    expect(html).toContain("1 requested blocked");
    expect(html).toContain("finnhub");
    expect(html).toContain("Jev account-use flag");
    expect(html).toContain("missing · dispatch blocked");
    expect(html).toContain("operator attestations");
  });
});
