import { summarizeEvidenceBreadth } from "../lib/evidence-breadth.js";
import type { Mention } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";
import type { ExactTitleGroupFilter } from "../lib/exact-headline-groups.js";
import { findRelatedHeadlineCandidates } from "../lib/related-headline-candidates.js";
import { RelatedHeadlineCandidates } from "./RelatedHeadlineCandidates.js";

export function EvidenceBreadth({
  mentions,
  hours,
  loaded,
  error,
  hasMore,
  now,
  refreshWarning,
  onRetry,
  onRetryRefresh,
  onShowRecords,
  onOpenMention,
}: {
  mentions: Mention[];
  hours: number;
  loaded: boolean;
  error: boolean;
  hasMore: boolean;
  now: number;
  refreshWarning: boolean;
  onRetry: () => void;
  onRetryRefresh: () => void;
  onShowRecords: (filter?: ExactTitleGroupFilter) => void;
  onOpenMention: (mention: Mention) => void;
}) {
  const summary = summarizeEvidenceBreadth(mentions);
  const relatedHeadlineCandidates = findRelatedHeadlineCandidates(mentions);
  const period = hours === 6 ? "6H" : hours === 24 ? "24H" : hours === 72 ? "3D" : "7D";
  const absoluteTime = (value: number) => new Date(value).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const latestSourceTime = summary.latestSourceAt == null
    ? "unavailable"
    : <time
        dateTime={new Date(summary.latestSourceAt).toISOString()}
        title={`Source time basis: ${summary.latestSourceTimeBasis}; ${absoluteTime(summary.latestSourceAt)}`}
        aria-label={`${summary.latestSourceTimeBasis} source time, ${absoluteTime(summary.latestSourceAt)}`}
      >{timeAgo(summary.latestSourceAt, now)} · {summary.latestSourceTimeBasis}</time>;
  const latestJevScoreTime = summary.latestScoreAt == null
    ? "none"
    : <time
        dateTime={new Date(summary.latestScoreAt).toISOString()}
        title={`Jev score completed ${absoluteTime(summary.latestScoreAt)}`}
        aria-label={`Jev score completed ${absoluteTime(summary.latestScoreAt)}`}
      >{timeAgo(summary.latestScoreAt, now)}</time>;

  return (
    <section className="evidence-breadth" aria-label={`${period} source evidence breadth`}>
      <div className="evidence-breadth-heading">
        <span className="micro">Source evidence · {period} · first-page sample</span>
        <span className="evidence-breadth-sample">
          {loaded ? `${mentions.length} / up to 100 source rows${hasMore ? " · sample only · older rows available" : " · complete at load"}` : error ? "Unavailable" : "Loading…"}
        </span>
      </div>
      {refreshWarning && (
        <p className="evidence-breadth-status score-bucket-error" role="alert">
          Some saved records in this sample could not be refreshed after reconnect and may be out of date. {" "}
          <button type="button" onClick={onRetryRefresh}>Retry refresh</button>
        </p>
      )}
      {loaded && !error && hasMore && (
        <p className="evidence-breadth-caveat" role="note">
          Counts below cover only these loaded rows, not the full {period} window. Older saved records are available in the mention feed.
        </p>
      )}
      {error ? (
        <p className="evidence-breadth-status" role="alert">
          Could not load this evidence summary. The source feed is separate.{" "}
          <button type="button" onClick={onRetry} aria-label="Retry loading evidence summary">Retry</button>
        </p>
      ) : !loaded ? (
        <p className="evidence-breadth-status" role="status">Loading saved source records for the selected window…</p>
      ) : summary.scoredRecordCount === 0 ? (
        <p className="evidence-breadth-status" role="status">No scored source records in this first-page sample ({summary.sourceRecordCount} saved records).</p>
      ) : (
        <>
          <p className="evidence-breadth-metrics">
            <strong>{summary.scoredRecordCount} scored in this sample</strong>
            <span>{summary.exactHeadlineCount} distinct exact-title {summary.exactHeadlineCount === 1 ? "group" : "groups"}</span>
            {summary.repeatedHeadlineGroupCount > 0 ? (
              <button
                type="button"
                className="evidence-breadth-metric-link"
                aria-controls="mention-feed-panel"
                onClick={() => onShowRecords("repeated")}
              >
                {summary.repeatedHeadlineGroupCount} repeated exact-title {summary.repeatedHeadlineGroupCount === 1 ? "group" : "groups"} · {summary.recordsInRepeatedHeadlineGroups} source {summary.recordsInRepeatedHeadlineGroups === 1 ? "record" : "records"} <span aria-hidden="true">↘</span>
              </button>
            ) : (
              <span>0 repeated exact-title groups</span>
            )}
            {summary.mixedJevLabelGroupCount > 0 ? (
              <button
                type="button"
                className="evidence-breadth-metric-link"
                aria-controls="mention-feed-panel"
                aria-label={`${summary.mixedJevLabelGroupCount} exact-title groups whose records have more than one most-likely Jev sentiment class. Inspect those groups in the loaded feed.`}
                onClick={() => onShowRecords("mixed")}
              >
                {summary.mixedJevLabelGroupCount} groups with mixed Jev labels <span aria-hidden="true">↘</span>
              </button>
            ) : (
              <span>0 groups with mixed Jev labels</span>
            )}
            <span className="evidence-breadth-sentiment">
              <b className="text-emerald-300/90">Positive {summary.sentiment.positive} of {summary.scoredRecordCount}</b>
              <b className="text-slate-200">Neutral {summary.sentiment.neutral} of {summary.scoredRecordCount}</b>
              <b className="text-rose-300/90">Negative {summary.sentiment.negative} of {summary.scoredRecordCount}</b>
            </span>
            <span>{summary.publisherLabelCount} publisher labels</span>
          </p>
          <p className="evidence-breadth-caveat">
            Window uses publisher, provider-observed, then retrieval time. Mixed labels means exact-title rows have different Jev most-likely classes. Exact-title matches are only a duplicate cue; publisher labels do not verify independent reporting.
          </p>
        </>
      )}
      {loaded && !error && (
        <RelatedHeadlineCandidates
          candidates={relatedHeadlineCandidates}
          loaded={loaded && !error}
          now={now}
          onOpenMention={onOpenMention}
        />
      )}
      {loaded && !error && (
        <p className="evidence-breadth-caveat">
          Latest source time {latestSourceTime} · latest completed Jev score {latestJevScoreTime}
        </p>
      )}
      {loaded && !error && summary.sourceRecordCount > 0 && (
        <button type="button" className="evidence-breadth-link" aria-controls="mention-feed-panel" onClick={() => onShowRecords()}>
          Open All mention feed <span aria-hidden="true">↓</span>
        </button>
      )}
    </section>
  );
}
