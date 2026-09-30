import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "../web/src/lib/api.js";
import { formatChartTimestamp } from "../web/src/lib/chart-time.js";
import { hasOlderSavedPriceHistory, sentimentSeriesState } from "../web/src/lib/series-chart-state.js";

function point(t: number, v: number | null, n: number): SeriesPoint {
  return { t, v, n, itemImpactMin: null, itemImpactMax: null, lastScoredAt: n > 0 ? t : null };
}

describe("sentiment chart data states", () => {
  it("prints an explicit timezone on modeled and scored chart timestamps", () => {
    const timestamp = Date.parse("2026-09-28T10:00:00.000Z");
    const expectedZone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === "timeZoneName")?.value;

    expect(expectedZone).toBeTruthy();
    expect(formatChartTimestamp(timestamp)).toContain(expectedZone);
  });

  it("keeps a modeled-only decay line visible when no selected-window scores arrived", () => {
    expect(sentimentSeriesState([point(1, 24, 0), point(2, 12, 0)])).toEqual({
      hasSentiment: false,
      hasModeledHistory: true,
      hasChartData: true,
    });
  });

  it("does not claim chart data when the series contains only empty buckets", () => {
    expect(sentimentSeriesState([point(1, null, 0), point(2, null, 0)])).toEqual({
      hasSentiment: false,
      hasModeledHistory: false,
      hasChartData: false,
    });
  });

  it("recognizes newly scored buckets separately from decay", () => {
    expect(sentimentSeriesState([point(1, 24, 1), point(2, 12, 0)])).toEqual({
      hasSentiment: true,
      hasModeledHistory: true,
      hasChartData: true,
    });
  });

  it("offers seven-day history only for verified points older than the selected window and still within seven days", () => {
    const now = Date.parse("2026-09-28T08:00:00.000Z");

    expect(hasOlderSavedPriceHistory(now - 36 * 60 * 60_000, 24, now)).toBe(true);
    expect(hasOlderSavedPriceHistory(now - 8 * 24 * 60 * 60_000, 24, now)).toBe(false);
    expect(hasOlderSavedPriceHistory(now - 12 * 60 * 60_000, 24, now)).toBe(false);
    expect(hasOlderSavedPriceHistory(null, 24, now)).toBe(false);
  });
});
