import { describe, expect, it } from "vitest";
import {
  isScoreBucketCoverage,
  normalizeExactHeadline,
  sameScoreBucketCoverage,
  summarizeScoreBucketCoverage,
  type ScoreBucketCoverageInput,
} from "../shared/score-bucket-coverage.js";

function record(overrides: Partial<ScoreBucketCoverageInput> = {}): ScoreBucketCoverageInput {
  return {
    title: "Café update",
    scoredAt: 1_800_000_000_000,
    timeBasis: "publisher_declared",
    publisherPublishedAt: 1_799_999_000_000,
    providerObservedAt: null,
    deliveryId: null,
    ...overrides,
  };
}

describe("full score-bucket coverage", () => {
  it("uses exact normalized titles, basis-specific source clocks, and all scored rows", () => {
    expect(normalizeExactHeadline("  CAFE\u0301   UPDATE ")).toBe("café update");
    const summary = summarizeScoreBucketCoverage([
      record(),
      record({ title: "CAFÉ UPDATE", scoredAt: 1_800_000_000_250, deliveryId: "receipt-1" }),
      record({ title: " ", scoredAt: 1_800_000_000_500, publisherPublishedAt: null }),
      record({
        title: "Different story",
        timeBasis: "provider_observed",
        publisherPublishedAt: null,
        providerObservedAt: 1_799_998_000_000,
      }),
      record({
        title: "Uncertain clock",
        timeBasis: "unknown",
        publisherPublishedAt: 1_799_997_000_000,
        providerObservedAt: 1_799_996_000_000,
      }),
      record({
        title: "Old row",
        timeBasis: "legacy_unknown",
        publisherPublishedAt: 1_799_995_000_000,
        providerObservedAt: 1_799_994_000_000,
      }),
    ]);

    expect(summary).toEqual({
      exactNormalizedTitleCount: 4,
      repeatedTitleRecordCount: 2,
      untitledRecordCount: 1,
      scoreCompletionTime: { earliestAtMs: 1_800_000_000_000, latestAtMs: 1_800_000_000_500 },
      sourceTimes: {
        publisherDeclared: {
          recordCount: 3,
          timestampedRecordCount: 2,
          range: { earliestAtMs: 1_799_999_000_000, latestAtMs: 1_799_999_000_000 },
        },
        providerObserved: {
          recordCount: 1,
          timestampedRecordCount: 1,
          range: { earliestAtMs: 1_799_998_000_000, latestAtMs: 1_799_998_000_000 },
        },
        unknownRecordCount: 1,
        legacyUnknownRecordCount: 1,
      },
      receiptLinkedRecordCount: 1,
    });
    expect(isScoreBucketCoverage(summary, 6)).toBe(true);
    expect(isScoreBucketCoverage(summary, 6, 1_800_000_000_000, 1_800_000_000_501)).toBe(true);
    expect(isScoreBucketCoverage(summary, 6, 1_800_000_000_000, 1_800_000_000_500)).toBe(false);
    expect(isScoreBucketCoverage({ ...summary, repeatedTitleRecordCount: 1 }, 6)).toBe(false);
    expect(isScoreBucketCoverage({ ...summary, exactNormalizedTitleCount: 0 }, 6)).toBe(false);
    expect(isScoreBucketCoverage({ ...summary, repeatedTitleRecordCount: 0 }, 6)).toBe(false);
  });

  it("keeps empty ranges null and rejects impossible or inconsistent summaries", () => {
    const empty = summarizeScoreBucketCoverage([]);
    expect(empty.scoreCompletionTime).toBeNull();
    expect(empty.sourceTimes.publisherDeclared.range).toBeNull();
    expect(isScoreBucketCoverage(empty, 0)).toBe(true);
    expect(isScoreBucketCoverage({ ...empty, scoreCompletionTime: { earliestAtMs: 1, latestAtMs: 1 } }, 0)).toBe(false);
    expect(isScoreBucketCoverage({
      ...empty,
      sourceTimes: {
        ...empty.sourceTimes,
        publisherDeclared: { recordCount: 1, timestampedRecordCount: 0, range: { earliestAtMs: 1, latestAtMs: 1 } },
      },
    }, 1)).toBe(false);
    expect(isScoreBucketCoverage({ ...empty, exactNormalizedTitleCount: 1 }, 0)).toBe(false);
  });

  it("summarizes large buckets without a spread-argument limit", () => {
    const summary = summarizeScoreBucketCoverage(Array.from({ length: 130_000 }, (_, index) => record({
      scoredAt: 1_800_000_000_000 + index,
    })));
    expect(summary.scoreCompletionTime).toEqual({
      earliestAtMs: 1_800_000_000_000,
      latestAtMs: 1_800_000_129_999,
    });
    expect(summary.repeatedTitleRecordCount).toBe(130_000);
  });

  it("compares every accepted full-bucket coverage value", () => {
    const left = summarizeScoreBucketCoverage([record()]);
    expect(sameScoreBucketCoverage(left, { ...left })).toBe(true);
    expect(sameScoreBucketCoverage(left, { ...left, receiptLinkedRecordCount: 1 })).toBe(false);
  });
});
