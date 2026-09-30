import type { CompanySnapshot, Quote, SeriesPoint } from "../lib/api.js";
import { NEU, fmtDelta, fmtIndex, quoteSourceAgeLabel, sentimentColor, timeAgo } from "../lib/format.js";

export function Sparkline({ points, width = 76, height = 24 }: { points?: SeriesPoint[]; width?: number; height?: number }) {
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
      <line x1="0" x2={width} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.09)" strokeDasharray="2 3" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function DeltaChip({ delta, label }: { delta: number | null; label?: string }) {
  if (delta == null) {
    return (
      <span className="text-[10px] text-white/25" aria-label={label ? `${label}: unavailable` : undefined}>
        --
      </span>
    );
  }
  const color = delta > 0.5 ? "#34d399" : delta < -0.5 ? "#f87171" : NEU;
  const arrow = delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "·";
  return (
    <span
      className="tabnum inline-flex items-center gap-0.5 text-[10px]"
      style={{ color }}
      aria-label={label ? `${label}: ${fmtDelta(delta)} impact points` : undefined}
    >
      {arrow} {fmtDelta(delta)}
    </span>
  );
}

export function Watchlist({
  companies,
  selectedId,
  sparks,
  quotes,
  onSelect,
}: {
  companies: CompanySnapshot[];
  selectedId: string | null;
  sparks: Record<string, SeriesPoint[]>;
  quotes: Record<string, Quote>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {companies.map((c) => {
        const selected = c.id === selectedId;
        const color = sentimentColor(c.index == null ? "neutral" : c.index > 3 ? "positive" : c.index < -3 ? "negative" : "neutral");
        const q = quotes[c.ticker];
        const change = q?.changePct;
        const sourceAge = q ? quoteSourceAgeLabel(q.at) : null;
        const sourceTiming = q == null
          ? null
          : sourceAge ?? "source time within the last 15 minutes";
        const freshness = q?.delivery === "cache"
          ? `cached ${timeAgo(q.retrievedAt)} · ${sourceTiming}`
          : sourceAge;
        const changeColor = change == null ? NEU : change > 0.001 ? "#34d399" : change < -0.001 ? "#f87171" : NEU;
        const indexDescription = c.index == null
          ? "Jev weighted item mean unavailable"
          : `Jev weighted item mean ${fmtIndex(c.index)} impact points from ${c.indexRecordCount} scored source records over ${c.indexWindow === "24h" ? "the trailing 24 hours (fallback)" : "the latest 3 hours"}`;
        const deltaDescription = c.delta == null
          ? "Current 3-hour weighted Jev mean minus trailing 24-hour weighted Jev mean is unavailable"
          : `Current 3-hour weighted Jev mean minus trailing 24-hour weighted Jev mean: ${fmtDelta(c.delta)} impact points`;
        const priceDescription = q == null
          ? "Market price unavailable"
          : `Market price ${q.price >= 1000 ? q.price.toFixed(0) : q.price.toFixed(2)} ${q.currency}; ${sourceTiming}; ${q.delivery === "cache" ? "cached" : "network"} delivery retrieved ${timeAgo(q.retrievedAt)}; ${change == null ? "price change unavailable" : `price change ${fmtDelta(change)} percent`}`;
        const sourceFreshness = `latest saved source record collected ${timeAgo(c.latestSourceCollectedAt)}`;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            aria-pressed={selected}
            aria-label={`${c.name} (${c.ticker}). ${indexDescription}. ${deltaDescription}. ${priceDescription}. ${sourceFreshness}. Activate to show ${c.name} research.`}
            className={`flex w-full items-center gap-2.5 border-b border-white/[0.04] px-3 py-2 text-left transition-colors ${
              selected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
            }`}
            style={{ borderLeft: `2px solid ${selected ? c.color : "transparent"}` }}
          >
            <span className="w-[72px] shrink-0">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} />
                <span className="text-[12px] font-semibold tracking-wide">{c.ticker}</span>
              </span>
              <span className="clamp-1 mt-0.5 block text-[10.5px] text-white/60">{c.name}</span>
            </span>

            <Sparkline points={sparks[c.id]} />

            <span className="w-[58px] shrink-0 text-right">
              <span className={`tabnum block text-[11.5px] ${q?.delivery === "cache" ? "text-amber-300/80" : "text-white/85"}`} title={q ? priceDescription : undefined}>
                {q ? `${q.price >= 1000 ? q.price.toFixed(0) : q.price.toFixed(2)} ${q.currency}` : "--"}
              </span>
              <span className="tabnum block truncate text-[10.5px]" style={{ color: freshness ? "#fbbf24" : changeColor }}>
                {freshness ?? (change != null ? `${fmtDelta(change)}%` : "--")}
              </span>
            </span>

            <span className="w-[52px] shrink-0 text-right">
              <span
                className="tabnum block text-[12.5px] font-semibold"
                style={{ color }}
                title={indexDescription}
              >
                {fmtIndex(c.index)}
              </span>
              <DeltaChip delta={c.delta} />
            </span>
          </button>
        );
      })}
      <div className="px-3 py-2 text-[10.5px] text-white/55">
        {companies.length} companies · latest source record collected {timeAgo(
          companies.reduce<number | null>((acc, c) => (c.latestSourceCollectedAt ?? 0) > (acc ?? 0) ? c.latestSourceCollectedAt : acc, null),
        )}
      </div>
    </div>
  );
}
