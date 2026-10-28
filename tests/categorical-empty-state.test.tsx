import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CategoricalEmptyState, CategoricalUntimedState } from "../web/src/components/CategoricalTrendChart.js";

describe("Luna empty chart state", () => {
  it("makes saved source evidence the primary next step and historical Jev an explicit choice", () => {
    const html = renderToStaticMarkup(createElement(CategoricalEmptyState, {
      withheldInvalidCount: 0,
      classifierEnabled: false,
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      historicalJevSummary: "51 saved scores in UTC week [2026-09-28, 2026-10-05)",
    }));

    expect(html).toContain("This is an empty result, not a neutral sentiment reading.");
    expect(html.indexOf("Review saved source records")).toBeLessThan(html.indexOf("View historical Jev chart"));
    expect(html).toContain("New Luna classifications are currently paused.");
    expect(html).not.toContain("external requests are disabled");
    expect(html).not.toContain("connections");
    expect(html).toContain("51 saved scores in UTC week [2026-09-28, 2026-10-05)");
    expect(html).not.toContain("Reload saved results locally");
  });

  it("shows withheld-lineage state without implying a classifier result", () => {
    const html = renderToStaticMarkup(createElement(CategoricalEmptyState, {
      withheldInvalidCount: 2,
      classifierEnabled: true,
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      historicalJevSummary: "saved archive unavailable",
    }));

    expect(html).toContain("2 candidate classifications are withheld because source or model lineage is incomplete.");
    expect(html).toContain("Review saved source records");
    expect(html).not.toContain("positive");
  });

  it("lets the investor open GPT-6 Luna access from the empty chart without opening operations", () => {
    const html = renderToStaticMarkup(createElement(CategoricalEmptyState, {
      withheldInvalidCount: 0,
      classifierEnabled: false,
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      onOpenLunaSettings: vi.fn(),
      historicalJevSummary: "saved Jev history available",
    }));

    expect(html).toContain("Open GPT-6 Luna access");
    expect(html).toContain("New Luna classifications are currently paused");
    expect(html).not.toContain("Review classification availability");
    expect(html).not.toContain("Data connections &amp; operations");
  });

  it("explains when every eligible classification lacks a validated source time", () => {
    const html = renderToStaticMarkup(createElement(CategoricalUntimedState, {
      count: 3,
      historicalJevSummary: "saved Jev history available",
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
    }));

    expect(html).toContain("No eligible Luna classifications have a usable source time");
    expect(html).toContain("3 saved source observations have no validated publisher, feed, or provider timestamp");
    expect(html).toContain("excluded from the timeline");
    expect(html).toContain("Review saved source records");
    expect(html).not.toContain("Neutral");
  });

  it("discloses the Gemini key, item consent, public-source boundary, and unknown free-tier billing in the empty chart", () => {
    const html = renderToStaticMarkup(createElement(CategoricalEmptyState, {
      withheldInvalidCount: 0,
      classifierEnabled: false,
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      onOpenLunaSettings: vi.fn(),
      historicalJevSummary: "saved history available",
      provider: "google_gemini",
    }));

    expect(html).toContain("No saved Gemini 3.8 Flash classifications in this window");
    expect(html).toContain("This is an empty result, not a neutral sentiment reading.");
    expect(html).toContain("Chart reads never contact Google");
    expect(html).toContain("Only public, non-sensitive source text is eligible");
    expect(html).toContain("each item needs your explicit approval");
    expect(html).toContain("private notes are never sent from this lane");
    expect(html).toContain("Google lists free quota for eligible models and projects where free use is allowed");
    expect(html).toContain("Its terms require API clients made available in the EEA, Switzerland, and UK to use Paid Services through an actively billed Cloud project");
    expect(html).toContain("a free-tier-only project is not eligible there");
    expect(html).toContain("Gemini 3.8 Flash paid-tier usage is metered");
    expect(html).toContain("If you require strictly $0 use in those regions, do not send Gemini requests");
    expect(html).not.toContain("draws on free quota");
    expect(html).toContain("cannot verify your region, eligibility, billing, or remaining quota");
    expect(html).toContain("Open Gemini model settings");
    expect(html).not.toContain("New Luna classifications are currently paused");
  });

  it("labels untimed Gemini rows without turning them into chart points", () => {
    const html = renderToStaticMarkup(createElement(CategoricalUntimedState, {
      count: 2,
      historicalJevSummary: "saved Jev history available",
      onReviewSourceRecords: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      provider: "google_gemini",
    }));

    expect(html).toContain("No eligible Gemini 3.8 Flash classifications have a usable source time");
    expect(html).toContain("2 saved source observations have no validated publisher, feed, or provider timestamp");
    expect(html).toContain("excluded from the timeline");
  });
});
