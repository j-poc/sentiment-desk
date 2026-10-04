import { describe, expect, it } from "vitest";
import type { CategoricalTrendCounts, CategoricalTrendResult } from "../web/src/lib/api.js";
import { aggregateCategoricalTrend, displayBucketMsForWindow, displayIntervalLabel, formatUtcRange } from "../web/src/lib/categorical-chart.js";

const sourceBucketMs = 15 * 60_000;

function resultForWindow(hours: number, throughMs: number): CategoricalTrendResult {
  const fromMs = throughMs - hours * 60 * 60_000;
  const firstBucket = Math.floor(fromMs / sourceBucketMs) * sourceBucketMs;
  const points: CategoricalTrendResult["points"] = [];
  const counts: CategoricalTrendCounts = { positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0 };
  for (let bucketStartMs = firstBucket; bucketStartMs < throughMs; bucketStartMs += sourceBucketMs) {
    const category: CategoricalTrendCounts = {
      positive: bucketStartMs % 37 === 0 ? 1 : 0,
      neutral: bucketStartMs % 41 === 0 ? 1 : 0,
      negative: bucketStartMs % 53 === 0 ? 2 : 0,
      reviewRequired: bucketStartMs % 67 === 0 ? 1 : 0,
      excluded: 0,
      total: 0,
    };
    category.total = category.positive + category.neutral + category.negative + category.reviewRequired;
    const pointFrom = Math.max(fromMs, bucketStartMs);
    const pointThrough = Math.min(throughMs, bucketStartMs + sourceBucketMs);
    points.push({ bucketStartMs, fromMs: pointFrom, throughMs: pointThrough, counts: category });
    for (const key of ["positive", "neutral", "negative", "reviewRequired", "excluded"] as const) counts[key] += category[key];
    counts.total += category.total;
  }
  return {
    companyId: "acme", windowHours: hours, fromMs, throughMs, bucketMs: sourceBucketMs,
    timeBasis: "classification_available_at", countBasis: "immutable_source_observation",
    snapshotGeneration: "00000000-0000-4000-8000-000000000001", snapshotKey: "snapshot",
    points, counts, eligibleObservationCount: counts.total, candidateClassificationCount: counts.total,
    withheldInvalidCount: 0, latestClassifiedAt: null, lineages: [],
  };
}

describe("Luna categorical chart projection", () => {
  it("keeps a full seven-day overview readable while preserving every saved category count", () => {
    const result = resultForWindow(168, Date.parse("2026-10-08T00:00:00.000Z"));
    const points = aggregateCategoricalTrend(result);
    expect(displayBucketMsForWindow(6)).toBe(30 * 60_000);
    expect(displayBucketMsForWindow(24)).toBe(60 * 60_000);
    expect(displayBucketMsForWindow(72)).toBe(3 * 60 * 60_000);
    expect(displayBucketMsForWindow(168)).toBe(6 * 60 * 60_000);
    expect(displayIntervalLabel(6 * 60 * 60_000)).toBe("6-hour intervals");
    expect(points).toHaveLength(28);
    expect(points.every((point) => point.bucketStartMs % (6 * 60 * 60_000) === 0)).toBe(true);
    expect(points[0]?.fromMs).toBe(result.fromMs);
    expect(points.at(-1)?.throughMs).toBe(result.throughMs);
    for (const key of ["positive", "neutral", "negative", "reviewRequired", "excluded"] as const) {
      expect(points.reduce((sum, point) => sum + point.counts[key], 0)).toBe(result.counts[key]);
    }
    expect(points.reduce((sum, point) => sum + point.counts.total, 0)).toBe(result.eligibleObservationCount);
    expect(points.some((point) => point.counts.total === 0)).toBe(true);
  });

  it("clips partial UTC edge intervals and formats exact ranges without invalid Intl options", () => {
    const result = resultForWindow(1, Date.parse("2026-10-02T12:07:31.456Z"));
    const points = aggregateCategoricalTrend(result, 60 * 60_000);
    expect(points).toHaveLength(2);
    expect(points[0]?.fromMs).toBe(result.fromMs);
    expect(points.at(-1)?.throughMs).toBe(result.throughMs);
    expect(points[0]?.throughMs).toBe(points[1]?.fromMs);
    expect(points.reduce((sum, point) => sum + point.counts.total, 0)).toBe(result.eligibleObservationCount);
    expect(formatUtcRange(result.fromMs, result.throughMs)).toContain("end exclusive");
    expect(formatUtcRange(result.fromMs, result.throughMs)).toContain("UTC");
    expect(formatUtcRange(result.fromMs, result.throughMs).match(/31[.,]456/g)).toHaveLength(2);
  });

  it("rejects a malformed canonical source interval instead of drawing a plausible chart", () => {
    const result = resultForWindow(1, Date.parse("2026-10-02T12:00:00.000Z"));
    const malformed = { ...result, points: result.points.map((point, index) => index === 0 ? { ...point, bucketStartMs: point.bucketStartMs + 1 } : point) };
    expect(() => aggregateCategoricalTrend(malformed)).toThrow("Source trend contains an invalid interval");
  });
});
