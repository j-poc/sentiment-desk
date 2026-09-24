import type { CompanySnapshot, MarketSnapshot } from "../lib/api.js";
import { fmtDelta, sentimentColor, timeAgo } from "../lib/format.js";

/**
 * Top tape: market indices first (context, never scored), then every watched
 * ticker with live quote and sentiment direction. Click a cell to select.
 */
export function TickerTape({
  market,
  companies,
  selectedId,
  onSelect,
  indices,
}: {
  market: MarketSnapshot | null;
  companies: CompanySnapshot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  indices: string[];
}) {
  const quotes = market?.quotes ?? {};
  const labelFor = (t: string) => t.replace("^", "");

  const cell = (key: string, ticker: string, price?: number, changePct?: number, sentiment?: number | null, companyId?: string) => {
    const color = changePct != null ? (changePct > 0.001 ? "#34d399" : changePct < -0.001 ? "#f87171" : "#94a3b8") : "#64748b";
    const selected = companyId != null && companyId === selectedId;
    const body = (
      <span
        key={key}
        onClick={companyId ? () => onSelect(companyId) : undefined}
        className={`flex shrink-0 items-baseline gap-1.5 border-r border-white/[0.05] px-3.5 text-[11px] ${
          companyId ? "cursor-pointer hover:bg-white/[0.04]" : ""
        } ${selected ? "bg-white/[0.05]" : ""}`}
      >
        <span className="font-semibold tracking-wide text-white/75">{labelFor(ticker)}</span>
        {price != null ? (
          <span className="tabnum text-white/90">{price >= 1000 ? price.toFixed(0) : price.toFixed(2)}</span>
        ) : (
          <span className="tabnum text-white/25">--</span>
        )}
        {changePct != null && (
          <span className="tabnum w-11 text-right" style={{ color }}>
            {fmtDelta(changePct)}%
          </span>
        )}
        {sentiment != null && companyId && (
          <span
            className="mb-[3px] inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: sentimentColor(sentiment > 3 ? "positive" : sentiment < -3 ? "negative" : "neutral"),
            }}
            title={`sentiment ${sentiment?.toFixed(1)}`}
          />
        )}
      </span>
    );
    return body;
  };

  return (
    <div className="no-scrollbar flex h-[34px] shrink-0 items-center overflow-x-auto border-b border-desk-line bg-black/50">
      {indices.map((t) => {
        const q = quotes[t];
        return cell(`idx-${t}`, t, q?.price, q?.changePct);
      })}
      {companies.map((c) => {
        const q = quotes[c.ticker];
        return cell(c.id, c.ticker, q?.price, q?.changePct, c.index, c.id);
      })}
      {market && market.updatedAt > 0 && (
        <span className="tabnum shrink-0 px-3 text-[9.5px] text-white/25" title="quote age">
          {timeAgo(market.updatedAt)}
        </span>
      )}
    </div>
  );
}
