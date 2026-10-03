import type { SeriesPoint } from "./api.js";
import { isValidUtcMilliseconds } from "./chart-time.js";

const SEVEN_DAYS_MS = 168 * 60 * 60 * 1000;
const SERIES_BUCKET_MS = 15 * 60_000;

export function hasOlderSavedPriceHistory(latestPriceAt: number | null, hours: number, now: number): boolean {
  return latestPriceAt != null
    && Number.isFinite(latestPriceAt)
    && latestPriceAt < now - hours * 60 * 60 * 1000
    && latestPriceAt >= now - SEVEN_DAYS_MS
    && latestPriceAt <= now;
}

export function sentimentSeriesState(points: SeriesPoint[]) {
  const hasSentiment = points.some((point) => point.scoredRecordCount > 0);
  return {
    hasSentiment,
    hasChartData: hasSentiment,
  };
}

/** Preserve exact UTC millisecond bucket ends as fractional Unix seconds. */
export function scoreBucketChartTimeline(points: SeriesPoint[]): Array<{
  point: SeriesPoint;
  chartTimeSeconds: number;
}> {
  const ordered = [...points].sort((left, right) => left.bucketEndAtMs - right.bucketEndAtMs);
  const plotted: Array<{ point: SeriesPoint; chartTimeSeconds: number }> = [];
  let lastTimeSeconds: number | null = null;
  for (const point of ordered) {
    if (!isValidUtcMilliseconds(point.bucketEndAtMs)) {
      throw new RangeError("Score bucket timestamps must be valid UTC milliseconds.");
    }
    const chartTimeSeconds = point.bucketEndAtMs / 1000;
    if (lastTimeSeconds != null && chartTimeSeconds <= lastTimeSeconds) {
      throw new RangeError("Score bucket end timestamps must be unique and increasing.");
    }
    plotted.push({ point, chartTimeSeconds });
    lastTimeSeconds = chartTimeSeconds;
  }
  return plotted;
}

export function chartVisibleThroughSeconds(nowMs: number, lastChartTimeSeconds: number | null): number {
  const nowSeconds = nowMs / 1000;
  return lastChartTimeSeconds == null ? nowSeconds : Math.max(nowSeconds, lastChartTimeSeconds);
}

export function scoreBucketEvidenceBaseline(points: SeriesPoint[], requestedFromMs: number, requestedThroughMs: number): {
  bucketFromMs: number;
  bucketThroughMs: number;
  snapshotKey: string | null;
  recordCount: number;
} | null {
  if (!Number.isSafeInteger(requestedFromMs) || !Number.isSafeInteger(requestedThroughMs) || requestedThroughMs <= requestedFromMs) return null;
  const bucketIndex = Math.floor(requestedFromMs / SERIES_BUCKET_MS);
  if (Math.floor((requestedThroughMs - 1) / SERIES_BUCKET_MS) !== bucketIndex) return null;
  const point = points.find((candidate) => Math.floor(candidate.bucketStartAtMs / SERIES_BUCKET_MS) === bucketIndex
    && Math.floor((candidate.bucketEndAtMs - 1) / SERIES_BUCKET_MS) === bucketIndex);
  if (!point) return null;
  return {
    bucketFromMs: point.bucketStartAtMs,
    bucketThroughMs: point.bucketEndAtMs,
    snapshotKey: point.bucketSnapshotKey,
    recordCount: point.scoredRecordCount,
  };
}

export function scoreBucketSnapshotMatches(
  expectedSnapshotKey: string | null,
  expectedCount: number,
  actualSnapshotKey: string,
  actualCount: number,
): boolean {
  if (actualCount !== expectedCount) return false;
  if (expectedSnapshotKey == null) return actualCount === 0;
  return expectedSnapshotKey === actualSnapshotKey;
}

export function refreshedScoreBucketState(
  points: SeriesPoint[],
  selection: {
    bucketFromMs: number;
    bucketThroughMs: number;
    snapshotKey: string | null;
    recordCount: number;
  },
): { expectedCount: number; snapshotStale: boolean; selectionExpired: boolean } {
  const baseline = scoreBucketEvidenceBaseline(points, selection.bucketFromMs, selection.bucketThroughMs);
  const selectionExpired = baseline == null;
  return {
    expectedCount: baseline?.recordCount ?? 0,
    selectionExpired,
    snapshotStale: selectionExpired
      || baseline!.bucketFromMs !== selection.bucketFromMs
      || baseline!.bucketThroughMs !== selection.bucketThroughMs
      || !scoreBucketSnapshotMatches(selection.snapshotKey, selection.recordCount, baseline!.snapshotKey ?? "", baseline!.recordCount),
  };
}
