import type { Mention } from "../lib/api.js";
import { MentionFeed } from "./MentionFeed.js";

export function ScoreBucketEvidence({
  bucketAt,
  expectedCount,
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
}: {
  bucketAt: number;
  expectedCount: number;
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
}) {
  const receiptLinkedCount = mentions.filter((mention) => mention.source.deliveryId != null).length;
  const unlinkedHistoricalCount = mentions.length - receiptLinkedCount;
  const time = new Date(bucketAt).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  return (
    <section className="score-bucket-evidence" aria-labelledby="score-bucket-heading">
      <header className="score-bucket-heading">
        <div>
          <h2 id="score-bucket-heading" ref={headingRef} tabIndex={-1}>Jev score bucket · {time}</h2>
          <span>{expectedCountFreshness === "current"
            ? `${expectedCount} saved scored ${expectedCount === 1 ? "record" : "records"} in the latest chart count`
            : expectedCountFreshness === "refreshing"
              ? `Updating chart count · last confirmed ${expectedCount} ${expectedCount === 1 ? "record" : "records"}`
              : `Chart count unavailable · last confirmed ${expectedCount} ${expectedCount === 1 ? "record" : "records"}`}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close score bucket evidence">Close</button>
      </header>
      <p className="score-bucket-caveat">
        Selected by score-completion time in one 15-minute chart bucket. Each card retains its own source time; repeated coverage may appear more than once.
      </p>
      {refreshWarning && (
        <p className="score-bucket-status score-bucket-error" role="alert">
          Some loaded records in this bucket could not be rechecked after reconnect and may be out of date. {" "}
          <button type="button" onClick={onRetryRefresh}>Retry refresh</button>
        </p>
      )}
      {loading ? (
        <p role="status" className="score-bucket-status">Loading saved, source-identified scored records…</p>
      ) : error ? (
        <p role="status" className="score-bucket-status score-bucket-error">
          The saved records for this bucket could not be loaded. <button type="button" onClick={onRetry}>Retry</button>
        </p>
      ) : mentions.length === 0 ? (
        <p role="status" className="score-bucket-status">
          No saved scored records matched this bucket. The chart and source lookup may have changed between refreshes.
        </p>
      ) : (
        <>
          <p className="score-bucket-status" role="status">
            Loaded {mentions.length} source {mentions.length === 1 ? "record" : "records"} from this bucket. {expectedCountFreshness === "refreshing"
              ? "The chart bucket count is updating. "
              : expectedCountFreshness === "error"
                ? "The latest chart bucket count is unavailable. "
                : `The latest chart count is ${expectedCount}. `}
            Of the loaded records: {receiptLinkedCount} receipt-linked; {unlinkedHistoricalCount} unlinked historical without a receipt. Exact-title groups are presentation cues, not verified story clusters.
          </p>
          <div className="score-bucket-list">
            <MentionFeed mentions={mentions} onOpen={onOpenMention} expandFirstGroup />
          </div>
          {loadMoreError && <p className="score-bucket-status score-bucket-error" role="status">Older bucket records could not be loaded. Retry the next page.</p>}
          {hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              aria-busy={loadingMore}
              className="score-bucket-more"
            >
              {loadingMore ? "Loading more bucket records…" : "Load more bucket records"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
