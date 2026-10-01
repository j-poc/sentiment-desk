import { summarizeEvidenceBreadth } from "../lib/evidence-breadth.js";
import type { Mention } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";
import { normalizeExactHeadline, type ExactTitleGroupFilter } from "../lib/exact-headline-groups.js";
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
  const categorical = mentions.filter((mention) => mention.classification != null);
  const classified = categorical.filter((mention) => mention.status === "classified");
  const reviewRequired = categorical.filter((mention) => mention.status === "review_required").length;
  const excluded = categorical.filter((mention) => mention.status === "excluded").length;
  const relatedHeadlineCandidates = findRelatedHeadlineCandidates(mentions);
  const headlineRows = new Map<string, Mention[]>();
  for (const mention of mentions) {
    const key = normalizeExactHeadline(mention.title);
    const group = headlineRows.get(key) ?? [];
    group.push(mention);
    headlineRows.set(key, group);
  }
  const visibleHeadlines = [...headlineRows.values()].slice(0, 3);
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
        <span className="micro">Saved evidence · {period}</span>
        <span className="evidence-breadth-sample">
          {loaded ? `${mentions.length} of up to 100 loaded source rows${hasMore ? " · older rows available" : " · sample complete"}` : error ? "Unavailable" : "Loading…"}
        </span>
      </div>
      {refreshWarning && (
        <p className="evidence-breadth-status score-bucket-error" role="alert">
          Some saved records in this sample could not be refreshed after reconnect and may be out of date. {" "}
          <button type="button" onClick={onRetryRefresh}>Retry refresh</button>
        </p>
      )}
      {error ? (
        <p className="evidence-breadth-status" role="alert">
          Could not load this evidence summary. The source feed is separate.{" "}
          <button type="button" onClick={onRetry} aria-label="Retry loading evidence summary">Retry</button>
        </p>
      ) : !loaded ? (
        <p className="evidence-breadth-status" role="status">Loading saved source records for the selected window…</p>
      ) : (
        <>
          <div className="evidence-record-list" aria-label={`Latest saved source records in the ${period} window`}>
            {visibleHeadlines.map((rows) => {
              const mention = rows[0]!;
              const recordAt = mention.publishedAt ?? mention.providerObservedAt ?? mention.retrievedAt;
              const publisher = mention.publisherName || mention.source.name;
              const timeBasis = mention.publishedAt != null ? "publisher time"
                : mention.providerObservedAt != null ? "provider observed" : "retrieved";
              const sentiment = mention.score ? `${mention.score.sentiment} · ${mention.score.impact > 0 ? "+" : ""}${mention.score.impact.toFixed(0)} impact` : mention.classification ? `Luna · ${mention.classification.disposition === "classified" ? mention.classification.sentiment ?? "direction uncertain" : mention.classification.disposition.replaceAll("_", " ")}` : mention.status.replaceAll("_", " ");
              return (
                <button
                  className="evidence-record"
                  key={mention.id}
                  type="button"
                  onClick={() => onOpenMention(mention)}
                  aria-label={`Open saved evidence from ${publisher}: ${mention.title}. ${sentiment}. ${timeAgo(recordAt, now)} ${timeBasis}.`}
                >
                  <span className="evidence-record-title">{mention.title}</span>
                  <span className="evidence-record-meta">{publisher} · {timeAgo(recordAt, now)} · {timeBasis} · {sentiment}{rows.length > 1 ? ` · ${rows.length} same-title rows loaded` : ""}</span>
                </button>
              );
            })}
          </div>
          {loaded && mentions.length === 0 && <p className="evidence-breadth-status" role="status">No saved source records in this {period} window.</p>}
          {loaded && mentions.length > 0 && summary.scoredRecordCount === 0 && <p className="evidence-breadth-status" role="status">No scored records in these {summary.sourceRecordCount} saved rows.</p>}
          <button type="button" className="evidence-breadth-link" aria-controls="mention-feed-panel" onClick={() => onShowRecords()}>
            Open full mention feed <span aria-hidden="true">↓</span>
          </button>
          <details className="evidence-coverage">
            <summary>Coverage and title analysis <span>{summary.scoredRecordCount} Jev scored{categorical.length > 0 ? ` · ${classified.length} Luna classified` : ""} · {summary.exactHeadlineCount} exact-title groups</span></summary>
            {categorical.length > 0 && <p className="evidence-breadth-metrics">
              <strong>Luna in this loaded sample: {classified.length} classified · {reviewRequired} need evidence review · {excluded} excluded</strong>
              <span>Positive {classified.filter((mention) => mention.classification?.sentiment === "positive").length} · Neutral {classified.filter((mention) => mention.classification?.sentiment === "neutral").length} · Negative {classified.filter((mention) => mention.classification?.sentiment === "negative").length}</span>
            </p>}
            {hasMore && (
              <p className="evidence-breadth-caveat" role="note">
                Counts below cover only these loaded rows, not the full {period} window. Older saved records are available in the mention feed.
              </p>
            )}
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
                {summary.repeatedHeadlineGroupCount} repeated exact-title {summary.repeatedHeadlineGroupCount === 1 ? "group" : "groups"} · {summary.recordsInRepeatedHeadlineGroups} of {summary.scoredRecordCount} scored sample {summary.recordsInRepeatedHeadlineGroups === 1 ? "record" : "records"} <span aria-hidden="true">↘</span>
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
          <RelatedHeadlineCandidates
            candidates={relatedHeadlineCandidates}
            loaded={loaded && !error}
            now={now}
            onOpenMention={onOpenMention}
          />
          <p className="evidence-breadth-caveat">
            Latest source time {latestSourceTime} · latest completed Jev score {latestJevScoreTime}
          </p>
          </details>
        </>
      )}
    </section>
  );
}
