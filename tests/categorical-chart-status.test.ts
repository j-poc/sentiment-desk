import { describe, expect, it } from "vitest";
import { categoricalChartStatusLabel } from "../web/src/lib/categorical-chart-status.js";

describe("categorical chart status labels", () => {
  it("distinguishes an in-progress saved-history read from Luna classification work", () => {
    expect(categoricalChartStatusLabel({
      companyId: "aapl",
      windowHours: 168,
      status: "loading",
      eligibleObservationCount: 0,
      observedAt: 67_000,
    }, "7D", 100_000)).toBe("Loading saved Luna history · last confirmed 0 in 7D · last successful read 33s ago");
  });

  it("reports the last confirmed count and read after a failed request", () => {
    expect(categoricalChartStatusLabel({
      companyId: "aapl",
      windowHours: 168,
      status: "failed",
      eligibleObservationCount: 12,
      observedAt: 67_000,
    }, "7D", 100_000)).toBe("Saved Luna history unavailable · last confirmed 12 in 7D · last successful read 33s ago");
  });

  it("does not imply an old successful read or classifications when none are known", () => {
    expect(categoricalChartStatusLabel({
      companyId: "aapl",
      windowHours: 168,
      status: "loading",
      eligibleObservationCount: null,
      observedAt: null,
    }, "7D", 100_000)).toBe("Loading saved Luna history");
  });
});
