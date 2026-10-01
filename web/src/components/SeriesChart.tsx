import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  BaselineSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  LineType,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint, SeriesPoint } from "../lib/api.js";
import { formatChartTimestamp } from "../lib/chart-time.js";
import { timeAgo } from "../lib/format.js";
import { sentimentSeriesState } from "../lib/series-chart-state.js";
import { SavedPriceHistoryControl } from "./SavedPriceHistoryControl.js";

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
  latestScoreAvailableAt,
  onViewHistory,
  onSelectBucket,
  bucketEvidence,
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
  latestScoreAvailableAt: number | null;
  onViewHistory?: () => void;
  onSelectBucket?: (bucketAt: number, includeFromBoundary: boolean, returnFocus?: HTMLButtonElement) => void;
  bucketEvidence?: ReactNode;
  priceLoading?: boolean;
  priceError?: boolean;
  seriesError?: boolean;
  seriesReady?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const indexRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const decayRef = useRef<ISeriesApi<"Line"> | null>(null);
  const arrivalsRef = useRef<ISeriesApi<"Histogram"> | null>(null);
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
  const firstBucketAtRef = useRef<number | null>(drawableSentiment[0]?.t ?? null);
  firstBucketAtRef.current = drawableSentiment[0]?.t ?? null;
  const onSelectBucketRef = useRef(onSelectBucket);
  onSelectBucketRef.current = onSelectBucket;
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  const drawablePrice = useMemo(
    () => comparison
      ? (price ?? []).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price))
      : [],
    [comparison, price],
  );
  const sentimentState = sentimentSeriesState(drawableSentiment);
  const { hasSentiment, hasModeledHistory } = sentimentState;
  const hasPrice = drawablePrice.length >= 2;
  const insufficientPrice = comparison && drawablePrice.length === 1;
  const hasChartData = sentimentState.hasChartData || drawablePrice.length > 0;
  const waitingForPrice = comparison && priceLoading && drawablePrice.length === 0;
  const latestVisibleScoreAt = drawableSentiment.reduce<number | null>(
    (latest, point) => point.n > 0 && point.lastScoredAt != null
      ? Math.max(latest ?? point.lastScoredAt, point.lastScoredAt)
      : latest,
    null,
  );
  const lastScoredAt = latestScoreAvailableAt ?? latestVisibleScoreAt;
  const hasModeledTail = lastScoredAt != null
    && drawableSentiment.some((point) => point.t > lastScoredAt && point.v != null && point.n === 0);
  const scorePointCount = drawableSentiment.filter((point) => point.v != null && point.n > 0).length;
  const hasVisibleModeledIndex = drawableSentiment.some((point) => point.v != null && point.n === 0 && Math.abs(point.v) >= 0.5);
  const scoredBuckets = drawableSentiment.filter((point) => point.v != null && point.n > 0);
  const lastPoint = drawableSentiment.at(-1) ?? null;
  const latestModeledPoint = lastPoint?.v != null && lastPoint.n === 0 ? lastPoint : null;

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
      lineType: LineType.WithSteps,
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
    index.priceScale().applyOptions({
      scaleMargins: { top: 0.04, bottom: 0.04 },
      entireTextOnly: true,
    });

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

    // Counts get their own synchronized pane so their numeric scale cannot
    // change the fixed −100..+100 sentiment range or hide the index line.
    const arrivalsPaneIndex = comparison ? 2 : 1;
    chart.addPane();
    const arrivals = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      color: "rgba(148,163,184,0.58)",
      priceFormat: { type: "volume", precision: 0 },
      priceLineVisible: false,
      lastValueVisible: false,
    }, arrivalsPaneIndex);
    arrivals.priceScale().applyOptions({
      scaleMargins: { top: 0.12, bottom: 0.08 },
      visible: true,
      borderVisible: false,
    });

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
        const impactRange = score.itemImpactMin != null && score.itemImpactMax != null
          ? ` · item impacts ${score.itemImpactMin.toFixed(0)} to ${score.itemImpactMax.toFixed(0)}`
          : "";
        parts.push(score.n > 0
          ? `Jev impact index ${value} · ${score.n} scored source ${score.n === 1 ? "record" : "records"}${impactRange}`
          : `Modeled decay ${value} · no new scored source records`);
      }
      const priceValue = priceSeries ? seriesValue(param.seriesData.get(priceSeries)) : null;
      const activeCurrency = currencyRef.current;
      if (priceValue != null) parts.push(`${activeCurrency ? `${activeCurrency} ` : ""}${priceValue.toFixed(2)}`);
      tip.textContent = parts.join("  ·  ");
      tip.style.opacity = parts.length > 0 ? "1" : "0";
    });

    const selectScoredBucket = (param: { point?: { x: number; y: number } | null; time?: unknown }) => {
      if (param.point == null || typeof param.time !== "number") return;
      const point = sentimentByTimeRef.current.get(param.time);
      if (point?.n) {
        onSelectBucketRef.current?.(point.t, point.t === firstBucketAtRef.current);
      }
    };
    chart.subscribeClick(selectScoredBucket);

    chartRef.current = chart;
    indexRef.current = index;
    decayRef.current = decay;
    arrivalsRef.current = arrivals;
    priceRef.current = priceSeries;
    const panes = chart.panes();
    panes[0]?.setStretchFactor(4);
    panes[1]?.setStretchFactor(comparison ? 2 : 1);
    panes[2]?.setStretchFactor(1);

    return () => {
      chart.unsubscribeClick(selectScoredBucket);
      chart.remove();
      chartRef.current = null;
      indexRef.current = null;
      decayRef.current = null;
      arrivalsRef.current = null;
      priceRef.current = null;
    };
  }, [comparison]);

  useEffect(() => {
    const index = indexRef.current;
    const decay = decayRef.current;
    const arrivals = arrivalsRef.current;
    const priceSeries = priceRef.current;
    const chart = chartRef.current;
    if (!index || !decay || !arrivals || !chart) return;

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

    arrivals.setData(drawableSentiment
      .filter((point) => point.n > 0)
      .map((point) => ({ time: toSec(point.t), value: point.n })));

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
      ? "No Jev scores or modeled history in this window."
      : insufficientPrice
        ? "One saved price observation; at least two are needed for a line."
        : "No saved Yahoo prices or Jev scores in this window.";
  const noScoreMessage = seriesError
    ? "Sentiment history could not be loaded. Check the source status above."
    : lastScoredAt != null && lastScoredAt < Date.now() - hours * 60 * 60_000 && !hasVisibleModeledIndex
      ? `No saved scores or visible index in this window · latest saved score ${timeAgo(lastScoredAt)}`
      : hasVisibleModeledIndex
        ? `No new Jev scores in this window · modeled decay from the latest saved score ${lastScoredAt == null ? "at an unknown time" : timeAgo(lastScoredAt)}`
        : "No Jev-scored items in this window";
  const canShowLatestSavedHistory = lastScoredAt != null
    && lastScoredAt >= Date.now() - 168 * 60 * 60_000
    && hours < 168
    && onViewHistory != null;
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
        aria-label={`Sequential Jev impact index on a fixed scale from minus 100 to plus 100. Individual impact is 100 times the difference between Jev's positive and negative probabilities, in impact points. The index updates as each judgment completes and decays toward zero with a fixed eight-hour half-life. Reconstructed by score-completion time, which can cluster records that were published hours apart. Aligned bottom bars count Jev-scored source records completed per 15-minute bucket; repeated coverage may count more than once, and bars do not count distinct stories or investors. This is a model-derived index, not a stock return or validated investor opinion. Solid step marks show ${scorePointCount} buckets when Jev judgments became available; hovering a bucket reveals its source-record count and individual-impact range. Click a scored bucket or use View source records in the keyboard table to inspect saved evidence. Dashed segments show modeled decay between scored buckets. Latest Jev judgment completed ${lastScoredAt == null ? "at an unknown time" : new Date(lastScoredAt).toISOString()}.${comparison ? ` Share price is shown in a separate aligned pane${currency ? ` in ${currency}` : "; currency unknown"}.` : ""}`}
        className={comparison ? "chart-canvas chart-canvas-comparison" : "chart-canvas chart-canvas-sentiment"}
      />
      {comparison && (
        <>
          <div className="pointer-events-none absolute left-[86px] top-2 z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            JEV IMPACT INDEX · FIXED −100 TO +100
          </div>
          <div className="pointer-events-none absolute left-[86px] top-[calc(57.143%+2px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            SHARE PRICE{currency ? ` · ${currency}` : " · CURRENCY UNKNOWN"}
          </div>
          <div className="pointer-events-none absolute left-[86px] top-[calc(85.714%+2px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            SCORED RECORDS / 15M
          </div>
          {priceStatus && (
            <div className="absolute right-[76px] top-[calc(57.143%+36px)] z-10 flex max-w-[calc(100%-100px)] items-center gap-2 rounded bg-[#0c0e14]/85 px-2 py-1 text-[10px] text-white/60">
              <span>{priceStatus}</span>
              <SavedPriceHistoryControl
                comparison={comparison}
                savedPriceCount={drawablePrice.length}
                latestPriceAt={latestPriceAt}
                hours={hours}
                onViewHistory={onViewHistory}
              />
            </div>
          )}
        </>
      )}
      {!comparison && (
        <div className="pointer-events-none absolute left-[76px] top-[calc(80%+2px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
          SCORED RECORDS / 15M
        </div>
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
      {!loading && !waitingForPrice && comparison && !hasSentiment && hasModeledHistory && (
        <div role="status" className="absolute left-[86px] top-9 z-10 flex max-w-[calc(100%-110px)] flex-wrap items-center gap-2 rounded bg-[#0c0e14]/90 px-2 py-1 text-[10.5px] text-white/65">
          {noScoreMessage}
          {canShowLatestSavedHistory && (
            <button
              type="button"
              onClick={onViewHistory}
              aria-label="Show the last 7 days of saved Jev history"
              className="pointer-events-auto rounded border border-white/15 px-1.5 py-0.5 text-emerald-200/80 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
            >
              Show 7D history
            </button>
          )}
        </div>
      )}
      {!loading && !waitingForPrice && !comparison && !hasSentiment && hasModeledHistory && (
        <div role="status" className="absolute left-[86px] top-2 z-10 flex max-w-[calc(100%-110px)] flex-wrap items-center gap-2 rounded bg-[#0c0e14]/90 px-2 py-1 text-[10.5px] text-white/65">
          {noScoreMessage}
          {canShowLatestSavedHistory && (
            <button
              type="button"
              onClick={onViewHistory}
              aria-label="Show the last 7 days of saved Jev history"
              className="pointer-events-auto rounded border border-white/15 px-1.5 py-0.5 text-emerald-200/80 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
            >
              Show 7D history
            </button>
          )}
        </div>
      )}
      {!loading && !waitingForPrice && !hasChartData && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-white/55">
          <span>{noDataMessage}</span>
        </div>
      )}
      {comparison && hasModeledTail && !loading && (
        <span className="sr-only">
          Score-availability timeline · modelled decay follows the last completed Jev judgment at {new Date(lastScoredAt ?? 0).toISOString()}.
        </span>
      )}
      {comparison && scorePointCount > 0 && (
        <span className="sr-only">{scorePointCount} sentiment buckets contain newly scored items.</span>
      )}
      {bucketEvidence}
      {(scoredBuckets.length > 0 || latestModeledPoint || comparison) && (
      <details className="chart-data-disclosure">
          <summary>
            Inspect plotted data by keyboard
            <span>{scoredBuckets.length} scored {scoredBuckets.length === 1 ? "bucket" : "buckets"}</span>
          </summary>
          <p className="chart-data-note">
            {scoredBuckets.length > 0 || latestModeledPoint
              ? "Score rows show 15-minute bucket ends, not individual publication times. The index decays between scored buckets."
              : seriesError
                ? "Saved Jev score history could not be loaded; score rows are unavailable."
                : !seriesReady
                  ? "Loading saved Jev score history…"
                  : "No saved Jev score buckets are available in this window."}
            {latestModeledPoint && " The modeled row is the latest saved index point without a new score."}
            {comparison && " Share-price rows show each saved provider source time and the separate time it was collected."}
          </p>
          {(scoredBuckets.length > 0 || latestModeledPoint) && (
            <div className="chart-table-scroll" role="region" aria-label="Plotted score bucket data" tabIndex={0}>
              <table>
                <caption>Saved Jev score buckets in the selected chart window</caption>
                <thead>
                  <tr>
                    <th scope="col">Time / state</th>
                    <th scope="col">Index</th>
                    <th scope="col">Records</th>
                    <th scope="col">Item impact range</th>
                    <th scope="col">Saved source rows</th>
                  </tr>
                </thead>
                <tbody>
                  {scoredBuckets.map((point) => (
                    <tr key={`score-${point.t}`}>
                      <th scope="row">{formatChartTimestamp(point.t)}</th>
                      <td>{point.v! > 0 ? "+" : ""}{point.v!.toFixed(1)}</td>
                      <td>{point.n}</td>
                      <td>{point.itemImpactMin == null || point.itemImpactMax == null
                        ? "Not available"
                        : `${point.itemImpactMin > 0 ? "+" : ""}${point.itemImpactMin.toFixed(0)} to ${point.itemImpactMax > 0 ? "+" : ""}${point.itemImpactMax.toFixed(0)}`}</td>
                      <td><button type="button" onClick={(event) => onSelectBucket?.(
                        point.t,
                        point.t === firstBucketAtRef.current,
                        event.currentTarget,
                      )}>
                        View {point.n} source {point.n === 1 ? "record" : "records"}
                      </button></td>
                    </tr>
                  ))}
                  {latestModeledPoint && (
                    <tr key={`modeled-${latestModeledPoint.t}`}>
                      <th scope="row">{formatChartTimestamp(latestModeledPoint.t)} · modeled</th>
                      <td>{latestModeledPoint.v! > 0 ? "+" : ""}{latestModeledPoint.v!.toFixed(1)}</td>
                      <td>0 new</td>
                      <td>—</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {comparison && drawablePrice.length > 0 && (
            <div className="chart-table-scroll" role="region" aria-label="Plotted share-price observations" tabIndex={0}>
              <table>
                <caption>Saved Yahoo share-price observations</caption>
                <thead>
                  <tr>
                    <th scope="col">Provider source time</th>
                    <th scope="col">Share price</th>
                    <th scope="col">Collected time</th>
                  </tr>
                </thead>
                <tbody>
                  {drawablePrice.map((point) => (
                    <tr key={`price-${point.t}`}>
                      <th scope="row"><time dateTime={new Date(point.t).toISOString()}>{formatChartTimestamp(point.t)}</time></th>
                      <td>{point.currency} {point.price.toFixed(2)}</td>
                      <td><time dateTime={new Date(point.retrievedAt).toISOString()}>{formatChartTimestamp(point.retrievedAt)}</time></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {comparison && drawablePrice.length === 0 && (
            <p className="chart-data-note" role="status">
              {priceStatus ?? "No saved Yahoo price points in this window"}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
