import { describe, expect, it } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { filterExactHeadlineGroups, groupExactHeadlineRepeats } from "../web/src/lib/exact-headline-groups.js";

function mention(overrides: Partial<Mention> & Pick<Mention, "id" | "title">): Mention {
  return {
    companyId: "acme",
    source: { name: "Publisher", url: `https://example.com/${overrides.id}`, kind: "rss", tier: "major", collector: "google_news_rss", publisher: "Publisher", publisherDomain: "example.com" },
    snippet: "Saved source text",
    publishedAt: 1_000,
    providerObservedAt: null,
    retrievedAt: 1_000,
    ingestedAt: 1_000,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: "Publisher",
    publisherDomain: "example.com",
    status: "scored",
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: {
      sentiment: "positive", pPos: 0.8, pNeu: 0.1, pNeg: 0.1, confidence: 0.8,
      about: 1, material: 0.8, novel: 0.8, credible: 0.9, eventType: "other",
      takeaway: "context", magnitude: 0.5, surprise: 0.1, eventScore: 60, impact: 70,
      weight: 0.8, engine: "test", inputTokens: 1, outputTokens: 1,
      estimatedInputCostUsd: 0, latencyMs: 1, rubricSha: "fixture", scoredAt: 1_000,
    },
    error: null,
    ...overrides,
  };
}

describe("exact-title feed grouping", () => {
  it("groups only case, spacing, and Unicode-normalized exact headlines and retains all records", () => {
    const first = mention({ id: "one", title: "Acme raises guidance", publisherDomain: "wire.example" });
    const second = mention({
      id: "two", title: "  ACME   raises guidance  ", publisherDomain: "paper.example",
      score: { ...first.score!, sentiment: "negative", impact: -45 },
    });
    const differentPunctuation = mention({ id: "three", title: "Acme raises guidance!" });
    const pending = mention({ id: "four", title: "Acme raises guidance", status: "pending", score: null });

    const entries = groupExactHeadlineRepeats([first, second, differentPunctuation, pending]);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      kind: "exact-title-repeats", title: "Acme raises guidance", publisherLabelCount: 2,
      directions: { positive: 1, neutral: 0, negative: 1 }, impactMin: -45, impactMax: 70,
    });
    if (entries[0]?.kind === "exact-title-repeats") {
      expect(entries[0].mentions.map((item) => item.id)).toEqual(["one", "two"]);
    }
    expect(entries[1]).toMatchObject({ kind: "mention", mention: { id: "three" } });
    expect(entries[2]).toMatchObject({ kind: "mention", mention: { id: "four" } });
  });

  it("does not collapse same headlines with different punctuation or unscored records", () => {
    const entries = groupExactHeadlineRepeats([
      mention({ id: "one", title: "Acme results" }),
      mention({ id: "two", title: "Acme results?" }),
      mention({ id: "three", title: "Acme results", status: "failed", score: null }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["mention", "mention", "mention"]);
  });

  it("groups pending rows by company and normalized title with deterministic source counts", () => {
    const entries = groupExactHeadlineRepeats([
      mention({ id: "p1", title: "Acme files results", status: "pending", score: null, publisherName: "Wire A", publisherDomain: "wire-a.example", collector: "google_news_rss" }),
      mention({ id: "p2", title: " ACME  FILES results ", status: "pending", score: null, publisherName: "Wire B", publisherDomain: "wire-b.example", collector: "gdelt_doc_api" }),
      mention({ id: "other-company", companyId: "other", title: "Acme files results", status: "pending", score: null }),
      mention({ id: "retry", title: "Acme files results", status: "retrying", score: null }),
      mention({ id: "failed", title: "Acme files results", status: "failed", score: null }),
      mention({ id: "empty", title: "   ", status: "pending", score: null }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "pending-title-repeats", "mention", "mention", "mention", "mention",
    ]);
    expect(entries[0]).toMatchObject({
      kind: "pending-title-repeats", companyId: "acme", title: "Acme files results",
      publisherLabelCount: 2, collectorFeedCount: 2,
    });
    if (entries[0]?.kind === "pending-title-repeats") {
      expect(entries[0].mentions.map((item) => item.id)).toEqual(["p1", "p2"]);
    }
    expect(entries.slice(1).map((entry) => entry.kind === "mention" ? entry.mention.id : "unexpected-group"))
      .toEqual(["other-company", "retry", "failed", "empty"]);
  });

  it("drills into repeated titles or only groups whose Jev labels differ", () => {
    const first = mention({ id: "one", title: "Acme announces contract" });
    const mixed = mention({
      id: "two", title: "Acme announces contract",
      score: { ...first.score!, sentiment: "negative", impact: -40 },
    });
    const neutral = mention({
      id: "three", title: "Acme expands factory",
      score: { ...first.score!, sentiment: "neutral", impact: 0 },
    });
    const secondNeutral = mention({
      id: "four", title: "Acme expands factory",
      score: { ...first.score!, sentiment: "neutral", impact: 2 },
    });
    const entries = groupExactHeadlineRepeats([first, mixed, neutral, secondNeutral]);

    expect(filterExactHeadlineGroups(entries, "repeated")).toHaveLength(2);
    expect(filterExactHeadlineGroups(entries, "mixed")).toMatchObject([{
      kind: "exact-title-repeats",
      title: "Acme announces contract",
      directions: { positive: 1, neutral: 0, negative: 1 },
    }]);
    expect(filterExactHeadlineGroups(entries, null)).toEqual(entries);
  });
});
