import type { CategoricalTrendCounts, CategoricalTrendPoint, CategoricalTrendResult } from "./api.js";

export const CATEGORICAL_SOURCE_BUCKET_MS = 15 * 60_000;
export const CATEGORICAL_DISPLAY_BUCKETS_MS = [
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

const COUNT_KEYS = ["positive", "neutral", "negative", "reviewRequired", "excluded"] as const;

export function displayBucketMsForWindow(hours: number): number {
  if (hours <= 6) return 30 * 60_000;
  if (hours <= 24) return 60 * 60_000;
  if (hours <= 72) return 3 * 60 * 60_000;
  return 6 * 60 * 60_000;
}

export function displayIntervalLabel(bucketMs: number): string {
  const minutes = bucketMs / 60_000;
  return minutes < 60 ? `${minutes}-minute intervals` : `${minutes / 60}-hour intervals`;
}

const utcRangeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  second: "2-digit", fractionalSecondDigits: 3,
  timeZone: "UTC", timeZoneName: "short",
});
const utcInstantFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  timeZone: "UTC", timeZoneName: "short",
});

export function formatUtcRange(fromMs: number, throughMs: number): string {
  return `${utcRangeFormatter.format(fromMs)} – ${utcRangeFormatter.format(throughMs)} (end exclusive)`;
}

export function formatUtcInstant(atMs: number): string {
  return utcInstantFormatter.format(atMs);
}

export function aggregateCategoricalTrend(
  result: CategoricalTrendResult,
  bucketMs = displayBucketMsForWindow(result.windowHours),
): CategoricalTrendPoint[] {
  if (!CATEGORICAL_DISPLAY_BUCKETS_MS.includes(bucketMs as (typeof CATEGORICAL_DISPLAY_BUCKETS_MS)[number])
    || result.bucketMs !== CATEGORICAL_SOURCE_BUCKET_MS
    || result.fromMs >= result.throughMs) throw new Error("Unsupported categorical chart interval");

  const aggregates = new Map<number, CategoricalTrendCounts>();
  for (const point of result.points) {
    if (point.bucketStartMs % CATEGORICAL_SOURCE_BUCKET_MS !== 0
      || point.fromMs >= point.throughMs || point.fromMs < result.fromMs || point.throughMs > result.throughMs) {
      throw new Error("Source trend contains an invalid interval");
    }
    const bucketStartMs = Math.floor(point.bucketStartMs / bucketMs) * bucketMs;
    const counts = aggregates.get(bucketStartMs) ?? {
      positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0,
    };
    for (const key of COUNT_KEYS) counts[key] += point.counts[key];
    counts.total += point.counts.total;
    aggregates.set(bucketStartMs, counts);
  }

  const firstStart = Math.floor(result.fromMs / bucketMs) * bucketMs;
  const lastStart = Math.floor((result.throughMs - 1) / bucketMs) * bucketMs;
  const points: CategoricalTrendPoint[] = [];
  for (let bucketStartMs = firstStart; bucketStartMs <= lastStart; bucketStartMs += bucketMs) {
    points.push({
      bucketStartMs,
      fromMs: Math.max(result.fromMs, bucketStartMs),
      throughMs: Math.min(result.throughMs, bucketStartMs + bucketMs),
      counts: aggregates.get(bucketStartMs) ?? {
        positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0,
      },
    });
  }
  const total = points.reduce((sum, point) => sum + point.counts.total, 0);
  const expected = COUNT_KEYS.reduce((sum, key) => sum + result.counts[key], 0);
  if (total !== expected || total !== result.eligibleObservationCount
    || COUNT_KEYS.some((key) => points.reduce((sum, point) => sum + point.counts[key], 0) !== result.counts[key])
    || points.some((point) => COUNT_KEYS.reduce((sum, key) => sum + point.counts[key], 0) !== point.counts.total)) {
    throw new Error("Displayed categorical intervals do not reconcile to the saved trend");
  }
  return points;
}
