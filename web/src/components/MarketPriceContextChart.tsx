import { useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  createChart,
  CrosshairMode,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint, PriceSeriesDTO } from "../lib/api.js";
import { isValidUtcMilliseconds } from "../lib/chart-time.js";
import { timeAgo } from "../lib/format.js";
import { prepareMarketPriceSeries, shouldShowMarketPriceContext, type MarketPriceRefreshState } from "../lib/market-price-context.js";

function utcTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function formatPrice(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function deliveryLabel(delivery: PriceSeriesDTO["delivery"] | undefined): string {
  switch (delivery) {
    case "local_store": return "local store";
    case "memory_cache": return "memory cache";
    case "network": return "network";
    default: return "saved data";
  }
}

function currencyPrecision(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export type MarketPriceContextChartProps = {
  companyName: string;
  ticker: string;
  hours: number;
  points: PricePoint[];
  source: PriceSeriesDTO | null;
  loading: boolean;
  transportError: boolean;
  refreshState: MarketPriceRefreshState;
  onRefresh: () => void;
  now: number;
};

/** Keep market context visible in the active Luna workspace regardless of sentiment availability. */
export function SelectedCompanyMarketPriceContext({
  chartView,
  companyId,
  ...chartProps
}: MarketPriceContextChartProps & {
  chartView: "luna" | "jev";
  companyId: string | null;
}) {
  if (!shouldShowMarketPriceContext(chartView, companyId)) return null;
  return <MarketPriceContextChart {...chartProps} />;
}

export function MarketPriceContextChart({
  companyName,
  ticker,
  hours,
  points,
  source,
  loading,
  transportError,
  refreshState,
  onRefresh,
  now,
}: MarketPriceContextChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const priceByTime = useMemo(() => new Map(points.map((point) => [point.t / 1000, point])), [points]);
  const priceByTimeRef = useRef(priceByTime);
  priceByTimeRef.current = priceByTime;
  const series = useMemo(() => prepareMarketPriceSeries(points), [points]);
  const refreshFailed = !loading && (transportError || source?.refreshError != null);
  const refreshEnabled = refreshState === "enabled";
  const hasSavedPoints = series.state === "ready" && series.points.length > 0;
  const latest = hasSavedPoints ? series.points.at(-1) ?? null : null;

  // The chart host only exists after the first verified point arrives. Retry
  // initialization at that transition; an empty first render has no ref yet.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(232,235,242,0.62)",
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      leftPriceScale: { visible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.3)", labelBackgroundColor: "#1a1f2b" },
        horzLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#1a1f2b" },
      },
    });
    chartRef.current = chart;
    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (param.point == null || typeof param.time !== "number") {
        tooltip.style.opacity = "0";
        return;
      }
      const point = priceByTimeRef.current.get(param.time);
      if (!point) {
        tooltip.style.opacity = "0";
        return;
      }
      tooltip.textContent = `${utcTime(point.t)} · ${formatPrice(point.price, point.currency)} · Yahoo source observation`;
      tooltip.style.opacity = "1";
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [hasSavedPoints]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const previous of seriesRef.current) chart.removeSeries(previous);
    seriesRef.current = [];
    if (series.state !== "ready") return;

    const precision = currencyPrecision(series.currency);
    for (const segment of series.segments) {
      const line = chart.addSeries(LineSeries, {
        color: "rgba(142,180,217,0.92)",
        lineWidth: 2,
        pointMarkersVisible: segment.length === 1,
        crosshairMarkerVisible: true,
        priceFormat: { type: "price", precision, minMove: 10 ** -precision },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      line.setData(segment.map((point) => ({
        time: (point.t / 1000) as UTCTimestamp,
        value: point.price,
      })));
      seriesRef.current.push(line);
    }
    if (series.points.length > 0) chart.timeScale().fitContent();
  }, [series]);

  const chartLabel = series.state === "ready"
    ? `Share-price observations for ${companyName} (${ticker}) in ${series.currency} over the selected ${hours}-hour window. Plotted points are receipt-verified Yahoo chart observations. Gaps of six hours or longer have no connecting line. No price values are carried forward or inferred. Latest source observation ${latest == null ? "unknown" : new Date(latest.t).toISOString()}, retrieved ${latest == null ? "unknown" : new Date(latest.retrievedAt).toISOString()}.`
    : `Share-price context for ${companyName} (${ticker}) over the selected ${hours}-hour window. ${series.state === "invalid" ? series.reason : "No eligible Yahoo price observations are available."}`;
  const windowHoursLabel = hours >= 24 && hours % 24 === 0 ? `${hours / 24}D` : `${hours}H`;

  return (
    <section className="market-price-context panel" aria-labelledby="market-price-context-title">
      <header className="market-price-context-head">
        <div>
          <p className="micro">MARKET PRICE · {ticker}</p>
          <h2 id="market-price-context-title">Share-price context</h2>
          <p className="market-price-context-disclosure">Market context only. This is not sentiment.</p>
        </div>
        <button
          type="button"
          className="market-price-refresh"
          onClick={onRefresh}
          aria-label={loading ? `Checking ${ticker} prices` : refreshEnabled ? refreshFailed ? `Retry ${ticker} price history` : `Check for newer ${ticker} prices` : refreshState === "checking" ? "Checking price-source status" : refreshState === "paused" ? `Price refresh paused for ${ticker}` : `Price refresh status unavailable for ${ticker}`}
          disabled={loading || !refreshEnabled}
        >
          {loading ? "Checking…" : refreshEnabled ? refreshFailed ? "Retry price history" : "Check prices" : refreshState === "checking" ? "Checking status…" : refreshState === "paused" ? "Refresh paused" : "Status unavailable"}
        </button>
      </header>

      <div className="market-price-context-meta" aria-live="polite">
        <span>{windowHoursLabel} window</span>
        {hasSavedPoints && latest && <>
          <span>{series.points.length} observations</span>
          <span>Latest {timeAgo(latest.t, now)}</span>
        </>}
        {!hasSavedPoints && series.state === "empty" && <span>Price observations unavailable</span>}
      </div>

      {loading && !hasSavedPoints && <p className="market-price-context-state" role="status">{refreshEnabled ? "Loading Yahoo price history…" : "Loading saved Yahoo price history…"}</p>}
      {loading && hasSavedPoints && <p className="market-price-context-state" role="status">{refreshEnabled ? "Checking for newer Yahoo observations. Saved verified prices remain visible." : "Reading saved Yahoo prices. No external refresh is running."}</p>}
      {!loading && refreshState === "paused" && <p className="market-price-context-state" role="status">Price refresh is paused by source or storage controls. Saved verified prices remain available.</p>}
      {!loading && refreshState === "unknown" && <p className="market-price-context-state" role="status">Price-source status is unavailable. Refresh is paused until the desk can verify it.</p>}
      {!loading && refreshState === "checking" && <p className="market-price-context-state" role="status">Checking whether a price refresh is available.</p>}
      {refreshFailed && hasSavedPoints && <p className="market-price-context-warning" role="status">Price refresh failed. Showing saved verified observations.</p>}
      {refreshFailed && !hasSavedPoints && <p className="market-price-context-warning" role="alert">Price history is unavailable. Review source status before retrying.</p>}
      {!loading && !refreshFailed && series.state === "empty" && <p className="market-price-context-state" role="status">No verified Yahoo price observations are saved in this window. No values are filled in.</p>}
      {!loading && !refreshFailed && series.state === "invalid" && <p className="market-price-context-warning" role="alert">{series.reason}</p>}
      {hasSavedPoints && latest && (
        <>
          {series.points.length === 1 && <p className="market-price-context-state" role="status">One saved observation. The dot marks that observation; there is not enough data for a line.</p>}
          <div className="market-price-context-chart-frame">
            <div
              ref={containerRef}
              className="market-price-context-chart"
              role="img"
              aria-label={chartLabel}
            />
            <div ref={tooltipRef} className="market-price-context-tooltip" aria-hidden="true" />
          </div>
          <p className="market-price-context-freshness">
            <span>{series.currency} · {utcTime(series.points[0]!.t)} to {utcTime(latest.t)}</span>
            <span>Delivery: {deliveryLabel(source?.delivery)}</span>
            <span>Source observation: {utcTime(latest.t)}</span>
            <span>Retrieved: {utcTime(latest.retrievedAt)}</span>
            {series.gapCount > 0 && <span>{series.gapCount} line break{series.gapCount === 1 ? "" : "s"} at gaps of 6h or more</span>}
          </p>
        </>
      )}

      <details className="market-price-context-details">
        <summary>Source, exclusions, and plotted values</summary>
        {source?.quarantine.legacyUnknownRows == null
          ? <p>Legacy price-provenance count is unavailable. Those records never enter this chart.</p>
          : source.quarantine.legacyUnknownRows > 0
            ? <p>{source.quarantine.legacyUnknownRows.toLocaleString("en-US")} legacy price rows are excluded because their source provenance is incomplete. This count covers all saved history for {ticker}.</p>
            : <p>No legacy unknown-source price rows were found in all saved history for {ticker}.</p>}
        <p>Each plotted point has a Yahoo collection receipt. Gaps of six hours or longer have no connecting line. Values are not carried forward or estimated.</p>
        {hasSavedPoints && (
          <div className="market-price-context-table-scroll" role="region" aria-label={`${ticker} plotted Yahoo price observations`} tabIndex={0}>
            <table>
              <caption>Saved Yahoo price observations for {ticker}</caption>
              <thead><tr><th scope="col">Source observation time</th><th scope="col">Price</th><th scope="col">Retrieved</th><th scope="col">Collection receipt</th></tr></thead>
              <tbody>{series.points.map((point) => (
                <tr key={`${point.deliveryId}:${point.t}`}>
                  <th scope="row"><time dateTime={new Date(point.t).toISOString()}>{utcTime(point.t)}</time></th>
                  <td>{formatPrice(point.price, point.currency)}</td>
                  <td><time dateTime={new Date(point.retrievedAt).toISOString()}>{utcTime(point.retrievedAt)}</time></td>
                  <td><code title={point.deliveryId}>{point.deliveryId.slice(0, 8)}</code></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {refreshFailed && <button type="button" className="market-price-retry" onClick={onRefresh}>Retry price history</button>}
      </details>
    </section>
  );
}
