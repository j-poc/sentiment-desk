import { useMemo, useRef, useState } from "react";
import type { PricePoint, SeriesPoint } from "../lib/api.js";
import { dayTime, shortTime } from "../lib/format.js";

/**
 * Sentiment index chart with an optional price overlay. The series is a
 * smoothed leaky-integrator index (continuous by construction), rendered as
 * Catmull-Rom curves split into green segments above the zero line and red
 * segments below it, each with its own area fill. The price overlay is
 * normalized to its own min/max on a right axis and shares the time domain.
 * Hover shows both series at the hovered instant.
 */

const W = 800;
const H = 280;
const PAD_X = 10;
const TOP = 14;
const BOTTOM = 14;

const POS = "#34d399";
const NEG = "#f87171";

interface Pt {
  x: number;
  y: number;
  t: number;
  v: number;
  n: number;
}

/** Catmull-Rom through the points, as cubic beziers. */
function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

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

    const pts: Pt[] = [];
    points.forEach((p, i) => {
      if (p.v != null) pts.push({ x: xOfT(p.t), y: yOf(p.v), t: p.t, v: p.v, n: p.n });
    });

    // Split into same-sign segments, inserting interpolated zero crossings so
    // areas and colors meet exactly at the baseline.
    const segments: Array<{ sign: 1 | -1; pts: Pt[] }> = [];
    let cur: Pt[] = [];
    let curSign: 1 | -1 = 1;
    const flush = () => {
      if (cur.length >= 1) segments.push({ sign: curSign, pts: cur });
      cur = [];
    };
    for (const p of pts) {
      const s: 1 | -1 = p.v >= 0 ? 1 : -1;
      if (cur.length > 0 && s !== curSign) {
        // Interpolate the crossing between last point of cur and p.
        const prev = cur[cur.length - 1]!;
        const frac = Math.abs(prev.v) / (Math.abs(prev.v) + Math.abs(p.v) || 1);
        const cross: Pt = {
          x: prev.x + (p.x - prev.x) * frac,
          y: zeroY,
          t: prev.t + (p.t - prev.t) * frac,
          v: 0,
          n: 0,
        };
        cur.push(cross);
        flush();
        curSign = s;
        cur = [cross, p];
      } else {
        if (cur.length === 0) curSign = s;
        cur.push(p);
      }
    }
    flush();

    const linePath = (seg: Pt[]) => smoothPath(seg);
    const areaPath = (seg: Pt[]) => {
      const last = seg[seg.length - 1];
      const first = seg[0];
      if (!last || !first) return "";
      return `${smoothPath(seg)} L${last.x.toFixed(1)},${zeroY.toFixed(1)} L${first.x.toFixed(1)},${zeroY.toFixed(1)} Z`;
    };

    // Price overlay, clamped to the sentiment time domain.
    let priceLine: {
      path: string;
      min: number;
      max: number;
      last?: { xFrac: number; yFrac: number; price: number };
      at: (t: number) => number | null;
    } | null = null;
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
        const pad = (max - min) * 0.08;
        min -= pad;
        max += pad;
        const yP = (p: number) => TOP + (1 - (p - min) / (max - min)) * (H - TOP - BOTTOM);
        const pp = source
          .map((p) => ({ x: xOfT(Math.max(t0, Math.min(t1, p.t))), y: yP(p.price), t: p.t, v: p.price, n: 0 }))
          .sort((a, b) => a.t - b.t);
        const lastPt = pp[pp.length - 1];
        priceLine = {
          path: smoothPath(pp),
          min,
          max,
          last: lastPt ? { xFrac: lastPt.x / W, yFrac: lastPt.y / H, price: lastPt.v } : undefined,
          at: (t: number) => {
            let best: number | null = null;
            let bestDist = Infinity;
            for (const p of pp) {
              const d = Math.abs(p.t - t);
              if (d < bestDist) {
                bestDist = d;
                best = p.v;
              }
            }
            return best;
          },
        };
      }
    }

    return { zeroY, yOf, xOfT, segments, linePath, areaPath, n, t0, t1, priceLine };
  }, [points, mode, price]);

  const onMove = (e: React.MouseEvent) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || geom.n === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const i = Math.round(frac * (geom.n - 1));
    setHover({ i, x: frac * box.width });
  };

  const hoverPoint = hover ? points[hover.i] : null;
  const hoverPrice = hover && hoverPoint && geom.priceLine ? geom.priceLine.at(hoverPoint.t) : null;

  return (
    <div ref={boxRef} className="relative select-none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-[280px] w-full" preserveAspectRatio="none">
        {[-100, -50, 50, 100].map((v) => (
          <line
            key={v}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={geom.yOf(v)}
            y2={geom.yOf(v)}
            stroke="rgba(255,255,255,0.045)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={geom.zeroY}
          y2={geom.zeroY}
          stroke="rgba(255,255,255,0.2)"
          strokeDasharray="4 5"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {geom.segments.map((seg, i) => (
          <g key={i}>
            <path d={geom.areaPath(seg.pts)} fill={seg.sign === 1 ? "rgba(52,211,153,0.13)" : "rgba(248,113,113,0.12)"} />
          </g>
        ))}

        {geom.priceLine && (
          <path
            d={geom.priceLine.path}
            fill="none"
            stroke="rgba(226,232,240,0.55)"
            strokeWidth="1.1"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        )}

        {geom.segments.map((seg, i) => (
          <path
            key={`l${i}`}
            d={geom.linePath(seg.pts)}
            fill="none"
            stroke={seg.sign === 1 ? POS : NEG}
            strokeWidth="1.9"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {hover && (
          <line
            x1={geom.xOfT(hoverPoint?.t ?? geom.t0)}
            x2={geom.xOfT(hoverPoint?.t ?? geom.t0)}
            y1={TOP - 6}
            y2={H - BOTTOM + 6}
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hover && hoverPoint?.v != null && (
          <circle
            cx={geom.xOfT(hoverPoint.t)}
            cy={geom.yOf(hoverPoint.v)}
            r="3.5"
            fill={hoverPoint.v >= 0 ? POS : NEG}
            stroke="#08090d"
            strokeWidth="1.5"
          />
        )}

      </svg>

      {/* Sentiment axis */}
      <div className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between py-1 text-[9px] text-white/30 tabnum">
        <span>+100</span>
        <span>+50</span>
        <span>0</span>
        <span>-50</span>
        <span>-100</span>
      </div>

      {/* Price axis */}
      {geom.priceLine && (
        <div className="pointer-events-none absolute inset-y-0 right-1 text-[9px] text-white/45 tabnum">
          <span className="absolute" style={{ top: `${(TOP / H) * 100}%` }}>
            {geom.priceLine.max.toFixed(0)}
          </span>
          <span
            className="absolute"
            style={{ top: "50%", transform: "translateY(-50%)", color: "rgba(232,235,242,0.6)" }}
          >
            {((geom.priceLine.min + geom.priceLine.max) / 2).toFixed(0)}
          </span>
          <span
            className="absolute"
            style={{ top: `${((H - BOTTOM) / H) * 100}%`, transform: "translateY(-100%)" }}
          >
            {geom.priceLine.min.toFixed(0)}
          </span>
        </div>
      )}

      {/* Last price chip riding the overlay */}
      {geom.priceLine?.last && (
        <div
          className="pointer-events-none absolute z-10 -translate-y-1/2 rounded border border-white/15 bg-[#0c0e14] px-1.5 py-[1px] text-[9.5px] text-white/85 tabnum"
          style={{ left: `${geom.priceLine.last.xFrac * 100}%`, top: `${geom.priceLine.last.yFrac * 100}%` }}
        >
          {geom.priceLine.last.price.toFixed(2)}
        </div>
      )}

      {hover && hoverPoint && hoverPoint.v != null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-desk-line bg-[#0c0e14]/95 px-3 py-2 text-[11px] shadow-xl"
          style={{
            left: Math.min(Math.max(hover.x - 70, 8), (boxRef.current?.clientWidth ?? 400) - 170),
          }}
        >
          <div className="tabnum text-[13px] font-semibold" style={{ color: hoverPoint.v >= 0 ? POS : NEG }}>
            {hoverPoint.v > 0 ? "+" : ""}
            {hoverPoint.v.toFixed(1)}
          </div>
          <div className="mt-0.5 text-white/50">
            {hours <= 24 ? shortTime(hoverPoint.t) : dayTime(hoverPoint.t)} · {hoverPoint.n} mention
            {hoverPoint.n === 1 ? "" : "s"}
            {hoverPrice != null && <span className="tabnum"> · ${hoverPrice.toFixed(2)}</span>}
          </div>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-white/40">loading series…</div>
      )}
    </div>
  );
}
