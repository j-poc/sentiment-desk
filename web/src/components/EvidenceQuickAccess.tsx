import type { Mention } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";
import { summarizeEvidenceBreadth } from "../lib/evidence-breadth.js";

export function EvidenceQuickAccess({
  mentions,
  hours,
  loaded,
  error,
  hasMore,
  now,
  onReview,
  onRetry,
}: {
  mentions: Mention[];
  hours: number;
  loaded: boolean;
  error: boolean;
  hasMore: boolean;
  now: number;
  onReview: () => void;
  onRetry: () => void;
}) {
  const period = hours === 6 ? "6H" : hours === 24 ? "24H" : hours === 72 ? "3D" : "7D";
  const summary = summarizeEvidenceBreadth(mentions);
  const unclassifiedByLuna = mentions.filter((mention) => mention.classification == null).length;
  const loadedRecordsLabel = `${mentions.length.toLocaleString("en-US")} saved source ${mentions.length === 1 ? "record" : "records"}`;
  const latestSource = summary.latestSourceAt == null
    ? null
    : `${timeAgo(summary.latestSourceAt, now)} · ${summary.latestSourceTimeBasis} time`;

  return (
    <section className="evidence-quick-access" aria-label={`${period} saved source evidence status`}>
      {!loaded && error ? (
        <span role="status">Saved {period} evidence is unavailable.</span>
      ) : !loaded ? (
        <span role="status">Loading saved {period} evidence…</span>
      ) : mentions.length === 0 ? (
        <span role="status">No saved source-timed rows in {period}.</span>
      ) : (
        <span role="status" aria-label={`${period}: ${mentions.length} loaded saved source rows${hasMore ? ", with older rows available" : ""}; ${unclassifiedByLuna} ${unclassifiedByLuna === 1 ? "has" : "have"} no Luna classification; latest source ${latestSource ?? "time unavailable"}.`}>
          {period} evidence · {mentions.length} {hasMore ? "latest loaded" : "saved"} {mentions.length === 1 ? "row" : "rows"} · {unclassifiedByLuna} unclassified by Luna · latest {latestSource ?? "source time unavailable"}
          {hasMore ? " · older rows available" : ""}
        </span>
      )}
      {loaded && !error && mentions.length > 0 ? (
        <button type="button" onClick={onReview} aria-controls="mention-feed-panel">
          {hasMore ? `Review latest ${loadedRecordsLabel} ↓` : `Review ${loadedRecordsLabel} ↓`}
        </button>
      ) : error ? (
        <button type="button" onClick={onRetry} aria-label={`Retry loading saved ${period} evidence`}>Retry</button>
      ) : null}
    </section>
  );
}
