import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getJSON,
  getCompanyFundamentals,
  getCompanySavedHistoryPage,
  getSavedSourceCoverage,
  refreshCompanyFundamentals,
  isCurrentCompanySelection,
  readBackendSnapshot,
  lookupMentionsByIds,
  openStream,
  type CompanySnapshot,
  type HealthDTO,
  type MentionPage,
  type ScoreBucketEvidencePage,
  type MarketSnapshot,
  type Mention,
  type PricePoint,
  type PriceSeriesDTO,
  type SeriesPoint,
  type SeriesResult,
  type JevHistoryWeekResult,
  getJevHistoryWeek,
  type FirstRunEvidenceDTO,
  type AnalystResearchQueueItem,
} from "./lib/api.js";
import type { CompanyFundamentalsView } from "../../shared/company-fundamentals.js";
import type { SavedSourceCoverageSnapshot } from "../../shared/saved-source-coverage.js";
import { filterFreshQuotes, nextQuoteExpiryDelayMs } from "../../shared/quote-freshness.js";
import type { AnalystResearchDispositionChange, AnalystSourceReview } from "../../shared/analyst-research.js";
import { sessionInfo, type SessionInfo } from "./lib/marketHours.js";
import { Header } from "./components/Header.js";
import { MobileCompanyPicker } from "./components/MobileCompanyPicker.js";
import { Watchlist } from "./components/Watchlist.js";
import { SeriesChart } from "./components/SeriesChart.js";
import { HistoricalJevCaveat } from "./components/HistoricalJevCaveat.js";
import { MentionFeed } from "./components/MentionFeed.js";
import { EvidenceBreadth } from "./components/EvidenceBreadth.js";
import { EvidenceQuickAccess } from "./components/EvidenceQuickAccess.js";
import { SelectedCompanyResearchSections } from "./components/SelectedCompanyResearchSections.js";
import { shouldLeadWithCurrentSourceEvidence } from "./lib/chart-view-preference.js";
import { ScoreBucketEvidence } from "./components/ScoreBucketEvidence.js";
import { OutcomeCheck } from "./components/OutcomeCheck.js";
import { CompanyInventoryState } from "./components/CompanyInventoryState.js";
import { SecFilingsInbox } from "./components/SecFilingsInbox.js";
import { recoverToSavedSources, SavedSourcesView, type SavedCompanyHistoryState, type SavedSourcesMode, type SavedSourcesState } from "./components/SavedSourcesView.js";
import { ValidationPanel } from "./components/ValidationPanel.js";
import { MentionDrawer } from "./components/MentionDrawer.js";
import { MATERIAL_FILTER_DESCRIPTION, MaterialFilterDisclosure } from "./components/MaterialFilterDisclosure.js";
import { Tape } from "./components/Tape.js";
import { AlertDeliveryStatus, HealthPanel } from "./components/HealthPanel.js";
import { SourceCoverageDisclosure } from "./components/SourceCoverageDisclosure.js";
import { TopMovers } from "./components/TopMovers.js";
import { StatusBar } from "./components/StatusBar.js";
import { FirstRunEvidenceBrief } from "./components/FirstRunEvidenceBrief.js";
import { FollowedEvidenceBaseline } from "./components/FollowedEvidenceBaseline.js";
import { CompanyFundamentals } from "./components/CompanyFundamentals.js";
import { CategoricalTrendChart } from "./components/CategoricalTrendChart.js";
import { SelectedCompanyMarketPriceContext } from "./components/MarketPriceContextChart.js";
import { AnalystResearchQueue } from "./components/AnalystResearchQueue.js";
import { reconcileScoreBucketAgainstRollingSeries, scoreBucketEvidenceBaseline, scoreBucketSnapshotMatches, shouldRefreshScoreBucketFromRollingSeries } from "./lib/series-chart-state.js";
import { scoreBucketRetryMode } from "./lib/score-bucket-retry.js";
import { isScoreBucketCoverage, sameScoreBucketCoverage } from "../../shared/score-bucket-coverage.js";
import { OpportunityRadar } from "./components/OpportunityRadar.js";
import { fmtDelta, quoteSourceAgeLabel, timeAgo } from "./lib/format.js";
import { filterMentionFeed, matchesMentionFeedFilter } from "./lib/mention-filters.js";
import { applyDispositionChange, includesWeakIssuerMatches, visibleInWorkingScan } from "./lib/analyst-feed.js";
import { operationsAttentionCount } from "./lib/operations-attention.js";
import { retryAvailabilityFor } from "./lib/retryAvailability.js";
import { historicalJevRevealTarget, revealScrollTarget } from "./lib/reveal-scroll-target.js";
import { resetResearchScrollForSelection } from "./lib/research-scroll.js";
import { INITIAL_SAVED_SOURCES_BROWSE_STATE, mergeSavedHistoryStreamEvent, readSavedSourcesBrowseState, shouldRestoreSavedHistoryPage, writeSavedSourcesBrowseState, type SavedSourcesBrowseState } from "./lib/saved-sources-browse-state.js";
import { automaticHistoricalArchiveLookupAction, chartViewPreferenceAfterCompanySelection, deriveChartView, matchingCategoricalSnapshot, shouldLoadHistoricalJevForVisibleTab, shouldLookupHistoricalJev, shouldRefreshInactiveLunaSnapshot, type CategoricalChartSnapshot, type ChartViewPreference } from "./lib/chart-view-preference.js";
import { categoricalChartStatusLabel } from "./lib/categorical-chart-status.js";
import { mentionDrawerReturnTarget, researchViewAfterMentionClose, selectCompanyForResearch, type MentionDrawerReturnTarget, type ResearchView } from "./lib/research-navigation.js";
import { marketPriceRefreshState, shouldLeadWithMarketPriceContext, shouldShowMarketPriceContext } from "./lib/market-price-context.js";
import { readSessionPreference, writeSessionPreference } from "./lib/session-preferences.js";
import { FirstEvidenceRecovery } from "./lib/firstRunEvidence.js";
import { createHealthRefresher } from "./lib/health-refresh.js";
import { hasComparableDeltas, orderWatchlistCompanies } from "./lib/watchlist-order.js";
import { mentionIsInWindow, mentionPageParams, mentionWindowHours } from "./lib/mention-window.js";
import type { ExactTitleGroupFilter } from "./lib/exact-headline-groups.js";
import {
  mergeMentionPages,
  reconcileDrawerMentionOnReconnect,
  reconcileMentionPageOnReconnect,
  reconcileScoreBucketOnMention,
  reconcileScoreBucketOnReconnect,
  hasUnrefreshedRecord,
  remainingLookupFailuresAfterStream,
} from "./lib/snapshot-reconciliation.js";

const WINDOWS = [
  { h: 6, label: "6H" },
  { h: 24, label: "24H" },
  { h: 72, label: "3D" },
  { h: 168, label: "7D" },
];

export function derivePriceChartState(
  source: PriceSeriesDTO | null,
  loading: boolean,
  transportError: boolean,
): { priceLoading: boolean; priceError: boolean; priceQuarantine: PriceSeriesDTO["quarantine"] | undefined } {
  return {
    priceLoading: loading,
    priceError: transportError || source?.refreshError != null,
    priceQuarantine: source?.quarantine,
  };
}

export function derivePriceRefreshLabels(
  source: PriceSeriesDTO | null,
  ready: boolean,
  transportError: boolean,
  pointCount: number,
): { label: string | null; titleDetail: string | null } {
  if (!transportError && source?.refreshError == null) return { label: null, titleDetail: null };
  if (!ready) return { label: "price history unavailable", titleDetail: "price request failed" };
  return pointCount > 0
    ? { label: "refresh failed · keeping saved series", titleDetail: "refresh failed; verified saved points remain visible" }
    : { label: "refresh failed · no verified points in this window", titleDetail: "refresh failed; no verified price points are available in this window" };
}

export function shouldAutoRouteFirstRunToFilings(input: {
  evidence: { state: "loading" | "error" } | { state: "ready"; eligibleObservationCount: number };
  hasExplicitViewChoice: boolean;
  currentView: ResearchView;
  localObservationArrived: boolean;
}): boolean {
  return !input.hasExplicitViewChoice
    && input.currentView === "desk"
    && input.evidence.state === "ready"
    && input.evidence.eligibleObservationCount === 0
    && !input.localObservationArrived;
}

function windowLabel(hours: number): string {
  return WINDOWS.find((window) => window.h === hours)?.label ?? `${hours}H`;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "bull", label: "Bullish" },
  { key: "bear", label: "Bearish" },
  { key: "material", label: "Model material" },
  { key: "offtarget", label: "Off-target" },
  { key: "failed", label: "Unscored" },
  { key: "history", label: "History" },
  { key: "identity_review", label: "Held matches" },
] as const;
const RECONNECT_LOOKUP_BATCH_SIZE = 900;
type FilterKey = (typeof FILTERS)[number]["key"];
type MentionFeedState = {
  companyId: string;
  filter: FilterKey;
  hours: number;
  includeDismissed: boolean;
  setAsideCount: number;
  issuerIdentityReviewCount: number;
  loadedAt: number | null;
  items: Mention[];
  nextCursor: MentionPage["nextCursor"];
  loaded: boolean;
  loadingMore: boolean;
  error: boolean;
  refreshError: boolean;
  loadMoreError: boolean;
};
type EvidenceBreadthState = {
  companyId: string;
  hours: number;
  items: Mention[];
  hasMore: boolean;
  loaded: boolean;
  error: boolean;
  refreshError: boolean;
};
type ScoreBucketEvidenceState = {
  companyId: string;
  hours: number;
  archiveWeekStartMs: number | null;
  bucketFromMs: number;
  bucketThroughMs: number;
  expectedCount: number;
  matchingRecordCount: number;
  impactBin: number | null;
  expectedCountFreshness: "current" | "refreshing" | "error";
  items: Mention[];
  nextCursor: ScoreBucketEvidencePage["nextCursor"];
  snapshotKey: string | null;
  recordCount: number;
  weightedMeanImpact: number | null;
  recordImpactMin: number | null;
  recordImpactMax: number | null;
  impactDistribution: ScoreBucketEvidencePage["impactDistribution"];
  coverageSummary: ScoreBucketEvidencePage["coverageSummary"] | null;
  snapshotStale: boolean;
  selectionExpired: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMoreError: boolean;
};

function mergeScoreBucketMentions(...pages: Mention[][]): Mention[] {
  const byId = new Map<string, Mention>();
  for (const page of pages) for (const mention of page) byId.set(mention.id, mention);
  return [...byId.values()].sort((a, b) =>
    (b.score?.scoredAt ?? 0) - (a.score?.scoredAt ?? 0)
    || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1),
  );
}


export default function App() {
  const [companies, setCompanies] = useState<CompanySnapshot[]>([]);
  const [companiesLoadState, setCompaniesLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [companyFundamentals, setCompanyFundamentals] = useState<{
    companyId: string;
    view: CompanyFundamentalsView | null;
    loading: boolean;
    refreshing: boolean;
    transportError: string | null;
  } | null>(null);
  const fundamentalsRequestKeyRef = useRef<{ companyId: string; requestKey: string } | null>(null);
  const [researchView, setResearchView] = useState<ResearchView>(() => {
    const saved = readSessionPreference("sentiment-desk-research-view");
    return saved === "sources" || saved === "filings" || saved === "queue" || saved === "desk" || saved === "radar" ? saved : "desk";
  });
  const researchViewTouchedRef = useRef(readSessionPreference("sentiment-desk-research-view") !== null);
  const [researchQueueRevision, setResearchQueueRevision] = useState(0);
  const [sourceReviewRevision, setSourceReviewRevision] = useState(0);
  const [tape, setTape] = useState<Mention[]>([]);
  const [savedSourcesState, setSavedSourcesState] = useState<SavedSourcesState>("loading");
  const [savedSourceCoverage, setSavedSourceCoverage] = useState<SavedSourceCoverageSnapshot<Mention> | null>(null);
  const [savedSourceCoverageState, setSavedSourceCoverageState] = useState<"loading" | "ready" | "failed">("loading");
  const [savedSourcesMode, setSavedSourcesMode] = useState<SavedSourcesMode>(() => {
    const saved = readSessionPreference("sentiment-desk-saved-sources-mode");
    return saved === "coverage" || saved === "search" || saved === "tape" ? saved : "coverage";
  });
  const savedSourceCoverageRequestSeq = useRef(0);
  const loadSavedSourceCoverage = useCallback(async () => {
    const requestSeq = ++savedSourceCoverageRequestSeq.current;
    setSavedSourceCoverageState("loading");
    try {
      const snapshot = await getSavedSourceCoverage();
      if (requestSeq !== savedSourceCoverageRequestSeq.current) return;
      setSavedSourceCoverage(snapshot);
      setSavedSourceCoverageState("ready");
    } catch {
      if (requestSeq !== savedSourceCoverageRequestSeq.current) return;
      setSavedSourceCoverageState("failed");
    }
  }, []);
  const changeSavedSourcesMode = useCallback((mode: SavedSourcesMode) => {
    setSavedSourcesMode(mode);
    writeSessionPreference("sentiment-desk-saved-sources-mode", mode);
  }, []);
  const [savedSourcesBrowseState, setSavedSourcesBrowseState] = useState<SavedSourcesBrowseState>(() => {
    try {
      return readSavedSourcesBrowseState(typeof window === "undefined" ? null : window.sessionStorage);
    } catch {
      return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    }
  });
  const [savedCompanyHistory, setSavedCompanyHistory] = useState<Record<string, SavedCompanyHistoryState>>({});
  const savedCompanyHistoryInFlight = useRef(new Set<string>());
  const savedCompanyHistoryGeneration = useRef(0);
  const rememberSavedSourcesBrowseState = useCallback((state: SavedSourcesBrowseState) => {
    setSavedSourcesBrowseState(state);
    try {
      writeSavedSourcesBrowseState(typeof window === "undefined" ? null : window.sessionStorage, state);
    } catch {
      // The in-memory browse state continues to work when session storage is unavailable.
    }
  }, []);
  useEffect(() => {
    if (researchView !== "sources") return;
    void loadSavedSourceCoverage();
    return () => { savedSourceCoverageRequestSeq.current += 1; };
  }, [researchView, loadSavedSourceCoverage]);
  const loadSavedCompanyHistory = useCallback(async (companyId: string, cursor: MentionPage["nextCursor"] = null) => {
    if (savedCompanyHistoryInFlight.current.has(companyId)) return;
    const generation = savedCompanyHistoryGeneration.current;
    savedCompanyHistoryInFlight.current.add(companyId);
    setSavedCompanyHistory((current) => {
      const previous = current[companyId];
      return {
        ...current,
        [companyId]: cursor == null
          ? { companyId, status: "loading", items: [], nextCursor: null, pagesLoaded: 0, loadingMore: false, loadMoreFailed: false }
          : { companyId, status: previous?.status ?? "ready", items: previous?.items ?? [], nextCursor: previous?.nextCursor ?? cursor, pagesLoaded: previous?.pagesLoaded ?? 1, loadingMore: true, loadMoreFailed: false },
      };
    });
    try {
      const page = await getCompanySavedHistoryPage(companyId, cursor);
      if (generation !== savedCompanyHistoryGeneration.current) return;
      setSavedCompanyHistory((current) => {
        const previous = current[companyId];
        const items = page.items.filter(isApplicationMention);
        return {
          ...current,
          [companyId]: {
            companyId,
            status: "ready",
            items: cursor == null ? mergeMentionPages(items, previous?.items ?? []) : mergeMentionPages(previous?.items ?? [], items),
            nextCursor: page.nextCursor,
            pagesLoaded: cursor == null ? 1 : (previous?.pagesLoaded ?? 1) + 1,
            loadingMore: false,
            loadMoreFailed: false,
          },
        };
      });
    } catch {
      if (generation !== savedCompanyHistoryGeneration.current) return;
      setSavedCompanyHistory((current) => {
        const previous = current[companyId];
        return {
          ...current,
          [companyId]: cursor == null
            ? { companyId, status: "failed", items: [], nextCursor: null, pagesLoaded: 0, loadingMore: false, loadMoreFailed: false }
            : { companyId, status: previous?.status ?? "ready", items: previous?.items ?? [], nextCursor: previous?.nextCursor ?? cursor, pagesLoaded: previous?.pagesLoaded ?? 1, loadingMore: false, loadMoreFailed: true },
        };
      });
    } finally {
      if (generation === savedCompanyHistoryGeneration.current) savedCompanyHistoryInFlight.current.delete(companyId);
    }
  }, []);
  useEffect(() => {
    if (researchView !== "sources" || companiesLoadState !== "ready" || savedSourcesBrowseState.companyFilter == null) return;
    if (!companies.some((company) => company.id === savedSourcesBrowseState.companyFilter)) return;
    if (savedCompanyHistory[savedSourcesBrowseState.companyFilter]) return;
    void loadSavedCompanyHistory(savedSourcesBrowseState.companyFilter);
  }, [companies, companiesLoadState, researchView, savedSourcesBrowseState.companyFilter, savedCompanyHistory, loadSavedCompanyHistory]);
  useEffect(() => {
    const companyId = savedSourcesBrowseState.companyFilter;
    const history = companyId == null ? null : savedCompanyHistory[companyId];
    if (researchView !== "sources" || companiesLoadState !== "ready" || companyId == null || history?.status !== "ready") return;
    if (!shouldRestoreSavedHistoryPage({
      loadedPageCount: history.pagesLoaded ?? 1,
      requestedPageCount: savedSourcesBrowseState.historyPageCounts[companyId] ?? 1,
      hasNextPage: history.nextCursor != null,
      loading: history.loadingMore,
      failed: history.loadMoreFailed,
    })) return;
    void loadSavedCompanyHistory(companyId, history.nextCursor);
  }, [companiesLoadState, loadSavedCompanyHistory, researchView, savedCompanyHistory, savedSourcesBrowseState.companyFilter, savedSourcesBrowseState.historyPageCounts]);
  useEffect(() => {
    const companyId = savedSourcesBrowseState.companyFilter;
    if (companiesLoadState !== "ready" || companyId == null || companies.some((company) => company.id === companyId)) return;
    rememberSavedSourcesBrowseState({ ...INITIAL_SAVED_SOURCES_BROWSE_STATE });
  }, [companies, companiesLoadState, savedSourcesBrowseState, rememberSavedSourcesBrowseState]);
  const savedSourcesSnapshotSeenRef = useRef(false);
  const [mentionFeedPage, setMentionFeedPage] = useState<MentionFeedState | null>(null);
  const [evidenceBreadthPage, setEvidenceBreadthPage] = useState<EvidenceBreadthState | null>(null);
  const [scoreBucketEvidence, setScoreBucketEvidence] = useState<ScoreBucketEvidenceState | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesLatestScoreAvailableAt, setSeriesLatestScoreAvailableAt] = useState<number | null>(null);
  const [seriesKey, setSeriesKey] = useState<string | null>(null);
  const [seriesLoadErrorKey, setSeriesLoadErrorKey] = useState<string | null>(null);
  const [jevArchive, setJevArchive] = useState<{ companyId: string; requestedWeek: number | "latest"; result: JevHistoryWeekResult | null; loading: boolean; error: boolean; notFound: boolean } | null>(null);
  const jevArchiveRequestSeq = useRef(0);
  const jevArchiveRef = useRef<JevHistoryWeekResult | null>(null);
  const [sparks, setSparks] = useState<Record<string, SeriesPoint[]>>({});
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  useEffect(() => {
    const quotes = market?.quotes;
    if (!quotes) return;
    const delayMs = nextQuoteExpiryDelayMs(quotes);
    if (delayMs == null) return;
    const expire = () => {
      setMarket((current) => {
        if (!current) return current;
        const quotes = filterFreshQuotes(current.quotes);
        if (Object.keys(quotes).length === Object.keys(current.quotes).length) return current;
        return { ...current, quotes };
      });
    };
    const timer = window.setTimeout(expire, delayMs);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") expire();
    };
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [market?.quotes]);
  const [price, setPrice] = useState<PricePoint[]>([]);
  const [priceResultKey, setPriceResultKey] = useState<string | null>(null);
  const [priceLoadErrorKey, setPriceLoadErrorKey] = useState<string | null>(null);
  const [priceRefreshingKey, setPriceRefreshingKey] = useState<string | null>(null);
  const [priceSource, setPriceSource] = useState<PriceSeriesDTO | null>(null);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [healthLoadState, setHealthLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [firstRunEvidence, setFirstRunEvidence] = useState<{ state: "loading" | "error" } | ({ state: "ready" } & FirstRunEvidenceDTO)>({ state: "loading" });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [streamRuntimeId, setStreamRuntimeId] = useState<string | null>(null);
  const [reconnectLookupFailedIds, setReconnectLookupFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const firstEvidenceRecoveryRef = useRef(new FirstEvidenceRecovery());
  const companyHistoryVisibleRef = useRef(false);
  const [outcomeRefreshRevision, setOutcomeRefreshRevision] = useState(0);
  const [windowHours, setWindowHours] = useState(168);
  const [chartMode, setChartMode] = useState<"sentiment" | "comparison">("sentiment");
  const [chartView, setChartView] = useState<"luna" | "jev">("luna");
  const [chartViewPreference, setChartViewPreference] = useState<ChartViewPreference>({ kind: "automatic" });
  const automaticJevLookupKeyRef = useRef<string | null>(null);
  const automaticJevRetryKeyRef = useRef<string | null>(null);
  const chartViewPreferenceRef = useRef(chartViewPreference);
  const chartViewRef = useRef(chartView);
  const [categoricalChartSnapshot, setCategoricalChartSnapshot] = useState<CategoricalChartSnapshot | null>(null);
  const [categoricalRefreshRequest, setCategoricalRefreshRequest] = useState<{ companyId: string; revision: number } | null>(null);
  const [feedFilter, setFeedFilter] = useState<FilterKey>("all");
  const [includeSetAside, setIncludeSetAside] = useState(false);
  const [feedGroupFilter, setFeedGroupFilter] = useState<ExactTitleGroupFilter>(null);
  const [sortMode, setSortMode] = useState<"delta" | "alpha">("delta");
  const [clock, setClock] = useState(Date.now());
  const [session, setSession] = useState<SessionInfo>(() => sessionInfo());
  const researchScrollRef = useRef<HTMLElement | null>(null);
  const savedSourcesDrawerReturnScrollRef = useRef<MentionDrawerReturnTarget | null>(null);
  const [savedSourcesDrawerReturnTarget, setSavedSourcesDrawerReturnTarget] = useState<MentionDrawerReturnTarget | null>(null);
  const previousResearchCompanyIdRef = useRef<string | null>(null);
  const previousResearchViewRef = useRef(researchView);
  const [drawerMention, setDrawerMention] = useState<Mention | null>(null);
  const drawerMentionIdRef = useRef<string | null>(null);
  const drawerMentionRef = useRef<Mention | null>(drawerMention);
  const mentionFeedPageRef = useRef<MentionFeedState | null>(mentionFeedPage);
  const evidenceBreadthPageRef = useRef<EvidenceBreadthState | null>(evidenceBreadthPage);
  const scoreBucketEvidenceRef = useRef<ScoreBucketEvidenceState | null>(scoreBucketEvidence);
  const mentionFeedHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const operationsDisclosureRef = useRef<HTMLDetailsElement | null>(null);
  const scoreBucketHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const openDrawerMention = useCallback((mention: Mention | null) => {
    drawerMentionIdRef.current = mention?.id ?? null;
    setDrawerMention(mention);
  }, []);
  const restoreSavedSourcesReturnTarget = useCallback((target: MentionDrawerReturnTarget | null) => {
    requestAnimationFrame(() => {
      if (researchScrollRef.current) researchScrollRef.current.scrollTop = target?.scrollTop ?? 0;
      requestAnimationFrame(() => {
        const trigger = target
          ? [...document.querySelectorAll<HTMLElement>("[data-saved-source-id]")]
            .find((element) => element.dataset.savedSourceId === target.mentionId)
          : undefined;
        (trigger ?? document.getElementById("saved-sources-heading"))?.focus();
        setSavedSourcesDrawerReturnTarget(null);
      });
    });
  }, []);
  const closeDrawer = useCallback((restorePosition = true) => {
    const returnTarget = savedSourcesDrawerReturnScrollRef.current;
    savedSourcesDrawerReturnScrollRef.current = null;
    openDrawerMention(null);
    const nextView = researchViewAfterMentionClose(researchView, returnTarget);
    if (nextView === researchView) {
      if (!restorePosition) setSavedSourcesDrawerReturnTarget(null);
      return;
    }
    researchViewTouchedRef.current = true;
    writeSessionPreference("sentiment-desk-research-view", nextView);
    setResearchView(nextView);
    const restoreAfterSearchLoads = restorePosition && returnTarget != null && nextView === "sources" && savedSourcesMode === "search";
    if (!restorePosition) setSavedSourcesDrawerReturnTarget(null);
    if (restoreAfterSearchLoads) setSavedSourcesDrawerReturnTarget(returnTarget);
    requestAnimationFrame(() => {
      if (!restorePosition) return;
      if (!restoreAfterSearchLoads && researchScrollRef.current && returnTarget) researchScrollRef.current.scrollTop = returnTarget.scrollTop;
      requestAnimationFrame(() => {
        if (!returnTarget) return;
        if (restoreAfterSearchLoads) {
          document.getElementById("saved-sources-heading")?.focus();
          return;
        }
        const trigger = [...document.querySelectorAll<HTMLElement>("[data-saved-source-id]")]
          .find((element) => element.dataset.savedSourceId === returnTarget.mentionId);
        (trigger ?? document.getElementById("saved-sources-heading"))?.focus();
      });
    });
  }, [openDrawerMention, researchView, savedSourcesMode]);
  const openResearchQueue = useCallback(() => {
    closeDrawer(false);
    setResearchView("queue");
  }, [closeDrawer]);
  const navigateToCompanyResearch = useCallback((companyId: string) => {
    const next = selectCompanyForResearch({ selectedCompanyId: selectedId, view: researchView }, companyId);
    if (next.selectedCompanyId !== selectedId) {
      const preference = chartViewPreferenceAfterCompanySelection(
        chartViewPreferenceRef.current,
        selectedId,
        companyId,
      );
      chartViewPreferenceRef.current = preference;
      setChartViewPreference(preference);
      chartViewRef.current = deriveChartView(preference);
      setChartView(chartViewRef.current);
    }
    setSelectedId(next.selectedCompanyId);
    researchViewTouchedRef.current = true;
    writeSessionPreference("sentiment-desk-research-view", next.view);
    setResearchView(next.view);
  }, [researchView, selectedId]);
  const openQueuedEvidence = useCallback((item: AnalystResearchQueueItem) => {
    navigateToCompanyResearch(item.companyId);
    openDrawerMention(item.mention);
  }, [navigateToCompanyResearch, openDrawerMention]);
  const openSavedSource = useCallback((mention: Mention) => {
    savedSourcesDrawerReturnScrollRef.current = mentionDrawerReturnTarget(researchView, researchScrollRef.current?.scrollTop ?? 0, mention.id);
    navigateToCompanyResearch(mention.companyId);
    openDrawerMention(mention);
  }, [navigateToCompanyResearch, openDrawerMention, researchView]);
  const applyResearchDispositionChange = useCallback((change: AnalystResearchDispositionChange) => {
    if (!applyDispositionChange(researchDispositionOverrides.current, change)) return;
    setMentionFeedPage((current) => {
      if (!current || current.companyId !== change.companyId) return current;
      const existing = current.items.find((mention) => mention.id === change.observationId);
      if (!existing) return current;
      const updated = {
        ...existing,
        analystResearchDisposition: change.disposition,
        analystResearchDispositionUpdatedAt: change.updatedAt,
      };
      const items = visibleInWorkingScan(updated, current.includeDismissed, researchDispositionOverrides.current, includesWeakIssuerMatches(current.filter))
        ? mergeMentionPages(current.items, [updated])
        : current.items.filter((mention) => mention.id !== change.observationId);
      return { ...current, items };
    });
    setDrawerMention((current) => current?.id === change.observationId
      ? { ...current, analystResearchDisposition: change.disposition, analystResearchDispositionUpdatedAt: change.updatedAt }
      : current);
    setResearchQueueRevision((revision) => revision + 1);
    setSourceReviewRevision((revision) => revision + 1);
  }, []);
  const reportResearchReviewChanged = useCallback((review: AnalystSourceReview) => {
    applyResearchDispositionChange({
      observationId: review.observationId,
      companyId: review.companyId,
      disposition: review.disposition,
      updatedAt: review.updatedAt,
    });
  }, [applyResearchDispositionChange]);
  const chooseChartView = useCallback((next: "luna" | "jev") => {
    const preference = { kind: "manual", view: next } as const;
    chartViewPreferenceRef.current = preference;
    setChartViewPreference(preference);
    chartViewRef.current = next;
    setChartView(next);
    if (next === "jev") {
      requestAnimationFrame(() => {
        const region = document.querySelector<HTMLElement>(".research-scroll");
        const panel = document.getElementById("chart-panel-jev");
        const target = panel && historicalJevRevealTarget(panel);
        if (!region || !target) return;
        revealScrollTarget(region, target, window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      });
    }
  }, []);
  const loadJevArchiveWeek = useCallback(async (companyId: string, week: number | "latest") => {
    const requestSeq = ++jevArchiveRequestSeq.current;
    scoreBucketRequestSeq.current += 1;
    jevArchiveRef.current = null;
    setScoreBucketEvidence(null);
    setJevArchive((current) => ({ companyId, requestedWeek: week,
      result: current?.companyId === companyId ? current.result : null, loading: true, error: false, notFound: false }));
    try {
      const result = await getJevHistoryWeek(companyId, week);
      if (requestSeq !== jevArchiveRequestSeq.current || selectedIdRef.current !== companyId) return;
      jevArchiveRef.current = result;
      setJevArchive({ companyId, requestedWeek: week, result, loading: false, error: false, notFound: false });
    } catch (error) {
      if (requestSeq !== jevArchiveRequestSeq.current || selectedIdRef.current !== companyId) return;
      const notFound = error instanceof Error && error.message.includes("-> 404");
      setJevArchive((current) => current?.companyId === companyId
        ? { ...current, requestedWeek: week, result: notFound ? null : current.result, loading: false, error: !notFound, notFound }
        : { companyId, requestedWeek: week, result: null, loading: false, error: !notFound, notFound });
    }
  }, []);
  useEffect(() => {
    if (chartViewPreference.kind !== "manual" || chartViewPreference.view !== "jev" || !selectedId) return;
    void loadJevArchiveWeek(selectedId, "latest");
  }, [chartViewPreference, selectedId, loadJevArchiveWeek]);
  const reportCategoricalChartSnapshot = useCallback((snapshot: CategoricalChartSnapshot) => {
    setCategoricalChartSnapshot(snapshot);
  }, []);
  const openOperationsFromDrawer = useCallback(() => {
    closeDrawer();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const disclosure = operationsDisclosureRef.current;
      if (!disclosure) return;
      disclosure.open = true;
      disclosure.scrollIntoView({ behavior: "auto", block: "start" });
      disclosure.querySelector<HTMLElement>("summary")?.focus();
    }));
  }, [closeDrawer]);
  const openOperationsFromFilings = useCallback(() => {
    researchViewTouchedRef.current = true;
    writeSessionPreference("sentiment-desk-research-view", "desk");
    setResearchView("desk");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const disclosure = operationsDisclosureRef.current;
      if (!disclosure) return;
      disclosure.open = true;
      disclosure.scrollIntoView({ behavior: "auto", block: "start" });
      disclosure.querySelector<HTMLElement>("summary")?.focus();
    }));
  }, []);
  const openRecentFilingsFromFirstRun = useCallback(() => {
    researchViewTouchedRef.current = true;
    writeSessionPreference("sentiment-desk-research-view", "filings");
    setResearchView("filings");
  }, []);
  const openAlertEvidence = useCallback(async (companyId: string, observationId: string) => {
    try {
      const mention = (await lookupMentionsByIds(companyId, [observationId]))[0];
      if (!mention) return false;
      openDrawerMention(mention);
      return true;
    } catch {
      return false;
    }
  }, [openDrawerMention]);

  useLayoutEffect(() => {
    drawerMentionRef.current = drawerMention;
    drawerMentionIdRef.current = drawerMention?.id ?? null;
    mentionFeedPageRef.current = mentionFeedPage;
    evidenceBreadthPageRef.current = evidenceBreadthPage;
    scoreBucketEvidenceRef.current = scoreBucketEvidence;
  }, [drawerMention, mentionFeedPage, evidenceBreadthPage, scoreBucketEvidence]);

  useEffect(() => {
    if (health?.opportunityRadarEnabled !== true && researchView === "radar") setResearchView("desk");
  }, [health?.opportunityRadarEnabled, researchView]);

  const selectedIdRef = useRef<string | null>(null);
  const windowRef = useRef(24);
  const chartModeRef = useRef<"sentiment" | "comparison">("sentiment");
  const seriesRequestSeq = useRef(0);
  const priceKeyRef = useRef<string | null>(null);
  const priceRequestSeq = useRef(0);
  const mentionStreamSequence = useRef(0);
  const latestStreamedMention = useRef(new Map<string, { sequence: number; mention: Mention }>());
  const researchDispositionOverrides = useRef(new Map<string, AnalystResearchDispositionChange>());
  const runtimeIdRef = useRef<string | null>(null);
  const healthRef = useRef<HealthDTO | null>(null);
  const snapshotRequestSeq = useRef(0);
  const scoreBucketRequestSeq = useRef(0);
  const scoreBucketReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useLayoutEffect(() => {
    const enteringDesk = researchView === "desk" && previousResearchViewRef.current !== "desk";
    resetResearchScrollForSelection(researchScrollRef.current, previousResearchCompanyIdRef.current, selectedId, enteringDesk);
    previousResearchCompanyIdRef.current = selectedId;
    previousResearchViewRef.current = researchView;
  }, [researchView, selectedId]);
  useEffect(() => {
    windowRef.current = windowHours;
  }, [windowHours]);
  useEffect(() => {
    setFeedGroupFilter(null);
    scoreBucketRequestSeq.current += 1;
    setScoreBucketEvidence(null);
  }, [selectedId, windowHours]);
  useEffect(() => {
    priceKeyRef.current = `${selectedId ?? ""}:${windowHours}`;
    priceRequestSeq.current += 1;
    setPrice([]);
    setPriceSource(null);
    setPriceResultKey(null);
    setPriceLoadErrorKey(null);
  }, [selectedId, windowHours]);
  useEffect(() => {
    chartModeRef.current = chartMode;
  }, [chartMode]);

  const selected = useMemo(
    () => companies.find((c) => c.id === selectedId) ?? null,
    [companies, selectedId],
  );
  const selectedFundamentals = companyFundamentals?.companyId === selectedId ? companyFundamentals : null;

  // Saved-only read on selection. Aborting plus the company identity check
  // prevents a slow response from a prior selection replacing the active view.
  useEffect(() => {
    if (!selectedId) {
      setCompanyFundamentals(null);
      fundamentalsRequestKeyRef.current = null;
      return;
    }
    const companyId = selectedId;
    const controller = new AbortController();
    let alive = true;
    setCompanyFundamentals({ companyId, view: null, loading: true, refreshing: false, transportError: null });
    void getCompanyFundamentals(companyId, controller.signal)
      .then((view) => {
        if (!alive || !isCurrentCompanySelection(companyId, selectedIdRef.current) || view.companyId !== companyId) return;
        setCompanyFundamentals({ companyId, view, loading: false, refreshing: false, transportError: null });
      })
      .catch(() => {
        if (!alive || controller.signal.aborted || !isCurrentCompanySelection(companyId, selectedIdRef.current)) return;
        setCompanyFundamentals({ companyId, view: null, loading: false, refreshing: false, transportError: "Saved SEC facts could not be loaded." });
      });
    return () => { alive = false; controller.abort(); };
  }, [selectedId]);

  const refreshSelectedFundamentals = useCallback(async () => {
    const company = selected;
    const current = selectedFundamentals;
    if (!company || !current?.view?.refreshAllowed || current.refreshing) return;
    const companyId = company.id;
    const request = fundamentalsRequestKeyRef.current?.companyId === companyId
      ? fundamentalsRequestKeyRef.current
      : { companyId, requestKey: crypto.randomUUID() };
    fundamentalsRequestKeyRef.current = request;
    setCompanyFundamentals((state) => state?.companyId === companyId
      ? { ...state, refreshing: true, transportError: null }
      : state);
    try {
      const result = await refreshCompanyFundamentals(companyId, request.requestKey);
      if (!isCurrentCompanySelection(companyId, selectedIdRef.current) || result.companyId !== companyId) return;
      setCompanyFundamentals({ companyId, view: result, loading: false, refreshing: false, transportError: null });
      fundamentalsRequestKeyRef.current = null;
    } catch {
      if (!isCurrentCompanySelection(companyId, selectedIdRef.current)) return;
      setCompanyFundamentals((state) => state?.companyId === companyId
        ? { ...state, refreshing: false, transportError: "SEC refresh failed. Saved facts, if any, remain available." }
        : state);
      // Preserve the key after an unknown transport outcome so a deliberate
      // retry cannot create a second provider attempt.
    }
  }, [selected, selectedFundamentals]);
  const selectedCompanyFundamentalsPanel = selected ? (
    <CompanyFundamentals
      companyName={selected.name}
      ticker={selected.ticker}
      state={selectedFundamentals?.refreshing ? "refreshing"
        : selectedFundamentals?.loading ? "loading"
          : selectedFundamentals?.transportError && !(selectedFundamentals.view?.facts.length) ? "failed"
            : selectedFundamentals?.view?.state ?? "loading"}
      facts={selectedFundamentals?.view?.facts ?? []}
      comparisons={selectedFundamentals?.view?.comparisons ?? []}
      points={selectedFundamentals?.view?.points ?? []}
      coverage={selectedFundamentals?.view?.coverage ?? []}
      refreshAllowed={selectedFundamentals?.view?.refreshAllowed === true && !selectedFundamentals.refreshing}
      refreshBlockedReason={selectedFundamentals?.view?.refreshBlockedReason}
      lastRefreshError={selectedFundamentals?.transportError ?? selectedFundamentals?.view?.lastRefreshError}
      staleReason={selectedFundamentals?.view?.staleReason}
      onRefresh={() => void refreshSelectedFundamentals()}
    />
  ) : null;
  const selectedQuote = selected && market ? market.quotes[selected.ticker] ?? null : null;
  const priceRefreshState = marketPriceRefreshState({
    healthState: healthLoadState,
    externalRequestsEnabled: health?.externalRequestsEnabled ?? null,
    chartCollectorEnabled: health?.deliveryHealth.find((source) => source.collector === "yahoo_chart")?.enabled ?? null,
    canStartExternalWork: health?.storage.canStartExternalWork ?? null,
  });
  const selectedSeriesKey = selectedId == null ? null : `${selectedId}:${windowHours}`;
  const selectedJevArchive = selectedId != null && jevArchive?.companyId === selectedId ? jevArchive : null;
  const jevArchiveResult = selectedJevArchive?.result ?? null;
  const selectedJevArchiveScoredRecordCount = jevArchiveResult?.points.reduce((total, point) => total + point.scoredRecordCount, 0) ?? 0;
  const historicalJevHeaderSummary = jevArchiveResult
    ? `${selectedJevArchiveScoredRecordCount.toLocaleString()} saved scores · UTC week [${new Date(jevArchiveResult.fromMs).toISOString().slice(0, 10)}, ${new Date(jevArchiveResult.throughMs).toISOString().slice(0, 10)}) · latest ${new Date(jevArchiveResult.latestEligibleScoreAtMs).toISOString().slice(0, 16).replace("T", " ")} UTC (${timeAgo(jevArchiveResult.latestEligibleScoreAtMs, clock)})${selectedJevArchive?.loading ? " · refreshing" : selectedJevArchive?.error ? " · refresh failed" : ""}`
    : selectedJevArchive?.loading ? "loading saved archive"
      : selectedJevArchive?.error ? "saved archive unavailable"
        : selectedJevArchive?.notFound ? "no eligible saved Jev scores"
          : "saved archive not checked";
  const matchingCategoricalChartSnapshot = matchingCategoricalSnapshot(categoricalChartSnapshot, selectedId, windowHours);
  const priceContextVisible = shouldShowMarketPriceContext(chartView, selectedId);
  const lunaWindowHeader = categoricalChartStatusLabel(matchingCategoricalChartSnapshot, windowLabel(windowHours), clock);
  const resolvedChartView = deriveChartView(chartViewPreference);
  useEffect(() => {
    if (chartViewPreference.kind !== "automatic") return;
    chartViewRef.current = resolvedChartView;
    setChartView(resolvedChartView);
  }, [chartViewPreference, resolvedChartView]);
  useEffect(() => {
    automaticJevLookupKeyRef.current = null;
    automaticJevRetryKeyRef.current = null;
  }, [selectedId, streamRuntimeId]);
  useEffect(() => {
    if (!shouldLookupHistoricalJev(chartViewPreference, matchingCategoricalChartSnapshot, selectedId, windowHours)) return;
    const lookupKey = `${selectedId}:${streamRuntimeId ?? "unknown-runtime"}`;
    const action = automaticHistoricalArchiveLookupAction(
      lookupKey,
      automaticJevLookupKeyRef.current,
      automaticJevRetryKeyRef.current,
      { loading: selectedJevArchive?.loading === true, failed: selectedJevArchive?.error === true },
    );
    if (action === "lookup") {
      automaticJevLookupKeyRef.current = lookupKey;
      automaticJevRetryKeyRef.current = null;
      void loadJevArchiveWeek(selectedId!, "latest");
      return;
    }
    if (action === "retry") {
      // One bounded local retry recovers transient failures. Further retries
      // wait for a new backend runtime or the user's explicit Retry action.
      automaticJevRetryKeyRef.current = lookupKey;
      void loadJevArchiveWeek(selectedId!, "latest");
    }
  }, [chartViewPreference, matchingCategoricalChartSnapshot, selectedId, windowHours, streamRuntimeId, selectedJevArchive?.loading, selectedJevArchive?.error, loadJevArchiveWeek]);
  useEffect(() => {
    if (selectedId == null) return;
    const lookupKey = `${selectedId}:${streamRuntimeId ?? "unknown-runtime"}`;
    if (!shouldLoadHistoricalJevForVisibleTab({
      chartView,
      companyId: selectedId,
      lookupKey,
      attemptedKey: automaticJevLookupKeyRef.current,
      archive: selectedJevArchive == null
        ? null
        : {
          companyId: selectedJevArchive.companyId,
          loading: selectedJevArchive.loading,
          hasResult: selectedJevArchive.result != null,
          confirmedEmpty: selectedJevArchive.notFound,
          failed: selectedJevArchive.error,
        },
    })) return;
    automaticJevLookupKeyRef.current = lookupKey;
    void loadJevArchiveWeek(selectedId, "latest");
  }, [chartView, selectedId, streamRuntimeId, selectedJevArchive?.companyId, selectedJevArchive?.loading, selectedJevArchive?.result, selectedJevArchive?.notFound, selectedJevArchive?.error, loadJevArchiveWeek]);
  const selectedSeriesReady = selectedSeriesKey != null && seriesKey === selectedSeriesKey;
  const selectedSeries = selectedSeriesReady ? series : [];
  const selectedSeriesHistoryLatestScoredAt = selectedSeriesReady ? seriesLatestScoreAvailableAt : null;
  const selectedSeriesError = selectedSeriesKey != null && seriesLoadErrorKey === selectedSeriesKey;
  const selectedSeriesLastScoredAt = selectedSeries.reduce<number | null>(
    (latest, point) => point.scoredRecordCount > 0 && point.latestRecordScoredAtMs != null
      ? Math.max(latest ?? point.latestRecordScoredAtMs, point.latestRecordScoredAtMs)
      : latest,
    null,
  );
  const selectedSeriesHasSentiment = selectedSeriesLastScoredAt != null;
  const selectedSeriesScoredItemCount = selectedSeries.reduce((total, point) => total + point.scoredRecordCount, 0);
  const selectedSeriesScoredBucketCount = selectedSeries.filter((point) => point.scoredRecordCount > 0).length;
  const selectedSeriesFreshness = !selectedSeriesReady && !selectedSeriesError
    ? "loading scores…"
    : selectedSeriesError
      ? "score history unavailable"
      : selectedSeriesHistoryLatestScoredAt == null
        ? "no scored items"
        : `last scored ${timeAgo(selectedSeriesHistoryLatestScoredAt)}`;
  const selectedPriceReady = selectedSeriesKey != null && priceResultKey === selectedSeriesKey;
  const selectedPrice = selectedPriceReady ? price : [];
  const selectedPriceCurrency = selectedPrice[0]?.currency ?? null;
  const selectedPriceCollector = selectedPrice.at(-1)?.collector === "yahoo_chart" ? "Yahoo chart" : null;
  const selectedPriceRetrievedAt = selectedPrice.at(-1)?.retrievedAt ?? null;
  const selectedPriceSource = selectedPriceReady ? priceSource : null;
  const selectedPriceError = selectedSeriesKey != null && priceLoadErrorKey === selectedSeriesKey;
  const priceRefreshRelevant = priceContextVisible || (chartView === "jev" && chartMode === "comparison");
  const selectedPricePending = priceRefreshRelevant && selectedSeriesKey != null
    && (priceRefreshingKey === selectedSeriesKey || (!selectedPriceReady && !selectedPriceError));
  const selectedPriceChartState = derivePriceChartState(selectedPriceSource, selectedPricePending, selectedPriceError);
  const marketPriceContextFirst = priceContextVisible
    && shouldLeadWithMarketPriceContext(matchingCategoricalChartSnapshot, selectedPrice);
  const selectedPriceRefreshLabels = derivePriceRefreshLabels(selectedPriceSource, selectedPriceReady, selectedPriceError, selectedPrice.length);
  const chartHasPrice = chartMode === "comparison" && selectedPrice.length >= 2;
  const chartLoading = selectedSeriesKey != null && (
    (!selectedSeriesReady && !selectedSeriesError)
    || (selectedPricePending && !chartHasPrice && !selectedSeriesHasSentiment)
  );

  const refreshSeries = useCallback(async (companyId?: string) => {
    const id = companyId ?? selectedIdRef.current;
    if (!id) return null;
    const hours = windowRef.current;
    const requestKey = `${id}:${hours}`;
    const requestSeq = ++seriesRequestSeq.current;
    setScoreBucketEvidence((current) => current?.companyId === id && current.hours === hours
      && shouldRefreshScoreBucketFromRollingSeries(current.archiveWeekStartMs)
      ? { ...current, expectedCountFreshness: "refreshing" }
      : current);
    try {
      const result = await getJSON<SeriesResult>(`/api/companies/${id}/series?hours=${hours}`);
      if (seriesRequestSeq.current === requestSeq && selectedIdRef.current === id && windowRef.current === hours) {
        setSeries(result.points);
        setSeriesLatestScoreAvailableAt(result.latestScoreAvailableAt);
        setSeriesKey(requestKey);
        setSeriesLoadErrorKey(null);
        setScoreBucketEvidence((current) => {
          if (!current || current.companyId !== id || current.hours !== hours) return current;
          const refreshedState = reconcileScoreBucketAgainstRollingSeries(result.points, current);
          if (refreshedState == null) return current;
          return current.expectedCount === refreshedState.expectedCount
            && current.expectedCountFreshness === "current"
            && current.snapshotStale === refreshedState.snapshotStale
            && current.selectionExpired === refreshedState.selectionExpired
            ? current
            : {
                ...current,
                expectedCount: refreshedState.expectedCount,
                expectedCountFreshness: "current",
                snapshotStale: refreshedState.snapshotStale,
                selectionExpired: refreshedState.selectionExpired,
              };
        });
        return result;
      }
      return null;
    } catch {
      if (seriesRequestSeq.current === requestSeq && selectedIdRef.current === id && windowRef.current === hours) {
        setSeriesLoadErrorKey(requestKey);
        setScoreBucketEvidence((current) => current?.companyId === id && current.hours === hours
          && shouldRefreshScoreBucketFromRollingSeries(current.archiveWeekStartMs)
          ? { ...current, expectedCountFreshness: "error" }
          : current);
      }
      return null;
    }
  }, []);

  const refreshPrice = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id) return;
    const hours = windowRef.current;
    const requestKey = `${id}:${hours}`;
    const requestSeq = ++priceRequestSeq.current;
    setPriceRefreshingKey(requestKey);
    setPriceLoadErrorKey(null);
    if (priceKeyRef.current !== requestKey) {
      priceKeyRef.current = requestKey;
      setPrice([]);
      setPriceSource(null);
      setPriceResultKey(null);
      setPriceLoadErrorKey(null);
    }
    try {
      const all = await getJSON<CompanySnapshot[]>("/api/companies");
      const c = all.find((x) => x.id === id);
      if (!c) {
        if (priceKeyRef.current === requestKey && priceRequestSeq.current === requestSeq) setPriceLoadErrorKey(requestKey);
        return;
      }
      const result = await getJSON<PriceSeriesDTO>(
        `/api/companies/${id}/price?ticker=${encodeURIComponent(c.ticker)}&hours=${hours}`,
      );
      if (priceKeyRef.current !== requestKey || priceRequestSeq.current !== requestSeq) return;
      setPrice(result.points);
      setPriceSource(result);
      setPriceResultKey(requestKey);
      setPriceLoadErrorKey(null);
    } catch {
      if (priceKeyRef.current === requestKey && priceRequestSeq.current === requestSeq) {
        setPriceLoadErrorKey(requestKey);
      }
    } finally {
      if (priceKeyRef.current === requestKey && priceRequestSeq.current === requestSeq) {
        setPriceRefreshingKey(null);
      }
    }
  }, []);

  const applyHealth = useCallback((snapshot: HealthDTO) => {
    if (runtimeIdRef.current && runtimeIdRef.current !== snapshot.runtimeId) return;
    runtimeIdRef.current = snapshot.runtimeId;
    healthRef.current = snapshot;
    setHealth(snapshot);
    setHealthLoadState("ready");
  }, []);

  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    const refresh = async () => {
      const sequence = ++requestSequence;
      try {
        const evidence = await getJSON<FirstRunEvidenceDTO>("/api/first-run-evidence");
        if (active && sequence === requestSequence) setFirstRunEvidence({ state: "ready", ...evidence });
      } catch {
        if (active && sequence === requestSequence) setFirstRunEvidence({ state: "error" });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const refreshBackendSnapshot = useCallback(async (reset = false, expectedRuntimeId?: string) => {
    if (reset) {
      savedCompanyHistoryGeneration.current += 1;
      savedCompanyHistoryInFlight.current.clear();
      setSavedCompanyHistory({});
    }
    const requestSeq = ++snapshotRequestSeq.current;
    const healthAtStart = healthRef.current;
    const streamSequenceAtStart = mentionStreamSequence.current;
    const idsByCompany = new Map<string, Set<string>>();
    const addLookupRows = (companyId: string, rows: Mention[]) => {
      const ids = idsByCompany.get(companyId) ?? new Set<string>();
      for (const row of rows) ids.add(row.id);
      idsByCompany.set(companyId, ids);
    };
    if (!reset) {
      const feedPage = mentionFeedPageRef.current;
      if (feedPage?.loaded) addLookupRows(feedPage.companyId, feedPage.items);
      const breadthPage = evidenceBreadthPageRef.current;
      if (breadthPage?.loaded) addLookupRows(breadthPage.companyId, breadthPage.items);
      const bucketPage = scoreBucketEvidenceRef.current;
      if (bucketPage?.items.length) addLookupRows(bucketPage.companyId, bucketPage.items);
      const openMention = drawerMentionRef.current;
      if (openMention) addLookupRows(openMention.companyId, [openMention]);
    }
    const { companies: cs, tape: tapeSnapshot, quotes: quoteSnapshot, health: healthSnapshot } = await readBackendSnapshot();
    if (requestSeq !== snapshotRequestSeq.current) return;
    if (healthSnapshot) {
      if (expectedRuntimeId && healthSnapshot.runtimeId !== expectedRuntimeId) return;
      if (runtimeIdRef.current && healthSnapshot.runtimeId !== runtimeIdRef.current) return;
      runtimeIdRef.current = healthSnapshot.runtimeId;
      healthRef.current = healthSnapshot;
      setHealth(healthSnapshot);
      setHealthLoadState("ready");
    } else if (healthRef.current === healthAtStart) {
      setHealthLoadState("failed");
    }
    if (cs) {
      const companyHistoryVisible = cs.some((company) => company.latestSourceCollectedAt != null);
      companyHistoryVisibleRef.current = companyHistoryVisible;
      firstEvidenceRecoveryRef.current.snapshotApplied(companyHistoryVisible);
      setCompanies(cs);
      setCompaniesLoadState("ready");
      setSelectedId((current) => current && cs.some((company) => company.id === current)
        ? current
        : cs[0]?.id ?? null);
    } else {
      firstEvidenceRecoveryRef.current.snapshotFailed();
      setCompaniesLoadState("failed");
    }

    // Read loaded historical IDs after the rolling tape. The ID response is
    // therefore the later database read when a row appears in both snapshots.
    const lookupResults = await Promise.all([...idsByCompany].map(async ([companyId, idSet]) => {
      const ids = [...idSet];
      const items: Mention[] = [];
      const refreshedIds = new Set<string>();
      const failedIds = new Set<string>();
      for (let index = 0; index < ids.length; index += RECONNECT_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(index, index + RECONNECT_LOOKUP_BATCH_SIZE);
        try {
          items.push(...await lookupMentionsByIds(companyId, batch));
          for (const id of batch) refreshedIds.add(id);
        } catch {
          for (const id of batch) failedIds.add(id);
        }
      }
      return { items, refreshedIds, failedIds };
    }));
    if (requestSeq !== snapshotRequestSeq.current) return;
    for (const mention of lookupResults.flatMap((result) => result.items)) {
      const updatedAt = mention.analystResearchDispositionUpdatedAt;
      if (mention.analystResearchDisposition && updatedAt != null) {
        applyDispositionChange(researchDispositionOverrides.current, {
          observationId: mention.id,
          companyId: mention.companyId,
          disposition: mention.analystResearchDisposition,
          updatedAt,
        });
      }
      const streamed = latestStreamedMention.current.get(mention.id);
      if (streamed) latestStreamedMention.current.set(mention.id, { ...streamed, mention });
    }
    const refreshedIds = new Set(lookupResults.flatMap((result) => [...result.refreshedIds]));
    const realTape = (tapeSnapshot ?? []).filter(isApplicationMention);
    const refreshedRows = mergeMentionPages(realTape, lookupResults.flatMap((result) => result.items));
    setReconnectLookupFailedIds(remainingLookupFailuresAfterStream(
      lookupResults.flatMap((result) => [...result.failedIds]),
      latestStreamedMention.current,
      streamSequenceAtStart,
    ));

    if (tapeSnapshot) {
      savedSourcesSnapshotSeenRef.current = true;
      setSavedSourcesState("ready");
      setOutcomeRefreshRevision((revision) => revision + 1);
      setTape((current) => mergeSnapshotWithLive(
        realTape,
        current,
        latestStreamedMention.current,
        streamSequenceAtStart,
        60,
        !reset,
      ));
    } else {
      setSavedSourcesState(savedSourcesSnapshotSeenRef.current ? "stale" : "failed");
    }
    setDrawerMention((current) => reconcileDrawerMentionOnReconnect(
        current,
        refreshedRows,
        reset,
        latestStreamedMention.current,
        streamSequenceAtStart,
        refreshedIds,
      ));
    if (!reset) {
      setMentionFeedPage((current) => current
        ? reconcileMentionPageOnReconnect(
            current,
            refreshedRows,
            latestStreamedMention.current,
            streamSequenceAtStart,
            (mention) => mentionIsInWindow(mention, current.hours)
              && matchesMentionFeedFilter(mention, current.filter)
              && visibleInWorkingScan(mention, current.includeDismissed, researchDispositionOverrides.current, includesWeakIssuerMatches(current.filter)),
            refreshedIds,
          )
        : current);
      setEvidenceBreadthPage((current) => current
        ? reconcileMentionPageOnReconnect(
          current,
          refreshedRows,
          latestStreamedMention.current,
          streamSequenceAtStart,
          (mention) => mentionIsInWindow(mention, current.hours),
          refreshedIds,
        )
        : current);
      setScoreBucketEvidence((current) => reconcileScoreBucketOnReconnect(
        current,
        refreshedRows,
        refreshedIds,
        latestStreamedMention.current,
        streamSequenceAtStart,
      ));
    }
    if (quoteSnapshot) setMarket(quoteSnapshot);
    if (reset) {
      setMentionFeedPage(null);
      setReconnectLookupFailedIds(new Set());
      setSnapshotRevision((revision) => revision + 1);
      setScoreBucketEvidence(null);
      setFeedGroupFilter(null);
      scoreBucketRequestSeq.current += 1;
    }
    if (reset) setSparks({});
    if (chartViewRef.current === "jev") void refreshSeries();
    if (chartViewRef.current === "jev" && chartModeRef.current === "comparison") void refreshPrice();
  }, [refreshPrice, refreshSeries]);

  useEffect(() => {
    if (firstRunEvidence.state !== "ready") return;
    const recovery = firstEvidenceRecoveryRef.current;
    const companyHistoryVisible = companyHistoryVisibleRef.current;
    const next = recovery.observe(firstRunEvidence.eligibleObservationCount, companyHistoryVisible);
    if (next.refreshFeeds) setSnapshotRevision((revision) => revision + 1);
    if (next.refreshSnapshot) {
      void refreshBackendSnapshot().catch(() => undefined).finally(() => recovery.snapshotSettled());
    }
  }, [firstRunEvidence, refreshBackendSnapshot]);

  useEffect(() => {
    if (priceContextVisible || (chartView === "jev" && chartMode === "comparison")) void refreshPrice();
  }, [chartMode, chartView, priceContextVisible, refreshPrice, selectedId, windowHours]);

  // Initial load: refresh authoritative server snapshots.
  useEffect(() => {
    void refreshBackendSnapshot();
  }, [refreshBackendSnapshot]);

  // Live stream: one EventSource, native reconnect.
  useEffect(() => {
    let lastSeriesRefresh = 0;
    let bucketRefreshTimer: number | null = null;
    const close = openStream({
      onHello: (d) => {
        const previousRuntimeId = runtimeIdRef.current ?? healthRef.current?.runtimeId ?? null;
        const runtimeChanged = previousRuntimeId != null && previousRuntimeId !== d.runtimeId;
        runtimeIdRef.current = d.runtimeId;
        setStreamRuntimeId(d.runtimeId);
        if (runtimeChanged) {
          snapshotRequestSeq.current += 1;
          mentionStreamSequence.current += 1;
          latestStreamedMention.current.clear();
          setCompanies([]);
          setCompaniesLoadState("loading");
          setTape([]);
          savedSourcesSnapshotSeenRef.current = false;
          setSavedSourcesState("loading");
          setMarket(null);
          setSparks({});
          setMentionFeedPage(null);
          setEvidenceBreadthPage(null);
          drawerMentionIdRef.current = null;
          setDrawerMention(null);
          setHealth(null);
          setHealthLoadState("loading");
          healthRef.current = null;
          setCategoricalChartSnapshot(null);
          seriesRequestSeq.current += 1;
          priceRequestSeq.current += 1;
          setSeries([]);
          setSeriesLatestScoreAvailableAt(null);
          setSeriesKey(null);
          setSeriesLoadErrorKey(null);
          setPrice([]);
          setPriceSource(null);
          setPriceResultKey(null);
          setPriceLoadErrorKey(null);
        }
        void refreshBackendSnapshot(runtimeChanged, d.runtimeId);
        if (!runtimeChanged) {
          const feed = mentionFeedPageRef.current;
          if (feed?.loaded) {
            const { companyId, filter, hours, includeDismissed } = feed;
            const streamSequenceAtStart = mentionStreamSequence.current;
            const params = mentionPageParams(filter, hours, null, 100, includeDismissed);
            void getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`).then((page) => {
              setMentionFeedPage((current) => {
                if (!current?.loaded || current.companyId !== companyId || current.filter !== filter
                  || current.hours !== hours || current.includeDismissed !== includeDismissed) return current;
                const pageIds = new Set(page.items.map((mention) => mention.id));
                const refreshed = page.items.map((mention) => {
                  const streamed = latestStreamedMention.current.get(mention.id);
                  return streamed && streamed.sequence > streamSequenceAtStart ? streamed.mention : mention;
                }).filter(isApplicationMention)
                  .filter((mention) => matchesMentionFeedFilter(mention, filter)
                    && visibleInWorkingScan(mention, includeDismissed, researchDispositionOverrides.current, includesWeakIssuerMatches(filter)));
                return {
                  ...current,
                  items: mergeMentionPages(current.items.filter((mention) => !pageIds.has(mention.id)), refreshed),
                  nextCursor: current.nextCursor ?? page.nextCursor,
                  setAsideCount: page.setAsideCount,
                  issuerIdentityReviewCount: page.issuerIdentityReviewCount,
                  loadedAt: Date.now(),
                  error: false,
                  refreshError: false,
                  loadMoreError: false,
                };
              });
            }).catch(() => {
              setMentionFeedPage((current) => !current?.loaded || current.companyId !== companyId
                || current.filter !== filter || current.hours !== hours || current.includeDismissed !== includeDismissed
                ? current : { ...current, refreshError: true });
            });
          }
          const breadth = evidenceBreadthPageRef.current;
          if (breadth?.loaded) {
            const { companyId, hours } = breadth;
            const streamSequenceAtStart = mentionStreamSequence.current;
            const params = mentionPageParams("all", hours, null, 100, true);
            void getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`).then((page) => {
              const refreshed = page.items.map((mention) => {
                const streamed = latestStreamedMention.current.get(mention.id);
                return streamed && streamed.sequence > streamSequenceAtStart ? streamed.mention : mention;
              });
              const streamedRows = [...latestStreamedMention.current.values()]
                .filter((entry) => entry.sequence > streamSequenceAtStart && entry.mention.companyId === companyId)
                .map((entry) => entry.mention);
              const items = mergeMentionPages(refreshed, streamedRows)
                .filter(isApplicationMention)
                .filter((mention) => mentionIsInWindow(mention, hours))
                .slice(0, 100);
              setEvidenceBreadthPage((current) => !current?.loaded || current.companyId !== companyId || current.hours !== hours
                ? current
                : { ...current, items, hasMore: page.nextCursor != null, error: false, refreshError: false });
            }).catch(() => {
              setEvidenceBreadthPage((current) => !current?.loaded || current.companyId !== companyId || current.hours !== hours
                ? current : { ...current, refreshError: true });
            });
          }
        }
        setConnected(true);
      },
      onState: setConnected,
      onMention: (m) => {
        if (!isApplicationMention(m)) return;
        if (m.analystResearchDisposition && m.analystResearchDispositionUpdatedAt != null) {
          applyDispositionChange(researchDispositionOverrides.current, {
            observationId: m.id,
            companyId: m.companyId,
            disposition: m.analystResearchDisposition,
            updatedAt: m.analystResearchDispositionUpdatedAt,
          });
        }
        const liveMention = {
          ...m,
          analystResearchDisposition: researchDispositionOverrides.current.get(m.id)?.disposition
            ?? m.analystResearchDisposition ?? null,
        };
        if (isApplicationMention(liveMention)) {
          savedSourcesSnapshotSeenRef.current = true;
          setSavedSourcesState((current) => current === "loading" || current === "failed" ? "ready" : current);
          setSavedCompanyHistory((current) => {
            const history = current[liveMention.companyId];
            const updated = mergeSavedHistoryStreamEvent(history, liveMention);
            return updated === history ? current : { ...current, [liveMention.companyId]: updated! };
          });
        }
        if (m.companyId === selectedIdRef.current) {
          setOutcomeRefreshRevision((revision) => revision + 1);
          if (shouldRefreshInactiveLunaSnapshot(chartViewRef.current, selectedIdRef.current, {
            companyId: m.companyId,
            provider: m.classification?.provider ?? null,
            classifiedAt: m.classification?.classifiedAt ?? null,
          })) {
            setCategoricalRefreshRequest((current) => ({
              companyId: m.companyId,
              revision: current?.companyId === m.companyId ? current.revision + 1 : 1,
            }));
          }
        }
        const wasStreamed = latestStreamedMention.current.has(m.id);
        const sequence = ++mentionStreamSequence.current;
        latestStreamedMention.current.delete(m.id);
        latestStreamedMention.current.set(m.id, { sequence, mention: liveMention });
        if (latestStreamedMention.current.size > 500) {
          const oldestId = [...latestStreamedMention.current.keys()]
            .find((id) => id !== drawerMentionIdRef.current);
          if (oldestId !== undefined) latestStreamedMention.current.delete(oldestId);
        }
        setTape((prev) => upsertMention(prev, liveMention, 60));
        setMentionFeedPage((current) => {
          if (!current || current.companyId !== m.companyId || !current.loaded) return current;
          const items = mentionIsInWindow(liveMention, current.hours)
            && matchesMentionFeedFilter(liveMention, current.filter)
            && visibleInWorkingScan(liveMention, current.includeDismissed, researchDispositionOverrides.current, includesWeakIssuerMatches(current.filter))
            ? mergeMentionPages(current.items, [liveMention])
            : current.items.filter((item) => item.id !== m.id);
          const newWeakIssuerMatch = (current.filter === "all" || current.filter === "identity_review")
            && liveMention.issuerIdentityStrong === false
            && !wasStreamed
            && current.loadedAt != null
            && liveMention.ingestedAt > current.loadedAt
            && mentionIsInWindow(liveMention, current.hours);
          return {
            ...current,
            items,
            issuerIdentityReviewCount: current.issuerIdentityReviewCount + Number(newWeakIssuerMatch),
          };
        });
        setEvidenceBreadthPage((current) => {
          if (!current || current.companyId !== m.companyId || !current.loaded) return current;
          const items = mentionIsInWindow(liveMention, current.hours)
            ? mergeMentionPages(current.items, [liveMention]).slice(0, 100)
            : current.items.filter((item) => item.id !== m.id);
          return { ...current, items };
        });
        setScoreBucketEvidence((current) => reconcileScoreBucketOnMention(current, liveMention));
        setDrawerMention((current) => current?.id === m.id ? liveMention : current);
        const now = Date.now();
        if (scoreBucketEvidenceRef.current?.companyId === m.companyId && bucketRefreshTimer == null) {
          bucketRefreshTimer = window.setTimeout(() => {
            bucketRefreshTimer = null;
            lastSeriesRefresh = Date.now();
            if (chartViewRef.current === "jev") void refreshSeries(m.companyId);
          }, 1_000);
        } else if (now - lastSeriesRefresh > 8_000) {
          lastSeriesRefresh = now;
          if (chartViewRef.current === "jev") void refreshSeries();
          if (chartViewRef.current === "jev" && chartModeRef.current === "comparison") void refreshPrice();
        }
      },
      onResearchDisposition: applyResearchDispositionChange,
      onCompany: (s) => setCompanies((prev) => prev.map((c) => (c.id === s.id ? s : c))),
      onQuotes: (s) => setMarket(s),
    });
    return () => {
      close();
      if (bucketRefreshTimer != null) window.clearTimeout(bucketRefreshTimer);
    };
  }, [applyResearchDispositionChange, refreshBackendSnapshot, refreshSeries, refreshPrice]);

  // Read saved history when selection changes; only poll while that chart is active.
  useEffect(() => {
    if (!selectedId) return;
    void refreshSeries(selectedId);
    const showHistoricalChart = chartView === "jev";
    const pollPrice = priceRefreshState === "enabled";
    if (!showHistoricalChart && !(pollPrice && priceContextVisible)) return;
    const t = setInterval(() => {
      if (showHistoricalChart) void refreshSeries(selectedId);
      if (pollPrice && (priceContextVisible || (showHistoricalChart && chartModeRef.current === "comparison"))) void refreshPrice();
    }, 30_000);
    return () => clearInterval(t);
  }, [selectedId, windowHours, chartView, priceContextVisible, priceRefreshState, refreshSeries, refreshPrice]);

  // Each Desk filter has its own server-side cursor. Unscored, History, and
  // held-identity recovery are unbounded by age; normal filters stay within
  // the selected time window.
  useEffect(() => {
    if (!selectedId) {
      setMentionFeedPage(null);
      return;
    }
    let alive = true;
    const companyId = selectedId;
    const filter = feedFilter;
    const hours = mentionWindowHours(filter, windowHours);
    const includeDismissed = includeSetAside;
    const streamSequenceAtStart = mentionStreamSequence.current;
    setMentionFeedPage({
      companyId, filter, hours, includeDismissed, setAsideCount: 0, issuerIdentityReviewCount: 0, loadedAt: null, items: [], nextCursor: null, loaded: false,
      loadingMore: false, error: false, refreshError: false, loadMoreError: false,
    });
    const params = mentionPageParams(filter, hours, null, 100, includeDismissed);
    getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`)
      .then((page) => {
        if (!alive) return;
        setMentionFeedPage((current) => {
          if (!current || current.companyId !== companyId || current.filter !== filter || current.hours !== hours
            || current.includeDismissed !== includeDismissed) return current;
          const reconciled = mergeSnapshotWithLive(
            page.items,
            [],
            latestStreamedMention.current,
            streamSequenceAtStart,
            page.items.length + latestStreamedMention.current.size,
            false,
          ).filter(isApplicationMention)
            .filter((mention) => matchesMentionFeedFilter(mention, filter)
              && visibleInWorkingScan(mention, includeDismissed, researchDispositionOverrides.current, includesWeakIssuerMatches(filter)));
          return {
            ...current,
            items: reconciled,
            nextCursor: page.nextCursor,
            setAsideCount: page.setAsideCount,
            issuerIdentityReviewCount: page.issuerIdentityReviewCount,
            loadedAt: Date.now(),
            loaded: true,
            loadingMore: false,
            error: false,
            refreshError: false,
            loadMoreError: false,
          };
        });
      })
      .catch(() => {
        if (!alive) return;
        setMentionFeedPage((current) => {
          if (!current || current.companyId !== companyId || current.filter !== filter || current.hours !== hours
            || current.includeDismissed !== includeDismissed) return current;
          return { ...current, error: true };
        });
      });
    return () => { alive = false; };
  }, [selectedId, snapshotRevision, sourceReviewRevision, feedFilter, windowHours, includeSetAside]);

  // Keep the index's evidence context independent from the selected feed
  // filter. This reads a bounded page of real saved source observations.
  useEffect(() => {
    if (!selectedId) {
      setEvidenceBreadthPage(null);
      return;
    }
    let alive = true;
    const companyId = selectedId;
    const hours = windowHours;
    const streamSequenceAtStart = mentionStreamSequence.current;
    setEvidenceBreadthPage({ companyId, hours, items: [], hasMore: false, loaded: false, error: false, refreshError: false });
    const params = mentionPageParams("all", hours, null, 100, true);
    getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`)
      .then((page) => {
        if (!alive) return;
        const responseRows = page.items.map((mention) => {
          const streamed = latestStreamedMention.current.get(mention.id);
          return streamed && streamed.sequence > streamSequenceAtStart ? streamed.mention : mention;
        });
        const newStreamRows = [...latestStreamedMention.current.values()]
          .filter((streamed) => streamed.sequence > streamSequenceAtStart
            && streamed.mention.companyId === companyId
            && mentionIsInWindow(streamed.mention, hours))
          .map((streamed) => streamed.mention);
        const items = mergeMentionPages(responseRows, newStreamRows)
          .filter(isApplicationMention)
          .filter((mention) => mentionIsInWindow(mention, hours))
          .slice(0, 100);
        setEvidenceBreadthPage((current) => !current || current.companyId !== companyId || current.hours !== hours
          ? current
          : { companyId, hours, items, hasMore: page.nextCursor != null, loaded: true, error: false, refreshError: false });
      })
      .catch(() => {
        if (!alive) return;
        setEvidenceBreadthPage((current) => !current || current.companyId !== companyId || current.hours !== hours
          ? current
          : { ...current, error: true });
      });
    return () => { alive = false; };
  }, [selectedId, snapshotRevision, sourceReviewRevision, windowHours]);

  // Health poll.
  useEffect(() => {
    const refresher = createHealthRefresher({
      read: (signal) => getJSON<HealthDTO>("/api/health", signal),
      current: () => healthRef.current,
      apply: applyHealth,
      failed: () => setHealthLoadState("failed"),
    });
    void refresher.refresh();
    const t = setInterval(() => void refresher.refresh(), 20_000);
    return () => { clearInterval(t); refresher.stop(); };
  }, [applyHealth]);

  // Sparklines for every watchlist row.
  const companyCount = companies.length;
  useEffect(() => {
    if (companyCount === 0) return;
    let alive = true;
    const load = async () => {
      const ids = (
        await getJSON<CompanySnapshot[]>("/api/companies").catch(() => [] as CompanySnapshot[])
      ).map((c) => c.id);
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const result = await getJSON<SeriesResult>(`/api/companies/${id}/series?hours=24`);
            return [id, result.points] as const;
          } catch {
            return [id, [] as SeriesPoint[]] as const;
          }
        }),
      );
      if (alive) setSparks(Object.fromEntries(entries));
    };
    void load();
    const t = setInterval(load, 90_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [companyCount, snapshotRevision]);

  // Clock + market session.
  useEffect(() => {
    const t = setInterval(() => {
      setClock(Date.now());
      setSession(sessionInfo());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Ordering for display and keyboard navigation.
  const deltaSortAvailable = hasComparableDeltas(companies);
  const ordered = useMemo(
    () => orderWatchlistCompanies(companies, sortMode),
    [companies, sortMode],
  );
  const orderRef = useRef<string[]>([]);
  useEffect(() => {
    orderRef.current = ordered.map((c) => c.id);
  }, [ordered]);

  // Keyboard: j/k or arrows move, 1-4 windows, f cycles filter, c toggles chart mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (drawerMention) return;
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      const move = (dir: number) => {
        const ids = orderRef.current;
        if (ids.length === 0) return;
        const idx = ids.indexOf(selectedIdRef.current ?? "");
        const next = ids[(idx + dir + ids.length) % ids.length];
        if (next != null) navigateToCompanyResearch(next);
        e.preventDefault();
      };
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (["1", "2", "3", "4"].includes(e.key)) setWindowHours(WINDOWS[Number(e.key) - 1]?.h ?? 24);
      else if (e.key === "f") {
        const i = FILTERS.findIndex((f) => f.key === feedFilter);
        setFeedFilter(FILTERS[(i + 1) % FILTERS.length]?.key ?? "all");
      } else if (e.key === "c" && chartView === "jev") setChartMode((m) => (m === "comparison" ? "sentiment" : "comparison"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chartView, drawerMention, feedFilter, navigateToCompanyResearch]);

  // Fresh, high-strength events across the whole watchlist: the speed lane.
  const breaking = useMemo(
    () =>
      tape.filter(
        (m) => m.issuerIdentityStrong === true && m.score && m.publishedAt != null && m.score.eventScore >= 60 && Date.now() - m.publishedAt < 45 * 60_000,
      ).slice(0, 6),
    [tape],
  );

  const tickerOf = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.ticker ?? id.slice(0, 4).toUpperCase(),
    [companies],
  );
  const companyNameOf = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.name ?? id,
    [companies],
  );
  const knownTickers = useMemo(() => companies.map((company) => company.ticker), [companies]);
  const activeMentionFeed = selectedId
    && mentionFeedPage?.companyId === selectedId
    && mentionFeedPage.filter === feedFilter
    && mentionFeedPage.hours === mentionWindowHours(feedFilter, windowHours)
    && mentionFeedPage.includeDismissed === includeSetAside
    ? mentionFeedPage
    : undefined;
  const totalMentions = companies.reduce((acc, c) => acc + c.sourceRecords24h, 0);
  const localObservationArrived = totalMentions > 0
    || companies.some((company) => company.latestSourceCollectedAt != null)
    || tape.some(isApplicationMention)
    || Boolean(activeMentionFeed?.loaded && activeMentionFeed.items.some(isApplicationMention));
  useEffect(() => {
    if (!shouldAutoRouteFirstRunToFilings({
      evidence: firstRunEvidence,
      hasExplicitViewChoice: researchViewTouchedRef.current,
      currentView: researchView,
      localObservationArrived,
    })) return;
    setResearchView("filings");
  }, [firstRunEvidence, localObservationArrived, researchView]);
  const firstRunActive = researchView === "desk"
    && firstRunEvidence.state === "ready"
    && firstRunEvidence.eligibleObservationCount === 0
    && !localObservationArrived;
  const healthAttentionCount = health ? operationsAttentionCount(health) : 0;
  const webhookNotConfigured = health != null && !health.alertDelivery.configured;
  const selectedMentions = (activeMentionFeed?.items ?? []).filter((mention) =>
    mentionIsInWindow(mention, activeMentionFeed?.hours ?? windowHours, clock),
  );
  const activeEvidenceBreadthPage = selectedId != null
    && evidenceBreadthPage?.companyId === selectedId
    && evidenceBreadthPage.hours === windowHours
    ? evidenceBreadthPage
    : undefined;
  const evidenceBreadthMentions = (activeEvidenceBreadthPage?.items ?? []).filter((mention) =>
    mentionIsInWindow(mention, windowHours, clock),
  );
  const filteredMentions = useMemo(() => filterMentionFeed(selectedMentions, feedFilter), [selectedMentions, feedFilter]);
  const mentionsPending = selectedId != null && !activeMentionFeed?.loaded && !activeMentionFeed?.error;
  const mentionsFailed = selectedId != null && activeMentionFeed?.error === true;
  const activeScoreBucketEvidence = scoreBucketEvidence?.companyId === selectedId && scoreBucketEvidence.hours === windowHours
    && scoreBucketEvidence.archiveWeekStartMs === (chartView === "jev" ? jevArchiveResult?.weekStartMs ?? null : null)
    ? scoreBucketEvidence
    : null;
  const activeFeedRefreshWarning = hasUnrefreshedRecord(activeMentionFeed?.items ?? [], reconnectLookupFailedIds)
    || activeMentionFeed?.refreshError === true;
  const evidenceBreadthRefreshWarning = hasUnrefreshedRecord(activeEvidenceBreadthPage?.items ?? [], reconnectLookupFailedIds)
    || activeEvidenceBreadthPage?.refreshError === true;
  const scoreBucketRefreshWarning = hasUnrefreshedRecord(activeScoreBucketEvidence?.items ?? [], reconnectLookupFailedIds);
  const drawerRefreshWarning = drawerMention != null && hasUnrefreshedRecord([drawerMention], reconnectLookupFailedIds);
  const retryAvailability = retryAvailabilityFor(health);

  const loadOlderMentions = async () => {
    const current = activeMentionFeed;
    if (!current || current.nextCursor == null || current.loadingMore) return;
    const { companyId, filter, hours, includeDismissed } = current;
    const cursor = current.nextCursor;
    const cursorKey = JSON.stringify(cursor);
    setMentionFeedPage((latest) => latest
      && latest.companyId === companyId
      && latest.filter === filter
      && latest.hours === hours
      && latest.includeDismissed === includeDismissed
      && JSON.stringify(latest.nextCursor) === cursorKey
      ? { ...latest, loadingMore: true, loadMoreError: false }
      : latest);
    try {
      const params = mentionPageParams(filter, hours, cursor, 100, includeDismissed);
      const page = await getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`);
      setMentionFeedPage((latest) => {
        if (!latest || latest.companyId !== companyId || latest.filter !== filter || latest.hours !== hours
          || latest.includeDismissed !== includeDismissed || JSON.stringify(latest.nextCursor) !== cursorKey) return latest;
        return {
          ...latest,
          items: mergeMentionPages(latest.items, page.items.filter(isApplicationMention)
            .filter((mention) => visibleInWorkingScan(mention, includeDismissed, researchDispositionOverrides.current, includesWeakIssuerMatches(filter)))),
          nextCursor: page.nextCursor,
          setAsideCount: page.setAsideCount,
          issuerIdentityReviewCount: page.issuerIdentityReviewCount,
          loadingMore: false,
          loadMoreError: false,
        };
      });
    } catch {
      setMentionFeedPage((latest) => !latest || latest.companyId !== companyId || latest.filter !== filter || latest.hours !== hours
        || latest.includeDismissed !== includeDismissed || JSON.stringify(latest.nextCursor) !== cursorKey
        ? latest
        : { ...latest, loadingMore: false, loadMoreError: true });
    }
  };

  const focusMentionFeed = () => {
    requestAnimationFrame(() => {
      const heading = mentionFeedHeadingRef.current;
      if (!heading) return;
      heading.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
      heading.focus({ preventScroll: true });
    });
  };

  const showMentionFeed = (groupFilter: ExactTitleGroupFilter = null) => {
    setFeedFilter("all");
    setFeedGroupFilter(groupFilter);
    focusMentionFeed();
  };

  const showUnscoredHistory = () => {
    setFeedFilter("failed");
    setFeedGroupFilter(null);
    focusMentionFeed();
  };

  const inspectScoreBucket = useCallback(async (
    bucketFromMs: number,
    bucketThroughMs: number,
    expectedSnapshotKey: string | null,
    expectedCount: number,
    returnFocus?: HTMLButtonElement,
    archiveWeekStartMs: number | null = null,
  ) => {
    const companyId = selectedIdRef.current;
    const hours = windowRef.current;
    if (!companyId) return;
    const requestSeq = ++scoreBucketRequestSeq.current;
    scoreBucketReturnFocusRef.current = returnFocus ?? null;
    setFeedGroupFilter(null);
    setFeedFilter("all");
    setScoreBucketEvidence({
      companyId, hours, archiveWeekStartMs, bucketFromMs, bucketThroughMs, expectedCount,
      matchingRecordCount: expectedCount, impactBin: null,
      expectedCountFreshness: "current", items: [],
      nextCursor: null, snapshotKey: null, recordCount: expectedCount,
      weightedMeanImpact: null, recordImpactMin: null, recordImpactMax: null,
      impactDistribution: [], coverageSummary: null, snapshotStale: false,
      selectionExpired: false,
      loading: true, loadingMore: false, error: false, loadMoreError: false,
    });
    const params = new URLSearchParams({
      from: String(bucketFromMs),
      through: String(bucketThroughMs),
      hours: String(hours),
      limit: "50",
    });
    if (archiveWeekStartMs != null) params.set("archiveWeek", String(archiveWeekStartMs));
    if (expectedSnapshotKey) params.set("snapshot", expectedSnapshotKey);
    try {
      const page = await getJSON<ScoreBucketEvidencePage>(
        `/api/companies/${encodeURIComponent(companyId)}/score-bucket?${params}`,
      );
      if (requestSeq !== scoreBucketRequestSeq.current || selectedIdRef.current !== companyId || windowRef.current !== hours
        || (archiveWeekStartMs != null && jevArchiveRef.current?.weekStartMs !== archiveWeekStartMs)) return;
      const items = page.items.filter((mention) => isApplicationMention(mention)
        && mention.status === "scored" && mention.score != null);
      const coverageValid = isScoreBucketCoverage(page.coverageSummary, page.recordCount, bucketFromMs, bucketThroughMs);
      const snapshotStale = page.bucketFromMs !== bucketFromMs || page.bucketThroughMs !== bucketThroughMs
        || !scoreBucketSnapshotMatches(expectedSnapshotKey, expectedCount, page.snapshotKey, page.recordCount)
        || page.matchingRecordCount !== page.recordCount || page.impactBin !== null
        || page.impactDistribution.reduce((total, bin) => total + bin.count, 0) !== page.recordCount
        || !coverageValid;
      setScoreBucketEvidence((current) => !current || current.bucketThroughMs !== bucketThroughMs || current.companyId !== companyId
        ? current
        : {
            ...current,
            items,
            nextCursor: page.nextCursor,
            snapshotKey: page.snapshotKey,
            recordCount: page.recordCount,
            matchingRecordCount: page.matchingRecordCount,
            impactBin: page.impactBin,
            weightedMeanImpact: page.weightedMeanImpact,
            recordImpactMin: page.recordImpactMin,
            recordImpactMax: page.recordImpactMax,
            impactDistribution: page.impactDistribution,
            coverageSummary: coverageValid ? page.coverageSummary : null,
            snapshotStale,
            loading: false,
            error: false,
          });
    } catch (error) {
      if (requestSeq !== scoreBucketRequestSeq.current) return;
      const snapshotStale = error instanceof Error && error.message.includes("-> 409");
      setScoreBucketEvidence((current) => !current || current.bucketThroughMs !== bucketThroughMs || current.companyId !== companyId
        ? current
        : { ...current, loading: false, error: !snapshotStale, snapshotStale });
    }
  }, []);

  const selectScoreBucketImpactBin = async (impactBin: number | null, retry = false) => {
    const current = activeScoreBucketEvidence;
    if (!current || current.loading || current.snapshotStale || current.snapshotKey == null
      || (impactBin != null && (!Number.isInteger(impactBin) || impactBin < 0 || impactBin >= 20))) return;
    if (impactBin === current.impactBin && !retry) return;
    const requestSeq = ++scoreBucketRequestSeq.current;
    const expectedMatchingCount = impactBin == null
      ? current.recordCount
      : current.impactDistribution.find((bin) => bin.from === -100 + impactBin * 10)?.count ?? -1;
    setScoreBucketEvidence((latest) => !latest || latest.companyId !== current.companyId || latest.bucketThroughMs !== current.bucketThroughMs
      ? latest
      : {
          ...latest,
          impactBin,
          matchingRecordCount: expectedMatchingCount,
          items: [],
          nextCursor: null,
          loading: true,
          loadingMore: false,
          error: false,
          loadMoreError: false,
        });
    const params = new URLSearchParams({
      from: String(current.bucketFromMs),
      through: String(current.bucketThroughMs),
      hours: String(current.hours),
      limit: "50",
      snapshot: current.snapshotKey,
    });
    if (current.archiveWeekStartMs != null) params.set("archiveWeek", String(current.archiveWeekStartMs));
    if (impactBin != null) params.set("impactBin", String(impactBin));
    try {
      const page = await getJSON<ScoreBucketEvidencePage>(
        `/api/companies/${encodeURIComponent(current.companyId)}/score-bucket?${params}`,
      );
      if (requestSeq !== scoreBucketRequestSeq.current || selectedIdRef.current !== current.companyId
        || windowRef.current !== current.hours
        || (current.archiveWeekStartMs != null && jevArchiveRef.current?.weekStartMs !== current.archiveWeekStartMs)) return;
      const validRows = page.items.every((mention) => {
        const impact = mention.score?.impact;
        if (impactBin == null) return true;
        const from = -100 + impactBin * 10;
        const through = from + 10;
        return impact != null && impact >= from && (impactBin === 19 ? impact <= through : impact < through);
      });
      const snapshotStale = page.snapshotKey !== current.snapshotKey
        || page.recordCount !== current.recordCount
        || page.matchingRecordCount !== expectedMatchingCount
        || page.impactBin !== impactBin
        || !validRows
        || JSON.stringify(page.impactDistribution) !== JSON.stringify(current.impactDistribution)
        || page.impactDistribution.reduce((total, bin) => total + bin.count, 0) !== page.recordCount
        || current.coverageSummary == null
        || !isScoreBucketCoverage(page.coverageSummary, page.recordCount, current.bucketFromMs, current.bucketThroughMs)
        || !sameScoreBucketCoverage(current.coverageSummary, page.coverageSummary);
      const items = page.items.filter((mention) => isApplicationMention(mention)
        && mention.status === "scored" && mention.score != null);
      setScoreBucketEvidence((latest) => !latest || latest.companyId !== current.companyId || latest.bucketThroughMs !== current.bucketThroughMs
        ? latest
        : {
            ...latest,
            items: snapshotStale ? [] : items,
            nextCursor: snapshotStale ? null : page.nextCursor,
            matchingRecordCount: page.matchingRecordCount,
            impactBin: page.impactBin,
            snapshotStale,
            loading: false,
            error: false,
          });
    } catch (error) {
      if (requestSeq !== scoreBucketRequestSeq.current) return;
      const snapshotStale = error instanceof Error && error.message.includes("-> 409");
      setScoreBucketEvidence((latest) => !latest || latest.companyId !== current.companyId || latest.bucketThroughMs !== current.bucketThroughMs
        ? latest
        : { ...latest, loading: false, error: !snapshotStale, snapshotStale });
    }
  };

  const reloadScoreBucketEvidence = useCallback(async () => {
    const current = activeScoreBucketEvidence;
    if (!current) return;
    const requestSeq = scoreBucketRequestSeq.current;
    const refreshed = current.archiveWeekStartMs == null
      ? await refreshSeries(current.companyId)
      : await getJevHistoryWeek(current.companyId, current.archiveWeekStartMs).catch(() => null);
    if (requestSeq !== scoreBucketRequestSeq.current
      || selectedIdRef.current !== current.companyId
      || windowRef.current !== current.hours
      || !refreshed) return;
    const baseline = scoreBucketEvidenceBaseline(refreshed.points, current.bucketFromMs, current.bucketThroughMs);
    if (!baseline) {
      setScoreBucketEvidence((latest) => !latest || latest.companyId !== current.companyId || latest.bucketFromMs !== current.bucketFromMs
        ? latest
        : { ...latest, expectedCount: 0, expectedCountFreshness: "current", selectionExpired: true, snapshotStale: true });
      return;
    }
    void inspectScoreBucket(
      baseline.bucketFromMs,
      baseline.bucketThroughMs,
      baseline.snapshotKey,
      baseline.recordCount,
      undefined,
      current.archiveWeekStartMs,
    );
  }, [activeScoreBucketEvidence, inspectScoreBucket, refreshSeries]);

  const retryScoreBucketEvidence = () => {
    const current = activeScoreBucketEvidence;
    if (current && scoreBucketRetryMode(current) === "same-snapshot") {
      void selectScoreBucketImpactBin(current.impactBin, true);
      return;
    }
    void reloadScoreBucketEvidence();
  };

  const loadOlderScoreBucketEvidence = async () => {
    const current = activeScoreBucketEvidence;
    if (!current || !current.nextCursor || current.loading || current.loadingMore || current.error) return;
    const requestSeq = scoreBucketRequestSeq.current;
    const cursor = current.nextCursor;
    setScoreBucketEvidence((latest) => !latest || latest.bucketThroughMs !== current.bucketThroughMs || latest.companyId !== current.companyId
      ? latest
      : { ...latest, loadingMore: true, loadMoreError: false });
    const params = new URLSearchParams({
      from: String(current.bucketFromMs),
      through: String(current.bucketThroughMs),
      hours: String(current.hours),
      limit: "50",
      cursor: JSON.stringify(cursor),
      snapshot: current.snapshotKey ?? "",
    });
    if (current.archiveWeekStartMs != null) params.set("archiveWeek", String(current.archiveWeekStartMs));
    if (current.impactBin != null) params.set("impactBin", String(current.impactBin));
    try {
      const page = await getJSON<ScoreBucketEvidencePage>(
        `/api/companies/${encodeURIComponent(current.companyId)}/score-bucket?${params}`,
      );
      if (requestSeq !== scoreBucketRequestSeq.current || (current.archiveWeekStartMs != null
        && jevArchiveRef.current?.weekStartMs !== current.archiveWeekStartMs)) return;
      if (page.bucketFromMs !== current.bucketFromMs || page.bucketThroughMs !== current.bucketThroughMs
        || page.snapshotKey !== current.snapshotKey || page.recordCount !== current.recordCount
        || page.matchingRecordCount !== current.matchingRecordCount || page.impactBin !== current.impactBin
        || JSON.stringify(page.impactDistribution) !== JSON.stringify(current.impactDistribution)
        || current.coverageSummary == null
        || !isScoreBucketCoverage(page.coverageSummary, page.recordCount, current.bucketFromMs, current.bucketThroughMs)
        || !sameScoreBucketCoverage(current.coverageSummary, page.coverageSummary)) {
        setScoreBucketEvidence((latest) => !latest || latest.bucketThroughMs !== current.bucketThroughMs || latest.companyId !== current.companyId
          ? latest
          : { ...latest, snapshotStale: true, loadingMore: false, loadMoreError: false });
        return;
      }
      const items = page.items.filter((mention) => isApplicationMention(mention)
        && mention.status === "scored" && mention.score != null);
      setScoreBucketEvidence((latest) => !latest || latest.bucketThroughMs !== current.bucketThroughMs || latest.companyId !== current.companyId
        ? latest
        : {
            ...latest,
            items: mergeScoreBucketMentions(latest.items, items),
            nextCursor: page.nextCursor,
            loadingMore: false,
            loadMoreError: false,
          });
    } catch (error) {
      if (requestSeq !== scoreBucketRequestSeq.current) return;
      const snapshotStale = error instanceof Error && error.message.includes("-> 409");
      setScoreBucketEvidence((latest) => !latest || latest.bucketThroughMs !== current.bucketThroughMs || latest.companyId !== current.companyId
        ? latest
        : { ...latest, loadingMore: false, loadMoreError: !snapshotStale, snapshotStale: snapshotStale || latest.snapshotStale });
    }
  };

  const closeScoreBucketEvidence = () => {
    scoreBucketRequestSeq.current += 1;
    const returnFocus = scoreBucketReturnFocusRef.current;
    scoreBucketReturnFocusRef.current = null;
    setScoreBucketEvidence(null);
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  };

  useEffect(() => {
    if (!activeScoreBucketEvidence) return;
    requestAnimationFrame(() => {
      const heading = scoreBucketHeadingRef.current;
      if (!heading) return;
      const evidencePanel = heading.closest<HTMLElement>(".score-bucket-evidence");
      (evidencePanel ?? heading).scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
      heading.focus({ preventScroll: true });
    });
  }, [activeScoreBucketEvidence?.bucketThroughMs]);

  return (
    <>
    <div className="flex h-full flex-col overflow-hidden" inert={drawerMention !== null}>
      <Header connected={connected} health={health} totalMentions={totalMentions} clock={clock} />
      {researchView !== "filings" && researchView !== "sources" && <MobileCompanyPicker companies={companies} selectedId={selectedId} onSelect={navigateToCompanyResearch} />}

      <div className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden ${researchView === "filings" || researchView === "sources" ? "lg:grid-cols-1" : "lg:grid-cols-[232px_minmax(0,1fr)]"}`}>
        {researchView !== "filings" && researchView !== "sources" && <aside className="hidden min-h-0 overflow-y-auto border-r border-desk-line lg:block">
          <div className="panel-head sticky top-0 z-10 bg-[#0a0c11]/95 backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="micro">Watchlist</span>
              <span className="tabnum text-[9px] text-white/35" title="Press J/K or the arrow keys to select the previous or next company.">J/K nav</span>
            </div>
            <button
              onClick={() => setSortMode((m) => (m === "delta" ? "alpha" : "delta"))}
              disabled={!deltaSortAvailable}
              className="tabnum flex items-center gap-1 rounded border border-white/10 px-1.5 py-[1px] text-[9.5px] text-white/50 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-35"
              title={deltaSortAvailable
                ? "Sort by the absolute difference between the current 3-hour and trailing 24-hour weighted Jev means, or alphabetically."
                : "No 3-hour versus trailing 24-hour weighted Jev mean comparison is available; companies are sorted alphabetically."}
              aria-label={deltaSortAvailable
                ? "Sort by absolute 3-hour versus trailing 24-hour weighted Jev mean difference; activate to sort alphabetically."
                : "Sort alphabetically. No 3-hour versus trailing 24-hour Jev weighted-mean comparison is available."}
            >
              {sortMode === "delta" && deltaSortAvailable ? "JEV MEAN Δ" : "A-Z"}
            </button>
          </div>
          <Watchlist
            companies={ordered}
            companiesLoadState={companiesLoadState}
            selectedId={selectedId}
            sparks={sparks}
            quotes={market?.quotes ?? {}}
            onSelect={navigateToCompanyResearch}
          />
        </aside>}

        <main ref={researchScrollRef} className="research-scroll flex min-h-0 min-w-0 flex-col overflow-y-auto px-3 py-2 sm:px-5 sm:py-3">
          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label="Research view">
            {([
              ["desk", "Desk"],
              ["sources", "Saved Sources"],
              ["filings", "Recent Filings"],
              ["queue", "My Research"],
              ...(health?.opportunityRadarEnabled === true ? [["radar", "Opportunity Radar"] as const] : []),
            ] as const).map(([view, label]) => (
              <button
                key={view}
                type="button"
                aria-pressed={researchView === view}
                onClick={() => {
                  researchViewTouchedRef.current = true;
                  writeSessionPreference("sentiment-desk-research-view", view);
                  setResearchView(view);
                }}
                className={`rounded-md border px-2.5 py-1.5 text-[10.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${researchView === view ? "border-white/15 bg-white/[0.08] text-white/85" : "border-transparent text-white/40 hover:bg-white/[0.04] hover:text-white/70"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {researchView === "desk" && firstRunActive && (
            <FirstRunEvidenceBrief
              {...firstRunEvidence}
              localObservationArrived={localObservationArrived}
              onOpenOperations={openOperationsFromDrawer}
              onOpenDisclosures={openRecentFilingsFromFirstRun}
            />
          )}
          {researchView === "desk" && (
            <details id="desk-operations" ref={operationsDisclosureRef} className="desk-operations">
              <summary>
                <span>Sources &amp; operations</span>
                <span className="desk-operations-summary desk-operations-summary-desktop">
                  <span className={healthLoadState === "failed" || healthAttentionCount > 0 || webhookNotConfigured ? "text-amber-200/85" : "text-white/60"}>
                    {health == null
                      ? healthLoadState === "failed" ? "status unavailable" : "checking status"
                      : healthLoadState === "failed"
                        ? `refresh failed · last received status${health.externalRequestsEnabled ? " · external requests enabled" : " · saved data only"}`
                        : health.storage.state !== "ready" ? "storage paused · saved data only"
                          : health.externalRequestsEnabled ? "external requests enabled" : "saved data only"}
                  </span>
                  {healthAttentionCount > 0 && healthLoadState !== "failed" && <span className="text-amber-200/80">{healthAttentionCount} health or alert signals</span>}
                  {webhookNotConfigured && <span className="text-amber-200/85">webhook not configured</span>}
                  <span className="text-white/50">Model output independently unvalidated</span>
                </span>
                <span className="desk-operations-summary-mobile">
                  {health == null
                    ? healthLoadState === "failed" ? "Status unavailable" : "Checking status"
                    : healthLoadState === "failed" ? "Status unavailable · showing last known state"
                      : health.storage.state !== "ready" ? "Storage paused · saved data only"
                        : health.externalRequestsEnabled ? "External requests enabled" : "Saved data only"}
                  {healthAttentionCount > 0 && healthLoadState !== "failed" ? ` · ${healthAttentionCount} issues` : ""}
                </span>
                <span className="desk-operations-detail">details</span>
              </summary>
              <div className="desk-operations-content">
                <SourceCoverageDisclosure externalRequestsEnabled={health?.externalRequestsEnabled ?? null} />
                <AlertDeliveryStatus delivery={health?.alertDelivery ?? null} onOpenEvidence={openAlertEvidence} />
                {healthLoadState === "failed" && <p role="status" className="px-1 py-2 text-[11px] text-amber-200/80">Operations status unavailable. Waiting for the next server update.</p>}
                {healthLoadState === "loading" && !health && <p role="status" className="px-1 py-2 text-[11px] text-white/55">Checking source, classifier, and webhook status…</p>}
                <HealthPanel health={health} />
                {!firstRunActive && <FirstRunEvidenceBrief {...firstRunEvidence} localObservationArrived={localObservationArrived} />}
                <details className="desk-market-activity">
                  <summary>Market activity</summary>
                  <div className="panel-head">
                    <span className="micro">Jev weighted-mean movers</span>
                    <span className="text-[9px] text-white/55">3h − 24h Δ · impact pts</span>
                  </div>
                  <TopMovers companies={companies} selectedId={selectedId} onSelect={navigateToCompanyResearch} />
                  <div className="panel-head mt-2 border-t border-desk-line">
                    <span className="micro">{health?.externalRequestsEnabled && health.deliveryHealth.some((source) => source.enabled) ? "Live tape" : "Recent tape"}</span>
                  </div>
                  <Tape mentions={tape} tickerOf={tickerOf} onOpen={openDrawerMention} />
                </details>
              </div>
            </details>
          )}
          {researchView === "sources" ? <SavedSourcesView
            mentions={tape}
            companies={companies}
            coverageSnapshot={savedSourceCoverage}
            coverageState={savedSourceCoverageState}
            mode={savedSourcesMode}
            onModeChange={changeSavedSourcesMode}
            companyInventoryState={companiesLoadState}
            state={savedSourcesState}
            companyHistory={savedSourcesBrowseState.companyFilter == null ? null : savedCompanyHistory[savedSourcesBrowseState.companyFilter] ?? null}
            tickerOf={tickerOf}
            knownTickers={knownTickers}
            companyNameOf={companyNameOf}
            onOpen={openSavedSource}
            browseState={savedSourcesBrowseState}
            onBrowseStateChange={rememberSavedSourcesBrowseState}
            drawerReturnTarget={savedSourcesDrawerReturnTarget}
            onRestoreDrawerReturnTarget={restoreSavedSourcesReturnTarget}
            onRetryCompanyHistory={(companyId) => { void loadSavedCompanyHistory(companyId); }}
            onRetryCoverage={() => { void loadSavedSourceCoverage(); }}
            onLoadOlderHistory={(companyId) => {
              const history = savedCompanyHistory[companyId];
              const cursor = history?.nextCursor;
              if (history == null || cursor == null) return;
              if (!history.loadMoreFailed && savedSourcesBrowseState.companyFilter === companyId) {
                rememberSavedSourcesBrowseState({
                  ...savedSourcesBrowseState,
                  historyPageCounts: {
                    ...savedSourcesBrowseState.historyPageCounts,
                    [companyId]: Math.max(savedSourcesBrowseState.historyPageCounts[companyId] ?? 1, (history.pagesLoaded ?? 1) + 1),
                  },
                });
              }
              void loadSavedCompanyHistory(companyId, cursor);
            }}
            onRetry={() => {
              if (!savedSourcesSnapshotSeenRef.current) setSavedSourcesState("loading");
              void refreshBackendSnapshot();
            }}
          /> : researchView === "filings" ? <SecFilingsInbox
            archiveStatus={firstRunEvidence.state !== "ready" ? "unknown" : firstRunEvidence.eligibleObservationCount > 0 ? "available" : "empty"}
            onOpenOperations={openOperationsFromFilings}
            onBrowseSavedSources={firstRunEvidence.state === "ready" && firstRunEvidence.eligibleObservationCount > 0 ? () => {
              recoverToSavedSources(rememberSavedSourcesBrowseState, changeSavedSourcesMode, () => {
                researchViewTouchedRef.current = true;
                writeSessionPreference("sentiment-desk-research-view", "sources");
                setResearchView("sources");
              });
            } : undefined}
          /> : researchView === "queue" ? (
            <AnalystResearchQueue
              refreshRevision={researchQueueRevision}
              onReviewChanged={reportResearchReviewChanged}
              onOpenEvidence={openQueuedEvidence}
            />
          ) : selected ? (
            researchView === "radar" ? (
              <OpportunityRadar
                key={selected.id}
                companyId={selected.id}
                ticker={selected.ticker}
                hours={windowHours}
                onHours={setWindowHours}
              />
            ) : (
            <>
              <div className="selected-company panel shrink-0 px-3 py-2.5 sm:px-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-[18px] font-semibold">{selected.name}</h1>
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium text-white/60">
                      {selected.ticker}
                    </span>
                    {(() => {
                      const q = market?.quotes[selected.ticker];
                      if (!q) return null;
                      const c = q.changePct;
                      return (
                        <>
                          <span
                            className="tabnum rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                            title={`${q.delivery === "cache" ? "Last-known cached quote" : "Yahoo Finance quote"}; ${q.currency}; source time ${q.at == null ? "unknown" : new Date(q.at).toISOString()}; retrieved ${timeAgo(q.retrievedAt)}`}
                            style={{
                              color: q.delivery === "cache" ? "#fbbf24" : c > 0.001 ? "#34d399" : c < -0.001 ? "#f87171" : "#94a3b8",
                              background: "rgba(255,255,255,0.04)",
                            }}
                          >
                            {q.currency} {q.price.toFixed(2)} {c > 0 ? "+" : ""}{c.toFixed(2)}%
                            {q.delivery === "cache" ? ` · cached ${timeAgo(q.retrievedAt)}` : ""}
                          </span>
                          {quoteSourceAgeLabel(q.at) && (
                            <span
                              className="text-[9px] text-amber-300/80"
                              title={`Exchange observation time; retrieved ${timeAgo(q.retrievedAt)}`}
                            >
                              {quoteSourceAgeLabel(q.at)}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  <div className="selected-company-context mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-white/40">
                    <span>
                        {selected.sector} · {chartView === "jev"
                        ? "Historical Jev archive · complete UTC week"
                        : `${lunaWindowHeader}${matchingCategoricalChartSnapshot?.status === "ready" ? " · rolling saved window" : ""}`}
                      {health?.health.classifier?.provider === "openai_luna" && (
                        <span title={health.health.classifier.enabled
                          ? "Luna is available for new categorical classifications. Historical Jev probabilities and this chart retain their original profile; no synthetic probability or impact is assigned."
                          : `New Luna classifications are paused: ${health.health.classifier.blockedReason ?? "classifier is unavailable"}. Historical Jev data keeps its original profile.`}>
                          {health.health.classifier.enabled ? " · Luna ready" : " · New Luna classifications paused"}
                        </span>
                      )}
                    </span>
                    {selected.earningsAt != null && (
                      <span
                        className="rounded border border-amber-400/25 bg-amber-400/[0.07] px-1.5 py-[1px] text-[10px] font-medium text-amber-300"
                        title="upcoming earnings date (finnhub calendar)"
                      >
                        earnings {Math.ceil((selected.earningsAt - Date.now()) / 86_400_000)}d
                      </span>
                    )}
                    {selected.lastSurprise && (
                      <span
                        className="tabnum rounded border px-1.5 py-[1px] text-[10px] font-medium"
                        style={{
                          color: selected.lastSurprise.percent >= 0 ? "#34d399" : "#f87171",
                          borderColor: selected.lastSurprise.percent >= 0 ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)",
                          background: "rgba(255,255,255,0.03)",
                        }}
                        title={`EPS vs consensus, ${selected.lastSurprise.period} (finnhub)`}
                      >
                        EPS surprise {selected.lastSurprise.percent > 0 ? "+" : ""}
                        {selected.lastSurprise.percent.toFixed(1)}%
                      </span>
                    )}
                    {chartView === "jev" && matchingCategoricalChartSnapshot?.status === "failed" && (
                      <button
                        type="button"
                        className="text-[10px] text-amber-200 underline underline-offset-2"
                        onClick={() => setCategoricalRefreshRequest((current) => ({
                          companyId: selected.id,
                          revision: current?.companyId === selected.id ? current.revision + 1 : 1,
                        }))}
                      >Retry Luna trend</button>
                    )}
                  </div>
                  {(selected.indexWindow === "24h" || selected.indexWindow === "3h") && (
                    <div className="mt-1.5 text-[11.5px] text-white/55" title="Jev's per-record impact mean is a research label, not share-price return or investor opinion. The 24-hour baseline includes the latest three hours.">
                      {selected.indexWindow === "24h"
                        ? "No scored activity in the latest 3 hours · 24-hour history available"
                        : selected.delta == null
                          ? "Recent 3-hour scored activity"
                          : `Recent 3h vs 24h mean: ${fmtDelta(selected.delta)} impact points`}
                    </div>
                  )}
                </div>
                <div role="group" aria-label="Current saved evidence window" className="chart-evidence-window flex min-w-0 w-full flex-row flex-wrap items-center justify-between gap-1 pt-2 sm:ml-auto sm:w-auto sm:shrink-0 sm:flex-nowrap sm:justify-start sm:pt-0">
                  <span className="chart-evidence-window-label micro mr-1">Saved-source window</span>
                  {WINDOWS.map((w, i) => (
                    <button
                      key={w.h}
                      onClick={() => setWindowHours(w.h)}
                      aria-pressed={windowHours === w.h}
                      className={`chart-range-control flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors sm:flex-none ${
                        windowHours === w.h
                          ? "bg-white/[0.09] text-white"
                          : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                      }`}
                    >
                      {w.label}
                      <kbd>{i + 1}</kbd>
                    </button>
                  ))}
                </div>
              </div>

              <SelectedCompanyResearchSections
                fundamentals={selectedCompanyFundamentalsPanel}
                evidenceFirst={shouldLeadWithCurrentSourceEvidence({
                  snapshot: matchingCategoricalChartSnapshot,
                  companyId: selectedId,
                  windowHours,
                  chartView,
                  historicalJevHasScores: selectedJevArchiveScoredRecordCount > 0,
                  marketPriceChartAvailable: marketPriceContextFirst,
                  evidence: { loaded: activeEvidenceBreadthPage?.loaded === true, recordCount: evidenceBreadthMentions.length },
                })}
                chart={
                  <>
              <div className="chart-view-tabs" role="tablist" aria-label={`${selected.name} sentiment chart`}>
                <button
                  id="chart-tab-luna"
                  type="button"
                  role="tab"
                  aria-selected={chartView === "luna"}
                  aria-controls="chart-panel-luna"
                  tabIndex={chartView === "luna" ? 0 : -1}
                  onClick={() => chooseChartView("luna")}
                  onKeyDown={(event) => {
                    if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      const next = event.key === "Home" || event.key === "ArrowLeft" ? "luna" : "jev";
                      chooseChartView(next);
                      requestAnimationFrame(() => document.getElementById(`chart-tab-${next}`)?.focus({ preventScroll: true }));
                    }
                  }}
                >Luna categories</button>
                <button
                  id="chart-tab-jev"
                  type="button"
                  role="tab"
                  aria-selected={chartView === "jev"}
                  aria-controls="chart-panel-jev"
                  tabIndex={chartView === "jev" ? 0 : -1}
                  onClick={() => chooseChartView("jev")}
                  onKeyDown={(event) => {
                    if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      const next = event.key === "Home" || event.key === "ArrowLeft" ? "luna" : "jev";
                      chooseChartView(next);
                      requestAnimationFrame(() => document.getElementById(`chart-tab-${next}`)?.focus({ preventScroll: true }));
                    }
                  }}
                >Historical Jev</button>
              </div>
              <div id="chart-panel-luna" role="tabpanel" aria-labelledby="chart-tab-luna" hidden={chartView !== "luna"} className="mt-2">
                <div className={priceContextVisible ? "luna-price-context-grid" : "contents"}>
                {marketPriceContextFirst && <SelectedCompanyMarketPriceContext
                  chartView={chartView}
                  companyId={selected.id}
                  companyName={selected.name}
                  ticker={selected.ticker}
                  hours={windowHours}
                  points={selectedPrice}
                  source={selectedPriceSource}
                  loading={selectedPricePending}
                  transportError={selectedPriceChartState.priceError}
                  refreshState={priceRefreshState}
                  onRefresh={() => void refreshPrice()}
                  now={clock}
                />}
                <CategoricalTrendChart
                  key={`${selected.id}:${windowHours}:${streamRuntimeId ?? "unknown-runtime"}`}
                  companyId={selected.id}
                  hours={windowHours}
                  active={chartView === "luna"}
                  refreshRevision={categoricalRefreshRequest?.companyId === selected.id ? categoricalRefreshRequest.revision : 0}
                  classifierEnabled={health?.health.classifier?.provider === "openai_luna" && health.health.classifier.enabled}
                  blockedReason={health?.health.classifier?.provider === "openai_luna" ? health.health.classifier.blockedReason : null}
                  historicalJevSummary={historicalJevHeaderSummary}
                  onOpenMention={openDrawerMention}
                  onOpenOperations={openOperationsFromDrawer}
                  onViewHistoricalJev={() => {
                    chooseChartView("jev");
                    requestAnimationFrame(() => document.getElementById("chart-tab-jev")?.focus({ preventScroll: true }));
                  }}
                  onReviewSourceRecords={() => showMentionFeed()}
                  onSnapshot={reportCategoricalChartSnapshot}
                />
                {!marketPriceContextFirst && <SelectedCompanyMarketPriceContext
                  chartView={chartView}
                  companyId={selected.id}
                  companyName={selected.name}
                  ticker={selected.ticker}
                  hours={windowHours}
                  points={selectedPrice}
                  source={selectedPriceSource}
                  loading={selectedPricePending}
                  transportError={selectedPriceChartState.priceError}
                  refreshState={priceRefreshState}
                  onRefresh={() => void refreshPrice()}
                  now={clock}
                />}
                </div>
              </div>
              <div id="chart-panel-jev" role="tabpanel" aria-labelledby="chart-tab-jev" hidden={chartView !== "jev"}>
                {chartView === "jev" && <>
              <section className="historical-archive-summary panel mt-2 px-3 py-2 text-[11px] text-white/70" aria-label="Saved Jev history navigation">
                <div className="historical-archive-summary-main" aria-live="polite">
                  {selectedJevArchive?.loading && !jevArchiveResult && <span>Loading saved Jev weeks…</span>}
                  {selectedJevArchive?.error && !jevArchiveResult && <span role="alert">Saved Jev history is unavailable.</span>}
                  {!selectedJevArchive?.loading && !selectedJevArchive?.error && !jevArchiveResult && <span>
                    {selectedJevArchive?.notFound ? "No eligible saved Jev scores exist in that week." : "No eligible saved Jev history for this company."}
                  </span>}
                  {jevArchiveResult && <>
                    <strong
                      className="text-white/90"
                      title={`Selected UTC week [${new Date(jevArchiveResult.fromMs).toISOString()}, ${new Date(jevArchiveResult.throughMs).toISOString()})`}
                    >
                      UTC week [{new Date(jevArchiveResult.fromMs).toISOString().slice(0, 10)}, {new Date(jevArchiveResult.throughMs).toISOString().slice(0, 10)})
                    </strong>
                    <time
                      dateTime={new Date(jevArchiveResult.latestEligibleScoreAtMs).toISOString()}
                      title={`Latest eligible Jev score completed ${new Date(jevArchiveResult.latestEligibleScoreAtMs).toISOString()}`}
                    >
                      Latest score {new Date(jevArchiveResult.latestEligibleScoreAtMs).toISOString().slice(0, 16).replace("T", " ")} UTC · {timeAgo(jevArchiveResult.latestEligibleScoreAtMs)}
                    </time>
                    {selectedJevArchive?.loading && <span role="status">Loading requested week · showing saved week.</span>}
                    {selectedJevArchive?.error && <span role="alert">Refresh failed · showing saved week.</span>}
                  </>}
                </div>
              </section>
              {jevArchiveResult && <div id="historical-jev-chart" className="panel mt-2 shrink-0">
                <HistoricalJevCaveat />
                <div className="panel-head chart-panel-head">
                  <div className="chart-panel-topline">
                    <span className="micro">Historical Jev Weighted Mean · saved local scores</span>
                  </div>
                  <div className="chart-panel-meta flex items-center gap-2 text-[11px] text-white/60">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-[3px] w-3 rounded-sm bg-gradient-to-r from-rose-400 to-emerald-400" />
                      Saved-record weighted mean · impact points −100 to +100
                    </span>
                    <span
                      className="text-white/65"
                      title="Repeated coverage can appear more than once; records do not represent distinct investors. Empty 15-minute intervals remain blank, and no value is carried forward or decayed."
                    >
                      {jevArchiveResult.points.reduce((sum, point) => sum + point.scoredRecordCount, 0)} source records · repeats included · {jevArchiveResult.points.filter((point) => point.scoredRecordCount > 0).length} populated buckets
                    </span>
                    <span className="text-white/60">15-minute gaps preserved · no price history aligned</span>
                  </div>
                </div>
                <div className="chart-context-layout px-3 py-2">
                  <div className="chart-context-plot">
                    <SeriesChart
                      key={`${selectedId ?? "no-selection"}:${jevArchiveResult.weekStartMs}`}
                      points={jevArchiveResult.points}
                      hours={168}
                      range={{ fromMs: jevArchiveResult.fromMs, throughMs: jevArchiveResult.throughMs }}
                      loading={selectedJevArchive?.loading ?? true}
                      mode="sentiment"
                      price={[]}
                      currency={null}
                      latestPriceAt={null}
                      latestScoreAvailableAt={jevArchiveResult.latestEligibleScoreAtMs}
                      seriesError={selectedJevArchive?.error ?? false}
                      seriesReady={!selectedJevArchive?.loading}
                      onSelectBucket={(bucketFromMs, bucketThroughMs, returnFocus) => {
                        const bucket = jevArchiveResult.points.find((point) => point.bucketEndAtMs === bucketThroughMs);
                        void inspectScoreBucket(bucketFromMs, bucketThroughMs, bucket?.bucketSnapshotKey ?? null,
                          bucket?.scoredRecordCount ?? 0, returnFocus, jevArchiveResult.weekStartMs);
                      }}
                      bucketEvidence={activeScoreBucketEvidence ? (
                        <ScoreBucketEvidence
                          bucketFromMs={activeScoreBucketEvidence.bucketFromMs}
                          bucketThroughMs={activeScoreBucketEvidence.bucketThroughMs}
                          expectedCount={activeScoreBucketEvidence.expectedCount}
                          recordCount={activeScoreBucketEvidence.recordCount}
                          matchingRecordCount={activeScoreBucketEvidence.matchingRecordCount}
                          impactBin={activeScoreBucketEvidence.impactBin}
                          weightedMeanImpact={activeScoreBucketEvidence.weightedMeanImpact}
                          recordImpactMin={activeScoreBucketEvidence.recordImpactMin}
                          recordImpactMax={activeScoreBucketEvidence.recordImpactMax}
                          impactDistribution={activeScoreBucketEvidence.impactDistribution}
                          coverageSummary={activeScoreBucketEvidence.coverageSummary}
                          snapshotStale={activeScoreBucketEvidence.snapshotStale}
                          selectionExpired={activeScoreBucketEvidence.selectionExpired}
                          expectedCountFreshness={activeScoreBucketEvidence.expectedCountFreshness}
                          mentions={activeScoreBucketEvidence.items}
                          loading={activeScoreBucketEvidence.loading}
                          loadingMore={activeScoreBucketEvidence.loadingMore}
                          error={activeScoreBucketEvidence.error}
                          loadMoreError={activeScoreBucketEvidence.loadMoreError}
                          hasMore={activeScoreBucketEvidence.nextCursor != null}
                          headingRef={scoreBucketHeadingRef}
                          onClose={closeScoreBucketEvidence}
                          onOpenMention={openDrawerMention}
                          onRetry={retryScoreBucketEvidence}
                          refreshWarning={scoreBucketRefreshWarning}
                          onRetryRefresh={() => void refreshBackendSnapshot()}
                          onLoadMore={() => void loadOlderScoreBucketEvidence()}
                          onSelectImpactBin={(bin) => void selectScoreBucketImpactBin(bin)}
                        />
                      ) : null}
                    />
                  </div>
                </div>
              </div>}
              <details className="historical-archive-controls mt-1 panel" aria-label="Browse saved Jev weeks">
                <summary>Browse saved weeks</summary>
                <div className="historical-archive-control-buttons">
                  <button type="button" disabled={!jevArchiveResult?.olderWeekStartMs || selectedJevArchive?.loading} onClick={() => jevArchiveResult?.olderWeekStartMs != null && selectedId && void loadJevArchiveWeek(selectedId, jevArchiveResult.olderWeekStartMs)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Older week</button>
                  <button type="button" disabled={!jevArchiveResult?.newerWeekStartMs || selectedJevArchive?.loading} onClick={() => jevArchiveResult?.newerWeekStartMs != null && selectedId && void loadJevArchiveWeek(selectedId, jevArchiveResult.newerWeekStartMs)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Newer week</button>
                  <button type="button" disabled={selectedJevArchive?.loading || (jevArchiveResult != null && jevArchiveResult.weekStartMs === jevArchiveResult.latestWeekStartMs)} onClick={() => selectedId && void loadJevArchiveWeek(selectedId, "latest")} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Latest</button>
                  {selectedJevArchive?.error && <button type="button" onClick={() => selectedId && void loadJevArchiveWeek(selectedId, selectedJevArchive.requestedWeek)} className="rounded border border-amber-200/30 px-2 py-1 text-amber-100">Retry</button>}
                  {selectedJevArchive?.notFound && <button type="button" onClick={() => showMentionFeed()} className="rounded border border-white/15 px-2 py-1">Review saved source records</button>}
                </div>
              </details>
                </>}
              </div>

                </>}
                afterChart={<EvidenceQuickAccess
                  mentions={evidenceBreadthMentions}
                  hours={windowHours}
                  loaded={activeEvidenceBreadthPage?.loaded === true}
                  error={activeEvidenceBreadthPage?.error === true}
                  hasMore={activeEvidenceBreadthPage?.hasMore === true}
                  now={clock}
                  onReview={() => showMentionFeed()}
                  onRetry={() => setSnapshotRevision((revision) => revision + 1)}
                />}
                evidence={
                  <EvidenceBreadth
                    mentions={evidenceBreadthMentions}
                    hours={windowHours}
                    loaded={activeEvidenceBreadthPage?.loaded === true}
                    error={activeEvidenceBreadthPage?.error === true}
                    hasMore={activeEvidenceBreadthPage?.hasMore === true}
                    now={clock}
                    refreshWarning={evidenceBreadthRefreshWarning}
                    onRetry={() => setSnapshotRevision((revision) => revision + 1)}
                    onRetryRefresh={() => {
                      void refreshBackendSnapshot();
                      setSnapshotRevision((revision) => revision + 1);
                    }}
                    onShowRecords={showMentionFeed}
                    onShowUnscoredHistory={showUnscoredHistory}
                    recentlyRetrievedCount={selected?.sourceRecords24h ?? 0}
                    onOpenMention={openDrawerMention}
                  />
                }
              />

              <FollowedEvidenceBaseline
                key={selected.id}
                companyId={selected.id}
                companyName={`${selected.name} (${selected.ticker})`}
                refreshKey={snapshotRevision}
                onOpenEvidence={openDrawerMention}
              />

              {breaking.length > 0 && (
                <div className="no-scrollbar panel mt-2 flex shrink-0 items-center gap-1.5 overflow-x-auto px-2 py-1.5">
                  <span className="micro shrink-0 px-1 text-amber-300/80">Just landed</span>
                  {breaking.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => openDrawerMention(m)}
                      className="flex shrink-0 items-baseline gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10.5px] hover:bg-white/[0.06]"
                    >
                      <span className="font-semibold text-white/80">{tickerOf(m.companyId)}</span>
                      <span
                        className="tabnum font-medium"
                        style={{ color: (m.score?.impact ?? 0) >= 0 ? "#34d399" : "#f87171" }}
                      >
                        {(m.score?.impact ?? 0) > 0 ? "+" : ""}
                        {(m.score?.impact ?? 0).toFixed(0)}
                      </span>
                      <span className="clamp-1 max-w-[240px] text-white/60">{m.title}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-2 grid grid-cols-1 gap-3">
                <div className="panel flex min-w-0 flex-col" id="mention-feed-panel">
                  <div className="panel-head mentions-panel-head shrink-0">
                    <h2 id="mention-feed-heading" ref={mentionFeedHeadingRef} tabIndex={-1} className="micro m-0 scroll-mt-3 p-0">
                      Source records · {feedFilter === "history" || feedFilter === "failed" || feedFilter === "identity_review" ? "all saved history · newest first" : windowLabel(windowHours)}
                      {mentionsFailed && <span className="ml-2 normal-case tracking-normal text-amber-300/80">refresh failed</span>}
                    </h2>
                    <div className="mentions-filters">
                      {FILTERS.map((f) => (
                        <button
                          key={f.key}
                          onClick={() => {
                            setFeedGroupFilter(null);
                            setFeedFilter(f.key);
                          }}
                          aria-pressed={feedFilter === f.key}
                          title={f.key === "material" ? MATERIAL_FILTER_DESCRIPTION : undefined}
                          aria-describedby={f.key === "material" && feedFilter === "material" ? "material-filter-disclosure" : undefined}
                          className={`rounded-md px-2 py-[3px] text-[10.5px] transition-colors ${
                            feedFilter === f.key
                              ? "bg-white/[0.09] text-white"
                              : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                          }`}
                        >
                          {f.label}
                          <kbd className="ml-1">f</kbd>
                        </button>
                      ))}
                      {(includeSetAside || (activeMentionFeed?.setAsideCount ?? 0) > 0) && (
                        <button
                          type="button"
                          onClick={() => {
                            setFeedGroupFilter(null);
                            setIncludeSetAside((value) => !value);
                          }}
                          aria-pressed={includeSetAside}
                          aria-label={includeSetAside
                            ? "Hide analyst-set-aside source records"
                            : `Show ${activeMentionFeed?.setAsideCount ?? 0} analyst-set-aside source records`}
                          className={`rounded-md px-2 py-[3px] text-[10.5px] transition-colors ${includeSetAside
                            ? "bg-amber-200/[0.12] text-amber-100/90"
                            : "text-amber-100/55 hover:bg-white/[0.04] hover:text-amber-100/85"}`}
                        >
                          {includeSetAside ? "Hide set-aside" : `Show set-aside · ${activeMentionFeed?.setAsideCount ?? 0}`}
                        </button>
                      )}
                    </div>
                  </div>
                  {feedFilter === "material" && <MaterialFilterDisclosure />}
                  {activeFeedRefreshWarning && (
                    <div className="mx-2 mt-2 rounded border border-amber-300/20 bg-amber-200/[0.04] px-3 py-2 text-[11px] text-amber-100/80" role="alert">
                      Some loaded saved records could not be refreshed after reconnect and may be out of date.{" "}
                      <button type="button" className="underline underline-offset-2" onClick={() => {
                        void refreshBackendSnapshot();
                        setSnapshotRevision((revision) => revision + 1);
                      }}>
                        Retry refresh
                      </button>
                    </div>
                  )}
                  {feedFilter === "all" && (activeMentionFeed?.issuerIdentityReviewCount ?? 0) > 0 && (
                    <div className="mx-2 mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-300/20 bg-amber-200/[0.04] px-3 py-2 text-[11px] text-amber-100/80" role="status">
                      <span>
                        {activeMentionFeed?.issuerIdentityReviewCount} company-name {activeMentionFeed?.issuerIdentityReviewCount === 1 ? "match is" : "matches are"} held by the current text rule. Some may still concern this company; saved records are unchanged.
                      </span>
                      <button
                        type="button"
                        className="shrink-0 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200"
                        onClick={() => {
                          setFeedGroupFilter(null);
                          setFeedFilter("identity_review");
                          focusMentionFeed();
                        }}
                      >
                        Review held matches
                      </button>
                    </div>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                    {filteredMentions.length > 0 && (
                      <div className="feed-method-note">
                        {filteredMentions.length} matching source {filteredMentions.length === 1 ? "record" : "records"}
                        {" · scored and pending repeats group by company and normalized title within these loaded rows. Groups are duplicate cues, not proof of independent reporting; every source row remains reviewable."}
                      </div>
                    )}
                    <MentionFeed
                      mentions={filteredMentions}
                      onOpen={openDrawerMention}
                      tickerOf={tickerOf}
                      knownTickers={knownTickers}
                      companyNameOf={companyNameOf}
                      groupFilter={feedGroupFilter}
                      hasOlderPages={activeMentionFeed?.nextCursor != null}
                      loaded={activeMentionFeed?.loaded === true}
                      loading={mentionsPending}
                      error={mentionsFailed}
                      onClearGroupFilter={() => setFeedGroupFilter(null)}
                      onRetry={() => setSnapshotRevision((revision) => revision + 1)}
                    />
                    {filteredMentions.length === 0 && feedGroupFilter == null && !mentionsFailed && (
                      <div className="px-3 py-4 text-[12px] text-white/35" role="status">
                        {mentionsPending
                            ? `Loading ${selected.ticker} mentions…`
                            : !includeSetAside && activeMentionFeed?.loaded && activeMentionFeed.setAsideCount > 0
                              ? `${activeMentionFeed.setAsideCount} source ${activeMentionFeed.setAsideCount === 1 ? "record is" : "records are"} set aside from this scan. Show set-aside to review them.`
                            : feedFilter === "identity_review" && activeMentionFeed?.loaded && selectedMentions.length === 0
                              ? "No company-name matches are held by the current identity rule in saved history."
                            : feedFilter === "history" && activeMentionFeed?.loaded && selectedMentions.length === 0
                              ? "No identified real-source records in retained history for this company."
                            : feedFilter === "failed" && activeMentionFeed?.loaded && selectedMentions.length === 0
                              ? "No unscored items in saved history."
                              : feedFilter === "all" && (activeMentionFeed?.issuerIdentityReviewCount ?? 0) > 0 && selectedMentions.length === 0
                              ? "No records pass the current issuer text rule in this window. Review held matches; some may still concern this company."
                              : feedFilter !== "all" && activeMentionFeed?.loaded && selectedMentions.length === 0
                                ? `No ${FILTERS.find((filter) => filter.key === feedFilter)?.label.toLowerCase()} items in this ${windowLabel(windowHours)} window.`
                              : selectedMentions.length === 0
                              ? !health
                                ? "No saved mentions in this window yet."
                                : !health.externalRequestsEnabled || !health.deliveryHealth.some((source) => source.enabled)
                                  ? "No saved mentions in this window yet. Live collection is paused."
                                  : !(health.health.classifier ?? health.health.jev).enabled
                                    ? "No saved mentions in this window yet. Classification is paused; collected real-source items remain pending."
                                    : "No saved mentions in this window yet. Waiting for a real-source delivery and classification."
                              : feedFilter === "all" && selectedMentions.length > 0 && selectedMentions.every((mention) => mention.status === "off_target" || mention.status === "excluded")
                                ? activeMentionFeed?.nextCursor != null
                                  ? `The newest ${selectedMentions.length} saved items are off-target. Load older items or choose Off-target to inspect them.`
                                  : `No in-scope saved mentions. ${selectedMentions.length} off-target ${selectedMentions.length === 1 ? "item is" : "items are"} hidden; choose Off-target to review them.`
                                : "Nothing matches this filter."}
                      </div>
                    )}
                    {activeMentionFeed?.loadMoreError && (
                      <div className="px-3 py-2 text-[11px] text-amber-200/80" role="status">
                        Older matching items could not be loaded. Try again.
                      </div>
                    )}
                    {activeMentionFeed?.nextCursor != null && (
                      <button
                        type="button"
                        onClick={() => void loadOlderMentions()}
                        disabled={activeMentionFeed.loadingMore}
                        className="self-center rounded-md border border-white/10 px-3 py-2 text-[11px] text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white/80 disabled:cursor-wait disabled:opacity-50"
                        aria-busy={activeMentionFeed.loadingMore}
                      >
                        {activeMentionFeed.loadingMore
                          ? "Loading older items…"
                          : feedFilter === "identity_review" ? "Load older held matches"
                            : feedFilter === "history" ? "Load older saved records"
                            : feedFilter === "failed" ? "Load older unscored items" : "Load older matching items"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 pb-2 xl:grid-cols-2">
                  <OutcomeCheck
                    companyId={selected.id}
                    ticker={selected.ticker}
                    hours={windowHours}
                    refreshToken={outcomeRefreshRevision}
                    onRetry={() => setOutcomeRefreshRevision((revision) => revision + 1)}
                  />
                  <ValidationPanel />
                </div>
              </div>
            </>
            )
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-white/35">
              {companies.length === 0 ? (
                <CompanyInventoryState state={companiesLoadState} onRetry={() => {
                  setCompaniesLoadState("loading");
                  void refreshBackendSnapshot(true);
                }} />
              ) : "Select a company from the watchlist."}
            </div>
          )}
        </main>

      </div>

      <StatusBar health={health} session={session} connected={connected} tape={tape} />
    </div>
    <MentionDrawer
      mention={drawerMention}
      onClose={closeDrawer}
      retryAvailability={retryAvailability}
      refreshWarning={drawerRefreshWarning}
      onRetryRefresh={() => void refreshBackendSnapshot()}
      onOpenOperations={openOperationsFromDrawer}
      onReviewChanged={reportResearchReviewChanged}
      onOpenResearchQueue={openResearchQueue}
      tickerOf={tickerOf}
      knownTickers={knownTickers}
      companyNameOf={companyNameOf}
    />
    </>
  );
}

function isApplicationMention(mention: Mention): boolean {
  return String(mention.collector) !== "demo_simulation" && mention.score?.engine !== "demo-sim";
}

function upsertMention(mentions: Mention[], mention: Mention, limit: number): Mention[] {
  if (!isApplicationMention(mention)) return mentions;
  const existingIndex = mentions.findIndex((item) => item.id === mention.id);
  if (existingIndex < 0) return [mention, ...mentions].slice(0, limit);
  const updated = mentions.slice();
  updated[existingIndex] = mention;
  return updated;
}

function mergeSnapshotWithLive(
  snapshot: Mention[],
  current: Mention[],
  latestStreamed: Map<string, { sequence: number; mention: Mention }>,
  sequenceAtStart: number,
  limit: number,
  preserveUnseenCurrent = true,
): Mention[] {
  const snapshotIds = new Set(snapshot.map((mention) => mention.id));
  const responseRows = snapshot.map((mention) => {
    const streamed = latestStreamed.get(mention.id);
    return streamed && streamed.sequence > sequenceAtStart ? streamed.mention : mention;
  });
  const unseenCurrent = preserveUnseenCurrent
    ? current.filter((mention) => !snapshotIds.has(mention.id) && isApplicationMention(mention))
    : [...latestStreamed.values()]
      .filter((streamed) => streamed.sequence > sequenceAtStart && !snapshotIds.has(streamed.mention.id))
      .map((streamed) => streamed.mention);
  return [...unseenCurrent, ...responseRows].slice(0, limit);
}
