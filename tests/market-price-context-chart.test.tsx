import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarketPriceContextChart, SelectedCompanyMarketPriceContext } from "../web/src/components/MarketPriceContextChart.js";
import type { PricePoint, PriceSeriesDTO } from "../web/src/lib/api.js";
import { MARKET_PRICE_GAP_BREAK_MS, marketPriceRefreshState, prepareMarketPriceSeries, shouldLeadWithMarketPriceContext, shouldShowMarketPriceContext } from "../web/src/lib/market-price-context.js";

const now = Date.parse("2026-10-06T16:00:00.000Z");
const firstAt = Date.parse("2026-10-06T14:00:00.000Z");

function pricePoint(t: number, price = 123.45, deliveryId = "receipt-1234", currency = "USD"): PricePoint {
  return { t, price, currency, collector: "yahoo_chart", retrievedAt: t + 5_000, adapterVersion: "yahoo-chart/1", deliveryId };
}

function source(points: PricePoint[]): PriceSeriesDTO {
  return {
    points,
    delivery: "network",
    servedAt: now,
    sourceLatestAt: points.at(-1)?.t ?? null,
    cacheAgeMs: null,
    refreshError: null,
    resampling: "source_observations_in_window",
    quarantine: { legacyUnknownRows: 2, scope: "all_saved_history" },
  };
}

function marketChart(points: PricePoint[], options: {
  refreshFailed?: boolean;
  loading?: boolean;
  refreshState?: "checking" | "enabled" | "paused" | "unknown";
  delivery?: PriceSeriesDTO["delivery"];
} = {}) {
  const refreshFailed = options.refreshFailed ?? false;
  const result = { ...source(points), ...(options.delivery ? { delivery: options.delivery } : {}) };
  return renderToStaticMarkup(<MarketPriceContextChart
    companyName="Example Company"
    ticker="EXM"
    hours={168}
    points={points}
    source={refreshFailed ? { ...result, refreshError: "provider unavailable" } : result}
    loading={options.loading ?? false}
    transportError={false}
    refreshState={options.refreshState ?? "enabled"}
    onRefresh={vi.fn()}
    now={now}
  />);
}

describe("market price context visibility", () => {
  it("allows refresh only when health confirms Yahoo chart, the global switch, and storage are ready", () => {
    expect(marketPriceRefreshState({ healthState: "loading", externalRequestsEnabled: null, chartCollectorEnabled: null, canStartExternalWork: null })).toBe("checking");
    expect(marketPriceRefreshState({ healthState: "ready", externalRequestsEnabled: false, chartCollectorEnabled: true, canStartExternalWork: true })).toBe("paused");
    expect(marketPriceRefreshState({ healthState: "ready", externalRequestsEnabled: true, chartCollectorEnabled: false, canStartExternalWork: true })).toBe("paused");
    expect(marketPriceRefreshState({ healthState: "ready", externalRequestsEnabled: true, chartCollectorEnabled: true, canStartExternalWork: false })).toBe("paused");
    expect(marketPriceRefreshState({ healthState: "ready", externalRequestsEnabled: true, chartCollectorEnabled: true, canStartExternalWork: true })).toBe("enabled");
    expect(marketPriceRefreshState({ healthState: "failed", externalRequestsEnabled: null, chartCollectorEnabled: null, canStartExternalWork: null })).toBe("unknown");
  });

  it("keeps verified prices visible but disables refresh when source or storage controls pause external work", () => {
    const html = marketChart([pricePoint(firstAt), pricePoint(firstAt + 60 * 60_000, 124, "receipt-b")], { refreshState: "paused" });
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Price refresh paused for EXM");
    expect(html).toContain("Price refresh is paused by source or storage controls");
    expect(html).toContain("Market context only. This is not sentiment.");
  });

  it("keeps the real market chart available for a selected stock while Luna is unavailable or populated", () => {
    expect(shouldShowMarketPriceContext("luna", "amd")).toBe(true);
    // Classifier readiness, result count, and window matching do not gate price history.
    expect(shouldShowMarketPriceContext("jev", "amd")).toBe(false);
    expect(shouldShowMarketPriceContext("luna", null)).toBe(false);
  });

  it("leads with receipt-verified prices only when current Luna categories are absent", () => {
    const points = [pricePoint(firstAt), pricePoint(firstAt + 60 * 60_000, 124.12, "receipt-b")];
    expect(shouldLeadWithMarketPriceContext(null, points)).toBe(true);
    expect(shouldLeadWithMarketPriceContext({ companyId: "amd", windowHours: 168, status: "ready", eligibleObservationCount: 0, observedAt: now }, points)).toBe(true);
    expect(shouldLeadWithMarketPriceContext({ companyId: "amd", windowHours: 168, status: "loading", eligibleObservationCount: 4, observedAt: now }, points)).toBe(false);
    expect(shouldLeadWithMarketPriceContext({ companyId: "amd", windowHours: 168, status: "ready", eligibleObservationCount: 4, observedAt: now }, points)).toBe(false);
    expect(shouldLeadWithMarketPriceContext({ companyId: "amd", windowHours: 168, status: "ready", eligibleObservationCount: 0, observedAt: now }, [])).toBe(false);
  });

  it("renders the selected-company market panel while Luna has no settled chart", () => {
    const html = renderToStaticMarkup(<SelectedCompanyMarketPriceContext
      chartView="luna"
      companyId="amd"
      companyName="Example Company"
      ticker="EXM"
      hours={168}
      points={[]}
      source={null}
      loading
      transportError={false}
      refreshState="enabled"
      onRefresh={vi.fn()}
      now={now}
    />);
    expect(html).toContain("Share-price context");
    expect(html).toContain("Market context only. This is not sentiment.");
    expect(html).toContain("Loading Yahoo price history");
  });

  it("keeps the market panel out of the historical Jev tab and with no selection", () => {
    const props = {
      companyName: "Example Company",
      ticker: "EXM",
      hours: 168,
      points: [],
      source: null,
      loading: false,
      transportError: false,
      refreshState: "enabled" as const,
      onRefresh: vi.fn(),
      now,
    };
    expect(renderToStaticMarkup(<SelectedCompanyMarketPriceContext {...props} chartView="jev" companyId="amd" />)).toBe("");
    expect(renderToStaticMarkup(<SelectedCompanyMarketPriceContext {...props} chartView="luna" companyId={null} />)).toBe("");
  });
});

describe("eligible Yahoo price observations", () => {
  it("preserves observed values and breaks lines across long gaps without adding points", () => {
    const points = [
      pricePoint(firstAt - 7 * 60 * 60_000, 123.45, "receipt-a"),
      pricePoint(firstAt - 6 * 60 * 60_000, 124.1, "receipt-a"),
      pricePoint(firstAt - 6 * 60 * 60_000 + MARKET_PRICE_GAP_BREAK_MS, 125.2, "receipt-b"),
    ];
    const result = prepareMarketPriceSeries(points, now);
    assert.equal(result.state, "ready");
    if (result.state !== "ready") return;
    expect(result.points).toEqual(points);
    expect(result.segments.map((segment) => segment.length)).toEqual([2, 1]);
    expect(result.gapCount).toBe(1);
  });

  it("withholds duplicate, mixed-currency, future, and non-Yahoo rows instead of repairing them", () => {
    expect(prepareMarketPriceSeries([pricePoint(firstAt), pricePoint(firstAt)], now).state).toBe("invalid");
    expect(prepareMarketPriceSeries([pricePoint(firstAt), pricePoint(firstAt + 60_000, 124, "receipt-b", "EUR")], now).state).toBe("invalid");
    expect(prepareMarketPriceSeries([pricePoint(now + 1_000)], now).state).toBe("invalid");
    const legacyPoint = { ...pricePoint(firstAt), collector: "legacy_unknown" };
    expect(prepareMarketPriceSeries([legacyPoint as unknown as PricePoint], now).state).toBe("invalid");
    expect(prepareMarketPriceSeries([], now)).toEqual({ state: "empty" });
  });
});

describe("market price context states and evidence", () => {
  it("labels the chart as price context and exposes source time, retrieval time, and receipt IDs", () => {
    const html = marketChart([pricePoint(firstAt), pricePoint(firstAt + 60 * 60_000, 124.12, "receipt-b")]);
    expect(html).toContain("Share-price context");
    expect(html).toContain("Market context only. This is not sentiment.");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("2026-10-06 14:00 UTC");
    expect(html).toContain("2026-10-06 15:00 UTC");
    expect(html).toContain("Delivery: network");
    expect(html).toContain("Source observation: 2026-10-06 15:00 UTC");
    expect(html).toContain("Retrieved: 2026-10-06 15:00 UTC");
    expect(html).toContain("Source, exclusions, and plotted values");
    expect(html).toContain("Collection receipt");
    expect(html).toContain("receipt-b");
    expect(html).toContain("2 legacy price rows are excluded");
  });

  it("uses readable delivery wording for a local store response", () => {
    const html = marketChart([pricePoint(firstAt)], { delivery: "local_store" });
    expect(html).toContain("Delivery: local store");
    expect(html).not.toContain("local_store");
  });

  it("keeps a single observation distinct from a plotted line and preserves true-empty state", () => {
    const onePoint = marketChart([pricePoint(firstAt)]);
    expect(onePoint).toContain("One saved observation.");
    expect(onePoint).toContain("The dot marks that observation");

    const empty = marketChart([]);
    expect(empty).toContain("No verified Yahoo price observations are saved in this window.");
    expect(empty).toContain("No values are filled in.");
    expect(empty).not.toContain("One saved observation.");
  });

  it("keeps saved verified points visible when refresh fails and gives a retry action", () => {
    const html = marketChart([pricePoint(firstAt), pricePoint(firstAt + 60 * 60_000, 124.12)], { refreshFailed: true });
    expect(html).toContain("Price refresh failed. Showing saved verified observations.");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("Retry price history");
  });

  it("shows refresh progress while keeping saved prices visible", () => {
    const html = marketChart([pricePoint(firstAt), pricePoint(firstAt + 60 * 60_000, 124.12)], { loading: true, refreshFailed: true });
    expect(html).toContain("Checking for newer Yahoo observations. Saved verified prices remain visible.");
    expect(html).toContain("Checking…");
    expect(html).toContain('aria-label="Checking EXM prices"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("role=\"img\"");
    expect(html).not.toContain("Price refresh failed.");
  });
});
