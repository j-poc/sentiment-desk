import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { getCategoricalBucket, getCategoricalTrend, getGoogleGeminiCategoricalTrend, type CategoricalBucketEvidencePage, type CategoricalTrendCounts, type CategoricalTrendPoint, type CategoricalTrendResult, type Mention } from "../lib/api.js";
import { aggregateCategoricalTrend, displayBucketMsForWindow, displayIntervalLabel, formatUtcInstant, formatUtcRange } from "../lib/categorical-chart.js";
import type { CategoricalChartSnapshot } from "../lib/chart-view-preference.js";
import { MentionFeed } from "./MentionFeed.js";

const CATEGORIES = [
  { key: "positive", label: "Positive", className: "categorical-positive" },
  { key: "neutral", label: "Neutral", className: "categorical-neutral" },
  { key: "negative", label: "Negative", className: "categorical-negative" },
  { key: "reviewRequired", label: "Needs review", className: "categorical-review" },
  { key: "excluded", label: "Excluded", className: "categorical-excluded" },
] as const;

type CategoryKey = typeof CATEGORIES[number]["key"];
type LoadState = "loading" | "ready" | "error";
type ChartProvider = "openai_luna" | "google_gemini";
const CHART_PROVIDER_PREFERENCE = "sentiment-desk.categorical-chart-provider";
type EvidenceState = {
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMoreError: boolean;
  page: CategoricalBucketEvidencePage | null;
  items: Mention[];
};

function emptyEvidence(): EvidenceState {
  return { loading: false, loadingMore: false, error: false, loadMoreError: false, page: null, items: [] };
}

function initialChartProvider(): ChartProvider {
  try {
    return window.localStorage.getItem(CHART_PROVIDER_PREFERENCE) === "google_gemini" ? "google_gemini" : "openai_luna";
  } catch {
    return "openai_luna";
  }
}

function sameCounts(a: CategoricalTrendCounts, b: CategoricalTrendCounts): boolean {
  return CATEGORIES.every(({ key }) => a[key] === b[key]) && a.total === b.total;
}

function dataFingerprint(result: CategoricalTrendResult): string {
  return JSON.stringify({
    counts: result.counts,
    points: result.points.map((point) => [point.bucketStartMs, point.counts]),
    lineages: result.lineages,
    classifierProvider: result.classifierProvider ?? "openai_luna",
    classifierModel: result.classifierModel ?? "gpt-6-luna",
    withheldInvalidCount: result.withheldInvalidCount,
    untimedObservationCount: result.untimedObservationCount,
  });
}

function exactRange(point: Pick<CategoricalTrendPoint, "fromMs" | "throughMs">): string {
  return formatUtcRange(point.fromMs, point.throughMs);
}

function readableCount(counts: CategoricalTrendCounts): string {
  return CATEGORIES.map(({ key, label }) => `${label.toLowerCase()} ${counts[key]}`).join(", ");
}

export function CategoricalEmptyState({
  withheldInvalidCount,
  classifierEnabled,
  onReviewSourceRecords,
  onViewHistoricalJev,
  onOpenOperations,
  onOpenLunaSettings,
  historicalJevSummary,
  provider = "openai_luna",
}: {
  withheldInvalidCount: number;
  classifierEnabled: boolean;
  onReviewSourceRecords: () => void;
  onViewHistoricalJev: () => void;
  onOpenOperations?: () => void;
  onOpenLunaSettings?: (provider: ChartProvider) => void;
  historicalJevSummary: string;
  provider?: ChartProvider;
}) {
  const gemini = provider === "google_gemini";
  const modelLabel = gemini ? "Gemini 3.8 Flash" : "GPT-6 Luna";
  return (
    <div className="categorical-trend-empty" role="status">
      <span className="categorical-empty-mark" aria-hidden="true">∅</span>
      <div>
        <strong>{withheldInvalidCount > 0 ? `No eligible ${modelLabel} classifications in this window` : `No saved ${modelLabel} classifications in this window`}</strong>
        <p>{withheldInvalidCount > 0
          ? `${withheldInvalidCount} candidate ${withheldInvalidCount === 1 ? "classification is" : "classifications are"} withheld because source or model lineage is incomplete.`
          : `This is an empty result, not a neutral sentiment reading. The chart fills only when real, source-linked ${modelLabel} classifications are saved.`}</p>
        {gemini
          ? <p className="categorical-blocked-reason">Chart reads never contact Google. Add a Gemini API key in model settings. Only public, non-sensitive source text is eligible, and each item needs your explicit approval; private notes are never sent from this lane. Google lists free quota for eligible models and projects where free use is allowed. Its terms require API clients made available in the EEA, Switzerland, and UK to use Paid Services through an actively billed Cloud project; a free-tier-only project is not eligible there, and Gemini 3.8 Flash paid-tier usage is metered. If you require strictly $0 use in those regions, do not send Gemini requests. Elsewhere, free quota depends on project eligibility and remaining quota, and unpaid-service prompts may be used to improve Google products and reviewed by people. Usage beyond quota may be charged. The app cannot verify your region, eligibility, billing, or remaining quota, or limit provider charges.</p>
          : !classifierEnabled && <p className="categorical-blocked-reason">New Luna classifications are currently paused. Check GPT-6 Luna access and source availability; saved classifications remain available with their source evidence.</p>}
        <div className="categorical-empty-actions">
          <button type="button" onClick={onReviewSourceRecords}>Review saved source records</button>
          <button type="button" className="categorical-history-action" onClick={onViewHistoricalJev}>
            <span>View historical Jev chart</span>
            <span className="categorical-history-action-detail">{historicalJevSummary}</span>
          </button>
          {onOpenOperations && (!classifierEnabled || withheldInvalidCount > 0) && <button type="button" onClick={onOpenOperations}>Review classification availability</button>}
          {onOpenLunaSettings && (gemini || !classifierEnabled || withheldInvalidCount > 0) && <button type="button" onClick={() => onOpenLunaSettings(gemini ? "google_gemini" : "openai_luna")}>{gemini ? "Open Gemini model settings" : "Open GPT-6 Luna access"}</button>}
        </div>
      </div>
    </div>
  );
}

export function CategoricalUntimedState({
  count, historicalJevSummary, onReviewSourceRecords, onViewHistoricalJev, onOpenOperations, onOpenLunaSettings, provider = "openai_luna",
}: {
  count: number;
  historicalJevSummary: string;
  onReviewSourceRecords: () => void;
  onViewHistoricalJev: () => void;
  onOpenOperations?: () => void;
  onOpenLunaSettings?: (provider: ChartProvider) => void;
  provider?: ChartProvider;
}) {
  const modelLabel = provider === "google_gemini" ? "Gemini 3.8 Flash" : "Luna";
  return (
    <div className="categorical-trend-empty" role="status">
      <span className="categorical-empty-mark" aria-hidden="true">◷</span>
      <div>
        <strong>No eligible {modelLabel} classifications have a usable source time</strong>
        <p>{count} saved source {count === 1 ? "observation has" : "observations have"} no validated publisher, feed, or provider timestamp. They are excluded from the timeline; retrieval and classification times are retained on the records.</p>
        <div className="categorical-empty-actions">
          <button type="button" onClick={onReviewSourceRecords}>Review saved source records</button>
          <button type="button" className="categorical-history-action" onClick={onViewHistoricalJev}>
            <span>View historical Jev chart</span>
            <span className="categorical-history-action-detail">{historicalJevSummary}</span>
          </button>
          {onOpenOperations && <button type="button" onClick={onOpenOperations}>Review classification availability</button>}
          {onOpenLunaSettings && <button type="button" onClick={() => onOpenLunaSettings(provider)}>{provider === "google_gemini" ? "Open Gemini model settings" : "Open GPT-6 Luna access"}</button>}
        </div>
      </div>
    </div>
  );
}

function mentionCounts(items: Mention[]): CategoricalTrendCounts {
  const counts: CategoricalTrendCounts = { positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0 };
  for (const item of items) {
    const classification = item.classification;
    const providerClassification = item.providerCategorical;
    const disposition = providerClassification?.disposition ?? classification?.disposition;
    const sentiment = providerClassification?.sentiment ?? classification?.sentiment;
    if (disposition === "excluded") counts.excluded += 1;
    else if (disposition === "review_required" || sentiment == null) counts.reviewRequired += 1;
    else counts[sentiment] += 1;
    counts.total += 1;
  }
  return counts;
}

function completeEvidenceMatches(items: Mention[], counts: CategoricalTrendCounts): boolean {
  return new Set(items.map((item) => item.id)).size === items.length
    && items.length === counts.total
    && sameCounts(mentionCounts(items), counts);
}

function mergeMentions(current: Mention[], next: Mention[]): Mention[] {
  const byId = new Map(current.map((mention) => [mention.id, mention]));
  for (const mention of next) byId.set(mention.id, mention);
  return [...byId.values()];
}

function validatedSourceTime(item: Mention): number | null {
  if (item.timeBasis === "publisher_declared") return item.publishedAt;
  if (item.timeBasis === "aggregator_declared") return item.aggregatorPublishedAt ?? item.publishedAt;
  if (item.timeBasis === "provider_observed") return item.providerObservedAt;
  return null;
}

export function CategoricalTrendChart({
  companyId,
  hours,
  active,
  refreshRevision = 0,
  providerClassificationRevision = 0,
  classifierEnabled,
  onOpenMention,
  onOpenOperations,
  onOpenLunaSettings,
  onViewHistoricalJev,
  onReviewSourceRecords,
  onSnapshot,
  historicalJevSummary,
}: {
  companyId: string;
  hours: number;
  active: boolean;
  refreshRevision?: number;
  providerClassificationRevision?: number;
  classifierEnabled: boolean;
  onOpenMention: (mention: Mention) => void;
  onOpenOperations?: () => void;
  onOpenLunaSettings?: (provider: ChartProvider) => void;
  onViewHistoricalJev: () => void;
  onReviewSourceRecords: () => void;
  onSnapshot: (snapshot: CategoricalChartSnapshot) => void;
  historicalJevSummary: string;
}) {
  const [provider, setProvider] = useState<ChartProvider>(initialChartProvider);
  const [result, setResult] = useState<CategoricalTrendResult | null>(null);
  const resultRef = useRef<CategoricalTrendResult | null>(null);
  const [pendingResult, setPendingResult] = useState<CategoricalTrendResult | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  const [selectedBucketStartMs, setSelectedBucketStartMs] = useState<number | null>(null);
  const selectedBucketRef = useRef<number | null>(null);
  const [evidence, setEvidence] = useState<EvidenceState>(emptyEvidence);
  const [focusedBucket, setFocusedBucket] = useState(0);
  const requestSequence = useRef(0);
  const lastSuccessfulRefreshAtRef = useRef<number | null>(null);
  const handledRefreshRevisionRef = useRef(0);
  const handledProviderClassificationRevisionRef = useRef(providerClassificationRevision);
  const bucketSequence = useRef(0);
  const barRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const evidenceHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const plotScrollRef = useRef<HTMLDivElement | null>(null);
  const nearLatestRef = useRef(true);
  const displayBucketMs = displayBucketMsForWindow(hours);

  const applyResult = useCallback((next: CategoricalTrendResult) => {
    const plot = plotScrollRef.current;
    if (plot) nearLatestRef.current = plot.scrollWidth - plot.clientWidth - plot.scrollLeft <= 24;
    resultRef.current = next;
    setResult(next);
    setPendingResult(null);
    setLoadState("ready");
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoadState("loading");
    onSnapshot({
      companyId,
      windowHours: hours,
      provider,
      status: "loading",
      eligibleObservationCount: resultRef.current?.eligibleObservationCount ?? null,
      observedAt: lastSuccessfulRefreshAtRef.current,
    });
    try {
      const next = provider === "google_gemini"
        ? await getGoogleGeminiCategoricalTrend(companyId, hours)
        : await getCategoricalTrend(companyId, hours);
      if (sequence !== requestSequence.current) return;
      if (next.companyId !== companyId || next.windowHours !== hours) throw new Error("Trend identity did not match the selected company and window");
      if (provider === "google_gemini" && (next.classifierProvider !== "google_gemini" || next.classifierModel !== "gemini-3.8-flash")) {
        throw new Error("Trend provider lineage did not match the selected Google Gemini lane");
      }
      if (provider === "openai_luna" && next.classifierProvider != null) throw new Error("Trend provider lineage did not match the selected GPT-6 Luna lane");
      lastSuccessfulRefreshAtRef.current = Date.now();
      onSnapshot({
        companyId: next.companyId,
        windowHours: next.windowHours,
        provider,
        status: "ready",
        eligibleObservationCount: next.eligibleObservationCount,
        observedAt: lastSuccessfulRefreshAtRef.current,
      });
      const current = resultRef.current;
      if (current && current.snapshotGeneration !== next.snapshotGeneration) {
        bucketSequence.current += 1;
        selectedBucketRef.current = null;
        setSelectedBucketStartMs(null);
        setEvidence(emptyEvidence());
        setSnapshotNotice("Desk restarted. The chart and source evidence were refreshed from a new saved snapshot.");
        applyResult(next);
      } else if (selectedBucketRef.current != null && current != null) {
        if (dataFingerprint(current) !== dataFingerprint(next)) setPendingResult(next);
      } else {
        // Apply each fresh token and rolling-window boundary even when its counts are unchanged.
        applyResult(next);
      }
      setLoadState("ready");
    } catch {
      if (sequence === requestSequence.current) {
        setLoadState("error");
        onSnapshot({
          companyId,
          windowHours: hours,
          provider,
          status: "failed",
          eligibleObservationCount: resultRef.current?.eligibleObservationCount ?? null,
          observedAt: lastSuccessfulRefreshAtRef.current,
        });
      }
    }
  }, [applyResult, companyId, hours, onSnapshot, provider]);

  useEffect(() => {
    resultRef.current = null;
    lastSuccessfulRefreshAtRef.current = null;
    selectedBucketRef.current = null;
    setResult(null);
    setPendingResult(null);
    setSelectedBucketStartMs(null);
    setEvidence(emptyEvidence());
    setFocusedBucket(0);
    setSnapshotNotice(null);
    setLoadState("loading");
  }, [companyId, hours, provider]);

  useEffect(() => {
    if (!active) return;
    if (lastSuccessfulRefreshAtRef.current == null || Date.now() - lastSuccessfulRefreshAtRef.current > 5_000) {
      void refresh();
    }
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      requestSequence.current += 1;
      window.clearInterval(timer);
    };
  }, [active, refresh]);

  useEffect(() => {
    if (handledRefreshRevisionRef.current === refreshRevision) return;
    handledRefreshRevisionRef.current = refreshRevision;
    if (active || refreshRevision === 0) return;
    // Keep the Luna snapshot fresh when a new result arrives while the user
    // deliberately inspects the historical archive. Routine polling remains
    // limited to the visible chart, and this refresh is debounced.
    const timer = window.setTimeout(() => void refresh(), 150);
    return () => window.clearTimeout(timer);
  }, [active, refresh, refreshRevision]);

  useEffect(() => {
    if (handledProviderClassificationRevisionRef.current === providerClassificationRevision) return;
    handledProviderClassificationRevisionRef.current = providerClassificationRevision;
    if (provider !== "google_gemini") return;
    const timer = window.setTimeout(() => void refresh(), 150);
    return () => window.clearTimeout(timer);
  }, [provider, providerClassificationRevision, refresh]);

  useEffect(() => () => {
    requestSequence.current += 1;
    bucketSequence.current += 1;
  }, []);

  useEffect(() => {
    if (!result) return;
    requestAnimationFrame(() => {
      const plot = plotScrollRef.current;
      if (plot && nearLatestRef.current) plot.scrollLeft = plot.scrollWidth;
      if (plot) nearLatestRef.current = plot.scrollWidth - plot.clientWidth - plot.scrollLeft <= 24;
    });
  }, [result]);

  useEffect(() => {
    if (selectedBucketStartMs == null || evidence.loading || evidence.error || evidence.page == null) return;
    requestAnimationFrame(() => evidenceHeadingRef.current?.focus());
  }, [selectedBucketStartMs, evidence.loading, evidence.error, evidence.page]);

  const displayPoints = useMemo(() => result ? aggregateCategoricalTrend(result, displayBucketMs) : [], [result, displayBucketMs]);
  const selectedPoint = useMemo(() => displayPoints.find((point) => point.bucketStartMs === selectedBucketStartMs) ?? null,
    [displayPoints, selectedBucketStartMs]);
  const maximum = Math.max(1, ...displayPoints.map((point) => point.counts.total));
  const maxAxis = Math.max(1, Math.ceil(maximum / 4) * 4);

  const inspectBucket = useCallback(async (bucketStartMs: number, returnFocus: HTMLButtonElement) => {
    const current = resultRef.current;
    if (!current) return;
    const sequence = ++bucketSequence.current;
    selectedBucketRef.current = bucketStartMs;
    returnFocusRef.current = returnFocus;
    setSelectedBucketStartMs(bucketStartMs);
    setEvidence({ ...emptyEvidence(), loading: true });
    try {
      const page = await getCategoricalBucket({ companyId, snapshotKey: current.snapshotKey, bucketStartMs, bucketDurationMs: displayBucketMs, limit: 50, provider });
      if (sequence !== bucketSequence.current || selectedBucketRef.current !== bucketStartMs) return;
      const point = aggregateCategoricalTrend(current, displayBucketMs).find((candidate) => candidate.bucketStartMs === bucketStartMs);
      if (!point || page.companyId !== companyId || page.snapshotKey !== current.snapshotKey
        || page.bucketStartMs !== bucketStartMs || page.bucketDurationMs !== displayBucketMs
        || page.fromMs !== point.fromMs || page.throughMs !== point.throughMs
        || !sameCounts(page.counts, point.counts)
        || page.items.some((item) => {
          const sourceTime = validatedSourceTime(item);
          const classifiedAt = provider === "google_gemini" ? item.providerCategorical?.classifiedAt : item.classification?.classifiedAt;
          return classifiedAt == null || sourceTime == null || sourceTime < page.fromMs || sourceTime >= page.throughMs;
        })) {
        throw new Error("Chart and source records could not be reconciled");
      }
      if ((page.nextCursor == null && !completeEvidenceMatches(page.items, page.counts))
        || (page.nextCursor != null && (page.items.length === 0 || page.items.length >= page.counts.total))) {
        throw new Error("The source page did not reconcile to the bucket total");
      }
      setEvidence({ loading: false, loadingMore: false, error: false, loadMoreError: false, page, items: page.items });
    } catch {
      if (sequence === bucketSequence.current && selectedBucketRef.current === bucketStartMs) {
        setEvidence({ ...emptyEvidence(), error: true });
      }
    }
  }, [companyId, displayBucketMs, provider]);

  const loadMore = useCallback(async () => {
    const page = evidence.page;
    const current = resultRef.current;
    const bucketStartMs = selectedBucketRef.current;
    if (!page?.nextCursor || !current || bucketStartMs == null) return;
    const sequence = ++bucketSequence.current;
    setEvidence((state) => ({ ...state, loadingMore: true, loadMoreError: false }));
    try {
      const next = await getCategoricalBucket({
        companyId, snapshotKey: page.snapshotKey, bucketStartMs, bucketDurationMs: page.bucketDurationMs, limit: 50, cursor: page.nextCursor, provider,
      });
      if (sequence !== bucketSequence.current || selectedBucketRef.current !== bucketStartMs) return;
      if (next.snapshotKey !== current.snapshotKey || next.bucketStartMs !== bucketStartMs
        || next.bucketDurationMs !== page.bucketDurationMs || next.fromMs !== page.fromMs || next.throughMs !== page.throughMs
        || !sameCounts(next.counts, page.counts)
        || next.items.some((item) => {
          const sourceTime = validatedSourceTime(item);
          const classifiedAt = provider === "google_gemini" ? item.providerCategorical?.classifiedAt : item.classification?.classifiedAt;
          return classifiedAt == null || sourceTime == null || sourceTime < next.fromMs || sourceTime >= next.throughMs;
        })) {
        throw new Error("Bucket page did not match its frozen source snapshot");
      }
      const existingIds = new Set(evidence.items.map((item) => item.id));
      if (next.items.some((item) => existingIds.has(item.id))) throw new Error("A source observation repeated across bucket pages");
      const mergedItems = mergeMentions(evidence.items, next.items);
      if ((next.nextCursor == null && !completeEvidenceMatches(mergedItems, next.counts))
        || (next.nextCursor != null && mergedItems.length >= next.counts.total)) {
        throw new Error("Paginated source records did not reconcile to the bucket counts");
      }
      setEvidence((state) => ({
        loading: false, loadingMore: false, error: false, loadMoreError: false,
        page: next, items: mergedItems,
      }));
    } catch {
      if (sequence === bucketSequence.current && selectedBucketRef.current === bucketStartMs) {
        setEvidence((state) => ({ ...state, loadingMore: false, loadMoreError: true }));
      }
    }
  }, [companyId, evidence.items, evidence.page, provider]);

  const closeBucket = useCallback(() => {
    bucketSequence.current += 1;
    selectedBucketRef.current = null;
    setSelectedBucketStartMs(null);
    setEvidence(emptyEvidence());
    if (pendingResult) applyResult(pendingResult);
    requestAnimationFrame(() => {
      const returnFocus = returnFocusRef.current;
      if (returnFocus?.isConnected) returnFocus.focus();
      else barRefs.current[displayPoints.length - 1]?.focus();
    });
  }, [applyResult, displayPoints.length, pendingResult]);

  const refreshAfterEvidenceFailure = useCallback(() => {
    bucketSequence.current += 1;
    selectedBucketRef.current = null;
    setSelectedBucketStartMs(null);
    setEvidence(emptyEvidence());
    void refresh();
  }, [refresh]);

  const onBucketKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = (displayPoints.length || 1) - 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = Math.min(lastIndex, index + 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = lastIndex;
    if (nextIndex != null) {
      event.preventDefault();
      setFocusedBucket(nextIndex);
      barRefs.current[nextIndex]?.focus();
    }
  };

  const selectedTime = selectedPoint ? exactRange(selectedPoint) : null;
  const latestText = result?.latestClassifiedAt == null
    ? "No saved classification time"
    : `Latest saved · ${formatUtcInstant(result.latestClassifiedAt)}`;
  const firstPoint = displayPoints[0];
  const middlePoint = displayPoints[Math.floor((displayPoints.length - 1) / 2)];
  const lastPoint = displayPoints.at(-1);
  const selectedCountMismatch = selectedPoint != null && evidence.page != null && !sameCounts(selectedPoint.counts, evidence.page.counts);
  const providerLabel = provider === "google_gemini" ? "Google Gemini · Gemini 3.8 Flash" : "GPT-6 Luna · saved plan/API classifications";
  const switchProvider = (next: ChartProvider) => {
    if (next === provider) return;
    requestSequence.current += 1;
    bucketSequence.current += 1;
    resultRef.current = null;
    selectedBucketRef.current = null;
    setResult(null);
    setPendingResult(null);
    setSelectedBucketStartMs(null);
    setEvidence(emptyEvidence());
    setSnapshotNotice(null);
    setLoadState("loading");
    try { window.localStorage.setItem(CHART_PROVIDER_PREFERENCE, next); } catch { /* Keep the in-session choice when storage is unavailable. */ }
    setProvider(next);
  };

  return (
    <section className="categorical-trend-panel" aria-labelledby="categorical-trend-title" aria-busy={loadState === "loading"}>
      <header className="categorical-trend-header">
        <div className="categorical-trend-title-block">
          <p className="micro">CURRENT CLASSIFIER · CATEGORICAL ACTIVITY</p>
          <h2 id="categorical-trend-title">{provider === "google_gemini" ? "Gemini sentiment categories" : "GPT-6 Luna category counts"}</h2>
          <p>Source observations by validated publisher/feed/provider time · {hours === 24 ? "24 hours" : hours < 24 ? `${hours} hours` : `${hours / 24} days`} · repeated coverage included</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1" role="group" aria-label="Sentiment classifier lane">
          <button type="button" aria-pressed={provider === "google_gemini"} onClick={() => switchProvider("google_gemini")}
            className="rounded border px-2 py-1 text-[10px] font-medium"
            style={{ borderColor: provider === "google_gemini" ? "rgba(52,211,153,.45)" : "rgba(255,255,255,.12)", color: provider === "google_gemini" ? "#a7f3d0" : "rgba(255,255,255,.58)", background: provider === "google_gemini" ? "rgba(16,185,129,.08)" : "transparent" }}>
            Gemini 3.8 Flash · own API key
          </button>
          <button type="button" aria-pressed={provider === "openai_luna"} onClick={() => switchProvider("openai_luna")}
            className="rounded border px-2 py-1 text-[10px] font-medium"
            style={{ borderColor: provider === "openai_luna" ? "rgba(52,211,153,.45)" : "rgba(255,255,255,.12)", color: provider === "openai_luna" ? "#a7f3d0" : "rgba(255,255,255,.58)", background: provider === "openai_luna" ? "rgba(16,185,129,.08)" : "transparent" }}>
            GPT-6 Luna · saved history
          </button>
        </div>
        {result && loadState === "ready" && result.eligibleObservationCount > 0 && (
          <div className="categorical-trend-total" aria-label={`${result.plottedObservationCount} plotted and ${result.untimedObservationCount} untimed of ${result.eligibleObservationCount} eligible source observations`}>
            <strong className="tabnum">{result.plottedObservationCount.toLocaleString()}</strong>
            <span>plotted · {result.untimedObservationCount.toLocaleString()} untimed</span>
          </div>
        )}
      </header>

      {loadState === "loading" && !result ? (
        <div className="categorical-trend-state" role="status"><span className="categorical-loading-mark" aria-hidden="true" />Loading saved {providerLabel} classifications…</div>
      ) : loadState === "error" && !result ? (
        <div className="categorical-trend-state categorical-trend-error" role="alert">
          The saved {providerLabel} trend could not be read. No chart is shown from stale or incomplete data.
          <button type="button" onClick={() => void refresh()}>Retry trend</button>
        </div>
      ) : result && result.eligibleObservationCount === 0 && loadState === "loading" ? (
        <div className="categorical-trend-state" role="status">
          Refreshing saved history. The previous empty result does not confirm the current window.
        </div>
      ) : result && result.eligibleObservationCount === 0 && loadState === "error" ? (
        <div className="categorical-trend-state categorical-trend-error" role="alert">
          The last confirmed saved read found no eligible {providerLabel} classifications. Refresh failed, so the current history is unknown.
          <button type="button" onClick={() => void refresh()}>Retry trend</button>
        </div>
      ) : result && result.eligibleObservationCount > 0 && result.plottedObservationCount === 0 ? (
        <CategoricalUntimedState count={result.untimedObservationCount} historicalJevSummary={historicalJevSummary}
          onReviewSourceRecords={onReviewSourceRecords} onViewHistoricalJev={onViewHistoricalJev}
          onOpenOperations={onOpenOperations} onOpenLunaSettings={onOpenLunaSettings} provider={provider} />
      ) : result && result.eligibleObservationCount === 0 ? (
        <CategoricalEmptyState
          withheldInvalidCount={result.withheldInvalidCount}
          classifierEnabled={provider === "google_gemini" || classifierEnabled}
          onReviewSourceRecords={onReviewSourceRecords}
          onViewHistoricalJev={onViewHistoricalJev}
          onOpenOperations={onOpenOperations}
          onOpenLunaSettings={onOpenLunaSettings}
          historicalJevSummary={historicalJevSummary}
          provider={provider}
        />
      ) : result && (
        <>
          {loadState === "error" && <div className="categorical-trend-state categorical-trend-error" role="alert">
            The chart below is the last successful saved read. The current window has not been re-confirmed.
            <button type="button" onClick={() => void refresh()}>Retry trend</button>
          </div>}
          <div className="categorical-trend-meta">
            <span>{result.counts.positive} positive · {result.counts.neutral} neutral · {result.counts.negative} negative</span>
            <span>{result.counts.reviewRequired} needs review · {result.counts.excluded} excluded</span>
            <span>{latestText}</span>
          </div>
          {snapshotNotice && <p className="categorical-snapshot-notice" role="status">{snapshotNotice}</p>}
          {result.lineages.length > 1 && (
            <p className="categorical-lineage-warning" role="note">
              Multiple prompt/schema profiles are present. Category counts can shift across classifier versions; this trend does not merge them into one qualified profile.
            </p>
          )}
          {result.withheldInvalidCount > 0 && (
            <p className="categorical-lineage-warning" role="status">
              {result.withheldInvalidCount} candidate {provider === "google_gemini" ? "Gemini" : "Luna"} {result.withheldInvalidCount === 1 ? "record is" : "records are"} withheld for incomplete source or model provenance; chart totals exclude them.
            </p>
          )}
          {result.untimedObservationCount > 0 && <p className="categorical-lineage-warning" role="status">
            {result.untimedObservationCount} eligible source {result.untimedObservationCount === 1 ? "observation has" : "observations have"} no validated publisher, feed, or provider timestamp and are excluded from the plotted timeline. Retrieval and {provider === "google_gemini" ? "Gemini" : "Luna"} classification times remain visible on each record.
          </p>}
          {loadState === "error" && <p className="categorical-refresh-warning" role="status">Trend refresh failed. Keeping the last complete saved snapshot.</p>}
          {pendingResult && selectedBucketStartMs != null && (
            <div className="categorical-update-notice" role="status">
              <span>New classifications are available. The selected source bucket stays pinned to its original snapshot.</span>
              <button type="button" onClick={closeBucket}>Update trend</button>
            </div>
          )}
          <div className="categorical-chart-legend" aria-label="Category legend">
            {CATEGORIES.map((category) => <span key={category.key}><i className={category.className} aria-hidden="true" />{category.label}</span>)}
            <span className="categorical-interval-label">{displayIntervalLabel(displayBucketMs)}</span>
          </div>
          <div className="categorical-plot-layout">
            <div className="categorical-y-axis" aria-hidden="true"><span>{maxAxis}</span><span>{Math.floor(maxAxis / 2)}</span><span>0</span></div>
            <div
              className="categorical-plot-column"
              ref={plotScrollRef}
              role="region"
              aria-label={`${provider === "google_gemini" ? "Gemini" : "Luna"} trend plot by validated source time with ${displayIntervalLabel(displayBucketMs)}, earliest on the left and latest on the right`}
              tabIndex={0}
              onScroll={(event) => {
                const plot = event.currentTarget;
                nearLatestRef.current = plot.scrollWidth - plot.clientWidth - plot.scrollLeft <= 24;
              }}
            >
              <div className="categorical-plot-content" style={{ "--bucket-count": displayPoints.length } as CSSProperties}>
                <div
                  className="categorical-bars"
                  role="group"
                  aria-label={`${provider === "google_gemini" ? "Gemini" : "Luna"} category counts by validated source time, ${hours} hour window`}
                >
                {displayPoints.map((point, index) => {
                  const label = `${exactRange(point)}. ${readableCount(point.counts)}. Total ${point.counts.total} source observations.`;
                  return (
                    <button
                      key={point.bucketStartMs}
                      ref={(node) => { barRefs.current[index] = node; }}
                      type="button"
                      className={`categorical-bar${selectedBucketStartMs === point.bucketStartMs ? " is-selected" : ""}${point.counts.total === 0 ? " is-empty" : ""}`}
                      aria-label={label}
                      aria-pressed={selectedBucketStartMs === point.bucketStartMs}
                      tabIndex={focusedBucket === index || (focusedBucket === 0 && index === 0) ? 0 : -1}
                      title={label}
                      onFocus={() => setFocusedBucket(index)}
                      onKeyDown={(event) => onBucketKeyDown(event, index)}
                      onClick={(event) => void inspectBucket(point.bucketStartMs, event.currentTarget)}
                    >
                      <span className="categorical-stack" style={{ height: `${Math.max(0, point.counts.total / maxAxis * 100)}%` }}>
                        {CATEGORIES.map((category) => {
                          const count = point.counts[category.key];
                          return count > 0 && <i key={category.key} className={`categorical-segment ${category.className}`} style={{ height: `${count / point.counts.total * 100}%` }} />;
                        })}
                      </span>
                    </button>
                  );
                })}
                </div>
                <div className="categorical-x-axis" aria-hidden="true">
                  <span>{firstPoint ? formatUtcInstant(firstPoint.fromMs) : ""}</span>
                  <span>{middlePoint ? formatUtcInstant(middlePoint.fromMs) : ""}</span>
                  <span>{lastPoint ? formatUtcInstant(lastPoint.throughMs) : ""}</span>
                </div>
              </div>
            </div>
          </div>
          <details className="categorical-data-table">
            <summary>View bucket data table</summary>
            <div className="categorical-table-scroll">
              <table>
              <caption>Source-observation counts by validated publisher/feed/provider time (UTC)</caption>
                <thead><tr><th scope="col">Interval (start inclusive)</th>{CATEGORIES.map((category) => <th scope="col" key={category.key}>{category.label}</th>)}<th scope="col">Total</th><th scope="col">Evidence</th></tr></thead>
                <tbody>{displayPoints.map((point, index) => (
                  <tr key={point.bucketStartMs} aria-selected={selectedBucketStartMs === point.bucketStartMs}>
                    <th scope="row">{exactRange(point)}</th>
                    {CATEGORIES.map((category) => <td className="tabnum" key={category.key}>{point.counts[category.key]}</td>)}
                    <td className="tabnum">{point.counts.total}</td>
                    <td><button type="button" onClick={(event) => { setFocusedBucket(index); void inspectBucket(point.bucketStartMs, event.currentTarget); }}>Inspect source observations</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </details>
          {selectedPoint && (
            <section className="categorical-bucket-evidence" aria-labelledby="categorical-bucket-heading">
              <header>
                <div>
                  <h3 id="categorical-bucket-heading" ref={evidenceHeadingRef} tabIndex={-1}>{provider === "google_gemini" ? "Gemini 3.8 Flash" : "GPT-6 Luna"} source bucket · {selectedTime}</h3>
                  <p>{selectedPoint.counts.total} source observations · {provider === "google_gemini" ? "Gemini classifications only" : "saved GPT-6 Luna classifications"}; bucketed by validated source time</p>
                </div>
                <button type="button" onClick={closeBucket} aria-label={`Close ${provider === "google_gemini" ? "Gemini" : "Luna"} source bucket`}>Close</button>
              </header>
              {selectedCountMismatch && <p className="categorical-lineage-warning" role="alert">Chart and source records could not be reconciled. The chart is hidden until you refresh and select the bucket again.</p>}
              {evidence.loading ? <p className="categorical-evidence-status" role="status">Loading source records from the frozen chart snapshot…</p>
                : evidence.error ? <p className="categorical-evidence-status categorical-trend-error" role="alert">Chart and source records could not be reconciled or loaded. <button type="button" onClick={refreshAfterEvidenceFailure}>Refresh trend</button></p>
                  : evidence.page && (
                    <>
                      <p className="categorical-evidence-status" role="status">{readableCount(evidence.page.counts)} · loaded {evidence.items.length} of {evidence.page.counts.total} source observations</p>
                      {provider === "google_gemini" ? evidence.items.map((item) => {
                        const classification = item.providerCategorical;
                        if (!classification) return null;
                        const resultLabel = classification.disposition === "excluded" ? "Excluded"
                          : classification.disposition === "review_required" || classification.sentiment == null ? "Needs review"
                            : classification.sentiment;
                        return <article className="categorical-evidence-status" key={item.id}>
                          <strong className="capitalize">{resultLabel}</strong>
                          <span> · Gemini 3.8 Flash · {item.publisherName} · {item.timeBasis === "aggregator_declared" ? "Feed time" : item.timeBasis === "publisher_declared" ? "Publisher time" : "Provider time"}: {formatUtcInstant(validatedSourceTime(item)!)}</span>
                          <p className="mt-1 text-white/70">{item.title}</p>
                          {classification.summary && <p className="mt-1 text-white/55">{classification.summary}</p>}
                          {classification.supportingExcerpt && <blockquote className="mt-1 border-l border-white/20 pl-2 text-white/45">{classification.supportingExcerpt}</blockquote>}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" onClick={() => onOpenMention(item)}>Review saved source record</button>
                            <a href={item.source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open source</a>
                          </div>
                        </article>;
                      }) : <MentionFeed mentions={evidence.items} onOpen={onOpenMention} expandFirstGroup />}
                      {evidence.loadMoreError && <p className="categorical-evidence-status categorical-trend-error" role="alert">The next source page could not be loaded from this snapshot. <button type="button" onClick={refreshAfterEvidenceFailure}>Refresh source read</button></p>}
                      {evidence.page.nextCursor && <button type="button" className="categorical-load-more" onClick={() => void loadMore()} disabled={evidence.loadingMore} aria-busy={evidence.loadingMore}>{evidence.loadingMore ? "Loading source records…" : "Load more source records"}</button>}
                    </>
                  )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
