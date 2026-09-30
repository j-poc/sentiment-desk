import type { Mention } from "./api.js";

export const RELATED_HEADLINE_RULE = {
  maxRecordTimeSpanHours: 6,
  minSharedTerms: 3,
  minJaccardOverlap: 0.4,
} as const;

const MAX_RECORD_TIME_SPAN_MS = RELATED_HEADLINE_RULE.maxRecordTimeSpanHours * 60 * 60_000;
const MIN_SHARED_TERMS = RELATED_HEADLINE_RULE.minSharedTerms;
const MIN_JACCARD_OVERLAP = RELATED_HEADLINE_RULE.minJaccardOverlap;

const COMMON_HEADLINE_TERMS = new Set([
  "a", "an", "and", "as", "at", "after", "before", "by", "for", "from", "in", "into",
  "is", "its", "of", "on", "or", "says", "said", "the", "to", "up", "via", "was", "with",
  "report", "reports", "reported", "announces", "announced", "shares", "stock",
]);

export interface RelatedHeadlineMember {
  title: string;
  mentions: Mention[];
  sharedTerms: string[];
  overlapPercent: number;
  anchorPairTimeSpanMinutes: number;
}

export interface RelatedHeadlineCandidate {
  anchor: RelatedHeadlineMember;
  related: [RelatedHeadlineMember, ...RelatedHeadlineMember[]];
  scoredRecordCount: number;
  publisherLabelCount: number;
  sentiment: { positive: number; neutral: number; negative: number };
  impactRange: { kind: "available"; min: number; max: number } | { kind: "none" };
  recordTimeSpanMinutes: number;
  latestRecordAt: number;
}

interface HeadlineBucket {
  key: string;
  headlineKey: string;
  companyId: string;
  title: string;
  mentions: Mention[];
  terms: Set<string>;
  earliestRecordAt: number;
  latestRecordAt: number;
}

interface HeadlineMatch {
  bucket: HeadlineBucket;
  sharedTerms: string[];
  overlapPercent: number;
  anchorPairTimeSpanMinutes: number;
}

function recordTime(mention: Mention): number {
  return mention.publishedAt ?? mention.providerObservedAt ?? mention.retrievedAt;
}

function headlineKey(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function headlineTerms(title: string): Set<string> {
  return new Set(
    (title.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length > 1 && !COMMON_HEADLINE_TERMS.has(term)),
  );
}

function sharedContentTerms(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((term) => right.has(term)).sort((a, b) => a.localeCompare(b, "en-US"));
}

function jaccardOverlap(left: Set<string>, right: Set<string>, sharedCount: number): number {
  const unionCount = left.size + right.size - sharedCount;
  return unionCount === 0 ? 0 : sharedCount / unionCount;
}

function timeBounds(mentions: Mention[]): { earliest: number; latest: number } | null {
  const times = mentions.map(recordTime);
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  return Number.isFinite(earliest) && Number.isFinite(latest) ? { earliest, latest } : null;
}

function publisherKey(mention: Mention): string {
  const publisher = mention.publisherDomain || mention.publisherName || mention.source.name;
  return publisher.normalize("NFKC").trim().replace(/^www\./i, "").toLocaleLowerCase("en-US");
}

function splitIntoTimeBuckets(companyId: string, normalizedTitle: string, rows: Mention[]): HeadlineBucket[] {
  const ordered = [...rows].sort((a, b) => recordTime(a) - recordTime(b) || a.id.localeCompare(b.id, "en-US"));
  const buckets: HeadlineBucket[] = [];
  let current: Mention[] = [];
  let currentStart: number | null = null;
  let bucketIndex = 0;

  const saveCurrent = () => {
    const first = current[0];
    const bounds = timeBounds(current);
    if (!first || !bounds) return;
    const terms = headlineTerms(first.title);
    if (terms.size >= MIN_SHARED_TERMS) {
      buckets.push({
        key: `${companyId}\u0000${normalizedTitle}\u0000${bucketIndex}`,
        headlineKey: normalizedTitle,
        companyId,
        title: first.title,
        mentions: current,
        terms,
        earliestRecordAt: bounds.earliest,
        latestRecordAt: bounds.latest,
      });
    }
    bucketIndex += 1;
    current = [];
    currentStart = null;
  };

  for (const mention of ordered) {
    const at = recordTime(mention);
    if (currentStart != null && at - currentStart > MAX_RECORD_TIME_SPAN_MS) saveCurrent();
    if (currentStart == null) currentStart = at;
    current.push(mention);
  }
  saveCurrent();
  return buckets;
}

function member(
  bucket: HeadlineBucket,
  sharedTerms: string[],
  overlapPercent: number,
  anchorPairTimeSpanMinutes: number,
): RelatedHeadlineMember {
  return {
    title: bucket.title,
    mentions: bucket.mentions,
    sharedTerms,
    overlapPercent,
    anchorPairTimeSpanMinutes,
  };
}

/**
 * Find provisional, explainable headline-overlap candidates from saved rows.
 * Every row in a candidate is time-scoped to one six-hour span. The groups are
 * inspection aids only: they are not verified events, independent-source
 * counts, or inputs to sentiment scores and rankings.
 */
export function findRelatedHeadlineCandidates(mentions: Mention[]): RelatedHeadlineCandidate[] {
  const byCompanyAndTitle = new Map<string, { companyId: string; normalizedTitle: string; rows: Mention[] }>();
  for (const mention of mentions) {
    if (mention.collector === "legacy_unknown" || mention.timeBasis === "legacy_unknown") continue;
    if (mention.status !== "scored" || mention.score == null || !mention.title.trim()) continue;
    const normalizedTitle = headlineKey(mention.title);
    const key = `${mention.companyId}\u0000${normalizedTitle}`;
    const group = byCompanyAndTitle.get(key) ?? { companyId: mention.companyId, normalizedTitle, rows: [] };
    group.rows.push(mention);
    byCompanyAndTitle.set(key, group);
  }

  const buckets = [...byCompanyAndTitle.values()]
    .flatMap((group) => splitIntoTimeBuckets(group.companyId, group.normalizedTitle, group.rows))
    .sort((a, b) => b.latestRecordAt - a.latestRecordAt || a.key.localeCompare(b.key, "en-US"));

  const groupedBuckets = new Set<string>();
  const candidates: RelatedHeadlineCandidate[] = [];
  for (const anchor of buckets) {
    if (groupedBuckets.has(anchor.key)) continue;
    const related: HeadlineMatch[] = [];
    let candidateEarliest = anchor.earliestRecordAt;
    let candidateLatest = anchor.latestRecordAt;

    for (const bucket of buckets) {
      if (bucket.key === anchor.key || groupedBuckets.has(bucket.key)) continue;
      if (bucket.companyId !== anchor.companyId || bucket.headlineKey === anchor.headlineKey) continue;

      const sharedTerms = sharedContentTerms(anchor.terms, bucket.terms);
      if (sharedTerms.length < MIN_SHARED_TERMS) continue;
      const overlap = jaccardOverlap(anchor.terms, bucket.terms, sharedTerms.length);
      if (overlap < MIN_JACCARD_OVERLAP) continue;

      const expandedEarliest = Math.min(candidateEarliest, bucket.earliestRecordAt);
      const expandedLatest = Math.max(candidateLatest, bucket.latestRecordAt);
      if (expandedLatest - expandedEarliest > MAX_RECORD_TIME_SPAN_MS) continue;

      related.push({
        bucket,
        sharedTerms,
        overlapPercent: Math.round(overlap * 100),
        anchorPairTimeSpanMinutes: Math.round((
          Math.max(anchor.latestRecordAt, bucket.latestRecordAt)
          - Math.min(anchor.earliestRecordAt, bucket.earliestRecordAt)
        ) / 60_000),
      });
      candidateEarliest = expandedEarliest;
      candidateLatest = expandedLatest;
    }
    const firstRelated = related[0];
    if (!firstRelated) continue;

    const anchorMember = member(anchor, [], 100, 0);
    const records = [...anchor.mentions, ...related.flatMap((item) => item.bucket.mentions)];
    const impacts = records.flatMap((mention) => mention.score ? [mention.score.impact] : []);
    const publishers = new Set(records.map(publisherKey).filter(Boolean));
    const sentiment = {
      positive: records.filter((mention) => mention.score?.sentiment === "positive").length,
      neutral: records.filter((mention) => mention.score?.sentiment === "neutral").length,
      negative: records.filter((mention) => mention.score?.sentiment === "negative").length,
    };
    const bounds = timeBounds(records);
    if (!bounds) continue;

    groupedBuckets.add(anchor.key);
    for (const item of related) groupedBuckets.add(item.bucket.key);

    candidates.push({
      anchor: anchorMember,
      related: [
        member(firstRelated.bucket, firstRelated.sharedTerms, firstRelated.overlapPercent, firstRelated.anchorPairTimeSpanMinutes),
        ...related.slice(1).map((item) => member(item.bucket, item.sharedTerms, item.overlapPercent, item.anchorPairTimeSpanMinutes)),
      ],
      scoredRecordCount: records.length,
      publisherLabelCount: publishers.size,
      sentiment,
      impactRange: impacts.length === 0
        ? { kind: "none" }
        : { kind: "available", min: Math.min(...impacts), max: Math.max(...impacts) },
      recordTimeSpanMinutes: Math.round((bounds.latest - bounds.earliest) / 60_000),
      latestRecordAt: bounds.latest,
    });
  }

  return candidates.sort((a, b) => b.scoredRecordCount - a.scoredRecordCount || b.latestRecordAt - a.latestRecordAt);
}
