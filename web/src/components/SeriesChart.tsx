import { useEffect, useRef } from "react";
import {
  AreaSeries,
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

/**
 * Sentiment index chart with an optional price overlay, built on TradingView
 * lightweight-charts (Apache-2.0; attribution satisfied via attributionLogo).
 *
 * Both series share one uniform time grid: the server resamples prices onto
 * the exact bucket grid the sentiment index uses (carry-forward through closed
 * periods). The sentiment series is a smoothed leaky-integrator index drawn as
 * a green area around the zero baseline; the price overlay lives on its own
 * right price scale. Crosshair, tooltips, session handling, and resize are the
 * library's job — that is why it was adopted over the hand-rolled SVG chart.
 */

const toSec = (ms: number): UTCTimestamp => Math.floor(ms / 1000) as UTCTimestamp;

export function SeriesChart({
  points,
  loading,
  mode,
  price,
}: {
  points: SeriesPoint[];
  hours: number;
  loading: boolean;
  mode: "sentiment" | "overlay";
  price?: PricePoint[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const sentimentRef = useRef<ISeriesApi<"Area"> | null>(null);
  const priceRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Create the chart once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(232,235,242,0.45)",
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      leftPriceScale: { visible: true, borderVisible: false },
      rightPriceScale: { visible: true, borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 0 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: "#1a1f2b" },
        horzLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: "#1a1f2b" },
      },
    });

    const sentiment = chart.addSeries(AreaSeries, {
      priceScaleId: "left",
      lineColor: "#34d399",
      topColor: "rgba(52,211,153,0.28)",
      bottomColor: "rgba(52,211,153,0.02)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
    });
    sentiment.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 } });
    sentiment.createPriceLine({
      price: 0,
      color: "rgba(255,255,255,0.25)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });

    const priceSeries = chart.addSeries(LineSeries, {
      color: "rgba(226,232,240,0.6)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    priceSeries.applyOptions({ visible: false });

    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      if (param.point == null || param.time == null) {
        tip.style.opacity = "0";
        return;
      }
      const s = param.seriesData.get(sentiment) as { value?: number } | undefined;
      const p = param.seriesData.get(priceSeries) as { value?: number } | undefined;
      const parts: string[] = [];
      if (s?.value != null) {
        parts.push(`sent ${s.value > 0 ? "+" : ""}${s.value.toFixed(1)}`);
      }
      if (p?.value != null) {
        parts.push(`$${p.value.toFixed(2)}`);
      }
      tip.textContent = parts.length > 0 ? parts.join("  ·  ") : "";
      tip.style.opacity = parts.length > 0 ? "1" : "0";
    });

    chartRef.current = chart;
    sentimentRef.current = sentiment;
    priceRef.current = priceSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      sentimentRef.current = null;
      priceRef.current = null;
    };
  }, []);

  // Push data on every change.
  useEffect(() => {
    const sentiment = sentimentRef.current;
    const priceSeries = priceRef.current;
    const chart = chartRef.current;
    if (!sentiment || !priceSeries || !chart) return;

    sentiment.setData(
      points.map((p) => (p.v == null ? { time: toSec(p.t) } : { time: toSec(p.t), value: p.v })),
    );

    if (mode === "overlay" && price && price.length >= 2) {
      priceSeries.setData(
        price.map((p) => ({ time: toSec(p.t), value: p.price })),
      );
      priceSeries.applyOptions({ visible: true });
    } else {
      priceSeries.setData([]);
      priceSeries.applyOptions({ visible: false });
    }

    const from = points[0]?.t;
    const to = points[points.length - 1]?.t;
    if (from != null && to != null) {
      chart.timeScale().setVisibleRange({ from: toSec(from), to: toSec(to) });
    }
  }, [points, price, mode]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-[280px] w-full" />
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute left-3 top-2 z-10 rounded-md border border-desk-line bg-[#0c0e14]/90 px-2.5 py-1 text-[10.5px] text-white/80 tabnum opacity-0 transition-opacity"
      />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-white/40">
          loading series…
        </div>
      )}
    </div>
  );
}
