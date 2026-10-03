import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "../web/src/lib/api.js";
import { formatChartTimestamp } from "../web/src/lib/chart-time.js";
import { chartVisibleThroughSeconds, hasOlderSavedPriceHistory, refreshedScoreBucketState, scoreBucketEvidenceBaseline, scoreBucketChartTimeline, scoreBucketSnapshotMatches, sentimentSeriesState } from "../web/src/lib/series-chart-state.js";

function point(t: number, v: number | null, n: number): SeriesPoint {
  return {
    bucketStartAtMs: t - 15 * 60_000,
    bucketEndAtMs: t,
    bucketSnapshotKey: n > 0 ? "a".repeat(64) : null,
    weightedMeanImpact: v,
    scoredRecordCount: n,
    recordImpactMin: null,
    recordImpactMax: null,
    latestRecordScoredAtMs: n > 0 ? t : null,
    t, v, n, itemImpactMin: null, itemImpactMax: null, lastScoredAt: n > 0 ? t : null,
  };
}

describe("sentiment chart data states", () => {
  it("prints exact UTC milliseconds on saved scored chart timestamps", () => {
    const timestamp = Date.parse("2026-09-28T10:00:00.000Z");
    expect(formatChartTimestamp(timestamp)).toBe("2026-09-28 10:00:00.000 UTC");
  });

  it("does not claim chart data when the series contains only empty buckets", () => {
    expect(sentimentSeriesState([point(1, null, 0), point(2, null, 0)])).toEqual({
      hasSentiment: false,
      hasChartData: false,
    });
  });

  it("recognizes actual weighted-mean buckets as plotted data", () => {
    expect(sentimentSeriesState([point(1, 24, 1), point(2, 12, 0)])).toEqual({
      hasSentiment: true,
      hasChartData: true,
    });
  });

  it("preserves distinct UTC millisecond positions at a bucket boundary", () => {
    const previous = point(Date.parse("2026-09-28T13:15:00.000Z"), -12, 2);
    previous.bucketStartAtMs = Date.parse("2026-09-28T13:00:00.000Z");
    const newPartial = point(Date.parse("2026-09-28T13:15:00.420Z"), 34, 1);
    newPartial.bucketStartAtMs = Date.parse("2026-09-28T13:15:00.000Z");

    const timeline = scoreBucketChartTimeline([previous, newPartial]);
    const chartSeconds = timeline.map((item) => item.chartTimeSeconds);

    expect(timeline.map(({ point }) => point)).toEqual([previous, newPartial]);
    expect(chartSeconds).toEqual([
      Date.parse("2026-09-28T13:15:00.000Z") / 1000,
      Date.parse("2026-09-28T13:15:00.420Z") / 1000,
    ]);
    expect(chartSeconds.every((value, index) => index === 0 || value > chartSeconds[index - 1]!)).toBe(true);
    expect(chartVisibleThroughSeconds(newPartial.bucketEndAtMs, chartSeconds.at(-1)!)).toBe(newPartial.bucketEndAtMs / 1000);
  });

  it("rejects duplicate true bucket endpoints rather than inventing plot times", () => {
    const timestamp = Date.parse("2026-09-28T13:15:00.420Z");
    expect(() => scoreBucketChartTimeline([point(timestamp, -12, 1), point(timestamp, 34, 1)]))
      .toThrow("Score bucket end timestamps must be unique and increasing.");
  });

  it("rejects safe integers outside JavaScript's UTC date range", () => {
    expect(() => scoreBucketChartTimeline([point(Number.MAX_SAFE_INTEGER, 1, 1)]))
      .toThrow("Score bucket timestamps must be valid UTC milliseconds.");
    expect(() => formatChartTimestamp(Number.MAX_SAFE_INTEGER))
      .toThrow("Chart timestamp must be valid UTC milliseconds.");
  });

  it("keeps saved zero-weight records visible even when no weighted mean can be calculated", () => {
    expect(sentimentSeriesState([point(1, null, 3)])).toEqual({
      hasSentiment: true,
      hasChartData: true,
    });
  });

  it("reopens stale bucket evidence against the refreshed chart snapshot and count", () => {
    const oldFrom = Date.parse("2026-09-28T12:45:00.000Z");
    const oldThrough = Date.parse("2026-09-28T12:55:00.000Z");
    const fresh = point(Date.parse("2026-09-28T12:57:00.000Z"), 42, 3);
    fresh.bucketStartAtMs = oldFrom;
    fresh.bucketSnapshotKey = "b".repeat(64);
    const baseline = scoreBucketEvidenceBaseline([fresh], oldFrom, oldThrough);

    expect(baseline).toEqual({ bucketFromMs: oldFrom, bucketThroughMs: fresh.bucketEndAtMs, snapshotKey: "b".repeat(64), recordCount: 3 });
    expect(scoreBucketSnapshotMatches("b".repeat(64), 3, "b".repeat(64), 3)).toBe(true);
    expect(scoreBucketSnapshotMatches("a".repeat(64), 3, "b".repeat(64), 3)).toBe(false);
    expect(scoreBucketSnapshotMatches(baseline!.snapshotKey, baseline!.recordCount, "c".repeat(64), 4)).toBe(false);
  });

  it("accepts a refreshed empty interval without a bucket hash only when it still has zero records", () => {
    const from = Date.parse("2026-09-28T12:45:00.000Z");
    const through = Date.parse("2026-09-28T13:00:00.000Z");
    const baseline = scoreBucketEvidenceBaseline([point(through, null, 0)], from, through);

    expect(baseline).toEqual({ bucketFromMs: from, bucketThroughMs: through, snapshotKey: null, recordCount: 0 });
    expect(scoreBucketSnapshotMatches(baseline!.snapshotKey, baseline!.recordCount, "d".repeat(64), 0)).toBe(true);
    expect(scoreBucketSnapshotMatches(baseline!.snapshotKey, baseline!.recordCount, "d".repeat(64), 1)).toBe(false);
  });

  it("moves a refreshed first partial bucket boundary and rejects an interval that left the selected window", () => {
    const oldFrom = Date.parse("2026-09-21T12:07:00.000Z");
    const through = Date.parse("2026-09-21T12:15:00.000Z");
    const freshFrom = Date.parse("2026-09-21T12:09:00.000Z");
    const fresh = point(through, 7, 2);
    fresh.bucketStartAtMs = freshFrom;
    fresh.bucketSnapshotKey = "e".repeat(64);

    expect(scoreBucketEvidenceBaseline([fresh], oldFrom, through)).toEqual({
      bucketFromMs: freshFrom, bucketThroughMs: through, snapshotKey: "e".repeat(64), recordCount: 2,
    });
    expect(scoreBucketEvidenceBaseline([], oldFrom, through)).toBeNull();
  });

  it("retries with the newest interval and snapshot after membership changes again during recovery", () => {
    const oldFrom = Date.parse("2026-09-21T12:07:00.000Z");
    const oldThrough = Date.parse("2026-09-21T12:15:00.000Z");
    const firstRefresh = point(oldThrough, 18, 3);
    firstRefresh.bucketStartAtMs = Date.parse("2026-09-21T12:09:00.000Z");
    firstRefresh.bucketSnapshotKey = "b".repeat(64);

    const firstBaseline = scoreBucketEvidenceBaseline([firstRefresh], oldFrom, oldThrough)!;
    expect(firstBaseline).toEqual({
      bucketFromMs: firstRefresh.bucketStartAtMs,
      bucketThroughMs: oldThrough,
      snapshotKey: "b".repeat(64),
      recordCount: 3,
    });

    // A source row arrives while the first retry is in flight, invalidating that
    // exact snapshot. Recovery must follow the same UTC bucket again and adopt
    // the second refresh's new boundary, digest, and count.
    const secondRefresh = point(oldThrough, 25, 4);
    secondRefresh.bucketStartAtMs = Date.parse("2026-09-21T12:10:00.000Z");
    secondRefresh.bucketSnapshotKey = "c".repeat(64);
    const secondBaseline = scoreBucketEvidenceBaseline(
      [secondRefresh], firstBaseline.bucketFromMs, firstBaseline.bucketThroughMs,
    );

    expect(secondBaseline).toEqual({
      bucketFromMs: secondRefresh.bucketStartAtMs,
      bucketThroughMs: oldThrough,
      snapshotKey: "c".repeat(64),
      recordCount: 4,
    });
    expect(scoreBucketSnapshotMatches(
      firstBaseline.snapshotKey, firstBaseline.recordCount,
      secondBaseline!.snapshotKey!, secondBaseline!.recordCount,
    )).toBe(false);
  });

  it("marks an already stale zero-row selection expired when its UTC bucket leaves the window", () => {
    const from = Date.parse("2026-09-21T12:07:00.000Z");
    const through = Date.parse("2026-09-21T12:15:00.000Z");
    const refreshed = refreshedScoreBucketState([], {
      bucketFromMs: from,
      bucketThroughMs: through,
      snapshotKey: null,
      recordCount: 0,
    });

    expect(refreshed).toEqual({ expectedCount: 0, snapshotStale: true, selectionExpired: true });
  });

  it("offers seven-day history only for verified points older than the selected window and still within seven days", () => {
    const now = Date.parse("2026-09-28T08:00:00.000Z");

    expect(hasOlderSavedPriceHistory(now - 36 * 60 * 60_000, 24, now)).toBe(true);
    expect(hasOlderSavedPriceHistory(now - 8 * 24 * 60 * 60_000, 24, now)).toBe(false);
    expect(hasOlderSavedPriceHistory(now - 12 * 60 * 60_000, 24, now)).toBe(false);
    expect(hasOlderSavedPriceHistory(null, 24, now)).toBe(false);
  });
});
