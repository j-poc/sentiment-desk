import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getSavedSourceSearch, type CompanySnapshot, type Mention, type MentionPage } from "../lib/api.js";
import { differentPossessiveHeadlineSubject, otherExplicitTickerSymbols, sourceLinkPathNamesCompany } from "../lib/issuer-symbols.js";
import { INITIAL_SAVED_SOURCES_BROWSE_STATE, type SavedSourcesBrowseState } from "../lib/saved-sources-browse-state.js";
import { sourceClockForMention } from "../lib/source-clock.js";
import { sourceDateTime, timeAgo } from "../lib/format.js";
import type { SavedSourceCoverageSnapshot } from "../../../shared/saved-source-coverage.js";
import { savedSourceTextMatches, type SavedSourceSearchCursor, type SavedSourceSearchPage } from "../../../shared/saved-source-search.js";
import { normalizeExactHeadline } from "../../../shared/score-bucket-coverage.js";
import type { MentionDrawerReturnTarget } from "../lib/research-navigation.js";

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
    mention.source.publisher, mention.source.name, mention.title, mention.snippet,
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
export type SavedSourcesMode = "coverage" | "search" | "tape";

type ArchiveSearchState = NonNullable<SavedSourcesBrowseState["archiveSearch"]>;

export interface SavedArchiveSearchGroup {
  companyId: string;
  title: string;
  mentions: Mention[];
}

/** Group repeated normalized headlines only within one result page and issuer assignment. */
export function groupSavedArchiveSearchPage(mentions: readonly Mention[]): SavedArchiveSearchGroup[] {
  const groups: SavedArchiveSearchGroup[] = [];
  for (const mention of mentions) {
    const normalizedTitle = normalizeExactHeadline(mention.title);
    const previous = groups.at(-1);
    const previousTitle = previous ? normalizeExactHeadline(previous.title) : "";
    if (normalizedTitle && previous?.companyId === mention.companyId && previousTitle === normalizedTitle) {
      previous.mentions.push(mention);
    } else {
      groups.push({ companyId: mention.companyId, title: mention.title, mentions: [mention] });
    }
  }
  return groups;
}

export function newestSavedArchiveRetrievalAt(mentions: readonly Mention[]): number | null {
  let newest: number | null = null;
  for (const mention of mentions) {
    if (newest == null || mention.retrievedAt > newest) newest = mention.retrievedAt;
  }
  return newest;
}

export function savedArchiveSearchMatchLocation(mention: Mention, query: string): "headline" | "excerpt" | "headline and excerpt" | "location unavailable" {
  const inHeadline = savedSourceTextMatches(mention.title, query);
  const inExcerpt = savedSourceTextMatches(mention.snippet, query);
  if (inHeadline && inExcerpt) return "headline and excerpt";
  if (!inHeadline && !inExcerpt) return "location unavailable";
  return inHeadline ? "headline" : "excerpt";
}

export function savedArchiveSearchMatchSummary(mentions: readonly Mention[], query: string): string {
  const locations = new Set(mentions.map((mention) => savedArchiveSearchMatchLocation(mention, query)));
  if (locations.size === 1) return `Match location: ${locations.values().next().value}`;
  if (locations.size > 1 && !locations.has("location unavailable")) return "Match location varies by source record; expand to inspect";
  return "Match location unavailable; expand to inspect each record";
}

function SavedArchiveSearch({
  companies,
  state,
  onStateChange,
  onOpen,
  returnTarget,
  onRestoreReturnTarget,
  tickerOf,
}: {
  companies: readonly CompanySnapshot[];
  state: ArchiveSearchState;
  onStateChange: (state: ArchiveSearchState) => void;
  onOpen: (mention: Mention) => void;
  returnTarget: MentionDrawerReturnTarget | null;
  onRestoreReturnTarget: (target: MentionDrawerReturnTarget | null) => void;
  tickerOf: (companyId: string) => string;
}) {
  const [page, setPage] = useState<SavedSourceSearchPage<Mention> | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [loadError, setLoadError] = useState<"read-failed" | "snapshot-changed" | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const requestVersion = useRef(0);
  const query = state.query.trim();
  const resultGroups = useMemo(() => page ? groupSavedArchiveSearchPage(page.items) : [], [page]);
  const repeatedHeadlineGroupCount = resultGroups.filter((group) => group.mentions.length > 1).length;

  useEffect(() => {
    const requestId = ++requestVersion.current;
    if (query.length < 2) {
      setPage(null);
      setLoadState("idle");
      return;
    }
    const controller = new AbortController();
    setLoadState("loading");
    setLoadError(null);
    const timer = window.setTimeout(() => {
      void getSavedSourceSearch({
        query,
        companyId: state.companyId,
        publisher: state.publisher,
        includeDismissed: state.includeDismissed,
        snapshotAt: state.snapshotAt,
        reviewRevision: state.reviewRevision,
        cursor: state.cursor,
        signal: controller.signal,
      }).then((result) => {
        if (requestId !== requestVersion.current) return;
        setPage(result);
        setLoadState("ready");
      }).catch((error: unknown) => {
        if (requestId !== requestVersion.current || controller.signal.aborted) return;
        setLoadError(error instanceof ApiRequestError && error.status === 409
          && error.code === "saved_source_search_snapshot_changed" ? "snapshot-changed" : "read-failed");
        setLoadState("failed");
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, state.companyId, state.publisher, state.includeDismissed, state.snapshotAt, state.reviewRevision, state.cursor, retryVersion]);

  useEffect(() => {
    if (!returnTarget) return;
    if (query.length < 2 || loadState === "failed") {
      onRestoreReturnTarget(null);
      return;
    }
    if (loadState !== "ready" || !page) return;
    onRestoreReturnTarget(page.items.some((item) => item.id === returnTarget.mentionId) ? returnTarget : null);
  }, [returnTarget, query, loadState, page, onRestoreReturnTarget]);

  const changeSearch = (patch: Partial<ArchiveSearchState>) => {
    onStateChange({
      ...state,
      ...patch,
      snapshotAt: null,
      reviewRevision: null,
      cursor: null,
      previousCursors: [],
    });
  };
  const nextPage = () => {
    if (!page?.nextCursor || !page.snapshotAt) return;
    onStateChange({
      ...state,
      snapshotAt: page.snapshotAt,
      reviewRevision: page.reviewRevision,
      previousCursors: [...state.previousCursors, state.cursor].slice(-100),
      cursor: page.nextCursor,
    });
  };
  const previousPage = () => {
    if (state.previousCursors.length === 0) return;
    const previousCursors = [...state.previousCursors];
    const cursor = previousCursors.pop() ?? null;
    onStateChange({ ...state, cursor, previousCursors });
  };
  const restartSearch = () => onStateChange({ ...state, snapshotAt: null, reviewRevision: null, cursor: null, previousCursors: [] });

  return (
    <section className="border-b border-desk-line" aria-labelledby="saved-archive-search-heading">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <div>
          <h2 id="saved-archive-search-heading" className="text-sm font-semibold text-white/85">Search retained source records</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-white/55">Search titles and excerpts in this Desk’s saved real-source archive. Two-letter terms such as AI or EV match whole words; longer terms match within text. Results are leads, not verified issuer relevance, independent events, or current activity.</p>
        </div>
        <div role="search" aria-label="Search saved source archive" className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[minmax(15rem,2fr)_minmax(12rem,1fr)_minmax(12rem,1fr)_auto]">
          <label className="min-w-0 text-[11px] text-white/55">
            Search title and excerpt
            <input type="search" maxLength={120} value={state.query} placeholder="Try Hong Kong, shortage, or complaint" onChange={(event) => changeSearch({ query: event.currentTarget.value })}
              className="mt-1 min-h-11 w-full rounded-md border border-white/15 bg-black/25 px-3 text-[13px] text-white/90 placeholder:text-white/35 focus:border-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-300/20" />
          </label>
          <label className="min-w-0 text-[11px] text-white/55">
            Company
            <select value={state.companyId ?? ""} onChange={(event) => changeSearch({ companyId: event.currentTarget.value || null })}
              className="mt-1 min-h-11 w-full rounded-md border border-white/15 bg-[#101315] px-3 text-[13px] text-white/85 focus:border-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-300/20">
              <option value="">All tracked companies</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name} · {company.ticker}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-[11px] text-white/55">
            Publisher contains
            <input type="search" maxLength={120} value={state.publisher} placeholder="Publisher or site" onChange={(event) => changeSearch({ publisher: event.currentTarget.value })}
              className="mt-1 min-h-11 w-full rounded-md border border-white/15 bg-black/25 px-3 text-[13px] text-white/90 placeholder:text-white/35 focus:border-emerald-300/50 focus:outline-none focus:ring-2 focus:ring-emerald-300/20" />
          </label>
          <label className="flex min-h-11 items-center gap-2 self-end rounded-md border border-white/10 px-3 py-2 text-[12px] text-white/60">
            <input type="checkbox" checked={state.includeDismissed} onChange={(event) => changeSearch({ includeDismissed: event.currentTarget.checked })} className="size-4 accent-emerald-300" />
            Include dismissed
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-white/45">Grouped by the company assignment stored in the Desk; search does not decide whether that company is the article’s main subject. Dismissed rows are hidden unless included. This local search sends no provider or classifier requests.</p>
      </div>

      {query.length < 2 && <p className="px-3 pb-4 text-[13px] text-white/55" role="status">Enter at least two characters to search the retained archive.</p>}
      {query.length >= 2 && loadState === "loading" && <p className="px-3 pb-4 text-[13px] text-white/55" role="status" aria-live="polite">Searching saved titles and excerpts…</p>}
      {query.length >= 2 && loadState === "failed" && (
        <div className="flex flex-col gap-2 px-3 pb-4 text-[13px] text-amber-100/80" role="alert">
          <p>{loadError === "snapshot-changed"
            ? "Saved review statuses changed while you were paging. Restart from the first page to read a consistent result set."
            : "Saved archive search could not be read. No collection or classification was started."}</p>
          <div className="flex flex-wrap gap-2">
            {loadError !== "snapshot-changed" && <button type="button" onClick={() => setRetryVersion((version) => version + 1)} className="min-h-10 rounded border border-white/15 px-3 py-2 text-[12px] hover:bg-white/[0.05]">Retry search</button>}
            {(state.cursor != null || state.snapshotAt != null) && <button type="button" onClick={restartSearch} className="min-h-10 rounded border border-white/15 px-3 py-2 text-[12px] hover:bg-white/[0.05]">Restart from first page</button>}
          </div>
        </div>
      )}
      {query.length >= 2 && loadState === "ready" && page && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-white/[0.07] px-3 py-2.5 sm:px-4">
            <p className="text-[12px] text-white/65" role="status" aria-live="polite">
              <strong className="text-white/90">{page.totalCount.toLocaleString()}</strong> saved record{page.totalCount === 1 ? "" : "s"} match “{page.query}”{page.companyId ? ` · ${companies.find((company) => company.id === page.companyId)?.ticker ?? "selected company"}` : " · all tracked companies"}{page.publisher ? ` · publisher ${page.publisher}` : ""} · search snapshot taken {sourceDateTime(page.snapshotAt)}.
              {repeatedHeadlineGroupCount > 0 && <span className="ml-1">{repeatedHeadlineGroupCount} repeated headline group{repeatedHeadlineGroupCount === 1 ? "" : "s"} on this page; counts remain saved records.</span>}
            </p>
            <span className="text-[11px] text-white/45">Known source times newest first · unknown times last · page {state.previousCursors.length + 1}</span>
          </div>
          {page.items.length === 0 ? (
            <p className="px-3 py-6 text-[13px] leading-relaxed text-white/60" role="status">No saved records match these terms and filters at this archive cutoff. That does not establish that no current company activity exists.</p>
          ) : (
            <ol className="divide-y divide-white/[0.07]" aria-label={`Saved source records matching ${page.query}`}>
              {resultGroups.map((group) => {
                const [firstMention] = group.mentions;
                const groupCompany = companies.find((entry) => entry.id === group.companyId);
                const groupTicker = groupCompany?.ticker ?? tickerOf(group.companyId);
                const groupCompanyName = groupCompany?.name ?? group.companyId;
                const renderRecord = (mention: Mention) => {
                  const company = companies.find((entry) => entry.id === mention.companyId);
                  const ticker = company?.ticker ?? tickerOf(mention.companyId);
                  const name = company?.name ?? mention.companyId;
                  const clock = sourceClockForMention(mention);
                  const otherTickers = otherExplicitTickerSymbols(`${mention.title} ${mention.snippet}`, ticker, companies.map((entry) => entry.ticker));
                  const leadSubject = differentPossessiveHeadlineSubject(mention.title, mention.snippet, name, ticker);
                  const matchLocation = savedArchiveSearchMatchLocation(mention, page.query);
                  return (
                    <article key={mention.id} className="min-w-0 px-3 py-3">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/55">
                        <span className="font-semibold text-white/75">{name} · {ticker} assignment</span>
                        <span>{mention.publisherName || mention.source.publisher || mention.source.name}</span>
                        <span>{judgmentLabel(mention)}</span>
                        <span className="text-emerald-100/75">Match location: {matchLocation}</span>
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-amber-100/75">
                        {mention.issuerIdentityStrong === false && <span>ambiguous issuer · check identity</span>}
                        {otherTickers.map((symbol) => <span key={symbol}>also names {symbol} · check relevance</span>)}
                        {leadSubject && <span>headline leads with {leadSubject} · check {ticker} relevance</span>}
                      </p>
                      <h3 className="mt-1 break-words text-[13px] font-medium leading-snug text-white/90">{mention.title}</h3>
                      {mention.snippet.trim().length > 0 && <p className="mt-1 break-words text-[12px] leading-relaxed text-white/65">{mention.snippet}</p>}
                      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-relaxed text-white/50">
                        <span>{clock.label}: {clock.at == null ? "time unavailable" : <time dateTime={new Date(clock.at).toISOString()} title={clock.context}>{sourceDateTime(clock.at)}</time>}</span>
                        <span>retrieved <time dateTime={new Date(mention.retrievedAt).toISOString()} title="Desk retrieval time">{savedTime(mention.retrievedAt)}</time></span>
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" data-saved-source-id={mention.id} aria-label={`Review source record: ${mention.title}`} onClick={() => onOpen(mention)} className="min-h-11 rounded border border-white/15 px-3 py-2 text-[12px] text-white/80 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Review source record</button>
                        <a href={mention.source.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded border border-white/10 px-3 py-2 text-[12px] text-white/60 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open saved source</a>
                      </div>
                    </article>
                  );
                };
                return (
                  <li key={group.mentions.map((mention) => mention.id).join("|")} className="min-w-0 px-3 py-3 sm:px-4">
                    {group.mentions.length > 1 ? (
                      <details className="rounded-md border border-white/10 bg-white/[0.02]">
                        <summary className="cursor-pointer px-3 py-3 text-[12px] text-white/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
                          <span className="font-semibold">{groupCompanyName} · {groupTicker} assignment</span>
                          <span className="ml-2 font-medium">{group.title}</span>
                          <span className="ml-2 text-emerald-100/75">{savedArchiveSearchMatchSummary(group.mentions, page.query)}.</span>
                          <span className="ml-2 text-white/55">Newest retrieval in this group {savedTime(newestSavedArchiveRetrievalAt(group.mentions))}.</span>
                          <span className="ml-2 text-white/55">Show {group.mentions.length} adjacent records with the same headline. Expand to inspect each source. Similarity does not establish separate reporting.</span>
                        </summary>
                        <div className="divide-y divide-white/[0.07] border-t border-white/10">{group.mentions.map(renderRecord)}</div>
                      </details>
                    ) : firstMention ? renderRecord(firstMention) : null}
                  </li>
                );
              })}
            </ol>
          )}
          <nav aria-label="Saved archive search pages" className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-4">
            <button type="button" disabled={state.previousCursors.length === 0} onClick={previousPage} className="min-h-11 rounded border border-white/15 px-3 py-2 text-[12px] text-white/75 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40">Previous page</button>
            <button type="button" disabled={page.nextCursor == null} onClick={nextPage} className="min-h-11 rounded border border-white/15 px-3 py-2 text-[12px] text-white/75 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40">Next page</button>
          </nav>
        </>
      )}
    </section>
  );
}

function savedTime(value: number | null): string {
  return value == null ? "time unavailable" : `${sourceDateTime(value)} (${timeAgo(value)})`;
}

function SavedSourceCoverageScan({
  snapshot,
  state,
  onOpen,
  onRetry,
  onOpenCompanyHistory,
}: {
  snapshot: SavedSourceCoverageSnapshot<Mention> | null;
  state: "loading" | "ready" | "failed";
  onOpen: (mention: Mention) => void;
  onRetry: () => void;
  onOpenCompanyHistory: (companyId: string) => void;
}) {
  if (state === "loading") return <p className="px-3 py-6 text-[13px] text-white/60" role="status">Loading saved archive by company…</p>;
  if (state === "failed" || snapshot == null) return (
    <div className="px-3 py-6 text-[13px] text-white/60" role="status">
      <p>Saved archive by company could not be read. No source collection was started.</p>
      <button type="button" onClick={onRetry} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 hover:bg-white/[0.05]">Retry saved archive</button>
    </div>
  );

  const represented = snapshot.companies.filter((company) => company.identityGatePassCount > 0);
  const withReview = snapshot.companies.filter((company) => company.identityReviewCount > 0);
  const latestRetrievedAt = snapshot.companies.reduce<number | null>((latest, company) =>
    company.latestRetrievedAt == null ? latest : Math.max(latest ?? company.latestRetrievedAt, company.latestRetrievedAt), null);
  const notRepresented = snapshot.companies.filter((company) => company.identityGatePassCount === 0);

  return (
    <div className="border-b border-desk-line">
      <div className="flex flex-col gap-2 px-3 py-3 sm:px-4">
        <p className="text-[12px] leading-relaxed text-white/65">
          Coverage snapshot taken <time dateTime={new Date(snapshot.asOfMs).toISOString()}>{sourceDateTime(snapshot.asOfMs)}</time>. Rows are assigned to a company feed by the Desk; that assignment does not establish that the company is the article’s main subject. This is not live market coverage or an opportunity ranking.
        </p>
        <p className="text-[12px] leading-relaxed text-white/70">
          <strong className="text-white/90">{snapshot.companiesWithIdentityGatePasses} of {snapshot.trackedCompanyCount}</strong> tracked companies have records assigned to their Desk feed · {snapshot.identityGatePassCount.toLocaleString()} rows pass the Desk’s limited ambiguous-name check · newest retrieval {savedTime(latestRetrievedAt)}.
          {snapshot.identityReviewCount > 0 && <> {snapshot.identityReviewCount.toLocaleString()} additional rows remain outside this overview because the Desk could not disambiguate the issuer.</>}
        </p>
        {snapshot.identityGatePassCount === 0 && (
          <p className="text-[12px] text-amber-100/80" role="status">No saved sources passed the Desk’s limited ambiguous-name check. That does not show that there was no company activity; collection may be paused or the archive may have gaps.</p>
        )}
      </div>

      {represented.length > 0 && <ol className="space-y-2 px-3 pb-3 sm:px-4" aria-label="Companies with saved source records">
        {represented.map((company) => (
          <li key={company.companyId}>
            <details className="rounded-md border border-white/10 bg-white/[0.02]">
              <summary className="cursor-pointer list-none px-3 py-3 text-[12px] text-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
                <span className="font-semibold">{company.name} · {company.ticker}</span>
                <span className="ml-2 text-white/55">{company.identityGatePassCount.toLocaleString()} retained · latest retrieval {savedTime(company.latestRetrievedAt)}</span>
                {company.identityReviewCount > 0 && <span className="ml-2 text-amber-100/75">{company.identityReviewCount} ambiguous rows held out</span>}
              </summary>
              <div className="divide-y divide-white/[0.07] border-t border-white/10">
                {company.items.map((mention) => {
                  const clock = sourceClockForMention(mention);
                  const leadSubject = differentPossessiveHeadlineSubject(
                    mention.title, mention.snippet, company.name, company.ticker,
                  );
                  const titleLinkConflict = leadSubject != null
                    && sourceLinkPathNamesCompany(mention.source.url, company.name);
                  const otherTickers = otherExplicitTickerSymbols(
                    `${mention.title} ${mention.snippet}`, company.ticker,
                    snapshot.companies.map((entry) => entry.ticker),
                  );
                  return (
                    <article key={mention.id} className="min-w-0 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                        <span className="text-white/55">{mention.publisherName || mention.source.publisher || mention.source.name}</span>
                        {mention.issuerIdentityStrong !== true && <span className="text-amber-100/90">verify issuer match</span>}
                        {otherTickers.map((symbol) => <span key={symbol} className="text-amber-100/90">also names {symbol} · verify issuer</span>)}
                        {leadSubject && <span className="text-amber-100/90">{titleLinkConflict
                          ? `headline leads with ${leadSubject}; check title/link alignment`
                          : `headline leads with ${leadSubject}; verify ${company.ticker} relevance`}</span>}
                      </div>
                      <h3 className="mt-1 break-words text-[13px] font-medium leading-snug text-white/90">{mention.title}</h3>
                      {mention.snippet.trim().length > 0 && <p className="mt-1 line-clamp-2 break-words text-[11.5px] leading-relaxed text-white/65">{mention.snippet}</p>}
                      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-relaxed text-white/55">
                        <span>{clock.label}: {clock.at == null ? "time unavailable" : <time dateTime={new Date(clock.at).toISOString()} title={clock.context}>{sourceDateTime(clock.at)}</time>}</span>
                        <span>retrieved <time dateTime={new Date(mention.retrievedAt).toISOString()}>{savedTime(mention.retrievedAt)}</time></span>
                        <span>{judgmentLabel(mention)}</span>
                      </p>
                      <button type="button" data-saved-source-id={mention.id} aria-label={`Review source record: ${mention.title}`} onClick={() => onOpen(mention)} className="mt-2 rounded border border-white/15 px-3 py-2 text-[12px] text-white/80 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Review source record</button>
                    </article>
                  );
                })}
                <div className="px-3 py-2">
                  <button type="button" onClick={() => onOpenCompanyHistory(company.companyId)} className="rounded border border-white/15 px-3 py-2 text-[12px] text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open full {company.ticker} history</button>
                </div>
              </div>
            </details>
          </li>
        ))}
      </ol>}

      {notRepresented.length > 0 && <details className="mx-3 mb-3 rounded-md border border-white/10 sm:mx-4">
        <summary className="cursor-pointer px-3 py-2.5 text-[11.5px] text-white/55">{notRepresented.length} tracked companies have no rows passing the ambiguity check</summary>
        <p className="px-3 pb-2 text-[11px] text-white/45">This local archive does not establish that these companies have no current activity.</p>
        <ul className="grid grid-cols-1 gap-1 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Tracked companies without rows passing the ambiguity check">
        {notRepresented.map((company) => <li key={company.companyId} className="text-[11px] text-white/55">{company.name} · {company.ticker}{company.identityReviewCount > 0 ? ` · ${company.identityReviewCount} held for identity review` : ""}</li>)}
        </ul>
      </details>}

      {represented.length === 0 && withReview.length > 0 && <p className="px-3 pb-4 text-[11.5px] text-amber-100/75">Possible matches remain available in each company's full saved history for manual issuer review.</p>}
    </div>
  );
}

/** Clear a stale saved-source filter before the Recent Filings recovery route opens. */
export function recoverToSavedSources(
  saveBrowseState: (state: SavedSourcesBrowseState) => void,
  setMode: (mode: SavedSourcesMode) => void,
  navigateToSavedSources: () => void,
): void {
  saveBrowseState({ ...INITIAL_SAVED_SOURCES_BROWSE_STATE });
  setMode("search");
  navigateToSavedSources();
}

/** A bounded browse surface over real records already retained by this desk. */
export function SavedSourcesView({
  mentions,
  companies = [],
  coverageSnapshot = null,
  coverageState = "loading",
  mode = "coverage",
  onModeChange = () => {},
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
  onRetryCoverage = () => {},
  browseState,
  onBrowseStateChange,
  drawerReturnTarget = null,
  onRestoreDrawerReturnTarget = () => {},
}: {
  mentions: readonly Mention[];
  companies?: readonly CompanySnapshot[];
  coverageSnapshot?: SavedSourceCoverageSnapshot<Mention> | null;
  coverageState?: "loading" | "ready" | "failed";
  mode?: SavedSourcesMode;
  onModeChange?: (mode: SavedSourcesMode) => void;
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
  onRetryCoverage?: () => void;
  browseState?: SavedSourcesBrowseState;
  onBrowseStateChange?: (state: SavedSourcesBrowseState) => void;
  drawerReturnTarget?: MentionDrawerReturnTarget | null;
  onRestoreDrawerReturnTarget?: (target: MentionDrawerReturnTarget | null) => void;
}) {
  const [localBrowseState, setLocalBrowseState] = useState(INITIAL_SAVED_SOURCES_BROWSE_STATE);
  const currentBrowseState = browseState ?? localBrowseState;
  const { query, visibleCount, companyFilter } = currentBrowseState;
  const updateBrowseState = (patch: Partial<SavedSourcesBrowseState>) => {
    const next = { ...currentBrowseState, ...patch };
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
  const openCompanyHistory = (companyId: string) => {
    const current = currentBrowseState;
    updateBrowseState({
      companyFilter: companyId,
      visibleCount: PAGE_SIZE,
      historyPageCounts: current.historyPageCounts[companyId] !== undefined
        ? current.historyPageCounts
        : { ...current.historyPageCounts, [companyId]: 1 },
    });
    onModeChange("tape");
  };

  useEffect(() => {
    if (drawerReturnTarget && mode !== "search") onRestoreDrawerReturnTarget(null);
  }, [drawerReturnTarget, mode, onRestoreDrawerReturnTarget]);

  return (
    <section className="panel min-w-0" aria-labelledby="saved-sources-heading">
      <header className="panel-head flex-wrap gap-y-1">
        <div className="min-w-0">
          <h1 id="saved-sources-heading" tabIndex={-1} className="micro m-0 p-0 text-[12px]">{mode === "coverage" ? "SAVED ARCHIVE BY COMPANY" : mode === "search" ? "SEARCH SAVED ARCHIVE" : "RECENT SAVED SOURCES"}</h1>
          <p className="mt-1 text-[12px] normal-case tracking-normal leading-relaxed text-white/50">
            {mode === "coverage"
              ? "Scan retained sources by Desk-assigned company. Assignment does not verify article relevance; this archive is not live market coverage."
              : mode === "search"
                ? "Find saved source records by headline or excerpt across the Desk’s retained archive."
                : "Choose any desk company to read its retained source history. Reads use saved records only and do not start collection. The recent tape below is limited to 60 rows and is not full company coverage."}
          </p>
        </div>
        {mode === "tape" && (activeState === "ready" || activeState === "stale") && activeMentions.length > 0 && (
          <span className="tabnum text-[11.5px] text-white/55">{companyFilter == null ? `Recent tape · ${activeMentions.length} loaded · limited to latest 60` : `${selectedCompany?.name ?? companyNameOf(companyFilter)} · ${activeMentions.length} saved history rows loaded`}{` · ${issuerReviewCount} row${issuerReviewCount === 1 ? "" : "s"} need issuer check`}</span>
        )}
      </header>

      <div className="flex flex-wrap gap-2 border-b border-desk-line px-3 py-2.5 sm:px-4" role="group" aria-label="Saved source view">
        <button type="button" aria-pressed={mode === "coverage"} onClick={() => onModeChange("coverage")} className={`rounded-md border px-3 py-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${mode === "coverage" ? "border-emerald-300/40 bg-emerald-300/10 text-white" : "border-white/10 text-white/60 hover:bg-white/[0.04]"}`}>By company</button>
        <button type="button" aria-pressed={mode === "search"} onClick={() => onModeChange("search")} className={`rounded-md border px-3 py-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${mode === "search" ? "border-emerald-300/40 bg-emerald-300/10 text-white" : "border-white/10 text-white/60 hover:bg-white/[0.04]"}`}>Search archive</button>
        <button type="button" aria-pressed={mode === "tape"} onClick={() => onModeChange("tape")} className={`rounded-md border px-3 py-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${mode === "tape" ? "border-emerald-300/40 bg-emerald-300/10 text-white" : "border-white/10 text-white/60 hover:bg-white/[0.04]"}`}>Recent tape and full history</button>
      </div>

      {mode === "coverage" ? (
        <SavedSourceCoverageScan
          snapshot={coverageSnapshot}
          state={coverageState}
          onOpen={onOpen}
          onRetry={onRetryCoverage}
          onOpenCompanyHistory={openCompanyHistory}
        />
      ) : mode === "search" ? (
        <SavedArchiveSearch
          companies={companies}
          state={currentBrowseState.archiveSearch ?? INITIAL_SAVED_SOURCES_BROWSE_STATE.archiveSearch!}
          onStateChange={(archiveSearch) => updateBrowseState({ archiveSearch })}
          onOpen={onOpen}
          returnTarget={drawerReturnTarget}
          onRestoreReturnTarget={onRestoreDrawerReturnTarget}
          tickerOf={tickerOf}
        />
      ) : <>

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
      </>}
    </section>
  );
}
