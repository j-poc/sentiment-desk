import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint, SeriesPoint } from "../lib/api.js";
import { formatChartTimestamp } from "../lib/chart-time.js";
import { timeAgo } from "../lib/format.js";
import { isValidUtcMilliseconds } from "../lib/chart-time.js";
import { chartDataFocusRange, chartVisibleRange, scoreBucketChartTimeline, sentimentSeriesState } from "../lib/series-chart-state.js";
import { SavedPriceHistoryControl } from "./SavedPriceHistoryControl.js";

function toSec(ms: number): UTCTimestamp {
  if (!isValidUtcMilliseconds(ms)) throw new RangeError("Chart timestamp must be valid UTC milliseconds.");
  const seconds = ms / 1000;
  if (!Number.isFinite(seconds)) throw new RangeError("Chart timestamp is outside the UTC time range.");
  return seconds as UTCTimestamp;
}

function formatArchivePlotSpan(range: { fromMs: number; throughMs: number }): string {
  const from = new Date(range.fromMs).toISOString();
  const through = new Date(range.throughMs).toISOString();
  const formatTime = (iso: string) => `${new Date(iso).toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${iso.slice(8, 10)} ${iso.slice(11, 19)}`;
  const start = formatTime(from);
  const end = from.slice(0, 10) === through.slice(0, 10) ? through.slice(11, 19) : formatTime(through);
  return `Plot span (UTC, end exclusive) · ${start} to before ${end}`;
}

function formatCompactArchivePlotSpan(range: { fromMs: number; throughMs: number }): string {
  const from = new Date(range.fromMs);
  const through = new Date(range.throughMs);
  const dateTime = (value: Date) => `${value.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${value.toISOString().slice(8, 10)} ${value.toISOString().slice(11, 16)}`;
  const end = from.toISOString().slice(0, 10) === through.toISOString().slice(0, 10)
    ? through.toISOString().slice(11, 16)
    : dateTime(through);
  return `Plot · ${dateTime(from)}–${end} UTC`;
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
  priceQuarantine,
  range,
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
  onSelectBucket?: (bucketFromMs: number, bucketThroughMs: number, returnFocus?: HTMLButtonElement) => void;
  bucketEvidence?: ReactNode;
  priceLoading?: boolean;
  priceError?: boolean;
  priceQuarantine?: unknown;
  seriesError?: boolean;
  seriesReady?: boolean;
  /** Exact half-open interval for bounded archive charts; rolling windows remain the default. */
  range?: { fromMs: number; throughMs: number };
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const impactRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const arrivalsRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const comparison = mode === "comparison";
  const [archiveScale, setArchiveScale] = useState<"fit" | "full">("fit");

  const drawableSentiment = useMemo(
    () => points.filter((point) => Number.isSafeInteger(point.bucketEndAtMs)
      && (point.weightedMeanImpact == null || Number.isFinite(point.weightedMeanImpact))),
    [points],
  );
  const chartTimeline = useMemo(() => {
    try {
      if (points.some((point) => !isValidUtcMilliseconds(point.bucketEndAtMs)
        || (point.latestRecordScoredAtMs != null && !isValidUtcMilliseconds(point.latestRecordScoredAtMs)))) {
        return { entries: [], invalid: true };
      }
      return { entries: scoreBucketChartTimeline(drawableSentiment), invalid: false };
    } catch {
      return { entries: [], invalid: true };
    }
  }, [drawableSentiment, points]);
  const chartSentiment = chartTimeline.entries;
  const chartTimelineInvalid = chartTimeline.invalid;
  const sentimentByTime = useMemo(
    () => new Map(chartSentiment.map((entry) => [entry.chartTimeSeconds, entry])),
    [chartSentiment],
  );
  const sentimentByTimeRef = useRef(sentimentByTime);
  sentimentByTimeRef.current = sentimentByTime;
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
  const { hasSentiment } = sentimentState;
  const hasPrice = drawablePrice.length >= 2;
  const insufficientPrice = comparison && drawablePrice.length === 1;
  const hasChartData = (sentimentState.hasChartData && !chartTimelineInvalid) || drawablePrice.length > 0;
  const waitingForPrice = comparison && priceLoading && drawablePrice.length === 0;
  const latestVisibleScoreAt = drawableSentiment.reduce<number | null>(
    (latest, point) => point.scoredRecordCount > 0 && point.latestRecordScoredAtMs != null
      && isValidUtcMilliseconds(point.latestRecordScoredAtMs)
      ? Math.max(latest ?? point.latestRecordScoredAtMs, point.latestRecordScoredAtMs)
      : latest,
    null,
  );
  const lastScoredAt = latestScoreAvailableAt != null && isValidUtcMilliseconds(latestScoreAvailableAt)
    ? latestScoreAvailableAt
    : latestVisibleScoreAt;
  const scoredBuckets = chartSentiment
    .map(({ point }) => point)
    .filter((point) => point.scoredRecordCount > 0);
  const visibleRange = useMemo(() => range == null || archiveScale === "full"
    ? range
    : chartDataFocusRange(drawableSentiment, range), [archiveScale, drawableSentiment, range]);

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

    const impact = chart.addSeries(HistogramSeries, {
      priceScaleId: "left",
      base: 0,
      color: "rgba(52,211,153,0.8)",
      priceFormat: { type: "price", precision: 0, minMove: 1 },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: -100, maxValue: 100 } }),
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0);

    impact.priceScale().applyOptions({
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
    // change the fixed −100..+100 impact range or hide the bucket bars.
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
      const scoreEntry = sentimentByTimeRef.current.get(time);
      const score = scoreEntry?.point;
      const parts: string[] = [];
      if (score?.weightedMeanImpact != null && score.scoredRecordCount > 0) {
        const value = `${score.weightedMeanImpact > 0 ? "+" : ""}${score.weightedMeanImpact.toFixed(1)}`;
        const impactRange = score.recordImpactMin != null && score.recordImpactMax != null
          ? ` · record spread ${score.recordImpactMin.toFixed(0)} to ${score.recordImpactMax.toFixed(0)}`
          : "";
        const lineage = score.sourceLineage
          ? ` · source receipts ${score.sourceLineage.receiptLinkedRecordCount}/${score.sourceLineage.recordCount} · rows in repeated exact-title groups ${score.sourceLineage.repeatedTitleRecordCount}/${score.sourceLineage.recordCount} (title cue only)`
          : "";
        parts.push(`Jev score-time bucket ending ${formatChartTimestamp(score.bucketEndAtMs)} · weighted mean impact ${value} · ${score.scoredRecordCount} saved source ${score.scoredRecordCount === 1 ? "record" : "records"}${impactRange}${lineage}`);
      }
      const priceValue = priceSeries ? seriesValue(param.seriesData.get(priceSeries)) : null;
      const activeCurrency = currencyRef.current;
      if (priceValue != null) parts.push(`${activeCurrency ? `${activeCurrency} ` : ""}${priceValue.toFixed(2)}`);
      tip.textContent = parts.join("  ·  ");
      tip.style.opacity = parts.length > 0 ? "1" : "0";
    });

    const selectScoredBucket = (param: { point?: { x: number; y: number } | null; time?: unknown }) => {
      if (param.point == null || typeof param.time !== "number") return;
      const point = sentimentByTimeRef.current.get(param.time)?.point;
      if (point?.scoredRecordCount) {
        onSelectBucketRef.current?.(point.bucketStartAtMs, point.bucketEndAtMs);
      }
    };
    chart.subscribeClick(selectScoredBucket);

    chartRef.current = chart;
    impactRef.current = impact;
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
      impactRef.current = null;
      arrivalsRef.current = null;
      priceRef.current = null;
    };
  }, [comparison]);

  useEffect(() => {
    const impact = impactRef.current;
    const arrivals = arrivalsRef.current;
    const priceSeries = priceRef.current;
    const chart = chartRef.current;
    if (!impact || !arrivals || !chart) return;

    impact.setData(chartSentiment.map(({ point, chartTimeSeconds }) => point.weightedMeanImpact != null && point.scoredRecordCount > 0
      ? {
          time: chartTimeSeconds as UTCTimestamp,
          value: point.weightedMeanImpact,
          color: point.weightedMeanImpact >= 0 ? "rgba(52,211,153,0.8)" : "rgba(248,113,113,0.82)",
        }
      : { time: chartTimeSeconds as UTCTimestamp }));

    arrivals.setData(chartSentiment.map(({ point, chartTimeSeconds }) => point.scoredRecordCount > 0
      ? { time: chartTimeSeconds as UTCTimestamp, value: point.scoredRecordCount }
      : { time: chartTimeSeconds as UTCTimestamp }));

    if (priceSeries) {
      priceSeries.setData(drawablePrice.map((point) => ({ time: toSec(point.t), value: point.price })));
      priceSeries.applyOptions({ pointMarkersVisible: drawablePrice.length === 1 });
    }

    // Keep the selected window visible even when the latest saved observation
    // is stale; empty time to the right is part of the freshness evidence.
    if (hasChartData) {
      const now = Date.now();
      const visible = chartVisibleRange(hours, now, chartSentiment.at(-1)?.chartTimeSeconds ?? null, visibleRange);
      chart.timeScale().setVisibleRange({
        from: toSec(visible.fromMs),
        to: toSec(visible.throughMs),
      });
    }
  }, [chartSentiment, drawablePrice, hasChartData, hours, visibleRange]);

  const requestError = seriesError || (comparison && priceError);
  const noDataMessage = requestError
    ? "Chart data could not be loaded. Check the source status above."
    : mode === "sentiment"
      ? "No saved Jev-scored records in this window."
      : insufficientPrice
        ? "One saved price observation; at least two are needed for a line."
        : "No saved Yahoo prices or Jev scores in this window.";
  const noScoreMessage = seriesError
    ? "Sentiment history could not be loaded. Check the source status above."
    : lastScoredAt != null && lastScoredAt < Date.now() - hours * 60 * 60_000
      ? `No saved scores in this window · latest saved score ${timeAgo(lastScoredAt)}`
      : "No Jev-scored records in this window";
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
  const quarantine = typeof priceQuarantine === "object" && priceQuarantine !== null
    ? priceQuarantine as { legacyUnknownRows?: unknown; scope?: unknown }
    : null;
  const legacyUnknownRows = quarantine?.scope === "all_saved_history"
    && typeof quarantine.legacyUnknownRows === "number"
    && Number.isSafeInteger(quarantine.legacyUnknownRows)
    && quarantine.legacyUnknownRows >= 0
    ? quarantine.legacyUnknownRows
    : null;
  const priceEmptyDisclosure = comparison && drawablePrice.length === 0 && !priceLoading && !priceError
    ? `No verified Yahoo price points are saved in this window. ${legacyUnknownRows == null
      ? "Legacy unknown-source price row count is unavailable."
      : legacyUnknownRows > 0
        ? `${legacyUnknownRows.toLocaleString("en-US")} legacy price rows are excluded because their source provenance is incomplete. This count covers all saved history for this ticker.`
        : "No legacy unknown-source price rows were found in all saved history for this ticker."}`
    : null;
  const archiveRangeDescription = range && visibleRange
    ? ` The visible plot span is ${new Date(visibleRange.fromMs).toISOString()} to before ${new Date(visibleRange.throughMs).toISOString()}; the selected archive week is ${new Date(range.fromMs).toISOString()} to before ${new Date(range.throughMs).toISOString()}.`
    : "";

  return (
    <div className="relative">
      {range && (
        <div className="mb-2">
          <div
            role="note"
            aria-label={`Plot span in UTC, end exclusive: ${new Date(visibleRange?.fromMs ?? range.fromMs).toISOString()} to before ${new Date(visibleRange?.throughMs ?? range.throughMs).toISOString()}`}
            title={`Visible plot interval: ${new Date(visibleRange?.fromMs ?? range.fromMs).toISOString()} to before ${new Date(visibleRange?.throughMs ?? range.throughMs).toISOString()}. Selected archive week: ${new Date(range.fromMs).toISOString()} to before ${new Date(range.throughMs).toISOString()}.`}
            className="text-[11px] leading-5 text-white/60 tabnum"
          >
            <span className="hidden sm:inline">{formatArchivePlotSpan(visibleRange ?? range)}</span>
            <span className="sm:hidden">{formatCompactArchivePlotSpan(visibleRange ?? range)}</span>
          </div>
        </div>
      )}
      <div data-chart-overlay-frame="true" className="chart-canvas-frame relative">
      <div
        ref={containerRef}
        role="img"
        aria-label={`Discrete histogram of observed Jev score-time buckets.${archiveRangeDescription} Each bar is the weighted mean impact of saved Jev-scored source records completed in that 15-minute bucket, on a fixed scale from minus 100 to plus 100 impact points. Bars are grouped by Jev score-completion time, not article publication, public-discussion volume, investor activity, or share-price changes. Record spread is the minimum and maximum individual impact in the bucket; it is not a confidence interval. Empty buckets are blank gaps; values are never carried forward and no line connects buckets. Repeated coverage can contribute more than once, and records do not represent distinct investors. Select a bucket to inspect source clocks, repeated-title cues, and delivery-receipt links. This is a model-derived record summary, not a stock return or validated investor opinion. The lower bars count saved scored records per bucket. Click a bucket or use View source records in the keyboard table to inspect evidence. Latest saved Jev score completed ${lastScoredAt == null ? "at an unknown time" : new Date(lastScoredAt).toISOString()}.${comparison ? ` Share price is shown in a separate aligned pane${currency ? ` in ${currency}` : "; currency unknown"}.` : ""}`}
        className={comparison ? "chart-canvas chart-canvas-comparison" : "chart-canvas chart-canvas-sentiment"}
      />
      {comparison && (
        <>
          <div className="pointer-events-none absolute left-[86px] top-2 z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            WEIGHTED MEAN JEV IMPACT · −100 TO +100
          </div>
          <div className="pointer-events-none absolute left-[86px] top-[calc(57.143%+2px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            SHARE PRICE{currency ? ` · ${currency}` : " · CURRENCY UNKNOWN"}
          </div>
          <div className="pointer-events-none absolute left-[86px] top-[calc(85.714%+2px)] z-10 rounded bg-[#0c0e14]/85 px-2 py-1 text-[9px] tracking-wide text-white/60">
            SCORED RECORDS / 15M
          </div>
          {priceStatus && (
            <div className="absolute right-[76px] top-[calc(57.143%+36px)] z-10 flex max-w-[calc(100%-100px)] flex-wrap items-start gap-x-2 gap-y-1 rounded bg-[#0c0e14]/90 px-2 py-1 text-[10px] leading-relaxed text-white/70">
              <span>{priceEmptyDisclosure && legacyUnknownRows != null && legacyUnknownRows > 0
                ? `No verified Yahoo points · ${legacyUnknownRows.toLocaleString("en-US")} legacy rows quarantined`
                : priceStatus}</span>
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
      {chartTimelineInvalid && (
        <div role="alert" className="absolute left-[76px] top-2 z-20 max-w-[calc(100%-92px)] rounded-md border border-rose-400/30 bg-[#0c0e14]/95 px-2.5 py-1.5 text-[10.5px] text-rose-100/90">
          Score history is withheld because the response contains invalid score timestamps or duplicate UTC bucket times.
        </div>
      )}
      <div
        ref={tooltipRef}
        className="chart-canvas-tooltip pointer-events-none absolute right-[76px] top-2 z-20 max-w-[70%] rounded-md border border-desk-line bg-[#0c0e14]/95 px-2.5 py-1 text-[10.5px] text-white/85 tabnum opacity-0 transition-opacity"
      />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-white/50">
          loading chart data…
        </div>
      )}
      {!loading && !waitingForPrice && comparison && !hasSentiment && (
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
      {!loading && !waitingForPrice && !comparison && !hasSentiment && canShowLatestSavedHistory && (
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
      {!loading && !waitingForPrice && !chartTimelineInvalid && !hasChartData && !(canShowLatestSavedHistory && !hasSentiment) && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-white/55">
          <span>{noDataMessage}</span>
        </div>
      )}
      </div>
      {range && (
        <div role="group" aria-label="Chart time range" className="chart-archive-scale-control inline-flex min-h-11 rounded-md border border-white/10 p-0.5 text-[10px]">
          <button
            type="button"
            aria-pressed={archiveScale === "fit"}
            onClick={() => setArchiveScale("fit")}
            className="min-h-11 min-w-24 rounded px-3 text-white/70 aria-pressed:bg-white/10 aria-pressed:text-white"
          >Fit scores</button>
          <button
            type="button"
            aria-pressed={archiveScale === "full"}
            onClick={() => setArchiveScale("full")}
            className="min-h-11 min-w-24 rounded px-3 text-white/70 aria-pressed:bg-white/10 aria-pressed:text-white"
          >Full week</button>
        </div>
      )}
      {priceEmptyDisclosure && (
        <p role="status" aria-live="polite" className="chart-data-note mt-2 break-words text-[11px] leading-relaxed">
          {priceEmptyDisclosure}
        </p>
      )}
      {bucketEvidence}
      {(scoredBuckets.length > 0 || comparison) && (
      <details className="chart-data-disclosure">
          <summary>
            Inspect plotted data by keyboard
            <span>{scoredBuckets.length} scored {scoredBuckets.length === 1 ? "bucket" : "buckets"}</span>
          </summary>
          <p className="chart-data-note">
            {chartTimelineInvalid
              ? "Score history is withheld because score timestamps are invalid or duplicated."
              : scoredBuckets.length > 0
              ? "Each row is one UTC-aligned 15-minute score-completion bucket. The mean uses the saved, eligible scored records counted in that row; zero-weight records remain in the observed record count and spread. Record spread reports their actual minimum and maximum impacts; no confidence interval is inferred. Plot positions preserve each bucket's exact UTC millisecond end time."
              : seriesError
                ? "Saved Jev score history could not be loaded; score rows are unavailable."
                : !seriesReady
                  ? "Loading saved Jev score history…"
                  : "No saved Jev score buckets are available in this window."}
            {comparison && " Share-price rows show each saved provider source time and the separate time it was collected."}
            {scoredBuckets.some((point) => point.sourceLineage) && " Receipt links show whether a saved record references a collection receipt; they do not validate publisher quality. Repeated-title counts are cues only and do not prove duplicate stories or independent publishers."}
          </p>
          {scoredBuckets.length > 0 && (
            <div className="chart-table-scroll" role="region" aria-label="Plotted score bucket data" tabIndex={0}>
              <table>
                <caption>Saved Jev score buckets in the selected chart window</caption>
                <thead>
                  <tr>
                    <th scope="col">Time / state</th>
                    <th scope="col">Weighted mean impact</th>
                    <th scope="col">Records</th>
                    <th scope="col">Record spread (impact points)</th>
                    <th scope="col">Source delivery lineage</th>
                    <th scope="col">Saved source rows</th>
                  </tr>
                </thead>
                <tbody>
                  {scoredBuckets.map((point) => (
                    <tr key={`score-${point.bucketEndAtMs}`}>
                      <th scope="row">{formatChartTimestamp(point.bucketEndAtMs)}</th>
                      <td>{point.weightedMeanImpact == null
                        ? "Unavailable"
                        : `${point.weightedMeanImpact > 0 ? "+" : ""}${point.weightedMeanImpact.toFixed(1)}`}</td>
                      <td>{point.scoredRecordCount}</td>
                      <td>{point.recordImpactMin == null || point.recordImpactMax == null
                        ? "Not available"
                        : `${point.recordImpactMin > 0 ? "+" : ""}${point.recordImpactMin.toFixed(0)} to ${point.recordImpactMax > 0 ? "+" : ""}${point.recordImpactMax.toFixed(0)}`}</td>
                      <td>{point.sourceLineage
                        ? `${point.sourceLineage.receiptLinkedRecordCount}/${point.sourceLineage.recordCount} receipt-linked · ${point.sourceLineage.repeatedTitleRecordCount}/${point.sourceLineage.recordCount} rows in repeated exact-title groups`
                        : "Not summarized for this series"}</td>
                      <td><button type="button" onClick={(event) => onSelectBucket?.(
                        point.bucketStartAtMs,
                        point.bucketEndAtMs,
                        event.currentTarget,
                      )}>
                        View {point.scoredRecordCount} source {point.scoredRecordCount === 1 ? "record" : "records"}
                      </button></td>
                    </tr>
                  ))}
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
        </details>
      )}
    </div>
  );
}
