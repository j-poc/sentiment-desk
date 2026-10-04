import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CategoricalEmptyState } from "../web/src/components/CategoricalTrendChart.js";

describe("Luna empty chart state", () => {
  it("makes saved source evidence the primary next step and historical Jev an explicit choice", () => {
    const html = renderToStaticMarkup(createElement(CategoricalEmptyState, {
      withheldInvalidCount: 0,
      classifierEnabled: false,
      blockedReason: "external requests are disabled",
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      onOpenOperations: vi.fn(),
      onRefresh: vi.fn(),
    }));

    expect(html).toContain("This is an empty result, not a neutral sentiment reading.");
    expect(html.indexOf("Review saved source records")).toBeLessThan(html.indexOf("View historical Jev chart"));
    expect(html).toContain("New classifications are blocked: external requests are disabled");
  });

  it("shows withheld-lineage state without implying a classifier result", () => {
    const html = renderToStaticMarkup(createElement(CategoricalEmptyState, {
      withheldInvalidCount: 2,
      classifierEnabled: true,
      blockedReason: null,
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      onOpenOperations: vi.fn(),
      onRefresh: vi.fn(),
    }));

    expect(html).toContain("2 candidate classifications are withheld because source or model lineage is incomplete.");
    expect(html).toContain("Review saved source records");
    expect(html).not.toContain("positive");
  });
});
