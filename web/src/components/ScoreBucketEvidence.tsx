import type { ImpactDistributionBin, Mention } from "../lib/api.js";
import { formatUtcRange } from "../lib/categorical-chart.js";
import type { ScoreBucketCoverage } from "../../../shared/score-bucket-coverage.js";
import { MentionFeed } from "./MentionFeed.js";

function formatCoverageTime(atMs: number): string {
  return new Date(atMs).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC");
}

function formatCoverageRange(range: { earliestAtMs: number; latestAtMs: number } | null): string {
  return range == null ? "no timestamped records" : `${formatCoverageTime(range.earliestAtMs)} to ${formatCoverageTime(range.latestAtMs)}`;
}

export function ScoreBucketEvidence({
  bucketFromMs,
  bucketThroughMs,
  expectedCount,
  recordCount,
  matchingRecordCount,
  impactBin,
  weightedMeanImpact,
  recordImpactMin,
  recordImpactMax,
  impactDistribution,
  coverageSummary,
  snapshotStale,
  selectionExpired,
  expectedCountFreshness,
  mentions,
  loading,
  loadingMore,
  error,
  loadMoreError,
  hasMore,
  headingRef,
  onClose,
  onOpenMention,
  onRetry,
  refreshWarning,
  onRetryRefresh,
  onLoadMore,
  onSelectImpactBin,
}: {
  bucketFromMs: number;
  bucketThroughMs: number;
  expectedCount: number;
  recordCount: number;
  matchingRecordCount: number;
  impactBin: number | null;
  weightedMeanImpact: number | null;
  recordImpactMin: number | null;
  recordImpactMax: number | null;
  impactDistribution: ImpactDistributionBin[];
  coverageSummary: ScoreBucketCoverage | null;
  snapshotStale: boolean;
  selectionExpired: boolean;
  expectedCountFreshness: "current" | "refreshing" | "error";
  mentions: Mention[];
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMoreError: boolean;
  hasMore: boolean;
  headingRef: { current: HTMLHeadingElement | null };
  onClose: () => void;
  onOpenMention: (mention: Mention) => void;
  onRetry: () => void;
  refreshWarning: boolean;
  onRetryRefresh: () => void;
  onLoadMore: () => void;
  onSelectImpactBin: (bin: number | null) => void;
}) {
  const receiptLinkedCount = mentions.filter((mention) => mention.source.deliveryId != null).length;
  const unlinkedHistoricalCount = mentions.length - receiptLinkedCount;
  const histogramTotal = impactDistribution.reduce((sum, bin) => sum + bin.count, 0);
  const histogramComplete = !snapshotStale && impactDistribution.length === 20 && histogramTotal === recordCount;
  const maxBinCount = Math.max(1, ...impactDistribution.map((bin) => bin.count));

  return (
    <section className="score-bucket-evidence" aria-labelledby="score-bucket-heading">
      <header className="score-bucket-heading">
        <div>
          <h2 id="score-bucket-heading" ref={headingRef} tabIndex={-1}>Jev score-time interval</h2>
          <span>{formatUtcRange(bucketFromMs, bucketThroughMs)}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close score bucket evidence">Close</button>
      </header>
      {snapshotStale ? (
        <p className="score-bucket-status score-bucket-error" role="alert">
          {selectionExpired
            ? "This interval has left the selected window. Close it and choose a bucket from the refreshed chart."
            : <>Saved records or full-bucket coverage could not be reconciled to this chart snapshot. The summary and source list are withheld until reloaded. <button type="button" onClick={onRetry} disabled={expectedCountFreshness === "refreshing"} aria-busy={expectedCountFreshness === "refreshing"}>{expectedCountFreshness === "refreshing" ? "Refreshing this interval…" : "Reload this interval"}</button></>}
        </p>
      ) : error ? null : (
        <>
          <p className="score-bucket-summary">
            {recordCount} saved scored {recordCount === 1 ? "record" : "records"}
            {weightedMeanImpact == null ? " · weighted mean unavailable" : ` · weighted mean ${weightedMeanImpact > 0 ? "+" : ""}${weightedMeanImpact.toFixed(1)}`}
            {recordImpactMin == null || recordImpactMax == null ? " · record spread unavailable" : ` · record spread ${recordImpactMin} to ${recordImpactMax}`}
            {" impact points"}
          </p>
          <p className="score-bucket-caveat">
            Mean and count use the same saved, eligible scored records. Spread is their observed minimum to maximum, not a confidence interval. This interval groups when Jev finished scoring; it is not a 15-minute measure of publication volume or investor activity.
          </p>
          {coverageSummary && (
            <section className="score-bucket-coverage" aria-label="Full interval title and source-time coverage">
              <h3>Full interval coverage</h3>
              <p>
                {coverageSummary.exactNormalizedTitleCount} exact normalized titles · {coverageSummary.repeatedTitleRecordCount} records in repeated-title groups · {coverageSummary.untitledRecordCount} without a usable title.
              </p>
              <p>
                Jev score completion: {formatCoverageRange(coverageSummary.scoreCompletionTime)}.
              </p>
              <ul>
                {coverageSummary.sourceTimes.publisherDeclared.recordCount > 0 && (
                  <li>
                    Publisher-declared publication time: {coverageSummary.sourceTimes.publisherDeclared.timestampedRecordCount} of {coverageSummary.sourceTimes.publisherDeclared.recordCount} records timestamped; {formatCoverageRange(coverageSummary.sourceTimes.publisherDeclared.range)}.
                  </li>
                )}
                {coverageSummary.sourceTimes.providerObserved.recordCount > 0 && (
                  <li>
                    Provider-observed time: {coverageSummary.sourceTimes.providerObserved.timestampedRecordCount} of {coverageSummary.sourceTimes.providerObserved.recordCount} records timestamped; {formatCoverageRange(coverageSummary.sourceTimes.providerObserved.range)}.
                  </li>
                )}
                {coverageSummary.sourceTimes.unknownRecordCount > 0 && <li>{coverageSummary.sourceTimes.unknownRecordCount} records have unknown source-time basis.</li>}
                {coverageSummary.sourceTimes.legacyUnknownRecordCount > 0 && <li>{coverageSummary.sourceTimes.legacyUnknownRecordCount} records have legacy-unknown source-time basis.</li>}
              </ul>
              <p>
                {coverageSummary.receiptLinkedRecordCount} of {recordCount} records link to a delivery receipt. Exact-title repeats are duplicate cues only; they do not prove independent reporting or investor opinions. All counts cover the full interval and stay fixed while filtering or paging source rows.
              </p>
            </section>
          )}
          {histogramComplete ? (
            <div className="score-bucket-distribution" aria-label={`Complete distribution of ${recordCount} saved records across 20 impact bins`}>
              <div className="score-bucket-bars" aria-hidden="true">
                {impactDistribution.map((bin) => (
                  <span
                    key={bin.from}
                    className={bin.through <= 0 ? "is-negative" : bin.from >= 0 ? "is-positive" : "is-neutral"}
                    style={{ height: `${Math.max(bin.count > 0 ? 4 : 0, (bin.count / maxBinCount) * 100)}%` }}
                    title={`${bin.from} to ${bin.includeThrough ? "" : "< "}${bin.through}${bin.includeThrough ? " inclusive" : ""}: ${bin.count} ${bin.count === 1 ? "record" : "records"}`}
                  />
                ))}
              </div>
              <div className="score-bucket-axis" aria-hidden="true"><span>-100</span><span>0</span><span>+100</span></div>
              <p className="score-bucket-status">Full 20-bin distribution · {histogramTotal} of {recordCount} records · unweighted record counts</p>
              <label className="score-bucket-bin-filter">
                Filter source rows by impact band
                <select
                  value={impactBin == null ? "all" : String(impactBin)}
                  disabled={loading || snapshotStale}
                  onChange={(event) => onSelectImpactBin(event.currentTarget.value === "all" ? null : Number(event.currentTarget.value))}
                  aria-label="Filter source rows by impact band"
                >
                  <option value="all">All {recordCount} saved records</option>
                  {impactDistribution.map((bin, index) => (
                    <option key={bin.from} value={index}>{bin.from} to {bin.through}{bin.includeThrough ? " inclusive" : ""} · {bin.count} {bin.count === 1 ? "record" : "records"}</option>
                  ))}
                </select>
              </label>
              <details className="score-bucket-bin-details">
                <summary>Read bin counts</summary>
                <ol>
                  {impactDistribution.map((bin) => (
                    <li key={bin.from}>{bin.from} to {bin.through}{bin.includeThrough ? " inclusive" : ""}: {bin.count}</li>
                  ))}
                </ol>
              </details>
            </div>
          ) : !loading && !error && recordCount > 0 ? (
            <p className="score-bucket-status score-bucket-error" role="alert">The full-bucket distribution did not reconcile to the chart record count and is withheld.</p>
          ) : null}
        </>
      )}
      {!error && refreshWarning && (
        <p className="score-bucket-status score-bucket-error" role="alert">
          Some loaded records could not be rechecked after reconnect and may be out of date. <button type="button" onClick={onRetryRefresh}>Retry refresh</button>
        </p>
      )}
      {loading ? (
        <p role="status" className="score-bucket-status">Loading saved, source-identified scored records…</p>
      ) : error ? (
        <p role="status" className="score-bucket-status score-bucket-error">
          The saved records for this interval could not be loaded. <button type="button" onClick={onRetry}>Retry</button>
        </p>
      ) : !snapshotStale && (
        <>
          <p className="score-bucket-status" role="status">
            Loaded {mentions.length} of {matchingRecordCount} matching source records{hasMore ? " · more available" : " · source list complete"}{impactBin == null ? "." : ` · impact band ${-100 + impactBin * 10} to ${-90 + impactBin * 10}${impactBin === 19 ? " inclusive" : " exclusive"} · ${recordCount} records in the full interval.`} {expectedCountFreshness === "refreshing"
              ? `Chart count updating · last confirmed ${expectedCount}. `
              : expectedCountFreshness === "error"
                ? `Latest chart count unavailable · last confirmed ${expectedCount}. `
                : `Chart count ${expectedCount}. `}
            Of loaded rows: {receiptLinkedCount} receipt-linked; {unlinkedHistoricalCount} unlinked historical without a receipt. Exact-title groups are presentation cues, not verified story clusters.
          </p>
          {mentions.length > 0 && <div className="score-bucket-list"><MentionFeed mentions={mentions} onOpen={onOpenMention} expandFirstGroup /></div>}
          {matchingRecordCount === 0 && <p role="status" className="score-bucket-status">No saved scored records matched this impact band in the interval.</p>}
          {loadMoreError && <p className="score-bucket-status score-bucket-error" role="status">The next source page could not be loaded. <button type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>Retry</button></p>}
          {hasMore && (
            <button type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore} className="score-bucket-more">
              {loadingMore ? "Loading more source records…" : "Load more source records"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
