import type { CompanySnapshot } from "../lib/api.js";
import { fmtDelta, sentimentColor } from "../lib/format.js";

/** Biggest sentiment movers on the watchlist, ranked by absolute delta. */
export function TopMovers({
  companies,
  selectedId,
  onSelect,
}: {
  companies: CompanySnapshot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const movers = [...companies]
    .filter((c) => c.delta != null)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 5);
  const hasScores = companies.some((company) => company.index != null);

  return (
    <div>
      {movers.length === 0 && (
        <div className="px-4 py-4 text-[11px] text-white/30">
          {hasScores
            ? "Current scores are available; no prior 24h comparison yet."
            : "No scored sentiment is available yet."}
        </div>
      )}
      {movers.map((c) => {
        const d = c.delta ?? 0;
        const color = sentimentColor(d > 0.5 ? "positive" : d < -0.5 ? "negative" : "neutral");
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`flex w-full items-center gap-2.5 border-b border-white/[0.04] px-4 py-2.5 text-left transition-colors ${
              c.id === selectedId ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
            }`}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c.color }} />
            <span className="w-11 shrink-0 text-[11.5px] font-semibold tracking-wide">{c.ticker}</span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-white/40">{c.name}</span>
            <span className="tabnum shrink-0 text-[11.5px]" style={{ color }}>
              {fmtDelta(d)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
