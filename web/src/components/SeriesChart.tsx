import { useEffect, useMemo, useRef } from "react";
import {
  BaselineSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint, SeriesPoint } from "../lib/api.js";

function toSec(ms: number): UTCTimestamp {
  const seconds = Math.floor(ms / 1000);
  if (!Number.isSafeInteger(seconds)) throw new RangeError("Chart timestamp is outside the UTC time range.");
  return seconds as UTCTimestamp;
}

function seriesValue(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("value" in value)) return null;
  const candidate = value.value;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

export function SeriesChart({
  points,
  hours,
  loading,
  mode,
  price,
  currency,
  latestPriceAt,
  onViewHistory,
  priceLoading = false,
  priceError = false,
  seriesError = false,
  seriesReady = true,
}: {
  points: SeriesPoint[];
  hours: number;
  loading: boolean;
  mode: "sentiment" | "comparison";
  price?: PricePoint[];
  currency: string | null;
  latestPriceAt: number | null;
  onViewHistory?: () => void;
  priceLoading?: boolean;
  priceError?: boolean;
  seriesError?: boolean;
  seriesReady?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const indexRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const decayRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const comparison = mode === "comparison";

  const drawableSentiment = useMemo(
    () => points.filter((point) => Number.isFinite(point.t) && (point.v == null || Number.isFinite(point.v))),
    [points],
  );
  const sentimentByTime = useMemo(
    () => new Map(drawableSentiment.map((point) => [Number(toSec(point.t)), point])),
    [drawableSentiment],
  );
  const sentimentByTimeRef = useRef(sentimentByTime);
  sentimentByTimeRef.current = sentimentByTime;
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  const drawablePrice = useMemo(
    () => comparison
      ? (price ?? []).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price))
      : [],
    [comparison, price],
  );
  const hasSentiment = drawableSentiment.some((point) => point.v != null && point.n > 0);
  const hasPrice = drawablePrice.length >= 2;
  const insufficientPrice = comparison && drawablePrice.length === 1;
  const hasChartData = hasSentiment || drawablePrice.length > 0;
  const waitingForPrice = comparison && priceLoading && drawablePrice.length === 0;
  const lastScoredAt = [...drawableSentiment].reverse().find((point) => point.v != null && point.n > 0)?.t ?? null;
  const hasModeledTail = lastScoredAt != null
    && drawableSentiment.some((point) => point.t > lastScoredAt && point.v != null && point.n === 0);
  const scorePointCount = drawableSentiment.filter((point) => point.v != null && point.n > 0).length;

  // A new chart per mode gives comparison its own price pane while keeping the
  // sentiment-only view at full height. The two panes share one time scale.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(232,235,242,0.52)",
        fontSize: 10,
        attributionLogo: true,
        panes: {
          enableResize: false,
          separatorColor: "rgba(255,255,255,0.12)",
          separatorHoverColor: "rgba(255,255,255,0.18)",
        },
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      leftPriceScale: { visible: true, borderVisible: false },
      rightPriceScale: { visible: true, borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.3)", labelBackgroundColor: "#1a1f2b" },
        horzLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#1a1f2b" },
      },
    });

    const index = chart.addSeries(BaselineSeries, {
      priceScaleId: "left",
      baseValue: { type: "price", price: 0 },
      topFillColor1: "rgba(52,211,153,0.2)",
      topFillColor2: "rgba(52,211,153,0.025)",
      topLineColor: "#34d399",
      bottomFillColor1: "rgba(248,113,113,0.025)",
      bottomFillColor2: "rgba(248,113,113,0.18)",
      bottomLineColor: "#f87171",
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      baseLineVisible: true,
      baseLineColor: "rgba(255,255,255,0.35)",
      baseLineStyle: LineStyle.Dashed,
      pointMarkersVisible: true,
      pointMarkersRadius: 2,
      crosshairMarkerRadius: 4,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: -100, maxValue: 100 } }),
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0);

    const decay = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: "rgba(203,213,225,0.8)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      pointMarkersVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: -100, maxValue: 100 } }),
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0);
    index.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });

    let priceSeries: ISeriesApi<"Line"> | null = null;
    if (comparison) {
      chart.addPane();
      priceSeries = chart.addSeries(LineSeries, {
        priceScaleId: "right",
        color: "rgba(226,232,240,0.78)",
        lineWidth: 1,
        pointMarkersVisible: false,
        crosshairMarkerVisible: true,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        priceLineVisible: false,
        lastValueVisible: false,
      }, 1);
    }

    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      if (param.point == null || typeof param.time !== "number") {
        tip.style.opacity = "0";
        return;
      }

      const time = Number(param.time);
      const score = sentimentByTimeRef.current.get(time);
      const parts: string[] = [];
      if (score?.v != null) {
        const value = `${score.v > 0 ? "+" : ""}${score.v.toFixed(1)}`;
        parts.push(score.n > 0
          ? `Jev index ${value} · ${score.n} scored ${score.n === 1 ? "item" : "items"}`
          : `Modeled decay ${value} · no new scored items`);
      }
      const priceValue = priceSeries ? seriesValue(param.seriesData.get(priceSeries)) : null;
      const activeCurrency = currencyRef.current;
      if (priceValue != null) parts.push(`${activeCurrency ? `${activeCurrency} ` : ""}${priceValue.toFixed(2)}`);
      tip.textContent = parts.join("  ·  ");
      tip.style.opacity = parts.length > 0 ? "1" : "0";
    });

    chartRef.current = chart;
    indexRef.current = index;
    decayRef.current = decay;
    priceRef.current = priceSeries;
    const panes = chart.panes();
    panes[0]?.setStretchFactor(comparison ? 2 : 1);
    panes[1]?.setStretchFactor(1);

    return () => {
      chart.remove();
      chartRef.current = null;
      indexRef.current = null;
      decayRef.current = null;
      priceRef.current = null;
    };
  }, [comparison]);

  useEffect(() => {
    const index = indexRef.current;
    const decay = decayRef.current;
    const priceSeries = priceRef.current;
    const chart = chartRef.current;
    if (!index || !decay || !chart) return;

    index.setData(drawableSentiment.map((point) => (
      point.v != null && point.n > 0
        ? { time: toSec(point.t), value: point.v }
        : { time: toSec(point.t) }
    )));

    decay.setData(drawableSentiment.map((point, indexInSeries) => {
      const next = drawableSentiment[indexInSeries + 1];
      const beginsFade = point.n > 0 && next?.n === 0;
      return point.v != null && (point.n === 0 || beginsFade)
        ? { time: toSec(point.t), value: point.v }
        : { time: toSec(point.t) };
    }));

    if (priceSeries) {
      priceSeries.setData(drawablePrice.map((point) => ({ time: toSec(point.t), value: point.price })));
      priceSeries.applyOptions({ pointMarkersVisible: drawablePrice.length === 1 });
    }

    // Keep the selected window visible even when the latest saved observation
    // is stale; empty time to the right is part of the freshness evidence.
    if (hasChartData) {
      const now = Date.now();
      chart.timeScale().setVisibleRange({
        from: toSec(now - hours * 60 * 60 * 1000),
        to: toSec(now),
      });
    }
  }, [drawableSentiment, drawablePrice, hasChartData, hours]);

  const requestError = seriesError || (comparison && priceError);
  const noDataMessage = requestError
    ? "Chart data could not be loaded. Check the source status above."
    : mode === "sentiment"
      ? "No Jev scores in this window."
      : insufficientPrice
        ? "One saved price observation; at least two are needed for a line."
        : "No saved Yahoo prices or Jev scores in this window.";
  const noScoreMessage = seriesError
    ? "Sentiment history could not be loaded. Check the source status above."
    : "No Jev-scored items in this window";
  const hasOlderPriceHistory = latestPriceAt != null
    && latestPriceAt < Date.now() - hours * 60 * 60 * 1000;
  const priceStatus = priceError
    ? drawablePrice.length > 0 ? "Refresh failed · showing saved prices" : "Price history unavailable"
    : priceLoading
      ? "Loading saved price history…"
      : insufficientPrice
        ? "One saved price point; a line needs two"
        : drawablePrice.length === 0
          ? "No saved Yahoo price points in this window"
          : null;

  return (
    <div className="relative">
      <div
        ref={containerRef}
        role="img"
        aria-label={`Jev sentiment index on a fixed scale from minus 100 to plus 100. Solid colored marks show ${scorePointCount} buckets with newly scored items; dashed segments show modeled decay between scored buckets. Last scored ${lastScoredAt == null ? "time unknown" : new Date(lastScoredAt).toISOString()}.${comparison ? ` Share price is shown in a separate aligned pane${currency ? ` in ${currency}` : "; currency unknown"}.` : ""}`}
        className={comparison ? "chart-canvas chart-canvas-comparison" : "chart-canvas chart-canvas-sentiment"}
      />
      {comparison && (
        <>
          <div className="pointer-events-none absolute left-[86px] top-2 z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            JEV INDEX · −100 TO +100
          </div>
          <div className="pointer-events-none absolute left-[86px] top-[calc(66.667%+2px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            SHARE PRICE{currency ? ` · ${currency}` : " · CURRENCY UNKNOWN"}
          </div>
          {priceStatus && (
            <div className="pointer-events-none absolute right-[76px] top-[calc(66.667%+36px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[10px] text-white/45">
              {priceStatus}
            </div>
          )}
        </>
      )}
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute right-[76px] top-2 z-20 max-w-[70%] rounded-md border border-desk-line bg-[#0c0e14]/95 px-2.5 py-1 text-[10.5px] text-white/85 tabnum opacity-0 transition-opacity"
      />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-white/50">
          loading chart data…
        </div>
      )}
      {!loading && !waitingForPrice && comparison && !hasSentiment && drawablePrice.length > 0 && (
        <div role="status" className="pointer-events-none absolute left-[86px] top-9 z-10 rounded bg-[#0c0e14]/90 px-2 py-1 text-[10.5px] text-white/55">
          {noScoreMessage}
        </div>
      )}
      {!loading && !waitingForPrice && !hasChartData && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-white/55">
          <span>{noDataMessage}</span>
          {!requestError && hours < 168 && hasOlderPriceHistory && onViewHistory && (
            <button
              onClick={onViewHistory}
              className="rounded border border-white/10 px-2 py-1 text-white/70 hover:bg-white/[0.05]"
            >
              View 7D saved price history
            </button>
          )}
        </div>
      )}
      {comparison && hasModeledTail && !loading && (
        <span className="sr-only">
          The dashed sentiment segment is modelled decay after the last scored item at {new Date(lastScoredAt ?? 0).toISOString()}.
        </span>
      )}
      {comparison && scorePointCount > 0 && (
        <span className="sr-only">{scorePointCount} sentiment buckets contain newly scored items.</span>
      )}
    </div>
  );
}
