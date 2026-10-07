import type { PricePoint } from "./api.js";
import { isValidUtcMilliseconds } from "./chart-time.js";
import type { CategoricalChartSnapshot } from "./chart-view-preference.js";

export const MARKET_PRICE_GAP_BREAK_MS = 6 * 60 * 60 * 1000;

export type MarketPriceRefreshState = "checking" | "enabled" | "paused" | "unknown";

export function marketPriceRefreshState(input: {
  healthState: "loading" | "ready" | "failed";
  externalRequestsEnabled: boolean | null;
  chartCollectorEnabled: boolean | null;
  canStartExternalWork: boolean | null;
}): MarketPriceRefreshState {
  if (input.healthState === "loading") return "checking";
  if (input.healthState === "failed"
    || input.externalRequestsEnabled == null
    || input.chartCollectorEnabled == null
    || input.canStartExternalWork == null) return "unknown";
  return input.externalRequestsEnabled && input.chartCollectorEnabled && input.canStartExternalWork
    ? "enabled"
    : "paused";
}

export type MarketPriceSeries =
  | { state: "empty" }
  | { state: "invalid"; reason: string }
  | {
      state: "ready";
      currency: string;
      points: PricePoint[];
      segments: PricePoint[][];
      gapCount: number;
    };

/** Accepts only source-attributed observations that can be plotted without repair. */
export function prepareMarketPriceSeries(points: PricePoint[], nowMs = Date.now()): MarketPriceSeries {
  if (points.length === 0) return { state: "empty" };

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const currency = sorted[0]?.currency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return { state: "invalid", reason: "Price currency is missing or invalid." };
  }
  if (sorted.some((point) => point.currency !== currency)) {
    return { state: "invalid", reason: "Price observations use mixed currencies and are withheld." };
  }
  if (sorted.some((point) => point.collector !== "yahoo_chart"
    || !Number.isFinite(point.price) || point.price <= 0
    || !isValidUtcMilliseconds(point.t) || point.t > nowMs
    || !isValidUtcMilliseconds(point.retrievedAt) || point.retrievedAt > nowMs || point.retrievedAt < point.t
    || typeof point.adapterVersion !== "string" || point.adapterVersion.length === 0
    || typeof point.deliveryId !== "string" || point.deliveryId.length === 0)) {
    return { state: "invalid", reason: "Price history contains an invalid or unverified observation and is withheld." };
  }
  if (sorted.some((point, index) => index > 0 && point.t === sorted[index - 1]?.t)) {
    return { state: "invalid", reason: "Price history contains duplicate observation times and is withheld." };
  }

  const segments: PricePoint[][] = [];
  for (const point of sorted) {
    const current = segments.at(-1);
    const prior = current?.at(-1);
    if (!current || !prior || point.t - prior.t >= MARKET_PRICE_GAP_BREAK_MS) {
      segments.push([point]);
    } else {
      current.push(point);
    }
  }
  return { state: "ready", currency, points: sorted, segments, gapCount: Math.max(0, segments.length - 1) };
}

export function shouldShowMarketPriceContext(
  chartView: "luna" | "jev",
  companyId: string | null,
): boolean {
  // Real price observations remain useful context regardless of whether the
  // independent sentiment classifier has loaded, failed, or found records.
  return chartView === "luna" && companyId != null;
}

/** Put a real saved price chart first when there is no current Luna series to read. */
export function shouldLeadWithMarketPriceContext(
  snapshot: CategoricalChartSnapshot | null,
  points: PricePoint[],
): boolean {
  if (prepareMarketPriceSeries(points).state !== "ready") return false;
  if (snapshot == null) return true;
  if (snapshot.eligibleObservationCount === 0) return true;
  return snapshot.status !== "ready" && snapshot.eligibleObservationCount == null;
}
