import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CompanySnapshot, Mention } from "../web/src/lib/api.js";
import { filterSavedSources, groupSavedArchiveSearchPage, newestSavedArchiveRetrievalAt, recoverToSavedSources, savedArchiveSearchMatchLocation, savedArchiveSearchMatchSummary, SavedSourcesView } from "../web/src/components/SavedSourcesView.js";
import type { SavedCompanyHistoryState, SavedSourcesBrowseState } from "../web/src/components/SavedSourcesView.js";
import { differentPossessiveHeadlineSubject, otherExplicitTickerSymbols, sourceLinkPathNamesCompany } from "../web/src/lib/issuer-symbols.js";
import { INITIAL_SAVED_SOURCES_BROWSE_STATE, mergeSavedHistoryStreamEvent, readSavedSourcesBrowseState, SAVED_SOURCES_BROWSE_STORAGE_KEY, shouldRestoreSavedHistoryPage, writeSavedSourcesBrowseState } from "../web/src/lib/saved-sources-browse-state.js";
import type { SavedSourceCoverageSnapshot } from "../shared/saved-source-coverage.js";

const now = Date.UTC(2026, 9, 6, 12);

function company(id: string, name: string, ticker: string): CompanySnapshot {
  return { id, name, ticker, sector: "Test", color: "#fff", index: null, indexWindow: null, indexRecordCount: 0, delta: null, sourceRecords24h: 0, latestSourceCollectedAt: null, earningsAt: null, lastSurprise: null };
}

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: "source-1", companyId: "apple", source: { name: "Publisher feed", url: "https://example.com/story", kind: "rss", tier: "major", collector: "google_news_rss", publisher: "example.com", publisherDomain: "example.com" },
    title: "A real retained source headline", snippet: "Saved source excerpt", publishedAt: now - 86_400_000,
    issuerIdentityStrong: true, providerObservedAt: null, retrievedAt: now - 80_000_000, ingestedAt: now - 80_000_000,
    timeBasis: "publisher_declared", collector: "google_news_rss", publisherName: "Example Publisher", publisherDomain: "example.com",
    status: "pending", scoreRetryAt: null, usageCheckRequired: false, score: null, classification: null, error: null,
    ...overrides,
  };
}

const props = {
  companies: [company("apple", "Apple", "AAPL"), company("adobe", "Adobe", "ADBE"), company("walmart", "Walmart", "WMT"), company("lilly", "Eli Lilly", "LLY")],
  tickerOf: (companyId: string) => companyId === "apple" ? "AAPL" : companyId === "adobe" ? "ADBE" : companyId === "walmart" ? "WMT" : "UNKNOWN",
  companyNameOf: (companyId: string) => companyId === "apple" ? "Apple" : companyId === "adobe" ? "Adobe" : companyId === "walmart" ? "Walmart" : companyId === "lilly" ? "Eli Lilly" : companyId,
  mode: "tape" as const,
  onOpen: vi.fn(), onRetry: vi.fn(),
};

const coverageSnapshot: SavedSourceCoverageSnapshot<Mention> = {
  asOfMs: now,
  trackedCompanyCount: 4,
  companiesWithIdentityGatePasses: 2,
  identityGatePassCount: 3,
  identityReviewCount: 1,
  itemsPerCompany: 2,
  companies: [
    { companyId: "adobe", name: "Adobe", ticker: "ADBE", identityGatePassCount: 1, identityReviewCount: 0,
      latestRetrievedAt: now - 30_000, latestPublisherAt: now - 60_000, latestProviderObservedAt: null,
      items: [mention({ id: "adobe-coverage", companyId: "adobe", title: "Adobe expands a real product line" })] },
    { companyId: "apple", name: "Apple", ticker: "AAPL", identityGatePassCount: 2, identityReviewCount: 1,
      latestRetrievedAt: now - 80_000, latestPublisherAt: now - 90_000, latestProviderObservedAt: null,
      items: [mention({ id: "apple-coverage", title: "Apple expands its services business" }), mention({ id: "apple-coverage-old", title: "Apple reports a real product update", retrievedAt: now - 120_000 })] },
    { companyId: "walmart", name: "Walmart", ticker: "WMT", identityGatePassCount: 0, identityReviewCount: 0,
      latestRetrievedAt: null, latestPublisherAt: null, latestProviderObservedAt: null, items: [] },
    { companyId: "lilly", name: "Eli Lilly", ticker: "LLY", identityGatePassCount: 0, identityReviewCount: 0,
      latestRetrievedAt: null, latestPublisherAt: null, latestProviderObservedAt: null, items: [] },
  ],
};

describe("saved sources browse surface", () => {
  it("groups only same-company repeated headlines within the current archive page", () => {
    const amd = mention({ id: "amd-yahoo", companyId: "amd", title: "AMD expands its AI business", collector: "yahoo_finance_rss" });
    const amdGoogle = mention({ id: "amd-google", companyId: "amd", title: " amd   expands its AI business ", collector: "google_news_rss" });
    const intel = mention({ id: "intel-google", companyId: "intel", title: "AMD expands its AI business", collector: "google_news_rss" });
    const separate = mention({ id: "amd-other", companyId: "amd", title: "AMD product update" });

    expect(groupSavedArchiveSearchPage([amd, intel, amdGoogle, separate])).toEqual([
      { companyId: "amd", title: amd.title, mentions: [amd] },
      { companyId: "intel", title: intel.title, mentions: [intel] },
      { companyId: "amd", title: amdGoogle.title, mentions: [amdGoogle] },
      { companyId: "amd", title: separate.title, mentions: [separate] },
    ]);
    expect(groupSavedArchiveSearchPage([amd, amdGoogle, intel, separate])).toEqual([
      { companyId: "amd", title: amd.title, mentions: [amd, amdGoogle] },
      { companyId: "intel", title: intel.title, mentions: [intel] },
      { companyId: "amd", title: separate.title, mentions: [separate] },
    ]);
  });

  it("reports the newest retrieval time from the visible archive records, not their search snapshot", () => {
    const older = mention({ id: "older-result", retrievedAt: now - 7 * 86_400_000 });
    const newer = mention({ id: "newer-result", retrievedAt: now - 2 * 86_400_000 });
    expect(newestSavedArchiveRetrievalAt([older, newer])).toBe(now - 2 * 86_400_000);
    expect(newestSavedArchiveRetrievalAt([])).toBeNull();
  });

  it("shows whether an archive query matched the headline, excerpt, or both using search semantics", () => {
    expect(savedArchiveSearchMatchLocation(mention({ title: "AMD CPU Business", snippet: "A saved quarterly update." }), "CPU Business"))
      .toBe("headline");
    expect(savedArchiveSearchMatchLocation(mention({ title: "Demand outlook", snippet: "CPU Business plans shift." }), "CPU Business"))
      .toBe("excerpt");
    expect(savedArchiveSearchMatchLocation(mention({ title: "AI adoption", snippet: "Investors discuss AI." }), "AI"))
      .toBe("headline and excerpt");
    expect(savedArchiveSearchMatchLocation(mention({ title: "Taiwan chip exports", snippet: "Daily shipment note." }), "AI"))
      .toBe("location unavailable");
    expect(savedArchiveSearchMatchSummary([
      mention({ id: "amd-one", title: "AMD CPU Business", snippet: "Saved quarterly update." }),
      mention({ id: "amd-two", title: "AMD CPU Business", snippet: "Another saved report." }),
    ], "CPU Business")).toBe("Match location: headline");
    expect(savedArchiveSearchMatchSummary([
      mention({ id: "amd-one", title: "AMD CPU Business", snippet: "Saved quarterly update." }),
      mention({ id: "amd-two", title: "AMD CPU Business", snippet: "Investors discuss CPU Business plans." }),
    ], "CPU Business")).toBe("Match location varies by source record; expand to inspect");
  });

  it("finds saved excerpt-only demand signals in the existing company history filter", () => {
    const saved = mention({
      title: "Jefferies sees softer iPhone demand in resale prices",
      snippet: "Resale pricing in Hong Kong is below levels recorded for comparable models last year.",
    });
    expect(filterSavedSources([saved], "Hong Kong", props.tickerOf, props.companyNameOf)).toEqual([saved]);
    expect(filterSavedSources([saved], "resale", props.tickerOf, props.companyNameOf)).toEqual([saved]);
  });

  it("defaults to a balanced, archive-labeled company coverage scan with exact saved-source actions", () => {
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, mode: "coverage", coverageSnapshot, coverageState: "ready",
      state: "ready", mentions: [],
    }));
    expect(html).toContain("SAVED ARCHIVE BY COMPANY");
    expect(html).toContain("By company");
    expect(html).toContain("Recent tape and full history");
    expect(html).toContain("Coverage snapshot taken");
    expect(html).toContain("2 of 4");
    expect(html).toContain("3 rows pass the Desk’s limited ambiguous-name check");
    expect(html).toContain("newest retrieval");
    expect(html).toContain("This is not live market coverage or an opportunity ranking.");
    expect(html).toContain("Adobe · ADBE");
    expect(html).toContain("Apple · AAPL");
    expect(html).toContain("Apple expands its services business");
    expect(html).toContain("Review source record: Apple expands its services business");
    expect(html).toContain("Open full AAPL history");
    expect(html).toContain("2 tracked companies have no rows passing the ambiguity check");
    expect(html).toContain("does not establish that the company is the article’s main subject");
    expect(html).not.toContain("issuer-matched saved records");
    expect(html).not.toContain("No demo source");
  });

  it("keeps coverage loading, failure, and true empty states distinct without inserting rows", () => {
    const loading = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, mode: "coverage", coverageState: "loading", state: "ready", mentions: [],
    }));
    const failed = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, mode: "coverage", coverageState: "failed", state: "ready", mentions: [],
    }));
    const empty = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, mode: "coverage", coverageState: "ready", coverageSnapshot: {
        ...coverageSnapshot, companiesWithIdentityGatePasses: 0, identityGatePassCount: 0, identityReviewCount: 0,
        companies: coverageSnapshot.companies.map((entry) => ({ ...entry, identityGatePassCount: 0, identityReviewCount: 0, items: [], latestRetrievedAt: null, latestPublisherAt: null, latestProviderObservedAt: null })),
      }, state: "ready", mentions: [],
    }));
    expect(loading).toContain("Loading saved archive by company");
    expect(failed).toContain("Saved archive by company could not be read");
    expect(failed).toContain("Retry saved archive");
    expect(empty).toContain("No saved sources passed the Desk’s limited ambiguous-name check");
    expect(empty).not.toContain("Apple expands its services business");
  });

  it("opens the all-archive search with excerpt, company, publisher, and dismissal controls", () => {
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props,
      mode: "search",
      state: "ready",
      mentions: [],
      browseState: {
        ...INITIAL_SAVED_SOURCES_BROWSE_STATE,
        archiveSearch: { ...INITIAL_SAVED_SOURCES_BROWSE_STATE.archiveSearch!, query: "Hong Kong" },
      },
    }));
    expect(html).toContain("SEARCH SAVED ARCHIVE");
    expect(html).toContain("Search retained source records");
    expect(html).toContain("Search title and excerpt");
    expect(html).toContain("Two-letter terms such as AI or EV match whole words");
    expect(html).toContain("All tracked companies");
    expect(html).toContain("Publisher contains");
    expect(html).toContain("Include dismissed");
    expect(html).toContain("sends no provider or classifier requests");
  });

  it("makes existing records discoverable across companies with source and retrieval clocks", () => {
    const html = renderToStaticMarkup(createElement(SavedSourcesView, { ...props, state: "ready", mentions: [mention(), mention({ id: "source-2", companyId: "adobe", title: "Another saved source" })] }));
    expect(html).toContain("RECENT SAVED SOURCES");
    expect(html).toContain("Selecting one reads its full saved-history pages");
    expect(html).toContain("Recent tape · 2 loaded · limited to latest 60 · 0 rows need issuer check");
    expect(html).toContain('aria-label="Load saved source history for a company"');
    expect(html).toContain("Apple · AAPL");
    expect(html).toContain("Adobe · ADBE");
    expect(html).toContain("The company picker covers all 4 companies");
    expect(html).toContain("AAPL");
    expect(html).toContain("ADBE");
    expect(html).toContain("A real retained source headline");
    expect(html).toContain("Saved source excerpt");
    expect(html).toContain("publisher time");
    expect(html).toContain("retrieved");
    expect(html).toContain("Oct 05, 2026");
    expect(html).toContain("Judgment pending");
    expect(html).toContain("Review source record");
    expect(html).not.toContain("Demo Issuer");
    expect(html).not.toContain("confidence");
    expect(html).toContain("Filter company, ticker, publisher, headline");
  });

  it("states empty history plainly without seeding sample rows", () => {
    const html = renderToStaticMarkup(createElement(SavedSourcesView, { ...props, state: "ready", mentions: [] }));
    expect(html).toContain("No rows are available in the recent saved tape");
    expect(html).toContain("does not establish that company history is empty");
    expect(html).not.toContain("Review source record");
  });

  it("distinguishes loading from a recoverable saved-data failure", () => {
    const loading = renderToStaticMarkup(createElement(SavedSourcesView, { ...props, state: "loading", mentions: [] }));
    const failed = renderToStaticMarkup(createElement(SavedSourcesView, { ...props, state: "failed", mentions: [] }));
    const stale = renderToStaticMarkup(createElement(SavedSourcesView, { ...props, state: "stale", mentions: [mention()] }));
    expect(loading).toContain("Loading recent saved source records");
    expect(failed).toContain("No new collection was started");
    expect(failed).toContain("Retry loading saved sources");
    expect(stale).toContain("Showing the last records already loaded");
    expect(stale).toContain("A real retained source headline");
  });

  it("labels a saved Luna category without turning it into an independently validated claim", () => {
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props,
      state: "ready",
      mentions: [mention({
        status: "classified",
        classification: {
          attemptId: "attempt-1", provider: "openai_luna", modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna",
          serviceTierRequested: "default", serviceTier: "default", promptVersion: "v1", promptSha256: "prompt-hash",
          profileSha256: "profile-hash", schemaVersion: "v1", schemaSha256: "schema-hash", sentiment: "positive",
          eventType: "product_launch", takeaway: "material", about: true, investorRelevant: true, material: true,
          evidenceSufficient: true, summary: "Saved classification", supportingExcerpt: "Excerpt", disposition: "classified",
          responseId: "response-1", responseSha256: "response-hash", inputTokens: 1, cachedInputTokens: 0,
          cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, estimatedCostUsd: 0.001,
          latencyMs: 100, classifiedAt: now,
        },
      })],
    }));
    expect(html).toContain("Luna category: positive");
    expect(html).toContain("not independently validated");
    expect(html).not.toContain("confidence");
  });

  it("reveals a manageable first page and supports bounded local search", () => {
    const rows = Array.from({ length: 15 }, (_, index) => mention({
      id: `source-${index + 1}`,
      companyId: index === 14 ? "adobe" : "apple",
      title: index === 14 ? "Adobe reports a real product change" : `Saved source headline ${index + 1}`,
    }));
    const html = renderToStaticMarkup(createElement(SavedSourcesView, { ...props, state: "ready", mentions: rows }));
    expect(html.match(/<li /g)).toHaveLength(12);
    expect(html).toContain("Recent tape · 15 loaded · limited to latest 60 · 0 rows need issuer check");
    expect(html).toContain("Show next 3 of 15 loaded rows");
    expect(filterSavedSources(rows, "adbe", props.tickerOf).map((row) => row.id)).toEqual(["source-15"]);
    expect(filterSavedSources([mention({ id: "lilly-record", companyId: "lilly", title: "Jaypirca indication update" })], "eli lilly", props.tickerOf, props.companyNameOf).map((row) => row.id)).toEqual(["lilly-record"]);
    expect(filterSavedSources(rows, "example publisher", props.tickerOf)).toHaveLength(15);
    expect(filterSavedSources(rows, "no result", props.tickerOf)).toEqual([]);
  });

  it("restores a retained browse query and loaded-page position after the view is reopened", () => {
    const rows = Array.from({ length: 15 }, (_, index) => mention({
      id: `source-${index + 1}`,
      title: `Saved source headline ${index + 1}`,
    }));
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props,
      state: "ready",
      mentions: rows,
      browseState: { query: "Saved source", visibleCount: 15, companyFilter: null, historyPageCounts: {} },
      onBrowseStateChange: vi.fn(),
    }));

    expect(html.match(/<li /g)).toHaveLength(15);
    expect(html).toContain('value="Saved source"');
    expect(html).toContain("Showing 15 of 15 loaded matches");
    expect(html).not.toContain("Show next 3 of 15 loaded rows");
  });

  it("preserves expanded company-history position and rejects unbounded saved-source state", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const state = { query: "McDonald", visibleCount: 6000, companyFilter: "walmart", historyPageCounts: { walmart: 3, apple: 2 } };

    writeSavedSourcesBrowseState(storage, state);

    expect(values.size).toBe(1);
    expect(values.has(SAVED_SOURCES_BROWSE_STORAGE_KEY)).toBe(true);
    expect(readSavedSourcesBrowseState(storage)).toEqual(state);
    values.set(SAVED_SOURCES_BROWSE_STORAGE_KEY, JSON.stringify({ ...state, visibleCount: 1_000_001 }));
    expect(readSavedSourcesBrowseState(storage)).toEqual(INITIAL_SAVED_SOURCES_BROWSE_STATE);
    values.set(SAVED_SOURCES_BROWSE_STORAGE_KEY, JSON.stringify({ query: "McDonald", visibleCount: 24, companyFilter: "walmart" }));
    expect(readSavedSourcesBrowseState(storage)).toEqual({ query: "McDonald", visibleCount: 24, companyFilter: "walmart", historyPageCounts: {} });
    values.set(SAVED_SOURCES_BROWSE_STORAGE_KEY, JSON.stringify({ ...state, historyPageCounts: { walmart: 10_001 } }));
    expect(readSavedSourcesBrowseState(storage)).toEqual(INITIAL_SAVED_SOURCES_BROWSE_STATE);

    const searchState = {
      ...INITIAL_SAVED_SOURCES_BROWSE_STATE,
      archiveSearch: {
        ...INITIAL_SAVED_SOURCES_BROWSE_STATE.archiveSearch!,
        query: "Hong Kong",
        snapshotAt: now,
        reviewRevision: 0,
        cursor: { searchSemanticsVersion: 2 as const, query: "Hong Kong", companyId: null, publisher: null, includeDismissed: false, snapshotAt: now, reviewRevision: 0, sourceTimeUnknown: false, orderAt: now - 1000, retrievedAt: now - 950, ingestedAt: now - 900, id: "source-search" },
        previousCursors: [null],
      },
    };
    writeSavedSourcesBrowseState(storage, searchState);
    expect(readSavedSourcesBrowseState(storage)).toEqual(searchState);

    const legacyCursorState = {
      ...searchState,
      archiveSearch: {
        ...searchState.archiveSearch,
        cursor: { query: "Hong Kong", companyId: null, publisher: null, includeDismissed: false, snapshotAt: now, orderAt: now - 1000, ingestedAt: now - 900, id: "legacy-cursor" },
      },
    } as unknown as SavedSourcesBrowseState;
    writeSavedSourcesBrowseState(storage, legacyCursorState);
    expect(readSavedSourcesBrowseState(storage).archiveSearch).toMatchObject({
      query: "Hong Kong", snapshotAt: null, reviewRevision: null, cursor: null, previousCursors: [],
    });
  });

  it("restores only previously opened history pages and stops on failure or exhaustion", () => {
    const base = { loadedPageCount: 1, requestedPageCount: 3, hasNextPage: true, loading: false, failed: false };
    expect(shouldRestoreSavedHistoryPage(base)).toBe(true);
    expect(shouldRestoreSavedHistoryPage({ ...base, loadedPageCount: 3 })).toBe(false);
    expect(shouldRestoreSavedHistoryPage({ ...base, loading: true })).toBe(false);
    expect(shouldRestoreSavedHistoryPage({ ...base, failed: true })).toBe(false);
    expect(shouldRestoreSavedHistoryPage({ ...base, hasNextPage: false })).toBe(false);
  });

  it("clears a stale saved-source filter before the filings recovery route opens the browse page", () => {
    const transitions: unknown[] = [];
    recoverToSavedSources(
      (state) => transitions.push({ browseState: state }),
      (mode) => transitions.push({ mode }),
      () => transitions.push({ view: "sources" }),
    );

    expect(transitions).toEqual([
      { browseState: INITIAL_SAVED_SOURCES_BROWSE_STATE },
      { mode: "search" },
      { view: "sources" },
    ]);
  });

  it("explains a local no-match as limited to loaded saved rows and offers one-action filter recovery", () => {
    const onBrowseStateChange = vi.fn();
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props,
      state: "ready",
      mentions: [mention()],
      browseState: { query: "NVIDIA", visibleCount: 24, companyFilter: "walmart", historyPageCounts: { walmart: 2 } },
      companyHistory: { companyId: "walmart", status: "ready", items: [mention({ companyId: "walmart" })], nextCursor: null, loadingMore: false, loadMoreFailed: false },
      onBrowseStateChange,
    }));

    expect(html).toContain("No row matches these filters in the currently loaded saved set");
    expect(html).toContain("This does not show whether evidence exists elsewhere");
    expect(html).not.toContain("No evidence exists");
    expect(html).toContain("Clear search and company filter");
  });

  it("offers every company in the inventory even when it has no rows in the recent tape", () => {
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props,
      state: "ready",
      mentions: [mention({ companyId: "walmart" })],
    }));

    expect(html).toContain("Apple · AAPL");
    expect(html).toContain("value=\"apple\"");
    expect(html).toContain("Recent tape · up to 60 rows only");
    expect(html).not.toContain("Apple · 0");
  });

  it("distinguishes selected-company history loading, actual empty history, and retryable failure", () => {
    const selected = { query: "", visibleCount: 12, companyFilter: "apple", historyPageCounts: { apple: 1 } };
    const loading = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [], browseState: selected,
    }));
    const empty = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [], browseState: selected,
      companyHistory: { companyId: "apple", status: "ready", items: [], nextCursor: null, loadingMore: false, loadMoreFailed: false },
    }));
    const retry = vi.fn();
    const failed = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [], browseState: selected,
      companyHistory: { companyId: "apple", status: "failed", items: [], nextCursor: null, loadingMore: false, loadMoreFailed: false },
      onRetryCompanyHistory: retry,
    }));

    expect(loading).toContain("Loading saved history for Apple");
    expect(loading).not.toContain("No saved source records are present");
    expect(empty).toContain("No saved source records are present in the retained history for Apple");
    expect(failed).toContain("Could not load saved history for Apple");
    expect(failed).toContain("Retry company history");
  });

  it("keeps older-page access available even when the query misses the loaded company page", () => {
    const history: SavedCompanyHistoryState = {
      companyId: "apple", status: "ready", items: [mention()], nextCursor: { orderAt: now, ingestedAt: now, id: "source-1" }, loadingMore: false, loadMoreFailed: false,
    };
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props,
      state: "ready",
      mentions: [],
      browseState: { query: "NVIDIA", visibleCount: 12, companyFilter: "apple", historyPageCounts: { apple: 2 } },
      companyHistory: history,
      onLoadOlderHistory: vi.fn(),
    }));

    expect(html).toContain("No row matches these filters in the currently loaded saved set");
    expect(html).toContain("Load older saved history");
    expect(html).toContain("Search and counts cover the 1 loaded company-history row so far");
  });

  it("marks weak or unavailable issuer matches instead of presenting the desk ticker as fact", () => {
    const weak = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [mention({ issuerIdentityStrong: false })],
    }));
    expect(weak).toContain("1 row need issuer check");
    expect(weak).toContain("verify issuer match");

    const unknown = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [mention({ issuerIdentityStrong: undefined })],
    }));
    expect(unknown).toContain("issuer match unverified");
  });

  it("flags an explicit different-company ticker even when the stored identity rule says strong", () => {
    const headline = mention({
      companyId: "adobe",
      issuerIdentityStrong: true,
      title: "Twist Bioscience (TWST) Stock Could Be Reasonable",
    });
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [headline],
    }));
    expect(otherExplicitTickerSymbols(headline.title, "ADBE")).toEqual(["TWST"]);
    expect(html).toContain("1 row need issuer check");
    expect(html).toContain("also names TWST · verify issuer");
    expect(html).not.toContain("issuer match established");
  });

  it("cues issuer review when a different company leads the headline but the excerpt names the desk company", () => {
    const headline = mention({
      companyId: "walmart",
      issuerIdentityStrong: true,
      title: "Target’s Holiday Blitz: Slashing Prices to Capture Market Share",
      snippet: "Target cut prices on about 2,000 items ahead of the holidays, a strategy backed by strong margins, institutional buying, and a 2.9% dividend yield versus pricier rival Walmart.",
    });
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [headline],
    }));

    expect(differentPossessiveHeadlineSubject(headline.title, headline.snippet, "Walmart Inc.", "WMT")).toBe("Target");
    expect(html).toContain("1 row need issuer check");
    expect(html).toContain("headline leads with Target; excerpt names Walmart · verify WMT relevance");
    expect(html).toContain("The headline leads with Target");
    expect(html).toContain("Target cut prices on about 2,000 items ahead of the holidays");
    expect(html).toContain("Review source record");
  });

  it("does not cue review when the possessive headline lead is the desk company", () => {
    const headline = mention({
      companyId: "walmart",
      title: "Walmart’s Holiday Promotions Bring Customers In",
      snippet: "Walmart said the holiday promotions begin this week.",
    });
    expect(differentPossessiveHeadlineSubject(headline.title, headline.snippet, "Walmart Inc.", "WMT")).toBeNull();
  });

  it("does not mistake a question word before the desk issuer for another headline subject", () => {
    const title = "Can AMD’s CPU Business Fund Its AI Chip Ambitions?";
    const snippet = "Advanced Micro Devices (NASDAQ:AMD) has an established processor business.";
    expect(differentPossessiveHeadlineSubject(title, snippet, "AMD", "AMD")).toBeNull();
  });

  it("still detects a different company after a question word", () => {
    const title = "Can Target’s Holiday Prices Capture Walmart Shoppers?";
    const snippet = "Walmart said its holiday promotions begin this week.";
    expect(differentPossessiveHeadlineSubject(title, snippet, "Walmart", "WMT")).toBe("Target");
  });

  it("does not treat clinical acronyms or FDA as company tickers and recognizes Lilly as Eli Lilly", () => {
    const headline = "Lilly's Jaypirca, a BTK inhibitor, receives expanded indication from U.S. FDA";
    const snippet = "Eli Lilly and Company (NYSE: LLY) announced that the FDA approved Jaypirca, a Bruton tyrosine kinase (BTK) inhibitor.";
    expect(otherExplicitTickerSymbols(`${headline} ${snippet}`, "LLY")).toEqual([]);
    expect(differentPossessiveHeadlineSubject(headline, snippet, "Eli Lilly", "LLY")).toBeNull();
    expect(otherExplicitTickerSymbols("Twist Bioscience (TWST) Stock Could Be Reasonable", "LLY")).toEqual(["TWST"]);
    expect(otherExplicitTickerSymbols("Walmart (WMT) director defers compensation", "LLY", ["LLY", "WMT"])).toEqual(["WMT"]);
    expect(otherExplicitTickerSymbols("Bruton tyrosine kinase (BTK) inhibitor approved by FDA", "LLY", ["LLY", "WMT"])).toEqual([]);
  });

  it("calls out a different headline when the saved excerpt and URL path name the filed company", () => {
    const sourceUrl = "https://www.thestreet.com/retail/walmart-makes-a-pricing-promise-other-retailers-havent?.tsrc=rss";
    const headline = mention({
      companyId: "walmart",
      title: "McDonald's AI wants to know how much you're willing to pay",
      snippet: "Walmart’s CEO just put in writing that his stores won’t do this. Many of its rivals haven’t.",
      source: { ...mention().source, url: sourceUrl },
    });
    const html = renderToStaticMarkup(createElement(SavedSourcesView, {
      ...props, state: "ready", mentions: [headline],
    }));

    expect(sourceLinkPathNamesCompany(sourceUrl, "Walmart")).toBe(true);
    expect(html).toContain("headline leads with McDonald; excerpt and URL path name Walmart · check title/link");
    expect(html).toContain("the path does not verify page contents");
  });

  it("adds live source records to an already loaded company history without losing pagination state", () => {
    const older = mention({ id: "older", companyId: "apple", publishedAt: now - 1_000, retrievedAt: now - 1_000 });
    const newer = mention({ id: "newer", companyId: "apple", publishedAt: now, retrievedAt: now });
    const history: SavedCompanyHistoryState = {
      companyId: "apple", status: "ready", items: [older], nextCursor: { orderAt: now - 2_000, ingestedAt: now - 2_000, id: "cursor" },
      pagesLoaded: 2, loadingMore: false, loadMoreFailed: false,
    };

    const merged = mergeSavedHistoryStreamEvent(history, newer);
    expect(merged?.items.map(({ id }) => id).sort()).toEqual(["newer", "older"]);
    expect(merged).toMatchObject({ ...history, items: expect.any(Array) });
    expect(mergeSavedHistoryStreamEvent(history, { ...older, title: "Updated saved record" })?.items)
      .toEqual([{ ...older, title: "Updated saved record" }]);
    expect(mergeSavedHistoryStreamEvent(history, { ...newer, companyId: "adbe" })).toBe(history);
    expect(mergeSavedHistoryStreamEvent(undefined, newer)).toBeUndefined();
  });
});
