import { useMemo, useState } from "react";
import type { CompanySnapshot, Mention, MentionPage } from "../lib/api.js";
import { differentPossessiveHeadlineSubject, otherExplicitTickerSymbols, sourceLinkPathNamesCompany } from "../lib/issuer-symbols.js";
import { INITIAL_SAVED_SOURCES_BROWSE_STATE, type SavedSourcesBrowseState } from "../lib/saved-sources-browse-state.js";
import { sourceClockForMention } from "../lib/source-clock.js";
import { sourceDateTime, timeAgo } from "../lib/format.js";

const PAGE_SIZE = 12;

export function filterSavedSources(
  mentions: readonly Mention[],
  query: string,
  tickerOf: (companyId: string) => string,
  companyNameOf: (companyId: string) => string = (companyId) => companyId,
): Mention[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...mentions];
  return mentions.filter((mention) => [
    companyNameOf(mention.companyId), tickerOf(mention.companyId), mention.publisherName, mention.publisherDomain,
    mention.source.publisher, mention.source.name, mention.title,
  ].some((value) => value?.toLocaleLowerCase().includes(needle)));
}

function judgmentLabel(mention: Mention): string {
  if (mention.classification?.disposition === "classified") {
    const sentiment = mention.classification.sentiment;
    return `Luna category${sentiment ? `: ${sentiment}` : " available"} · not independently validated`;
  }
  if (mention.classification?.disposition === "excluded") return "Luna excluded this record";
  if (mention.classification?.disposition === "review_required") return "Luna record needs review";
  if (mention.score) return `Historical Jev judgment: ${mention.score.sentiment}`;
  if (mention.status === "pending" || mention.status === "retrying" || mention.status === "scoring") return "Judgment pending";
  if (mention.status === "failed") return "Classification failed";
  if (mention.status === "corrupt") return "Saved record needs integrity review";
  if (mention.status === "off_target") return "Historical Jev marked off-target";
  if (mention.status === "excluded") return "Excluded from sentiment analysis";
  if (mention.status === "review_required") return "Model review required";
  return "Review status available in record";
}

export type SavedSourcesState = "loading" | "ready" | "stale" | "failed";
export type SavedCompanyHistoryState = {
  companyId: string;
  status: "loading" | "ready" | "failed";
  items: Mention[];
  nextCursor: MentionPage["nextCursor"];
  pagesLoaded?: number;
  loadingMore: boolean;
  loadMoreFailed: boolean;
};
export type { SavedSourcesBrowseState } from "../lib/saved-sources-browse-state.js";

/** Clear a stale saved-source filter before the Recent Filings recovery route opens. */
export function recoverToSavedSources(
  saveBrowseState: (state: SavedSourcesBrowseState) => void,
  navigateToSavedSources: () => void,
): void {
  saveBrowseState({ ...INITIAL_SAVED_SOURCES_BROWSE_STATE });
  navigateToSavedSources();
}

/** A bounded browse surface over real records already retained by this desk. */
export function SavedSourcesView({
  mentions,
  companies = [],
  state,
  companyInventoryState = companies.length > 0 ? "ready" : "loading",
  tickerOf,
  knownTickers = [],
  companyNameOf,
  onOpen,
  onRetry,
  companyHistory,
  onRetryCompanyHistory,
  onLoadOlderHistory,
  browseState,
  onBrowseStateChange,
}: {
  mentions: readonly Mention[];
  companies?: readonly CompanySnapshot[];
  state: SavedSourcesState;
  companyInventoryState?: "loading" | "ready" | "failed";
  tickerOf: (companyId: string) => string;
  knownTickers?: readonly string[];
  companyNameOf: (companyId: string) => string;
  onOpen: (mention: Mention) => void;
  onRetry: () => void;
  companyHistory?: SavedCompanyHistoryState | null;
  onRetryCompanyHistory?: (companyId: string) => void;
  onLoadOlderHistory?: (companyId: string) => void;
  browseState?: SavedSourcesBrowseState;
  onBrowseStateChange?: (state: SavedSourcesBrowseState) => void;
}) {
  const [localBrowseState, setLocalBrowseState] = useState(INITIAL_SAVED_SOURCES_BROWSE_STATE);
  const { query, visibleCount, companyFilter } = browseState ?? localBrowseState;
  const updateBrowseState = (patch: Partial<SavedSourcesBrowseState>) => {
    const next = { ...(browseState ?? localBrowseState), ...patch };
    if (onBrowseStateChange) onBrowseStateChange(next);
    else setLocalBrowseState(next);
  };
  const selectedCompany = companyFilter == null ? null : companies.find((company) => company.id === companyFilter) ?? null;
  const selectedHistory = companyHistory?.companyId === companyFilter ? companyHistory : null;
  const activeState: SavedSourcesState = companyFilter == null
    ? state
    : selectedHistory?.status ?? "loading";
  const activeMentions = companyFilter == null ? mentions : selectedHistory?.items ?? [];
  const matchingMentions = useMemo(() => filterSavedSources(activeMentions, query, tickerOf, companyNameOf), [activeMentions, query, tickerOf, companyNameOf]);
  const companyFilteredMentions = useMemo(
    () => companyFilter == null ? matchingMentions : matchingMentions.filter((mention) => mention.companyId === companyFilter),
    [companyFilter, matchingMentions],
  );
  const visibleMentions = companyFilteredMentions.slice(0, visibleCount);
  const sortedCompanies = [...companies].sort((left, right) => left.name.localeCompare(right.name));
  const needsIssuerReview = (mention: Mention) => mention.issuerIdentityStrong !== true
    || otherExplicitTickerSymbols(`${mention.title} ${mention.snippet}`, tickerOf(mention.companyId), knownTickers).length > 0
    || differentPossessiveHeadlineSubject(
      mention.title,
      mention.snippet,
      companyNameOf(mention.companyId),
      tickerOf(mention.companyId),
    ) != null;
  const issuerReviewCount = activeMentions.filter(needsIssuerReview).length;

  return (
    <section className="panel min-w-0" aria-labelledby="saved-sources-heading">
      <header className="panel-head flex-wrap gap-y-1">
        <div className="min-w-0">
          <h1 id="saved-sources-heading" tabIndex={-1} className="micro m-0 p-0 text-[12px]">RECENT SAVED SOURCES</h1>
          <p className="mt-1 text-[12px] normal-case tracking-normal leading-relaxed text-white/50">
            Choose any desk company to read its retained source history. Reads use saved records only and do not start collection. The recent tape below is limited to 60 rows and is not full company coverage.
          </p>
        </div>
        {(activeState === "ready" || activeState === "stale") && activeMentions.length > 0 && (
          <span className="tabnum text-[11.5px] text-white/55">{companyFilter == null ? `Recent tape · ${activeMentions.length} loaded · limited to latest 60` : `${selectedCompany?.name ?? companyNameOf(companyFilter)} · ${activeMentions.length} saved history rows loaded`}{` · ${issuerReviewCount} row${issuerReviewCount === 1 ? "" : "s"} need issuer check`}</span>
        )}
      </header>

      <div className="flex flex-col gap-1.5 border-b border-desk-line px-3 py-3 sm:px-4">
        <label className="flex flex-wrap items-center gap-2 text-[12px] text-white/65">
          <span className="shrink-0">Company history</span>
          <select
            aria-label="Load saved source history for a company"
            value={companyFilter ?? ""}
            disabled={companyInventoryState !== "ready"}
            onChange={(event) => {
              const companyId = event.currentTarget.value || null;
              const current = browseState ?? localBrowseState;
              updateBrowseState({
                companyFilter: companyId,
                visibleCount: PAGE_SIZE,
                historyPageCounts: companyId === null || current.historyPageCounts[companyId] !== undefined
                  ? current.historyPageCounts
                  : { ...current.historyPageCounts, [companyId]: 1 },
              });
            }}
            className="min-w-0 max-w-full rounded-md border border-white/10 bg-[#111318] px-3 py-2 text-[13px] text-white/85 focus:border-emerald-300/40 focus:outline-none"
          >
            <option value="">Recent tape · up to 60 rows only</option>
            {sortedCompanies.map((company) => <option key={company.id} value={company.id}>{company.name} · {company.ticker}</option>)}
          </select>
        </label>
        {companyInventoryState === "loading" && <p className="text-[11px] text-white/45" role="status">Loading the company inventory…</p>}
        {companyInventoryState === "failed" && <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-100/75" role="alert"><span>The company inventory could not be loaded.</span><button type="button" onClick={onRetry} className="rounded border border-white/15 px-2 py-1 text-white/75">Retry company inventory</button></div>}
        {companyInventoryState === "ready" && companies.length > 0 && <p className="text-[11px] leading-relaxed text-white/45">The company picker covers all {companies.length} companies in this desk. Selecting one reads its full saved-history pages, including rows outside the recent tape.</p>}
        {companyInventoryState === "ready" && companies.length === 0 && <p className="text-[11px] text-white/45" role="status">No companies are present in the desk inventory.</p>}
      </div>

      {activeState === "loading" && <p className="px-3 py-5 text-[13px] text-white/55" role="status">{companyFilter == null ? "Loading recent saved source records…" : `Loading saved history for ${selectedCompany?.name ?? companyNameOf(companyFilter)}…`}</p>}
      {activeState === "failed" && companyFilter != null && (
        <div className="px-3 py-5 text-[13px] text-white/60" role="alert">
          <p>Could not load saved history for {selectedCompany?.name ?? companyNameOf(companyFilter)}. No new collection was started.</p>
          <button type="button" onClick={() => onRetryCompanyHistory?.(companyFilter)} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 hover:bg-white/[0.05]">Retry company history</button>
        </div>
      )}
      {activeState === "failed" && companyFilter == null && (
        <div className="px-3 py-5 text-[13px] text-white/60" role="alert">
          <p>Saved source records are unavailable right now. No new collection was started.</p>
          <button type="button" onClick={onRetry} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 hover:bg-white/[0.05]">Retry loading saved sources</button>
        </div>
      )}
      {activeState === "ready" && companyFilter != null && activeMentions.length === 0 && (
        <p className="px-3 py-6 text-[13px] leading-relaxed text-white/60" role="status">No saved source records are present in the retained history for {selectedCompany?.name ?? companyNameOf(companyFilter)}.</p>
      )}
      {activeState === "stale" && (
        <div className="mx-3 mt-3 rounded border border-amber-300/20 bg-amber-200/[0.04] px-3 py-2 text-[12px] leading-relaxed text-amber-100/85" role="status">
          <p>Could not refresh this saved view. Showing the last records already loaded; their individual source and retrieval times remain visible.</p>
          <button type="button" onClick={onRetry} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[10.5px] text-white/75 hover:bg-white/[0.05]">Retry loading saved sources</button>
        </div>
      )}
      {(activeState === "ready" || activeState === "stale") && companyFilter == null && activeMentions.length === 0 && (
        <p className="px-3 py-6 text-[13px] leading-relaxed text-white/60" role="status">No rows are available in the recent saved tape. This does not establish that company history is empty; choose a company above to check its retained records.</p>
      )}
      {(activeState === "ready" || activeState === "stale") && activeMentions.length > 0 && (
        <>
          <div className="flex flex-col gap-2 border-b border-desk-line px-3 py-3 sm:px-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="sr-only">Filter saved sources by company, ticker, publisher, or headline</span>
              <input
                type="search"
                value={query}
                onChange={(event) => updateBrowseState({ query: event.currentTarget.value, visibleCount: PAGE_SIZE })}
                maxLength={120}
                placeholder="Filter company, ticker, publisher, headline"
                className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2.5 text-[13px] text-white/85 placeholder:text-white/35 focus:border-emerald-300/40 focus:outline-none sm:max-w-sm"
              />
              {query && companyFilteredMentions.length > 0 && <button type="button" onClick={() => updateBrowseState({ query: "", visibleCount: PAGE_SIZE })} className="shrink-0 rounded border border-white/10 px-2 py-1.5 text-[10px] text-white/60 hover:bg-white/[0.05]">Clear</button>}
            </label>
              <span className="text-[11px] text-white/50" aria-live="polite">
              Showing {Math.min(visibleCount, companyFilteredMentions.length)} of {companyFilteredMentions.length} loaded matches
            </span>
            </div>
          </div>
          {companyFilteredMentions.length === 0 ? (
            <div className="px-3 py-6 text-[13px] leading-relaxed text-white/60" role="status">
              <p>No row matches these filters in the currently loaded saved set. This does not show whether evidence exists elsewhere.</p>
              {(query || companyFilter != null) && (
                <button
                  type="button"
                  onClick={() => updateBrowseState({ query: "", companyFilter: null, visibleCount: PAGE_SIZE })}
                  className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 hover:bg-white/[0.05]"
                >
                  Clear search and company filter
                </button>
              )}
            </div>
          ) : (
          <ol className="divide-y divide-white/[0.07]" aria-label={companyFilter == null ? "Recent saved source records, limited to the latest 60" : `Saved source history for ${selectedCompany?.name ?? companyNameOf(companyFilter)}`}>
          {visibleMentions.map((mention) => {
            const clock = sourceClockForMention(mention);
            const leadSubject = differentPossessiveHeadlineSubject(
              mention.title,
              mention.snippet,
              companyNameOf(mention.companyId),
              tickerOf(mention.companyId),
            );
            const titleLinkConflict = leadSubject != null
              && sourceLinkPathNamesCompany(mention.source.url, companyNameOf(mention.companyId));
            return (
              <li key={mention.id} className="min-w-0 px-3 py-4 sm:px-4">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-white/80">{tickerOf(mention.companyId)}</span>
                  {mention.issuerIdentityStrong !== true && (
                    <span className="text-[11px] text-amber-100/90" title="The saved record's company match needs review before treating it as issuer-specific evidence.">
                      {mention.issuerIdentityStrong === false ? "verify issuer match" : "issuer match unverified"}
                    </span>
                  )}
                  {otherExplicitTickerSymbols(`${mention.title} ${mention.snippet}`, tickerOf(mention.companyId), knownTickers).map((symbol) => (
                    <span key={symbol} className="text-[11px] text-amber-100/90" title={`This saved row is filed under ${tickerOf(mention.companyId)} and also names ${symbol}. Check which issuer the source is about before using it as issuer-specific evidence.`}>
                      also names {symbol} · verify issuer
                    </span>
                  ))}
                  {leadSubject && (
                    <span className="text-[11px] text-amber-100/90" title={titleLinkConflict
                      ? `The headline leads with ${leadSubject}, while the saved excerpt and URL path name ${companyNameOf(mention.companyId)}. Check that the headline and link belong together; the path does not verify page contents.`
                      : `The headline leads with ${leadSubject}, while the saved excerpt also mentions ${companyNameOf(mention.companyId)}. Check relevance before treating it as issuer-specific evidence.`}>
                      {titleLinkConflict
                        ? `headline leads with ${leadSubject}; excerpt and URL path name ${companyNameOf(mention.companyId)} · check title/link`
                        : `headline leads with ${leadSubject}; excerpt names ${companyNameOf(mention.companyId)} · verify ${tickerOf(mention.companyId)} relevance`}
                    </span>
                  )}
                  <span className="min-w-0 break-words text-[11.5px] text-white/55">{mention.publisherName || mention.source.publisher || mention.source.name}</span>
                </div>
                <h2 className="mt-2 break-words text-[15px] font-medium leading-snug text-white/90">{mention.title}</h2>
                {mention.snippet.trim().length > 0 && (
                  <p className="mt-1.5 line-clamp-2 break-words text-[12px] leading-relaxed text-white/65" title={mention.snippet}>
                    {mention.snippet}
                  </p>
                )}
                <p className="mt-1.5 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11.5px] leading-relaxed text-white/55">
                  <span>{clock.label}: {clock.at == null
                    ? "time unavailable"
                    : <time dateTime={new Date(clock.at).toISOString()} title={clock.context}>{sourceDateTime(clock.at)}</time>}</span>
                  <span>retrieved <time dateTime={new Date(mention.retrievedAt).toISOString()} title={`Retrieved ${new Date(mention.retrievedAt).toISOString()}`}>{sourceDateTime(mention.retrievedAt)} ({timeAgo(mention.retrievedAt)})</time></span>
                  <span>{judgmentLabel(mention)}</span>
                </p>
                <button type="button" data-saved-source-id={mention.id} aria-label={`Review source record: ${mention.title}`} onClick={() => onOpen(mention)} className="mt-3 rounded border border-white/15 px-3 py-2 text-[12px] text-white/80 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
                  Review source record
                </button>
              </li>
            );
          })}
          </ol>
          )}
          {visibleMentions.length < companyFilteredMentions.length && (
            <button
              type="button"
              onClick={() => updateBrowseState({ visibleCount: visibleCount + PAGE_SIZE })}
              className="m-3 self-center rounded-md border border-white/10 px-3 py-2.5 text-[12px] text-white/65 transition-colors hover:bg-white/[0.05] hover:text-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
            >
              Show next {Math.min(PAGE_SIZE, companyFilteredMentions.length - visibleMentions.length)} of {companyFilteredMentions.length} loaded rows
            </button>
          )}
          {companyFilter != null && selectedHistory?.nextCursor != null && (
            <div className="mx-3 my-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onLoadOlderHistory?.(companyFilter)}
                disabled={selectedHistory.loadingMore}
                className="rounded-md border border-white/10 px-3 py-2.5 text-[12px] text-white/65 hover:bg-white/[0.05] disabled:opacity-50"
              >
                {selectedHistory.loadingMore ? "Loading older saved history…" : selectedHistory.loadMoreFailed ? "Retry older saved history" : "Load older saved history"}
              </button>
              <span className="text-[11px] text-white/45">Search and counts cover the {activeMentions.length} loaded company-history row{activeMentions.length === 1 ? "" : "s"} so far.</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
