import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getJSON,
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
  type FirstRunEvidenceDTO,
} from "./lib/api.js";
import { sessionInfo, type SessionInfo } from "./lib/marketHours.js";
import { Header } from "./components/Header.js";
import { MobileCompanyPicker } from "./components/MobileCompanyPicker.js";
import { Watchlist } from "./components/Watchlist.js";
import { SeriesChart } from "./components/SeriesChart.js";
import { MentionFeed } from "./components/MentionFeed.js";
import { EvidenceBreadth } from "./components/EvidenceBreadth.js";
import { ScoreBucketEvidence } from "./components/ScoreBucketEvidence.js";
import { OutcomeCheck } from "./components/OutcomeCheck.js";
import { DeskConnectionState } from "./components/DeskConnectionState.js";
import { ValidationPanel } from "./components/ValidationPanel.js";
import { MentionDrawer } from "./components/MentionDrawer.js";
import { Tape } from "./components/Tape.js";
import { AlertDeliveryStatus, HealthPanel } from "./components/HealthPanel.js";
import { SourceCoverageDisclosure } from "./components/SourceCoverageDisclosure.js";
import { TopMovers } from "./components/TopMovers.js";
import { StatusBar } from "./components/StatusBar.js";
import { FirstRunEvidenceBrief, FirstRunNoLocalData } from "./components/FirstRunEvidenceBrief.js";
import { OpportunityRadar } from "./components/OpportunityRadar.js";
import { fmtDelta, quoteSourceAgeLabel, timeAgo } from "./lib/format.js";
import { filterMentionFeed, matchesMentionFeedFilter } from "./lib/mention-filters.js";
import { operationsAttentionCount } from "./lib/operations-attention.js";
import { retryAvailabilityFor } from "./lib/retryAvailability.js";
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

function windowLabel(hours: number): string {
  return WINDOWS.find((window) => window.h === hours)?.label ?? `${hours}H`;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "bull", label: "Bullish" },
  { key: "bear", label: "Bearish" },
  { key: "material", label: "Material" },
  { key: "offtarget", label: "Off-target" },
  { key: "failed", label: "Unscored" },
] as const;
const RECONNECT_LOOKUP_BATCH_SIZE = 900;
type FilterKey = (typeof FILTERS)[number]["key"];
type ResearchView = "desk" | "radar";
type MentionFeedState = {
  companyId: string;
  filter: FilterKey;
  hours: number;
  items: Mention[];
  nextCursor: MentionPage["nextCursor"];
  loaded: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMoreError: boolean;
};
type EvidenceBreadthState = {
  companyId: string;
  hours: number;
  items: Mention[];
  hasMore: boolean;
  loaded: boolean;
  error: boolean;
};
type ScoreBucketEvidenceState = {
  companyId: string;
  hours: number;
  bucketAt: number;
  includeFromBoundary: boolean;
  expectedCount: number;
  expectedCountFreshness: "current" | "refreshing" | "error";
  items: Mention[];
  nextCursor: ScoreBucketEvidencePage["nextCursor"];
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
  const [researchView, setResearchView] = useState<ResearchView>("desk");
  const [tape, setTape] = useState<Mention[]>([]);
  const [mentionFeedPage, setMentionFeedPage] = useState<MentionFeedState | null>(null);
  const [evidenceBreadthPage, setEvidenceBreadthPage] = useState<EvidenceBreadthState | null>(null);
  const [scoreBucketEvidence, setScoreBucketEvidence] = useState<ScoreBucketEvidenceState | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesLatestScoreAvailableAt, setSeriesLatestScoreAvailableAt] = useState<number | null>(null);
  const [seriesKey, setSeriesKey] = useState<string | null>(null);
  const [seriesLoadErrorKey, setSeriesLoadErrorKey] = useState<string | null>(null);
  const [sparks, setSparks] = useState<Record<string, SeriesPoint[]>>({});
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [price, setPrice] = useState<PricePoint[]>([]);
  const [priceResultKey, setPriceResultKey] = useState<string | null>(null);
  const [priceLoadErrorKey, setPriceLoadErrorKey] = useState<string | null>(null);
  const [priceSource, setPriceSource] = useState<PriceSeriesDTO | null>(null);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [healthLoadState, setHealthLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [firstRunEvidence, setFirstRunEvidence] = useState<{ state: "loading" | "error" } | ({ state: "ready" } & FirstRunEvidenceDTO)>({ state: "loading" });
  const [connected, setConnected] = useState(false);
  const [reconnectLookupFailedIds, setReconnectLookupFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const firstEvidenceRecoveryRef = useRef(new FirstEvidenceRecovery());
  const companyHistoryVisibleRef = useRef(false);
  const [outcomeRefreshRevision, setOutcomeRefreshRevision] = useState(0);
  const [windowHours, setWindowHours] = useState(168);
  const [chartMode, setChartMode] = useState<"sentiment" | "comparison">("sentiment");
  const [feedFilter, setFeedFilter] = useState<FilterKey>("all");
  const [feedGroupFilter, setFeedGroupFilter] = useState<ExactTitleGroupFilter>(null);
  const [sortMode, setSortMode] = useState<"delta" | "alpha">("delta");
  const [clock, setClock] = useState(Date.now());
  const [session, setSession] = useState<SessionInfo>(() => sessionInfo());
  const [drawerMention, setDrawerMention] = useState<Mention | null>(null);
  const drawerMentionIdRef = useRef<string | null>(null);
  const drawerMentionRef = useRef<Mention | null>(drawerMention);
  const mentionFeedPageRef = useRef<MentionFeedState | null>(mentionFeedPage);
  const evidenceBreadthPageRef = useRef<EvidenceBreadthState | null>(evidenceBreadthPage);
  const scoreBucketEvidenceRef = useRef<ScoreBucketEvidenceState | null>(scoreBucketEvidence);
  const mentionFeedHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const scoreBucketHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const openDrawerMention = useCallback((mention: Mention | null) => {
    drawerMentionIdRef.current = mention?.id ?? null;
    setDrawerMention(mention);
  }, []);
  const closeDrawer = useCallback(() => openDrawerMention(null), [openDrawerMention]);
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
  const runtimeIdRef = useRef<string | null>(null);
  const healthRef = useRef<HealthDTO | null>(null);
  const snapshotRequestSeq = useRef(0);
  const scoreBucketRequestSeq = useRef(0);
  const scoreBucketReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
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
  const selectedQuote = selected && market ? market.quotes[selected.ticker] ?? null : null;
  const selectedSeriesKey = selectedId == null ? null : `${selectedId}:${windowHours}`;
  const selectedSeriesReady = selectedSeriesKey != null && seriesKey === selectedSeriesKey;
  const selectedSeries = selectedSeriesReady ? series : [];
  const selectedSeriesHistoryLatestScoredAt = selectedSeriesReady ? seriesLatestScoreAvailableAt : null;
  const selectedSeriesError = selectedSeriesKey != null && seriesLoadErrorKey === selectedSeriesKey;
  const selectedSeriesLastScoredAt = selectedSeries.reduce<number | null>(
    (latest, point) => point.n > 0 && point.lastScoredAt != null
      ? Math.max(latest ?? point.lastScoredAt, point.lastScoredAt)
      : latest,
    null,
  );
  const selectedSeriesHasSentiment = selectedSeriesLastScoredAt != null;
  const selectedSeriesScoredItemCount = selectedSeries.reduce((total, point) => total + point.n, 0);
  const selectedSeriesScoredBucketCount = selectedSeries.filter((point) => point.n > 0).length;
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
  const selectedPricePending = chartMode === "comparison" && selectedSeriesKey != null && !selectedPriceReady && !selectedPriceError;
  const chartHasPrice = chartMode === "comparison" && selectedPrice.length >= 2;
  const chartLoading = selectedSeriesKey != null && (
    (!selectedSeriesReady && !selectedSeriesError)
    || (selectedPricePending && !chartHasPrice && !selectedSeriesHasSentiment)
  );

  const refreshSeries = useCallback(async (companyId?: string) => {
    const id = companyId ?? selectedIdRef.current;
    if (!id) return;
    const hours = windowRef.current;
    const requestKey = `${id}:${hours}`;
    const requestSeq = ++seriesRequestSeq.current;
    setScoreBucketEvidence((current) => current?.companyId === id && current.hours === hours
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
          const expectedCount = result.points.find((point) => point.t === current.bucketAt)?.n ?? 0;
          return current.expectedCount === expectedCount && current.expectedCountFreshness === "current"
            ? current
            : { ...current, expectedCount, expectedCountFreshness: "current" };
        });
      }
    } catch {
      if (seriesRequestSeq.current === requestSeq && selectedIdRef.current === id && windowRef.current === hours) {
        setSeriesLoadErrorKey(requestKey);
        setScoreBucketEvidence((current) => current?.companyId === id && current.hours === hours
          ? { ...current, expectedCountFreshness: "error" }
          : current);
      }
    }
  }, []);

  const refreshPrice = useCallback(async () => {
    if (chartModeRef.current !== "comparison") return;
    const id = selectedIdRef.current;
    if (!id) return;
    const hours = windowRef.current;
    const requestKey = `${id}:${hours}`;
    const requestSeq = ++priceRequestSeq.current;
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
      if (priceKeyRef.current === requestKey && priceRequestSeq.current === requestSeq) setPriceLoadErrorKey(requestKey);
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
    const refreshedIds = new Set(lookupResults.flatMap((result) => [...result.refreshedIds]));
    const realTape = (tapeSnapshot ?? []).filter(isApplicationMention);
    const refreshedRows = mergeMentionPages(realTape, lookupResults.flatMap((result) => result.items));
    setReconnectLookupFailedIds(remainingLookupFailuresAfterStream(
      lookupResults.flatMap((result) => [...result.failedIds]),
      latestStreamedMention.current,
      streamSequenceAtStart,
    ));

    if (tapeSnapshot) {
      setOutcomeRefreshRevision((revision) => revision + 1);
      setTape((current) => mergeSnapshotWithLive(
        realTape,
        current,
        latestStreamedMention.current,
        streamSequenceAtStart,
        60,
        !reset,
      ));
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
              && matchesMentionFeedFilter(mention, current.filter),
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
    void refreshSeries();
    void refreshPrice();
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
    if (chartMode === "comparison") void refreshPrice();
  }, [chartMode, refreshPrice]);

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
        if (runtimeChanged) {
          snapshotRequestSeq.current += 1;
          mentionStreamSequence.current += 1;
          latestStreamedMention.current.clear();
          setCompanies([]);
          setCompaniesLoadState("loading");
          setTape([]);
          setMarket(null);
          setSparks({});
          setMentionFeedPage(null);
          setEvidenceBreadthPage(null);
          drawerMentionIdRef.current = null;
          setDrawerMention(null);
          setHealth(null);
          setHealthLoadState("loading");
          healthRef.current = null;
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
        setConnected(true);
      },
      onState: setConnected,
      onMention: (m) => {
        if (!isApplicationMention(m)) return;
        if (m.companyId === selectedIdRef.current) {
          setOutcomeRefreshRevision((revision) => revision + 1);
        }
        const sequence = ++mentionStreamSequence.current;
        latestStreamedMention.current.delete(m.id);
        latestStreamedMention.current.set(m.id, { sequence, mention: m });
        if (latestStreamedMention.current.size > 500) {
          const oldestId = [...latestStreamedMention.current.keys()]
            .find((id) => id !== drawerMentionIdRef.current);
          if (oldestId !== undefined) latestStreamedMention.current.delete(oldestId);
        }
        setTape((prev) => upsertMention(prev, m, 60));
        setMentionFeedPage((current) => {
          if (!current || current.companyId !== m.companyId || !current.loaded) return current;
          const items = mentionIsInWindow(m, current.hours)
            && matchesMentionFeedFilter(m, current.filter)
            ? mergeMentionPages(current.items, [m])
            : current.items.filter((item) => item.id !== m.id);
          return { ...current, items };
        });
        setEvidenceBreadthPage((current) => {
          if (!current || current.companyId !== m.companyId || !current.loaded) return current;
          const items = mentionIsInWindow(m, current.hours)
            ? mergeMentionPages(current.items, [m]).slice(0, 100)
            : current.items.filter((item) => item.id !== m.id);
          return { ...current, items };
        });
        setScoreBucketEvidence((current) => reconcileScoreBucketOnMention(current, m));
        setDrawerMention((current) => current?.id === m.id ? m : current);
        const now = Date.now();
        if (scoreBucketEvidenceRef.current?.companyId === m.companyId && bucketRefreshTimer == null) {
          bucketRefreshTimer = window.setTimeout(() => {
            bucketRefreshTimer = null;
            lastSeriesRefresh = Date.now();
            void refreshSeries(m.companyId);
          }, 1_000);
        } else if (now - lastSeriesRefresh > 8_000) {
          lastSeriesRefresh = now;
          void refreshSeries();
          void refreshPrice();
        }
      },
      onCompany: (s) => setCompanies((prev) => prev.map((c) => (c.id === s.id ? s : c))),
      onQuotes: (s) =>
        setMarket((prev) => ({ quotes: { ...prev?.quotes, ...s.quotes }, updatedAt: s.updatedAt })),
    });
    return () => {
      close();
      if (bucketRefreshTimer != null) window.clearTimeout(bucketRefreshTimer);
    };
  }, [refreshBackendSnapshot, refreshSeries, refreshPrice]);

  // Series + price for the selected company: on select/window change and on timers.
  useEffect(() => {
    if (!selectedId) return;
    void refreshSeries(selectedId);
    void refreshPrice();
    const t = setInterval(() => {
      void refreshSeries(selectedId);
      void refreshPrice();
    }, 30_000);
    return () => clearInterval(t);
  }, [selectedId, windowHours, refreshSeries, refreshPrice]);

  // Each Desk filter has its own server-side cursor. Failed and pending work
  // is unbounded by age so an old provider failure remains recoverable.
  useEffect(() => {
    if (!selectedId) {
      setMentionFeedPage(null);
      return;
    }
    let alive = true;
    const companyId = selectedId;
    const filter = feedFilter;
    const hours = mentionWindowHours(filter, windowHours);
    const streamSequenceAtStart = mentionStreamSequence.current;
    setMentionFeedPage({
      companyId, filter, hours, items: [], nextCursor: null, loaded: false,
      loadingMore: false, error: false, loadMoreError: false,
    });
    const params = mentionPageParams(filter, hours);
    getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`)
      .then((page) => {
        if (!alive) return;
        setMentionFeedPage((current) => {
          if (!current || current.companyId !== companyId || current.filter !== filter || current.hours !== hours) return current;
          const reconciled = mergeSnapshotWithLive(
            page.items,
            [],
            latestStreamedMention.current,
            streamSequenceAtStart,
            page.items.length + latestStreamedMention.current.size,
            false,
          ).filter(isApplicationMention).filter((mention) => matchesMentionFeedFilter(mention, filter));
          return {
            ...current,
            items: reconciled,
            nextCursor: page.nextCursor,
            loaded: true,
            loadingMore: false,
            error: false,
            loadMoreError: false,
          };
        });
      })
      .catch(() => {
        if (!alive) return;
        setMentionFeedPage((current) => {
          if (!current || current.companyId !== companyId || current.filter !== filter || current.hours !== hours) return current;
          return { ...current, error: true };
        });
      });
    return () => { alive = false; };
  }, [selectedId, snapshotRevision, feedFilter, windowHours]);

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
    setEvidenceBreadthPage({ companyId, hours, items: [], hasMore: false, loaded: false, error: false });
    const params = mentionPageParams("all", hours, null, 100);
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
          : { companyId, hours, items, hasMore: page.nextCursor != null, loaded: true, error: false });
      })
      .catch(() => {
        if (!alive) return;
        setEvidenceBreadthPage((current) => !current || current.companyId !== companyId || current.hours !== hours
          ? current
          : { ...current, error: true });
      });
    return () => { alive = false; };
  }, [selectedId, snapshotRevision, windowHours]);

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
        if (next != null) setSelectedId(next);
        e.preventDefault();
      };
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (["1", "2", "3", "4"].includes(e.key)) setWindowHours(WINDOWS[Number(e.key) - 1]?.h ?? 24);
      else if (e.key === "f") {
        const i = FILTERS.findIndex((f) => f.key === feedFilter);
        setFeedFilter(FILTERS[(i + 1) % FILTERS.length]?.key ?? "all");
      } else if (e.key === "c") setChartMode((m) => (m === "comparison" ? "sentiment" : "comparison"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerMention, feedFilter]);

  // Fresh, high-strength events across the whole watchlist: the speed lane.
  const breaking = useMemo(
    () =>
      tape.filter(
        (m) => m.score && m.publishedAt != null && m.score.eventScore >= 60 && Date.now() - m.publishedAt < 45 * 60_000,
      ).slice(0, 6),
    [tape],
  );

  const tickerOf = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.ticker ?? id.slice(0, 4).toUpperCase(),
    [companies],
  );
  const activeMentionFeed = selectedId
    && mentionFeedPage?.companyId === selectedId
    && mentionFeedPage.filter === feedFilter
    && mentionFeedPage.hours === (feedFilter === "failed" ? 0 : windowHours)
    ? mentionFeedPage
    : undefined;
  const totalMentions = companies.reduce((acc, c) => acc + c.sourceRecords24h, 0);
  const localObservationArrived = totalMentions > 0
    || companies.some((company) => company.latestSourceCollectedAt != null)
    || tape.some(isApplicationMention)
    || Boolean(activeMentionFeed?.loaded && activeMentionFeed.items.some(isApplicationMention));
  const firstRunUndetermined = researchView === "desk"
    && firstRunEvidence.state !== "ready"
    && !localObservationArrived;
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
    ? scoreBucketEvidence
    : null;
  const activeFeedRefreshWarning = hasUnrefreshedRecord(activeMentionFeed?.items ?? [], reconnectLookupFailedIds);
  const evidenceBreadthRefreshWarning = hasUnrefreshedRecord(activeEvidenceBreadthPage?.items ?? [], reconnectLookupFailedIds);
  const scoreBucketRefreshWarning = hasUnrefreshedRecord(activeScoreBucketEvidence?.items ?? [], reconnectLookupFailedIds);
  const drawerRefreshWarning = drawerMention != null && hasUnrefreshedRecord([drawerMention], reconnectLookupFailedIds);
  const retryAvailability = retryAvailabilityFor(health);

  const loadOlderMentions = async () => {
    const current = activeMentionFeed;
    if (!current || current.nextCursor == null || current.loadingMore) return;
    const { companyId, filter, hours } = current;
    const cursor = current.nextCursor;
    const cursorKey = JSON.stringify(cursor);
    setMentionFeedPage((latest) => latest
      && latest.companyId === companyId
      && latest.filter === filter
      && latest.hours === hours
      && JSON.stringify(latest.nextCursor) === cursorKey
      ? { ...latest, loadingMore: true, loadMoreError: false }
      : latest);
    try {
      const params = mentionPageParams(filter, hours, cursor);
      const page = await getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`);
      setMentionFeedPage((latest) => {
        if (!latest || latest.companyId !== companyId || latest.filter !== filter || latest.hours !== hours || JSON.stringify(latest.nextCursor) !== cursorKey) return latest;
        return {
          ...latest,
          items: mergeMentionPages(latest.items, page.items.filter(isApplicationMention)),
          nextCursor: page.nextCursor,
          loadingMore: false,
          loadMoreError: false,
        };
      });
    } catch {
      setMentionFeedPage((latest) => !latest || latest.companyId !== companyId || latest.filter !== filter || latest.hours !== hours || JSON.stringify(latest.nextCursor) !== cursorKey
        ? latest
        : { ...latest, loadingMore: false, loadMoreError: true });
    }
  };

  const showMentionFeed = (groupFilter: ExactTitleGroupFilter = null) => {
    setFeedFilter("all");
    setFeedGroupFilter(groupFilter);
    requestAnimationFrame(() => {
      const heading = mentionFeedHeadingRef.current;
      if (!heading) return;
      heading.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "nearest",
      });
      heading.focus({ preventScroll: true });
    });
  };

  const inspectScoreBucket = useCallback(async (
    bucketAt: number,
    includeFromBoundary: boolean,
    expectedCount: number,
    returnFocus?: HTMLButtonElement,
  ) => {
    const companyId = selectedIdRef.current;
    const hours = windowRef.current;
    if (!companyId) return;
    const requestSeq = ++scoreBucketRequestSeq.current;
    scoreBucketReturnFocusRef.current = returnFocus ?? null;
    setFeedGroupFilter(null);
    setFeedFilter("all");
    setScoreBucketEvidence({
      companyId, hours, bucketAt, includeFromBoundary, expectedCount,
      expectedCountFreshness: "current", items: [],
      nextCursor: null, loading: true, loadingMore: false, error: false, loadMoreError: false,
    });
    const params = new URLSearchParams({
      through: String(bucketAt),
      hours: String(hours),
      includeFromBoundary: String(includeFromBoundary),
      limit: "50",
    });
    try {
      const page = await getJSON<ScoreBucketEvidencePage>(
        `/api/companies/${encodeURIComponent(companyId)}/score-bucket?${params}`,
      );
      if (requestSeq !== scoreBucketRequestSeq.current || selectedIdRef.current !== companyId || windowRef.current !== hours) return;
      const items = page.items.filter((mention) => isApplicationMention(mention)
        && mention.status === "scored" && mention.score != null);
      setScoreBucketEvidence((current) => !current || current.bucketAt !== bucketAt || current.companyId !== companyId
        ? current
        : { ...current, items, nextCursor: page.nextCursor, loading: false, error: false });
    } catch {
      if (requestSeq !== scoreBucketRequestSeq.current) return;
      setScoreBucketEvidence((current) => !current || current.bucketAt !== bucketAt || current.companyId !== companyId
        ? current
        : { ...current, loading: false, error: true });
    }
  }, []);

  const loadOlderScoreBucketEvidence = async () => {
    const current = activeScoreBucketEvidence;
    if (!current || !current.nextCursor || current.loading || current.loadingMore || current.error) return;
    const requestSeq = scoreBucketRequestSeq.current;
    const cursor = current.nextCursor;
    setScoreBucketEvidence((latest) => !latest || latest.bucketAt !== current.bucketAt || latest.companyId !== current.companyId
      ? latest
      : { ...latest, loadingMore: true, loadMoreError: false });
    const params = new URLSearchParams({
      through: String(current.bucketAt),
      hours: String(current.hours),
      includeFromBoundary: String(current.includeFromBoundary),
      limit: "50",
      cursor: JSON.stringify(cursor),
    });
    try {
      const page = await getJSON<ScoreBucketEvidencePage>(
        `/api/companies/${encodeURIComponent(current.companyId)}/score-bucket?${params}`,
      );
      if (requestSeq !== scoreBucketRequestSeq.current) return;
      const items = page.items.filter((mention) => isApplicationMention(mention)
        && mention.status === "scored" && mention.score != null);
      setScoreBucketEvidence((latest) => !latest || latest.bucketAt !== current.bucketAt || latest.companyId !== current.companyId
        ? latest
        : {
            ...latest,
            items: mergeScoreBucketMentions(latest.items, items),
            nextCursor: page.nextCursor,
            loadingMore: false,
            loadMoreError: false,
          });
    } catch {
      if (requestSeq !== scoreBucketRequestSeq.current) return;
      setScoreBucketEvidence((latest) => !latest || latest.bucketAt !== current.bucketAt || latest.companyId !== current.companyId
        ? latest
        : { ...latest, loadingMore: false, loadMoreError: true });
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
  }, [activeScoreBucketEvidence?.bucketAt]);

  return (
    <>
    <div className="flex h-full flex-col overflow-hidden" inert={drawerMention !== null}>
      <Header connected={connected} health={health} totalMentions={totalMentions} clock={clock} />
      <MobileCompanyPicker companies={companies} selectedId={selectedId} onSelect={setSelectedId} />

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 overflow-y-auto border-r border-desk-line lg:block">
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
            selectedId={selectedId}
            sparks={sparks}
            quotes={market?.quotes ?? {}}
            onSelect={setSelectedId}
          />
        </aside>

        <main className="research-scroll flex min-h-0 flex-col overflow-y-auto px-3 py-2 sm:px-5 sm:py-3">
          <div className="mb-2 flex shrink-0 items-center gap-1" role="group" aria-label="Research view">
            {([
              ["desk", "Desk"],
              ...(health?.opportunityRadarEnabled === true ? [["radar", "Opportunity Radar"] as const] : []),
            ] as const).map(([view, label]) => (
              <button
                key={view}
                type="button"
                aria-pressed={researchView === view}
                onClick={() => setResearchView(view)}
                className={`rounded-md border px-2.5 py-1.5 text-[10.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${researchView === view ? "border-white/15 bg-white/[0.08] text-white/85" : "border-transparent text-white/40 hover:bg-white/[0.04] hover:text-white/70"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {researchView === "desk" && firstRunActive && (
            <FirstRunEvidenceBrief {...firstRunEvidence} localObservationArrived={localObservationArrived} />
          )}
          {researchView === "desk" && (
            <details className="desk-operations">
              <summary>
                <span>Sources &amp; operations</span>
                <span className="desk-operations-summary">
                  <span className={healthLoadState === "failed" || healthAttentionCount > 0 || webhookNotConfigured ? "text-amber-200/85" : "text-white/60"}>
                    {health == null
                      ? healthLoadState === "failed" ? "status unavailable" : "checking status"
                      : healthLoadState === "failed"
                        ? `refresh failed · last received status${health.externalRequestsEnabled ? " · external requests enabled" : " · saved data only"}`
                        : health.externalRequestsEnabled ? "external requests enabled" : "saved data only"}
                  </span>
                  {healthAttentionCount > 0 && healthLoadState !== "failed" && <span className="text-amber-200/80">{healthAttentionCount} health or alert signals</span>}
                  {webhookNotConfigured && <span className="text-amber-200/85">webhook not configured</span>}
                  <span className="text-white/50">Model output independently unvalidated</span>
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
                  <TopMovers companies={companies} selectedId={selectedId} onSelect={setSelectedId} />
                  <div className="panel-head mt-2 border-t border-desk-line">
                    <span className="micro">{health?.externalRequestsEnabled && health.deliveryHealth.some((source) => source.enabled) ? "Live tape" : "Recent tape"}</span>
                  </div>
                  <Tape mentions={tape} tickerOf={tickerOf} onOpen={openDrawerMention} />
                </details>
              </div>
            </details>
          )}
          {selected ? (
            researchView === "radar" ? (
              <OpportunityRadar
                key={selected.id}
                companyId={selected.id}
                ticker={selected.ticker}
                hours={windowHours}
                onHours={setWindowHours}
              />
            ) : firstRunActive ? (
              <FirstRunNoLocalData
                company={selected.name}
                ticker={selected.ticker}
                state="empty"
                secCollectorEnabled={firstRunEvidence.state === "ready" && firstRunEvidence.secCollectorEnabled}
                jevSecScoringEnabled={firstRunEvidence.state === "ready" && firstRunEvidence.jevSecScoringEnabled}
                classifierProvider={firstRunEvidence.state === "ready" ? firstRunEvidence.classifierProvider : health?.health.classifier?.provider}
                classifierSecClassificationEnabled={firstRunEvidence.state === "ready" && firstRunEvidence.classifierSecClassificationEnabled === true}
                classifierBlockedReason={firstRunEvidence.state === "ready" ? firstRunEvidence.classifierBlockedReason : health?.health.classifier?.blockedReason}
              />
            ) : firstRunUndetermined ? (
              <FirstRunNoLocalData
                company={selected.name}
                ticker={selected.ticker}
                state={firstRunEvidence.state === "loading" ? "checking" : "unavailable"}
                secCollectorEnabled={false}
                jevSecScoringEnabled={false}
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
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-white/40">
                    <span>
                      {selected.sector} · {windowLabel(windowHours)} saved window · {selectedSeriesError
                        ? "score history unavailable"
                          : !selectedSeriesReady
                            ? "loading saved history"
                            : selectedSeriesScoredItemCount > 0
                            ? `${selectedSeriesScoredItemCount} scored records · ${selectedSeriesLastScoredAt == null ? "latest time unavailable" : `latest ${timeAgo(selectedSeriesLastScoredAt)}`}`
                            : `No scored records in ${windowLabel(windowHours)}`}
                      {health?.health.classifier?.provider === "openai_luna" && <span title="Luna supplies categories for new records. Historical Jev probabilities and this chart retain their original profile; no synthetic probability or impact is assigned."> · new judgments: Luna</span>}
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
                <div className="flex w-full flex-row justify-between gap-1 pt-2 sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-start sm:pt-0">
                  {WINDOWS.map((w, i) => (
                    <button
                      key={w.h}
                      onClick={() => setWindowHours(w.h)}
                      aria-pressed={windowHours === w.h}
                      className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
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

              {selectedSeriesReady && !selectedSeriesHasSentiment && health?.health.classifier?.provider === "openai_luna" && chartMode === "sentiment" ? (
                <section className="panel mt-2 px-3 py-3 text-[12px] text-white/55" role="status">
                  No historical Jev index in this window. Inspect saved source records and categorical judgments below.
                  <button type="button" className="ml-2 rounded border border-white/10 px-2 py-1 text-white/75" onClick={() => setChartMode("comparison")}>Inspect saved price history</button>
                </section>
              ) : <div className="panel mt-2 shrink-0">
                <div className="panel-head chart-panel-head">
                  <div className="chart-panel-topline">
                    <span className="micro">
                      {chartMode === "comparison" ? "Historical Jev Impact Index + Price" : "Historical Jev Impact Index"}
                    </span>
                    <button
                      onClick={() => setChartMode((m) => (m === "comparison" ? "sentiment" : "comparison"))}
                      aria-pressed={chartMode === "comparison"}
                  aria-label={chartMode === "comparison" ? "Switch to Jev impact index only" : "Compare Jev impact index with share price"}
                      className="tabnum rounded border border-white/10 px-1.5 py-[1px] hover:bg-white/[0.05]"
                    >
                      {chartMode === "comparison" ? "Index only" : "Compare price"}
                      <kbd className="ml-1">c</kbd>
                    </button>
                  </div>
                  <div className="chart-panel-meta flex items-center gap-2 text-[11px] text-white/60">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-[3px] w-3 rounded-sm bg-gradient-to-r from-rose-400 to-emerald-400" />
                      Sequential index · fixed 8h decay · −100 to +100
                    </span>
                    <span title="Bars count Jev-scored source records completed in each 15-minute bucket. Repeated coverage may count more than once; bars do not count distinct stories or investors.">
                      <span className="mr-1 inline-block h-[7px] w-[7px] rounded-sm bg-slate-400/70" />scored records / 15m
                    </span>
                    <span
                      className="text-white/65"
                      title="Count of Jev-scored source records by score-availability time. Syndicated or repeated coverage can appear as multiple records; this is not a count of independent investor opinions."
                    >
                      {selectedSeriesScoredItemCount} source records · {selectedSeriesScoredBucketCount} buckets · repeats included
                    </span>
                    <span className="text-white/65">
                      {selectedSeriesFreshness}
                    </span>
                    <span className="flex items-center gap-1 text-white/65" title="Dashed segments show the index fading between buckets with newly scored items.">
                      <span className="inline-block w-3 border-t border-dashed border-slate-300/80" /> modeled decay
                    </span>
                    {chartMode === "comparison" && (
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-[2px] w-3 bg-white/80" /> price{selectedPriceCurrency ? ` · ${selectedPriceCurrency}` : " · unit unavailable"}
                      </span>
                    )}
                    {chartMode === "comparison" && (
                      <span
                        className={selectedPriceError || selectedPriceSource?.refreshError ? "text-amber-200" : "text-white/65"}
                        title={selectedPriceSource ? `${selectedPriceCollector ?? "Provider unknown"}; delivery ${selectedPrice.at(-1)?.deliveryId ?? "unknown"}; latest source observation ${selectedPriceSource.sourceLatestAt == null ? "time unknown" : new Date(selectedPriceSource.sourceLatestAt).toISOString()}; latest point retrieved ${selectedPriceRetrievedAt == null ? "time unknown" : new Date(selectedPriceRetrievedAt).toISOString()}${selectedPriceSource.refreshError ? "; refresh failed; saved data retained" : ""}; served ${new Date(selectedPriceSource.servedAt).toISOString()}${selectedPriceSource.cacheAgeMs == null ? "" : `; memory cache age ${Math.round(selectedPriceSource.cacheAgeMs / 1000)}s`}; only provider-timestamped points with known currency are plotted.` : undefined}
                      >
                        {selectedPriceError || selectedPriceSource?.refreshError ? selectedPriceReady ? "refresh failed · keeping saved series" : "price history unavailable" : selectedPriceSource
                          ? `${selectedPriceCollector ?? "provider unknown"} · ${selectedPriceSource.delivery.replaceAll("_", " ")}${selectedPriceSource.cacheAgeMs == null ? "" : ` ${Math.round(selectedPriceSource.cacheAgeMs / 1000)}s`} · source ${timeAgo(selectedPriceSource.sourceLatestAt)}`
                          : "price waiting"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="chart-context-layout px-3 py-2">
                  <div className="chart-context-plot">
                    <SeriesChart
                      key={`${selectedSeriesKey ?? "no-selection"}:${chartMode}`}
                      points={selectedSeries}
                      hours={windowHours}
                      loading={chartLoading}
                      mode={chartMode}
                      price={selectedPrice}
                      currency={selectedPriceCurrency}
                      latestPriceAt={selectedPriceSource?.sourceLatestAt ?? null}
                      latestScoreAvailableAt={selectedSeriesHistoryLatestScoredAt}
                      onViewHistory={() => setWindowHours(168)}
                      onSelectBucket={(bucketAt, includeFromBoundary, returnFocus) => {
                        const bucket = selectedSeries.find((point) => point.t === bucketAt);
                        void inspectScoreBucket(bucketAt, includeFromBoundary, bucket?.n ?? 0, returnFocus);
                      }}
                      bucketEvidence={activeScoreBucketEvidence ? (
                        <ScoreBucketEvidence
                          bucketAt={activeScoreBucketEvidence.bucketAt}
                          expectedCount={activeScoreBucketEvidence.expectedCount}
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
                          onRetry={() => void inspectScoreBucket(
                            activeScoreBucketEvidence.bucketAt,
                            activeScoreBucketEvidence.includeFromBoundary,
                            activeScoreBucketEvidence.expectedCount,
                          )}
                          refreshWarning={scoreBucketRefreshWarning}
                          onRetryRefresh={() => void refreshBackendSnapshot()}
                          onLoadMore={() => void loadOlderScoreBucketEvidence()}
                        />
                      ) : null}
                      priceLoading={selectedPricePending}
                      priceError={selectedPriceError}
                      seriesError={selectedSeriesError}
                      seriesReady={selectedSeriesReady}
                    />
                  </div>
                </div>
              </div>}

              <EvidenceBreadth
                mentions={evidenceBreadthMentions}
                hours={windowHours}
                loaded={activeEvidenceBreadthPage?.loaded === true}
                error={activeEvidenceBreadthPage?.error === true}
                hasMore={activeEvidenceBreadthPage?.hasMore === true}
                now={clock}
                refreshWarning={evidenceBreadthRefreshWarning}
                onRetry={() => setSnapshotRevision((revision) => revision + 1)}
                onRetryRefresh={() => void refreshBackendSnapshot()}
                onShowRecords={showMentionFeed}
                onOpenMention={openDrawerMention}
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
                    <h2 id="mention-feed-heading" ref={mentionFeedHeadingRef} tabIndex={-1} className="micro m-0 p-0">
                      Source records · {feedFilter === "failed" ? "all saved history" : windowLabel(windowHours)}
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
                    </div>
                  </div>
                  {activeFeedRefreshWarning && (
                    <div className="mx-2 mt-2 rounded border border-amber-300/20 bg-amber-200/[0.04] px-3 py-2 text-[11px] text-amber-100/80" role="alert">
                      Some loaded saved records could not be refreshed after reconnect and may be out of date.{" "}
                      <button type="button" className="underline underline-offset-2" onClick={() => void refreshBackendSnapshot()}>
                        Retry refresh
                      </button>
                    </div>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                    {filteredMentions.length > 0 && (
                      <div className="feed-method-note">
                        {filteredMentions.length} matching source {filteredMentions.length === 1 ? "record" : "records"}
                        {filteredMentions.some((mention) => mention.status === "scored")
                          ? " · exact-title repeats grouped"
                          : " · unscored records remain separate"}
                      </div>
                    )}
                    <MentionFeed
                      mentions={filteredMentions}
                      onOpen={openDrawerMention}
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
                            : feedFilter === "failed" && activeMentionFeed?.loaded && selectedMentions.length === 0
                              ? "No unscored items in saved history."
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
                <DeskConnectionState state={companiesLoadState} onRetry={() => {
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
