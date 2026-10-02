import { useEffect, useRef } from "react";
import type { CompanySnapshot, Quote, SeriesPoint } from "../lib/api.js";
import { fmtDelta, fmtIndex, quoteSourceAgeLabel, sentimentColor, timeAgo } from "../lib/format.js";

export function Sparkline({ points, width = 76, height = 24 }: { points?: SeriesPoint[]; width?: number; height?: number }) {
  const vals = (points ?? []).map((p) => p.v).filter((v): v is number => v != null);
  if (vals.length < 2) return null;
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
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const latestSourceCollectedAt = companies.reduce<number | null>(
    (latest, company) => (company.latestSourceCollectedAt ?? 0) > (latest ?? 0) ? company.latestSourceCollectedAt : latest,
    null,
  );
  useEffect(() => {
    const row = selectedRowRef.current;
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

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
        const priceDescription = q == null
          ? "Market price unavailable"
          : `Market price ${q.price >= 1000 ? q.price.toFixed(0) : q.price.toFixed(2)} ${q.currency}; ${sourceTiming}; ${q.delivery === "cache" ? "cached" : "network"} delivery retrieved ${timeAgo(q.retrievedAt)}; ${change == null ? "price change unavailable" : `price change ${fmtDelta(change)} percent`}`;
        const historyStatus = c.indexRecordCount > 0
          ? `${c.indexRecordCount} scored records${c.indexWindow ? ` in ${c.indexWindow}` : ""}`
          : c.sourceRecords24h > 0
            ? `${c.sourceRecords24h} source ${c.sourceRecords24h === 1 ? "record" : "records"} retrieved in 24h · no scored index`
            : c.latestSourceCollectedAt != null
              ? `Saved history · latest ${timeAgo(c.latestSourceCollectedAt)}`
              : "No saved history";
        const indexDescription = c.index == null
          ? historyStatus
          : `Jev weighted item mean ${fmtIndex(c.index)} impact points from ${c.indexRecordCount} scored source records over ${c.indexWindow === "24h" ? "the trailing 24 hours (fallback)" : "the latest 3 hours"}`;
        const accessibleData = [indexDescription, c.delta == null ? null : `Current 3-hour weighted Jev mean minus trailing 24-hour weighted Jev mean: ${fmtDelta(c.delta)} impact points`, priceDescription, `latest saved source record collected ${timeAgo(c.latestSourceCollectedAt)}`]
          .filter(Boolean).join(". ");
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            aria-pressed={selected}
            ref={selected ? selectedRowRef : undefined}
            aria-label={`${c.name} (${c.ticker}). ${accessibleData}. Activate to show ${c.name} research.`}
            className={`flex w-full items-center gap-1.5 border-b border-white/[0.04] px-2 py-2 text-left transition-colors ${
              selected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
            }`}
            style={{ borderLeft: `2px solid ${selected ? c.color : "transparent"}` }}
          >
            <span className="w-[66px] shrink-0">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} />
                <span className="text-[12px] font-semibold tracking-wide">{c.ticker}</span>
              </span>
              <span className="clamp-1 mt-0.5 block text-[10.5px] text-white/60">{c.name}</span>
            </span>

            {(sparks[c.id] ?? []).some((point) => point.n > 0) && <Sparkline points={sparks[c.id]} width={32} height={20} />}

            <span className="min-w-0 flex-1 text-right">
              {q && (
                <span className={`tabnum block truncate text-[11px] ${q.delivery === "cache" ? "text-amber-300/85" : "text-white/85"}`} title={priceDescription}>
                  {q.currency} {q.price >= 1000 ? q.price.toFixed(0) : q.price.toFixed(2)}{change == null ? "" : ` · ${change > 0 ? "+" : ""}${fmtDelta(change)}%`}
                </span>
              )}
              {c.index != null ? (
                <span className="tabnum block truncate text-[10.5px]" style={{ color }} title={indexDescription}>
                  {fmtIndex(c.index)} impact · {c.indexRecordCount} scored
                </span>
              ) : (
                <span className="block clamp-2 text-[10.5px] leading-[1.3] text-white/55" title={historyStatus}>
                  {historyStatus}
                </span>
              )}
              {c.delta != null && (
                <span className="tabnum block truncate text-[9.5px] text-white/45" title={`3-hour minus 24-hour weighted mean: ${fmtDelta(c.delta)} impact points`}>
                  3h / 24h {fmtDelta(c.delta)}
                </span>
              )}
              {freshness && q && <span className="block truncate text-[9.5px] text-amber-200/65" title={`Quote source time: ${sourceTiming}; retrieved ${timeAgo(q.retrievedAt)}`}>{freshness}</span>}
            </span>
          </button>
        );
      })}
      <div className="px-3 py-2 text-[10.5px] text-white/55">
        {companies.length} companies · {latestSourceCollectedAt == null ? "no saved history yet" : `latest source record collected ${timeAgo(latestSourceCollectedAt)}`}
      </div>
    </div>
  );
}
