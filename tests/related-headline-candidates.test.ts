import { describe, expect, it } from "vitest";
import type { Mention, Sentiment } from "../web/src/lib/api.js";
import { findRelatedHeadlineCandidates } from "../web/src/lib/related-headline-candidates.js";

function mention(input: {
  id: string;
  title: string;
  publisher: string;
  at?: number;
  companyId?: string;
  sentiment?: Sentiment;
  impact?: number;
  status?: Mention["status"];
}): Mention {
  const at = input.at ?? 1_000_000;
  const status = input.status ?? "scored";
  return {
    id: input.id,
    companyId: input.companyId ?? "company-a",
    source: {
      name: input.publisher,
      url: `https://${input.publisher}/${input.id}`,
      kind: "rss",
      tier: "major",
      collector: "google_news_rss",
      publisher: input.publisher,
      publisherDomain: input.publisher,
    },
    title: input.title,
    snippet: "Saved source record",
    publishedAt: at,
    providerObservedAt: null,
    retrievedAt: at,
    ingestedAt: at,
    timeBasis: "publisher_declared",
    collector: "google_news_rss",
    publisherName: input.publisher,
    publisherDomain: input.publisher,
    status,
    scoreRetryAt: null,
    usageCheckRequired: false,
    score: status === "scored" ? {
      sentiment: input.sentiment ?? "positive",
      pPos: 0.7,
      pNeu: 0.2,
      pNeg: 0.1,
      confidence: 0.7,
      about: 1,
      material: 0.8,
      novel: 0.8,
      credible: 0.8,
      eventType: "other",
      takeaway: "context",
      magnitude: 0.6,
      surprise: 0.2,
      eventScore: 60,
      impact: input.impact ?? 60,
      weight: 0.7,
      engine: "test",
      inputTokens: 1,
      outputTokens: 1,
      estimatedInputCostUsd: 0,
      latencyMs: 1,
      rubricSha: "fixture",
      scoredAt: at,
    } : null,
    error: null,
  };
}

describe("provisional related-headline candidates", () => {
  it("groups non-identical titles by visible term overlap and keeps raw rows and score disagreement", () => {
    const rows = [
      mention({ id: "one", publisher: "wire.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises" }),
      mention({ id: "two", publisher: "paper.example", title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates", at: 1_060_000, sentiment: "negative", impact: -35 }),
      mention({ id: "three", publisher: "local.example", title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates", at: 1_090_000, sentiment: "neutral", impact: 5 }),
    ];
    const before = structuredClone(rows);

    const [candidate] = findRelatedHeadlineCandidates(rows);

    expect(candidate).toMatchObject({
      scoredRecordCount: 3,
      publisherLabelCount: 3,
      sentiment: { positive: 1, neutral: 1, negative: 1 },
      impactRange: { kind: "available", min: -35, max: 60 },
    });
    expect(candidate?.related).toHaveLength(1);
    const groupedIds = [
      ...(candidate?.anchor.mentions.map((row) => row.id) ?? []),
      ...(candidate?.related.flatMap((member) => member.mentions.map((row) => row.id)) ?? []),
    ];
    expect(groupedIds).toEqual(expect.arrayContaining(["one", "two", "three"]));
    expect(candidate?.related[0]?.sharedTerms).toEqual(expect.arrayContaining(["acme", "cloud", "estimates", "revenue"]));
    expect(rows).toEqual(before);
  });

  it("does not infer candidates from exact repeats alone, weak overlap, another company, or distant times", () => {
    const candidates = findRelatedHeadlineCandidates([
      mention({ id: "same-a", publisher: "one.example", title: "Acme quarterly revenue grows strongly" }),
      mention({ id: "same-b", publisher: "two.example", title: "Acme quarterly revenue grows strongly" }),
      mention({ id: "weak", publisher: "three.example", title: "Acme factory location changes soon" }),
      mention({ id: "other-company", publisher: "four.example", title: "Acme quarterly revenue grows analyst estimates", companyId: "company-b" }),
      mention({ id: "late", publisher: "five.example", title: "Acme quarterly revenue beats analyst estimates" , at: 1_000_000 + 7 * 60 * 60_000 }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("keeps distant repetitions out when one occurrence is near a related title", () => {
    const rows = [
      mention({ id: "early", publisher: "wire.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises", at: 1_000_000 }),
      mention({ id: "late-copy", publisher: "local.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises", at: 1_000_000 + 7 * 24 * 60 * 60_000 }),
      mention({ id: "variant", publisher: "paper.example", title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates", at: 1_000_000 + 60 * 60_000 }),
    ];

    const candidates = findRelatedHeadlineCandidates(rows);
    const group = candidates[0];
    const groupedIds = group == null ? [] : [
      ...group.anchor.mentions.map((row) => row.id),
      ...group.related.flatMap((member) => member.mentions.map((row) => row.id)),
    ];

    expect(candidates).toHaveLength(1);
    expect(group?.recordTimeSpanMinutes).toBe(60);
    expect(groupedIds).toEqual(expect.arrayContaining(["early", "variant"]));
    expect(groupedIds).not.toContain("late-copy");
  });

  it("reports the anchor-to-title span instead of repeating the cumulative candidate span", () => {
    const base = 1_000_000;
    const candidates = findRelatedHeadlineCandidates([
      mention({ id: "anchor-early", publisher: "wire.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises", at: base + 95 * 60_000 }),
      mention({ id: "anchor-latest", publisher: "wire.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises", at: base + 100 * 60_000 }),
      mention({ id: "older-copy", publisher: "paper.example", title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates", at: base + 10 * 60_000 }),
      mention({ id: "newer-copy", publisher: "paper.example", title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates", at: base + 95 * 60_000 }),
      mention({ id: "near-variant", publisher: "local.example", title: "Acme Q3 revenue exceeds analyst estimates as cloud demand rises", at: base + 85 * 60_000 }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.recordTimeSpanMinutes).toBe(90);
    expect(candidates[0]?.related[1]?.anchorPairTimeSpanMinutes).toBe(15);
  });

  it("accepts a pair with exactly three shared content terms when the ratio qualifies", () => {
    const candidates = findRelatedHeadlineCandidates([
      mention({ id: "one", publisher: "wire.example", title: "Acme AI growth" }),
      mention({ id: "two", publisher: "paper.example", title: "AI growth at Acme", at: 1_030_000 }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.related[0]?.sharedTerms).toEqual(["acme", "ai", "growth"]);
  });

  it("uses no unscored, pending, or empty-title rows as sentiment evidence", () => {
    const candidates = findRelatedHeadlineCandidates([
      mention({ id: "pending", publisher: "one.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises", status: "pending" }),
      mention({ id: "empty", publisher: "two.example", title: "   " }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("keeps historical unknown-source rows out of candidates", () => {
    const unknown = mention({ id: "unknown", publisher: "old.example", title: "Acme Q3 revenue beats analyst estimates after cloud demand rises" });
    unknown.collector = "legacy_unknown";
    unknown.timeBasis = "legacy_unknown";
    unknown.source.collector = "legacy_unknown";
    const identified = mention({ id: "identified", publisher: "wire.example", title: "Acme Q3 revenue tops analyst estimates as cloud demand accelerates" });

    expect(findRelatedHeadlineCandidates([unknown, identified])).toEqual([]);
  });
});
