import type { CompanySnapshot, MarketSnapshot, Quote } from "../lib/api.js";
import { fmtDelta, quoteSourceAgeLabel, sentimentColor, timeAgo } from "../lib/format.js";

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

  const cell = (key: string, ticker: string, quote?: Quote, sentiment?: number | null, company?: CompanySnapshot) => {
    const price = quote?.price;
    const changePct = quote?.changePct;
    const sourceAge = quote ? quoteSourceAgeLabel(quote.at) : null;
    const color = changePct != null ? (changePct > 0.001 ? "#34d399" : changePct < -0.001 ? "#f87171" : "#94a3b8") : "#64748b";
    const selected = company != null && company.id === selectedId;
    const contents = (
      <>
        <span className="font-semibold tracking-wide text-white/75">{labelFor(ticker)}</span>
        {price != null ? (
          <span className={`tabnum ${quote?.delivery === "cache" ? "text-amber-300/80" : "text-white/90"}`}>{price >= 1000 ? price.toFixed(0) : price.toFixed(2)} {quote?.currency}</span>
        ) : (
          <span className="tabnum text-white/25">--</span>
        )}
        {changePct != null && (
          <span className="tabnum w-11 text-right" style={{ color }}>
            {fmtDelta(changePct)}%
          </span>
        )}
        {quote?.delivery === "cache" && <span className="text-[8px] text-amber-300/80">cached {timeAgo(quote.retrievedAt)}</span>}
        {sourceAge && <span className="text-[8px] text-amber-300/80">{sourceAge}</span>}
        {sentiment != null && company && (
          <span
            className="mb-[3px] inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: sentimentColor(sentiment > 3 ? "positive" : sentiment < -3 ? "negative" : "neutral") }}
            title={`sentiment ${sentiment.toFixed(1)}`}
          />
        )}
      </>
    );
    const className = `flex h-[34px] shrink-0 items-baseline gap-1.5 border-r border-white/[0.05] px-3.5 text-[11px] ${
      company ? "cursor-pointer hover:bg-white/[0.04] focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" : ""
    } ${selected ? "bg-white/[0.05]" : ""}`;
    const title = quote ? `${quote.delivery === "cache" ? "Last-known cached quote" : "Yahoo Finance network quote"}; ${quote.currency}; source time ${quote.at == null ? "unknown" : new Date(quote.at).toISOString()}; retrieved ${timeAgo(quote.retrievedAt)}` : undefined;
    if (company) {
      return (
        <button
          key={key}
          type="button"
          aria-label={`Select ${company.name} (${ticker})`}
          aria-pressed={selected}
          onClick={() => onSelect(company.id)}
          className={className}
          title={title}
        >
          {contents}
        </button>
      );
    }
    return (
      <span key={key} className={className} title={title}>
        {contents}
      </span>
    );
  };

  return (
    <div className="no-scrollbar flex h-[34px] shrink-0 items-center overflow-x-auto border-b border-desk-line bg-black/50">
      {indices.map((t) => {
        const q = quotes[t];
        return cell(`idx-${t}`, t, q);
      })}
      {companies.map((c) => {
        const q = quotes[c.ticker];
        return cell(c.id, c.ticker, q, c.index, c);
      })}
      {market && market.updatedAt > 0 && (
        <span className="tabnum shrink-0 px-3 text-[9.5px] text-white/25" title="latest successful quote retrieval across symbols">
          {timeAgo(market.updatedAt)}
        </span>
      )}
    </div>
  );
}
