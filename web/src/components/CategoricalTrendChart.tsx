import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { getCategoricalBucket, getCategoricalTrend, type CategoricalBucketEvidencePage, type CategoricalTrendCounts, type CategoricalTrendPoint, type CategoricalTrendResult, type Mention } from "../lib/api.js";
import { aggregateCategoricalTrend, displayBucketMsForWindow, displayIntervalLabel, formatUtcInstant, formatUtcRange } from "../lib/categorical-chart.js";
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

function sameCounts(a: CategoricalTrendCounts, b: CategoricalTrendCounts): boolean {
  return CATEGORIES.every(({ key }) => a[key] === b[key]) && a.total === b.total;
}

function dataFingerprint(result: CategoricalTrendResult): string {
  return JSON.stringify({
    counts: result.counts,
    points: result.points.map((point) => [point.bucketStartMs, point.counts]),
    lineages: result.lineages,
    withheldInvalidCount: result.withheldInvalidCount,
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
  blockedReason,
  onReviewSourceRecords,
  onViewHistoricalJev,
  onOpenOperations,
  onRefresh,
}: {
  withheldInvalidCount: number;
  classifierEnabled: boolean;
  blockedReason: string | null;
  onReviewSourceRecords: () => void;
  onViewHistoricalJev: () => void;
  onOpenOperations: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="categorical-trend-empty" role="status">
      <span className="categorical-empty-mark" aria-hidden="true">∅</span>
      <div>
        <strong>{withheldInvalidCount > 0 ? "No eligible Luna classifications in this window" : "No saved GPT-6 Luna classifications in this window"}</strong>
        <p>{withheldInvalidCount > 0
          ? `${withheldInvalidCount} candidate ${withheldInvalidCount === 1 ? "classification is" : "classifications are"} withheld because source or model lineage is incomplete.`
          : "This is an empty result, not a neutral sentiment reading. The chart fills when real, source-linked Luna classifications are saved."}</p>
        {!classifierEnabled && blockedReason && <p className="categorical-blocked-reason">New classifications are blocked: {blockedReason}</p>}
        <div className="categorical-empty-actions">
          <button type="button" onClick={onReviewSourceRecords}>Review saved source records</button>
          <button type="button" onClick={onViewHistoricalJev}>View historical Jev chart</button>
          {(!classifierEnabled || withheldInvalidCount > 0) && <button type="button" onClick={onOpenOperations}>Review classification requirements</button>}
          <button type="button" onClick={onRefresh}>Refresh saved history</button>
        </div>
      </div>
    </div>
  );
}

function mentionCounts(items: Mention[]): CategoricalTrendCounts {
  const counts: CategoricalTrendCounts = { positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0 };
  for (const item of items) {
    const classification = item.classification;
    if (classification?.disposition === "excluded") counts.excluded += 1;
    else if (classification?.disposition === "review_required" || classification?.sentiment == null) counts.reviewRequired += 1;
    else counts[classification.sentiment] += 1;
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

export function CategoricalTrendChart({
  companyId,
  hours,
  active,
  classifierEnabled,
  blockedReason,
  onOpenMention,
  onOpenOperations,
  onViewHistoricalJev,
  onReviewSourceRecords,
  onSnapshot,
}: {
  companyId: string;
  hours: number;
  active: boolean;
  classifierEnabled: boolean;
  blockedReason: string | null;
  onOpenMention: (mention: Mention) => void;
  onOpenOperations: () => void;
  onViewHistoricalJev: () => void;
  onReviewSourceRecords: () => void;
  onSnapshot: (snapshot: Pick<CategoricalTrendResult, "companyId" | "windowHours" | "eligibleObservationCount">) => void;
}) {
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

  const refresh = useCallback(async (manual = false) => {
    const sequence = ++requestSequence.current;
    if (!resultRef.current || manual) setLoadState("loading");
    try {
      const next = await getCategoricalTrend(companyId, hours);
      if (sequence !== requestSequence.current) return;
      if (next.companyId !== companyId || next.windowHours !== hours) throw new Error("Trend identity did not match the selected company and window");
      onSnapshot({ companyId: next.companyId, windowHours: next.windowHours, eligibleObservationCount: next.eligibleObservationCount });
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
      if (sequence === requestSequence.current) setLoadState("error");
    }
  }, [applyResult, companyId, hours, onSnapshot]);

  useEffect(() => {
    resultRef.current = null;
    selectedBucketRef.current = null;
    setResult(null);
    setPendingResult(null);
    setSelectedBucketStartMs(null);
    setEvidence(emptyEvidence());
    setFocusedBucket(0);
    setSnapshotNotice(null);
    setLoadState("loading");
  }, [companyId, hours]);

  useEffect(() => {
    if (!active) return;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), 30_000);
    return () => {
      requestSequence.current += 1;
      window.clearInterval(timer);
    };
  }, [active, refresh]);

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
      const page = await getCategoricalBucket({ companyId, snapshotKey: current.snapshotKey, bucketStartMs, bucketDurationMs: displayBucketMs, limit: 50 });
      if (sequence !== bucketSequence.current || selectedBucketRef.current !== bucketStartMs) return;
      const point = aggregateCategoricalTrend(current, displayBucketMs).find((candidate) => candidate.bucketStartMs === bucketStartMs);
      if (!point || page.companyId !== companyId || page.snapshotKey !== current.snapshotKey
        || page.bucketStartMs !== bucketStartMs || page.bucketDurationMs !== displayBucketMs
        || page.fromMs !== point.fromMs || page.throughMs !== point.throughMs
        || !sameCounts(page.counts, point.counts)
        || page.items.some((item) => item.classification?.classifiedAt == null
          || item.classification.classifiedAt < page.fromMs || item.classification.classifiedAt >= page.throughMs)) {
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
  }, [companyId, displayBucketMs]);

  const loadMore = useCallback(async () => {
    const page = evidence.page;
    const current = resultRef.current;
    const bucketStartMs = selectedBucketRef.current;
    if (!page?.nextCursor || !current || bucketStartMs == null) return;
    const sequence = ++bucketSequence.current;
    setEvidence((state) => ({ ...state, loadingMore: true, loadMoreError: false }));
    try {
      const next = await getCategoricalBucket({
        companyId, snapshotKey: page.snapshotKey, bucketStartMs, bucketDurationMs: page.bucketDurationMs, limit: 50, cursor: page.nextCursor,
      });
      if (sequence !== bucketSequence.current || selectedBucketRef.current !== bucketStartMs) return;
      if (next.snapshotKey !== current.snapshotKey || next.bucketStartMs !== bucketStartMs
        || next.bucketDurationMs !== page.bucketDurationMs || next.fromMs !== page.fromMs || next.throughMs !== page.throughMs
        || !sameCounts(next.counts, page.counts)
        || next.items.some((item) => item.classification?.classifiedAt == null
          || item.classification.classifiedAt < next.fromMs || item.classification.classifiedAt >= next.throughMs)) {
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
  }, [companyId, evidence.items, evidence.page]);

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
    void refresh(true);
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

  return (
    <section className="categorical-trend-panel" aria-labelledby="categorical-trend-title" aria-busy={loadState === "loading"}>
      <header className="categorical-trend-header">
        <div className="categorical-trend-title-block">
          <p className="micro">CURRENT CLASSIFIER · CATEGORICAL ACTIVITY</p>
          <h2 id="categorical-trend-title">GPT-6 Luna category counts</h2>
          <p>Source observations by classifier-availability time · {hours === 24 ? "24 hours" : hours < 24 ? `${hours} hours` : `${hours / 24} days`} · repeated coverage included</p>
        </div>
        {result && loadState === "ready" && result.eligibleObservationCount > 0 && (
          <div className="categorical-trend-total" aria-label={`${result.eligibleObservationCount} eligible source observations`}>
            <strong className="tabnum">{result.eligibleObservationCount.toLocaleString()}</strong>
            <span>observations</span>
          </div>
        )}
      </header>

      {loadState === "loading" && !result ? (
        <div className="categorical-trend-state" role="status"><span className="categorical-loading-mark" aria-hidden="true" />Loading saved Luna classifications…</div>
      ) : loadState === "error" && !result ? (
        <div className="categorical-trend-state categorical-trend-error" role="alert">
          The saved Luna trend could not be read. No chart is shown from stale or incomplete data.
          <button type="button" onClick={() => void refresh(true)}>Retry trend</button>
        </div>
      ) : result && result.eligibleObservationCount === 0 && loadState === "loading" ? (
        <div className="categorical-trend-state" role="status">
          Refreshing saved history. The previous empty result does not confirm the current window.
        </div>
      ) : result && result.eligibleObservationCount === 0 && loadState === "error" ? (
        <div className="categorical-trend-state categorical-trend-error" role="alert">
          The last confirmed saved read found no eligible Luna classifications. Refresh failed, so the current history is unknown.
          <button type="button" onClick={() => void refresh(true)}>Retry trend</button>
        </div>
      ) : result && result.eligibleObservationCount === 0 ? (
        <CategoricalEmptyState
          withheldInvalidCount={result.withheldInvalidCount}
          classifierEnabled={classifierEnabled}
          blockedReason={blockedReason}
          onReviewSourceRecords={onReviewSourceRecords}
          onViewHistoricalJev={onViewHistoricalJev}
          onOpenOperations={onOpenOperations}
          onRefresh={() => void refresh(true)}
        />
      ) : result && (
        <>
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
              {result.withheldInvalidCount} candidate Luna {result.withheldInvalidCount === 1 ? "record is" : "records are"} withheld for incomplete source or model provenance; chart totals exclude them.
            </p>
          )}
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
              aria-label={`Luna trend plot with ${displayIntervalLabel(displayBucketMs)}, earliest on the left and latest on the right`}
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
                  aria-label={`Luna category counts by classifier-availability time, ${hours} hour window`}
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
                <caption>Source-observation counts by Luna classification-availability time (UTC)</caption>
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
                  <h3 id="categorical-bucket-heading" ref={evidenceHeadingRef} tabIndex={-1}>Luna source bucket · {selectedTime}</h3>
                  <p>{selectedPoint.counts.total} source observations · classifier availability time · source and retrieval clocks remain on each record</p>
                </div>
                <button type="button" onClick={closeBucket} aria-label="Close Luna source bucket">Close</button>
              </header>
              {selectedCountMismatch && <p className="categorical-lineage-warning" role="alert">Chart and source records could not be reconciled. The chart is hidden until you refresh and select the bucket again.</p>}
              {evidence.loading ? <p className="categorical-evidence-status" role="status">Loading source records from the frozen chart snapshot…</p>
                : evidence.error ? <p className="categorical-evidence-status categorical-trend-error" role="alert">Chart and source records could not be reconciled or loaded. <button type="button" onClick={refreshAfterEvidenceFailure}>Refresh trend</button></p>
                  : evidence.page && (
                    <>
                      <p className="categorical-evidence-status" role="status">{readableCount(evidence.page.counts)} · loaded {evidence.items.length} of {evidence.page.counts.total} source observations</p>
                      <MentionFeed mentions={evidence.items} onOpen={onOpenMention} expandFirstGroup />
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
