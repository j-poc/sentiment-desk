import type { SeriesPoint } from "./api.js";

const SEVEN_DAYS_MS = 168 * 60 * 60 * 1000;

export function hasOlderSavedPriceHistory(latestPriceAt: number | null, hours: number, now: number): boolean {
  return latestPriceAt != null
    && Number.isFinite(latestPriceAt)
    && latestPriceAt < now - hours * 60 * 60 * 1000
    && latestPriceAt >= now - SEVEN_DAYS_MS
    && latestPriceAt <= now;
}

export function sentimentSeriesState(points: SeriesPoint[]) {
  const hasSentiment = points.some((point) => point.v != null && point.n > 0);
  const hasModeledHistory = points.some((point) => point.v != null && point.n === 0);
  return {
    hasSentiment,
    hasModeledHistory,
    hasChartData: hasSentiment || hasModeledHistory,
  };
}
