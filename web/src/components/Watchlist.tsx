import type { CompanySnapshot, SeriesPoint } from "../lib/api.js";
import { NEU, fmtDelta, fmtIndex, sentimentColor, timeAgo } from "../lib/format.js";

export function Sparkline({ points, width = 84, height = 26 }: { points?: SeriesPoint[]; width?: number; height?: number }) {
  const vals = (points ?? []).map((p) => p.v).filter((v): v is number => v != null);
  if (vals.length < 2) {
    return <div style={{ width, height }} className="rounded bg-white/[0.03]" />;
  }
  const step = width / (vals.length - 1);
  const y = (v: number) => height - ((Math.max(-100, Math.min(100, v)) + 100) / 200) * height;
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1] ?? 0;
  const color = sentimentColor(last > 3 ? "positive" : last < -3 ? "negative" : "neutral");
  const zeroY = y(0);

  return (
    <svg width={width} height={height} className="shrink-0">
      <line x1="0" x2={width} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.1)" strokeDasharray="2 3" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function DeltaChip({ delta }: { delta: number | null }) {
  if (delta == null) return <span className="text-[10px] text-white/25">--</span>;
  const color = delta > 0.5 ? "#34d399" : delta < -0.5 ? "#f87171" : NEU;
  const arrow = delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "·";
  return (
    <span className="tabnum inline-flex items-center gap-0.5 text-[10.5px]" style={{ color }}>
      {arrow} {fmtDelta(delta)}
    </span>
  );
}

export function Watchlist({
  companies,
  selectedId,
  sparks,
  onSelect,
}: {
  companies: CompanySnapshot[];
  selectedId: string | null;
  sparks: Record<string, SeriesPoint[]>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {companies.map((c) => {
        const selected = c.id === selectedId;
        const color = sentimentColor(c.index == null ? "neutral" : c.index > 3 ? "positive" : c.index < -3 ? "negative" : "neutral");
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`group flex w-full items-center gap-3 border-b border-white/[0.04] px-4 py-3 text-left transition-colors ${
              selected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
            }`}
            style={{ borderLeft: `2px solid ${selected ? c.color : "transparent"}` }}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold tracking-wide">{c.ticker}</span>
                <span className="truncate text-[10.5px] text-white/35">{c.name}</span>
              </span>
              <span className="mt-0.5 block text-[10px] text-white/30">
                {c.mentions24h} mentions · {timeAgo(c.lastMentionAt)}
              </span>
            </span>
            <Sparkline points={sparks[c.id]} />
            <span className="w-14 shrink-0 text-right">
              <span className="tabnum block text-[13.5px] font-semibold" style={{ color }}>
                {fmtIndex(c.index)}
              </span>
              <DeltaChip delta={c.delta} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
