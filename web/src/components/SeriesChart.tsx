import { useMemo, useRef, useState } from "react";
import type { PricePoint, SeriesPoint } from "../lib/api.js";
import { dayTime, shortTime } from "../lib/format.js";

/**
 * Sentiment area chart with an optional normalized price overlay. The fill is
 * one user-space gradient: green above the zero line, red below, intensity
 * tracking distance from neutral. Hover gives the exact bucket. Null buckets
 * (no scored mentions) break the curve rather than lying with interpolation.
 * The price overlay is normalized to its own min/max on a right axis; it shares
 * the time domain with sentiment buckets, so divergences are readable directly.
 */

const W = 800;
const H = 280;
const PAD_X = 10;
const TOP = 14;
const BOTTOM = 14;

export function SeriesChart({
  points,
  hours,
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
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const geom = useMemo(() => {
    const n = points.length;
    const zeroY = TOP + (H - TOP - BOTTOM) / 2;
    const t0 = points[0]?.t ?? 0;
    const t1 = points[Math.max(0, n - 1)]?.t ?? 1;
    const span = Math.max(1, t1 - t0);
    const yOf = (v: number) => zeroY - (Math.max(-100, Math.min(100, v)) / 100) * ((H - TOP - BOTTOM) / 2);
    const xOfT = (t: number) => PAD_X + ((t - t0) / span) * (W - 2 * PAD_X);
    const xOf = (i: number) => xOfT(points[i]?.t ?? t0);

    const runs: Array<Array<{ x: number; y: number; v: number; t: number; n: number }>> = [];
    let cur: Array<{ x: number; y: number; v: number; t: number; n: number }> = [];
    points.forEach((p, i) => {
      if (p.v == null) {
        if (cur.length > 0) runs.push(cur);
        cur = [];
      } else {
        cur.push({ x: xOf(i), y: yOf(p.v), v: p.v, t: p.t, n: p.n });
      }
    });
    if (cur.length > 0) runs.push(cur);

    const linePath = (run: typeof runs[number]) =>
      run.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
    const areaPath = (run: typeof runs[number]) => {
      const last = run[run.length - 1];
      const first = run[0];
      if (!last || !first) return "";
      return `${linePath(run)} L${last.x.toFixed(1)},${zeroY.toFixed(1)} L${first.x.toFixed(1)},${zeroY.toFixed(1)} Z`;
    };

    // Price overlay, clamped to the sentiment time domain.
    let priceLine: { path: string; min: number; max: number; last?: { xFrac: number; yFrac: number; price: number } } | null = null;
    if (mode === "overlay" && price && price.length >= 2) {
      const inDomain = price.filter((p) => p.t >= t0 && p.t <= t1 && Number.isFinite(p.price));
      const source = inDomain.length >= 2 ? inDomain : price;
      let min = Infinity;
      let max = -Infinity;
      for (const p of source) {
        min = Math.min(min, p.price);
        max = Math.max(max, p.price);
      }
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        const pad = (max - min) * 0.06;
        min -= pad;
        max += pad;
        const yP = (p: number) => TOP + (1 - (p - min) / (max - min)) * (H - TOP - BOTTOM);
        const pts = source.map((p) => ({ x: xOfT(Math.max(t0, Math.min(t1, p.t))), y: yP(p.price), t: p.t, price: p.price }));
        priceLine = {
          path: pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" "),
          min,
          max,
          last: (() => {
            const lastPt = pts[pts.length - 1];
            if (!lastPt) return undefined;
            return { xFrac: lastPt.x / W, yFrac: lastPt.y / H, price: lastPt.price };
          })(),
        };
      }
    }

    return { zeroY, yOf, xOf, xOfT, runs, linePath, areaPath, n, t0, t1, priceLine };
  }, [points, mode, price]);

  const onMove = (e: React.MouseEvent) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || geom.n === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const i = Math.round(frac * (geom.n - 1));
    setHover({ i, x: frac * box.width });
  };

  const hoverPoint = hover ? points[hover.i] : null;

  return (
    <div ref={boxRef} className="relative select-none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-[260px] w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="series-fill" gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={H - BOTTOM}>
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.34" />
            <stop offset="49.9%" stopColor="#34d399" stopOpacity="0.07" />
            <stop offset="50.1%" stopColor="#f87171" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#f87171" stopOpacity="0.34" />
          </linearGradient>
        </defs>

        {[-100, -50, 50, 100].map((v) => (
          <line
            key={v}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={geom.yOf(v)}
            y2={geom.yOf(v)}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={geom.zeroY}
          y2={geom.zeroY}
          stroke="rgba(255,255,255,0.22)"
          strokeDasharray="4 5"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {geom.runs.map((run, ri) => (
          <g key={ri}>
            <path d={geom.areaPath(run)} fill="url(#series-fill)" />
            <path
              d={geom.linePath(run)}
              fill="none"
              stroke={(run[run.length - 1]?.v ?? 0) >= 0 ? "#34d399" : "#f87171"}
              strokeWidth="1.8"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </g>
        ))}

        {geom.priceLine && (
          <path
            d={geom.priceLine.path}
            fill="none"
            stroke="rgba(232,235,242,0.85)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        )}

        {hover && (
          <line
            x1={geom.xOf(hover.i)}
            x2={geom.xOf(hover.i)}
            y1={TOP - 6}
            y2={H - BOTTOM + 6}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hover && hoverPoint?.v != null && (
          <circle
            cx={geom.xOf(hover.i)}
            cy={geom.yOf(hoverPoint.v)}
            r="3.5"
            fill={hoverPoint.v >= 0 ? "#34d399" : "#f87171"}
            stroke="#08090d"
            strokeWidth="1.5"
          />
        )}
      </svg>

      {/* Axis labels */}
      <div className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between py-1 text-[9px] text-white/30 tabnum">
        <span>+100</span>
        <span>+50</span>
        <span>0</span>
        <span>-50</span>
        <span>-100</span>
      </div>

      {/* Price right axis */}
      {geom.priceLine && (
        <div className="pointer-events-none absolute inset-y-0 right-0 text-[9px] text-white/45 tabnum">
          <span className="absolute right-1" style={{ top: `${(TOP / H) * 100}%` }}>
            {geom.priceLine.max.toFixed(0)}
          </span>
          <span className="absolute right-1" style={{ top: `${((H - BOTTOM) / H) * 100}%`, transform: "translateY(-100%)" }}>
            {geom.priceLine.min.toFixed(0)}
          </span>
        </div>
      )}

      {/* Last price chip riding the overlay line */}
      {geom.priceLine?.last && (
        <div
          className="pointer-events-none absolute z-10 -translate-y-1/2 rounded border border-white/15 bg-[#0c0e14] px-1.5 py-[1px] text-[9.5px] text-white/85 tabnum"
          style={{ left: `${geom.priceLine.last.xFrac * 100}%`, top: `${geom.priceLine.last.yFrac * 100}%` }}
        >
          {geom.priceLine.last.price.toFixed(2)}
        </div>
      )}

      {hover && hoverPoint && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-desk-line bg-[#0c0e14]/95 px-3 py-2 text-[11px] shadow-xl"
          style={{
            left: Math.min(Math.max(hover.x - 60, 8), (boxRef.current?.clientWidth ?? 400) - 150),
          }}
        >
          <div className="tabnum text-[13px] font-semibold">
            {hoverPoint.v == null ? "no scored mentions" : `${hoverPoint.v > 0 ? "+" : ""}${hoverPoint.v.toFixed(1)}`}
          </div>
          <div className="mt-0.5 text-white/50">
            {hours <= 24 ? shortTime(hoverPoint.t) : dayTime(hoverPoint.t)} · {hoverPoint.n} mention
            {hoverPoint.n === 1 ? "" : "s"}
          </div>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-white/40">loading series…</div>
      )}
    </div>
  );
}
