export type ObservedTimeRange = {
  earliestAtMs: number;
  latestAtMs: number;
};

export type KnownSourceTimeCoverage = {
  recordCount: number;
  timestampedRecordCount: number;
  range: ObservedTimeRange | null;
};

export type ScoreBucketCoverage = {
  exactNormalizedTitleCount: number;
  repeatedTitleRecordCount: number;
  untitledRecordCount: number;
  scoreCompletionTime: ObservedTimeRange | null;
  sourceTimes: {
    publisherDeclared: KnownSourceTimeCoverage;
    aggregatorDeclared?: KnownSourceTimeCoverage;
    providerObserved: KnownSourceTimeCoverage;
    unknownRecordCount: number;
    legacyUnknownRecordCount: number;
  };
  receiptLinkedRecordCount: number;
};

export type ScoreBucketCoverageInput = {
  title: string;
  scoredAt: number;
  timeBasis: string;
  publisherPublishedAt: number | null;
  aggregatorPublishedAt?: number | null;
  providerObservedAt: number | null;
  deliveryId: string | null;
};

export function normalizeExactHeadline(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function validTime(value: number | null): value is number {
  return value != null && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

type TimeAccumulator = { count: number; earliestAtMs: number | null; latestAtMs: number | null };

function addTime(accumulator: TimeAccumulator, value: number | null): void {
  if (!validTime(value)) return;
  accumulator.count += 1;
  accumulator.earliestAtMs = accumulator.earliestAtMs == null ? value : Math.min(accumulator.earliestAtMs, value);
  accumulator.latestAtMs = accumulator.latestAtMs == null ? value : Math.max(accumulator.latestAtMs, value);
}

function accumulatedRange(accumulator: TimeAccumulator): ObservedTimeRange | null {
  if (accumulator.earliestAtMs == null || accumulator.latestAtMs == null) return null;
  return { earliestAtMs: accumulator.earliestAtMs, latestAtMs: accumulator.latestAtMs };
}

export function summarizeScoreBucketCoverage(
  records: readonly ScoreBucketCoverageInput[],
): ScoreBucketCoverage {
  const titleCounts = new Map<string, number>();
  const scoreTimes: TimeAccumulator = { count: 0, earliestAtMs: null, latestAtMs: null };
  const publisherTimes: TimeAccumulator = { count: 0, earliestAtMs: null, latestAtMs: null };
  const aggregatorTimes: TimeAccumulator = { count: 0, earliestAtMs: null, latestAtMs: null };
  const providerTimes: TimeAccumulator = { count: 0, earliestAtMs: null, latestAtMs: null };
  let untitledRecordCount = 0;
  let repeatedTitleRecordCount = 0;
  let publisherRecordCount = 0;
  let aggregatorRecordCount = 0;
  let providerRecordCount = 0;
  let unknownRecordCount = 0;
  let legacyUnknownRecordCount = 0;
  let receiptLinkedRecordCount = 0;

  for (const record of records) {
    if (!validTime(record.scoredAt)) throw new Error("score_bucket_invalid_completion_time");
    addTime(scoreTimes, record.scoredAt);
    const normalizedTitle = normalizeExactHeadline(record.title);
    if (normalizedTitle) titleCounts.set(normalizedTitle, (titleCounts.get(normalizedTitle) ?? 0) + 1);
    else untitledRecordCount += 1;

    if (record.deliveryId != null) receiptLinkedRecordCount += 1;
    if (record.timeBasis === "publisher_declared") {
      publisherRecordCount += 1;
      addTime(publisherTimes, record.publisherPublishedAt);
    } else if (record.timeBasis === "aggregator_declared") {
      aggregatorRecordCount += 1;
      addTime(aggregatorTimes, record.aggregatorPublishedAt ?? null);
    } else if (record.timeBasis === "provider_observed") {
      providerRecordCount += 1;
      addTime(providerTimes, record.providerObservedAt);
    } else if (record.timeBasis === "legacy_unknown") {
      legacyUnknownRecordCount += 1;
    } else {
      unknownRecordCount += 1;
    }
  }

  for (const count of titleCounts.values()) {
    if (count > 1) repeatedTitleRecordCount += count;
  }

  return {
    exactNormalizedTitleCount: titleCounts.size,
    repeatedTitleRecordCount,
    untitledRecordCount,
    scoreCompletionTime: accumulatedRange(scoreTimes),
    sourceTimes: {
      publisherDeclared: {
        recordCount: publisherRecordCount,
        timestampedRecordCount: publisherTimes.count,
        range: accumulatedRange(publisherTimes),
      },
      aggregatorDeclared: {
        recordCount: aggregatorRecordCount,
        timestampedRecordCount: aggregatorTimes.count,
        range: accumulatedRange(aggregatorTimes),
      },
      providerObserved: {
        recordCount: providerRecordCount,
        timestampedRecordCount: providerTimes.count,
        range: accumulatedRange(providerTimes),
      },
      unknownRecordCount,
      legacyUnknownRecordCount,
    },
    receiptLinkedRecordCount,
  };
}

function isRange(value: unknown): value is ObservedTimeRange {
  if (typeof value !== "object" || value == null) return false;
  const range = value as Partial<ObservedTimeRange>;
  return Number.isSafeInteger(range.earliestAtMs) && Number.isSafeInteger(range.latestAtMs)
    && Math.abs(range.earliestAtMs!) <= 8_640_000_000_000_000
    && Math.abs(range.latestAtMs!) <= 8_640_000_000_000_000
    && range.latestAtMs! >= range.earliestAtMs!;
}

function isKnownSourceTimeCoverage(value: unknown): value is KnownSourceTimeCoverage {
  if (typeof value !== "object" || value == null) return false;
  const coverage = value as Partial<KnownSourceTimeCoverage>;
  if (!Number.isSafeInteger(coverage.recordCount) || !Number.isSafeInteger(coverage.timestampedRecordCount)
    || coverage.recordCount! < 0 || coverage.timestampedRecordCount! < 0
    || coverage.timestampedRecordCount! > coverage.recordCount!) return false;
  return coverage.timestampedRecordCount === 0
    ? coverage.range === null
    : isRange(coverage.range);
}

export function isScoreBucketCoverage(
  value: unknown,
  recordCount: number,
  bucketFromMs?: number,
  bucketThroughMs?: number,
): value is ScoreBucketCoverage {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || typeof value !== "object" || value == null) return false;
  const coverage = value as Partial<ScoreBucketCoverage>;
  const sourceTimes = coverage.sourceTimes;
  if (!Number.isSafeInteger(coverage.exactNormalizedTitleCount) || !Number.isSafeInteger(coverage.repeatedTitleRecordCount)
    || !Number.isSafeInteger(coverage.untitledRecordCount) || !Number.isSafeInteger(coverage.receiptLinkedRecordCount)
    || coverage.exactNormalizedTitleCount! < 0 || coverage.repeatedTitleRecordCount! < 0
    || coverage.untitledRecordCount! < 0 || coverage.receiptLinkedRecordCount! < 0
    || coverage.exactNormalizedTitleCount! + coverage.untitledRecordCount! > recordCount
    || coverage.repeatedTitleRecordCount! > recordCount - coverage.untitledRecordCount!
    || coverage.receiptLinkedRecordCount! > recordCount
    || (recordCount === 0 ? coverage.scoreCompletionTime !== null : !isRange(coverage.scoreCompletionTime))) return false;
  const titledRecordCount = recordCount - coverage.untitledRecordCount!;
  const duplicateRecordExcess = titledRecordCount - coverage.exactNormalizedTitleCount!;
  if ((titledRecordCount === 0 && (coverage.exactNormalizedTitleCount !== 0 || coverage.repeatedTitleRecordCount !== 0))
    || (titledRecordCount > 0 && coverage.exactNormalizedTitleCount === 0)
    || (duplicateRecordExcess === 0 && coverage.repeatedTitleRecordCount !== 0)
    || (duplicateRecordExcess > 0 && (coverage.repeatedTitleRecordCount! < duplicateRecordExcess + 1
      || coverage.repeatedTitleRecordCount! > duplicateRecordExcess * 2))) return false;
  if (bucketFromMs !== undefined || bucketThroughMs !== undefined) {
    if (!Number.isSafeInteger(bucketFromMs) || !Number.isSafeInteger(bucketThroughMs) || bucketThroughMs! <= bucketFromMs!) return false;
    const completion = coverage.scoreCompletionTime;
    if (completion != null && (completion.earliestAtMs < bucketFromMs! || completion.latestAtMs >= bucketThroughMs!)) return false;
  }
  if (typeof sourceTimes !== "object" || sourceTimes == null
    || !isKnownSourceTimeCoverage(sourceTimes.publisherDeclared)
    || (sourceTimes.aggregatorDeclared != null && !isKnownSourceTimeCoverage(sourceTimes.aggregatorDeclared))
    || !isKnownSourceTimeCoverage(sourceTimes.providerObserved)
    || !Number.isSafeInteger(sourceTimes.unknownRecordCount) || !Number.isSafeInteger(sourceTimes.legacyUnknownRecordCount)
    || sourceTimes.unknownRecordCount! < 0 || sourceTimes.legacyUnknownRecordCount! < 0) return false;
  return sourceTimes.publisherDeclared.recordCount + sourceTimes.providerObserved.recordCount
    + (sourceTimes.aggregatorDeclared?.recordCount ?? 0)
    + sourceTimes.unknownRecordCount! + sourceTimes.legacyUnknownRecordCount! === recordCount;
}

export function sameScoreBucketCoverage(left: ScoreBucketCoverage, right: ScoreBucketCoverage): boolean {
  return left.exactNormalizedTitleCount === right.exactNormalizedTitleCount
    && left.repeatedTitleRecordCount === right.repeatedTitleRecordCount
    && left.untitledRecordCount === right.untitledRecordCount
    && left.receiptLinkedRecordCount === right.receiptLinkedRecordCount
    && JSON.stringify(left.scoreCompletionTime) === JSON.stringify(right.scoreCompletionTime)
    && JSON.stringify(left.sourceTimes) === JSON.stringify(right.sourceTimes);
}
