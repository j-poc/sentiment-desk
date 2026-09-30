import type { Mention } from "../lib/api.js";
import { fmtIndex, timeAgo } from "../lib/format.js";
import { RELATED_HEADLINE_RULE, type RelatedHeadlineCandidate, type RelatedHeadlineMember } from "../lib/related-headline-candidates.js";

export function RelatedHeadlineCandidates({
  candidates,
  loaded,
  now,
  onOpenMention,
}: {
  candidates: RelatedHeadlineCandidate[];
  loaded: boolean;
  now: number;
  onOpenMention: (mention: Mention) => void;
}) {
  if (!loaded) return null;

  return (
    <section className="related-headline-candidates" aria-label="Similar-title candidates">
      <div className="related-headline-heading">
        <strong>Similar-title candidates</strong>
        <span className="related-headline-badge">unvalidated</span>
      </div>
      <p className="related-headline-caveat">
        A local text rule compares scored titles with at least {RELATED_HEADLINE_RULE.minSharedTerms} shared content terms and {Math.round(RELATED_HEADLINE_RULE.minJaccardOverlap * 100)}% Jaccard overlap, then limits every displayed row to a full record-time span of {RELATED_HEADLINE_RULE.maxRecordTimeSpanHours} hours. Time uses publisher, then provider-observed, then retrieval time when source time is missing. These candidates are not verified stories or independent reporting and never change the chart or rankings.
      </p>
      {candidates.length === 0 ? (
        <p className="related-headline-empty" role="status">No candidates meet this rule in the loaded sample. This does not show that no stories were repeated.</p>
      ) : (
        <div className="related-headline-list">
          {candidates.slice(0, 3).map((candidate) => (
            <details className="related-headline-item" key={candidate.anchor.mentions[0]?.id}>
              <summary>
                <span className="related-headline-title">{candidate.anchor.title}</span>
                <span className="related-headline-stats">
                  {candidate.scoredRecordCount} scored records · {candidate.related.length + 1} title variants · {candidate.publisherLabelCount} publisher labels · {candidate.recordTimeSpanMinutes}m full span
                </span>
              </summary>
              <div className="related-headline-detail">
                <p>
                  Jev classes in these records: +{candidate.sentiment.positive} / ={candidate.sentiment.neutral} / −{candidate.sentiment.negative}
                  {candidate.impactRange.kind === "available"
                    ? ` · impact range ${fmtIndex(candidate.impactRange.min)} to ${fmtIndex(candidate.impactRange.max)} points`
                    : " · no scored impact values"}
                  {" · "}latest record time {timeAgo(candidate.latestRecordAt, now)}
                </p>
                <div className="related-headline-members">
                  <MemberRows member={candidate.anchor} now={now} onOpenMention={onOpenMention} />
                  {candidate.related.map((member) => (
                    <MemberRows key={member.mentions[0]?.id} member={member} now={now} onOpenMention={onOpenMention} />
                  ))}
                </div>
                <p className="related-headline-caveat">
                  The matching rule is a review aid, not story identity, source independence, or an alternative score.
                </p>
              </div>
            </details>
          ))}
          {candidates.length > 3 && <p className="related-headline-empty">Showing 3 of {candidates.length} candidates from the loaded sample.</p>}
        </div>
      )}
    </section>
  );
}

function MemberRows({
  member,
  now,
  onOpenMention,
}: {
  member: RelatedHeadlineMember;
  now: number;
  onOpenMention: (mention: Mention) => void;
}) {
  return (
    <div className="related-headline-member">
      <div className="related-headline-member-title">{member.title}</div>
      {member.sharedTerms.length > 0 && (
        <div className="related-headline-match">
          {member.overlapPercent}% title overlap · shared terms: {member.sharedTerms.slice(0, 5).join(", ")}{member.sharedTerms.length > 5 ? ", …" : ""} · anchor + this title full span {member.anchorPairTimeSpanMinutes}m
        </div>
      )}
      {member.mentions.map((mention) => (
        <RelatedRecordButton key={mention.id} mention={mention} now={now} onOpenMention={onOpenMention} />
      ))}
    </div>
  );
}

function RelatedRecordButton({
  mention,
  now,
  onOpenMention,
}: {
  mention: Mention;
  now: number;
  onOpenMention: (mention: Mention) => void;
}) {
  const publisherLabel = mention.publisherName || mention.source.name;
  const publisherDomain = mention.publisherDomain || mention.source.publisherDomain || "publisher domain unavailable";
  const collectorLabel = mention.collector === "legacy_unknown" ? "collector unknown" : mention.collector;
  const recordAt = mention.publishedAt ?? mention.providerObservedAt ?? mention.retrievedAt;
  const timeBasisLabel = mention.timeBasis === "publisher_declared"
    ? "publisher time"
    : mention.timeBasis === "provider_observed" ? "provider observed" : "retrieval fallback";
  const evidenceLabel = mention.score
    ? `${mention.score.sentiment}, impact ${fmtIndex(mention.score.impact)}`
    : mention.status;

  return (
    <button
      type="button"
      className="related-headline-record"
      onClick={() => onOpenMention(mention)}
      aria-label={`Open saved evidence record from ${publisherLabel}: ${mention.title}. Domain ${publisherDomain}; collector ${collectorLabel}; ${timeAgo(recordAt, now)} ${timeBasisLabel}; ${evidenceLabel}.`}
    >
      <span className="related-headline-record-top">
        <span>{publisherLabel}</span>
        <span>{evidenceLabel}</span>
      </span>
      <span className="related-headline-record-source">{publisherDomain} · {collectorLabel}</span>
      <span className="related-headline-record-time">{timeAgo(recordAt, now)} · {timeBasisLabel}</span>
    </button>
  );
}
