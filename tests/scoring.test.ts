import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyPostRules,
  bucketMsFor,
  forwardReturn,
  isFinanceRelevant,
  parseJudgment,
  rankIC,
  hasStrongIdentity,
  shouldAlert,
  weightedBucketSeries,
  summarizeReactions,
  weightedIndex,
} from "../server/scoring.js";
import type { ParsedJudgment } from "../server/scoring.js";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";

function judgment(over: Partial<ParsedJudgment> = {}): ParsedJudgment {
  return {
    sentiment: "negative",
    pPos: 0.1,
    pNeu: 0.2,
    pNeg: 0.7,
    confidence: 0.9,
    about: 0.95,
    material: 0.8,
    novel: 0.7,
    credible: 0.8,
    investorRelevant: 0.9,
    eventType: "legal_regulatory",
    takeaway: "legal_hit",
    magnitude: 0.7,
    surprise: 0.8,
    ...over,
  };
}

function answers(over: Record<string, unknown> = {}) {
  const eventTypeProbabilities = Object.fromEntries(
    EVENT_TYPES.map((eventType) => [eventType, eventType === "legal_regulatory" ? 0.8 : 0.2 / (EVENT_TYPES.length - 1)]),
  );
  const takeawayProbabilities = Object.fromEntries(
    TAKEAWAY_KEYS.map((key) => [key, key === "legal_hit" ? 0.8 : 0.2 / (TAKEAWAY_KEYS.length - 1)]),
  );
  return {
    sentiment: { type: "choice", choice: "negative", probabilities: { negative: 0.7, neutral: 0.2, positive: 0.1 }, confidence: 0.9 },
    about: { type: "noul", noul: 0.95 },
    material: { type: "noul", noul: 0.8 },
    novel: { type: "noul", noul: 0.6 },
    credible: { type: "noul", noul: 0.9 },
    investor_relevant: { type: "noul", noul: 0.85 },
    event_type: { type: "choice", choice: "legal_regulatory", probabilities: eventTypeProbabilities, confidence: 0.8 },
    takeaway: { type: "choice", choice: "legal_hit", probabilities: takeawayProbabilities, confidence: 0.8 },
    magnitude: { type: "noul", noul: 0.7 },
    surprise: { type: "noul", noul: 0.8 },
    ...over,
  };
}

describe("parseJudgment", () => {
  it("parses a full jev answer set", () => {
    const j = parseJudgment(answers());
    expect(j.sentiment).toBe("negative");
    expect(j.pNeg).toBeCloseTo(0.7);
    expect(j.confidence).toBe(0.9);
    expect(j.about).toBe(0.95);
    expect(j.eventType).toBe("legal_regulatory");
    expect(j.takeaway).toBe("legal_hit");
    expect(j.magnitude).toBe(0.7);
    expect(j.surprise).toBe(0.8);
  });

  it("rejects a missing, unknown, or probability-inconsistent choice", () => {
    const validSentiment = answers().sentiment;
    expect(() => parseJudgment(answers({ sentiment: { ...(validSentiment as object), choice: undefined } }))).toThrow();
    expect(() => parseJudgment(answers({ sentiment: { ...(validSentiment as object), choice: "bullish" } }))).toThrow();
    expect(() => parseJudgment(answers({ sentiment: { ...(validSentiment as object), choice: "positive" } }))).toThrow();
  });

  it("rejects incomplete, out-of-range, or unnormalized choice probabilities", () => {
    const validSentiment = answers().sentiment;
    expect(() => parseJudgment(answers({ sentiment: { ...(validSentiment as object), probabilities: { negative: 1 } } }))).toThrow();
    expect(() => parseJudgment(answers({ sentiment: { ...(validSentiment as object), probabilities: { negative: 1.2, neutral: 0, positive: 0 } } }))).toThrow();
    expect(() => parseJudgment(answers({ sentiment: { ...(validSentiment as object), probabilities: { negative: 0.2, neutral: 0.2, positive: 0.2 } } }))).toThrow();
  });

  it("fails closed on missing answers", () => {
    expect(() => parseJudgment({ sentiment: { probabilities: {} } })).toThrow();
    expect(() =>
      parseJudgment({
        sentiment: { probabilities: { negative: 1 } },
        about: { noul: 1 },
        // material, novel, credible missing
      }),
    ).toThrow();
  });

  it("rejects out-of-range noul values", () => {
    expect(() => parseJudgment(answers({ about: { noul: 1.5 } }))).toThrow();
    expect(() => parseJudgment(answers({ about: { type: "choice", noul: 0.5 } }))).toThrow();
  });
});

describe("applyPostRules", () => {
  it("excludes off-target mentions from the index", () => {
    const f = applyPostRules(judgment({ about: 0.3 }), 1);
    expect(f.exclude).toBe(true);
    expect(applyPostRules(judgment({ about: 0.5 }), 1).exclude).toBe(false);
  });

  it("damps low-confidence weight", () => {
    const hi = applyPostRules(judgment({ confidence: 0.9 }), 1).weight;
    const lo = applyPostRules(judgment({ confidence: 0.4 }), 1).weight;
    expect(lo).toBeLessThan(hi * 0.6);
  });

  it("impact is signed on a -100..100 scale", () => {
    expect(applyPostRules(judgment({ pPos: 0.8, pNeg: 0.1 }), 1).impact).toBe(70);
    expect(applyPostRules(judgment({ pPos: 0.05, pNeg: 0.75 }), 1).impact).toBe(-70);
  });

  it("blends source tier into the weight", () => {
    const wire = applyPostRules(judgment(), 1).weight;
    const social = applyPostRules(judgment(), 0.45).weight;
    expect(social).toBeCloseTo(wire * 0.45, 2);
  });
});

describe("weightedIndex", () => {
  it("computes the weighted mean", () => {
    expect(
      weightedIndex([
        { availableAt: 0, impact: 100, weight: 1 },
        { availableAt: 0, impact: -100, weight: 3 },
      ]),
    ).toBe(-50);
  });

  it("returns null with no usable weight", () => {
    expect(weightedIndex([])).toBeNull();
    expect(weightedIndex([{ availableAt: 0, impact: 10, weight: 0 }])).toBeNull();
  });
});

describe("weightedBucketSeries", () => {
  const bucket = 15 * 60_000;

  it("computes an order-invariant weighted mean and matching count and record spread", () => {
    const records = [
      { availableAt: bucket + 1, impact: -60, weight: 1, scoredAt: bucket + 1 },
      { availableAt: bucket + 2, impact: 40, weight: 3, scoredAt: bucket + 2 },
      { availableAt: bucket + 3, impact: 95, weight: 0 },
    ];
    const forward = weightedBucketSeries(records, 3 * bucket, bucket, 3 * bucket);
    const reversed = weightedBucketSeries([...records].reverse(), 3 * bucket, bucket, 3 * bucket);
    expect(forward).toEqual(reversed);
    expect(forward[1]).toMatchObject({
      v: 15,
      n: 3,
      itemImpactMin: -60,
      itemImpactMax: 95,
      lastScoredAt: bucket + 2,
    });
    expect(forward[1]?.v).toBe(weightedIndex(records.slice(0, 2)));
  });

  it("keeps empty UTC buckets null and emits no non-null points after the last record", () => {
    const now = 6 * bucket;
    const series = weightedBucketSeries([
      { availableAt: bucket + 1, impact: -20, weight: 1 },
      { availableAt: 4 * bucket + 1, impact: 60, weight: 1 },
    ], now, bucket, now);
    expect(series.map((point) => point.v)).toEqual([null, -20, null, null, 60, null]);
    expect(series.slice(5).every((point) => point.n === 0 && point.v == null)).toBe(true);
  });

  it("uses the selected half-open time window and retains zero-weight records in count and spread", () => {
    const start = 3 * bucket + bucket / 2;
    const now = 6 * bucket + bucket / 2;
    const result = weightedBucketSeries([
      { availableAt: start - 1, impact: 90, weight: 1 },
      { availableAt: start, impact: -10, weight: 1, scoredAt: start },
      { availableAt: 4 * bucket, impact: 30, weight: 1, scoredAt: 4 * bucket },
      { availableAt: now, impact: 50, weight: 1, scoredAt: now },
      { availableAt: now + 1, impact: -90, weight: 1 },
      { availableAt: 5 * bucket, impact: 90, weight: 0 },
      { availableAt: NaN, impact: 99, weight: 1 },
    ], 3 * bucket, bucket, now);

    expect(result.reduce((total, point) => total + point.n, 0)).toBe(3);
    expect(result.filter((point) => point.n > 0).map((point) => point.v)).toEqual([-10, 30, null]);
    expect(result.filter((point) => point.n > 0).map((point) => [point.itemImpactMin, point.itemImpactMax])).toEqual([[-10, -10], [30, 30], [90, 90]]);
    expect(result.at(-1)?.t).toBe(now);
    expect(result.at(-1)?.lastScoredAt).toBeNull();
  });

  it("uses one display bucket size across all selected windows", () => {
    expect(bucketMsFor(6)).toBe(bucketMsFor(24));
    expect(bucketMsFor(24)).toBe(bucketMsFor(72));
    expect(bucketMsFor(72)).toBe(bucketMsFor(168));
  });
});

describe("applyPostRules event composite", () => {
  it("blends materiality, surprise, magnitude into eventScore", () => {
    const f = applyPostRules(judgment({ material: 1, surprise: 1, magnitude: 1 }), 1);
    expect(f.eventScore).toBe(100);
    const g = applyPostRules(judgment({ material: 0, surprise: 0, magnitude: 0 }), 1);
    expect(g.eventScore).toBe(0);
  });
});

describe("forwardReturn", () => {
  const points = [
    { t: 0, price: 100, retrievedAt: 1_000 },
    { t: 120_000, price: 101, retrievedAt: 121_000 },
    { t: 600_000, price: 99, retrievedAt: 601_000 },
    { t: 1_830_000, price: 96.57, retrievedAt: 1_831_000 },
  ];
  it("measures the forward move from a timely post-score price", () => {
    // p0 = 101 (t=2m, within the 90s after score availability),
    // p1 = 96.57 (t=30.5m, last point within the 30m window).
    expect(forwardReturn(points, 60_000, 30 * 60_000)).toBe(-4.3861);
  });
  it("returns null instead of imputing when a side is missing", () => {
    expect(forwardReturn(points, -300_000, 60_000)).toBeNull();
    expect(forwardReturn([], 0, 60_000)).toBeNull();
  });
  it("rejects a stale baseline even when a later outcome point exists", () => {
    expect(forwardReturn([
      { t: -10 * 60_000, price: 100, retrievedAt: -10 * 60_000 + 1_000 },
      { t: 30 * 60_000, price: 102, retrievedAt: 30 * 60_000 + 1_000 },
    ], 0, 30 * 60_000)).toBeNull();
  });
  it("rejects a pre-publication baseline even when it is within the freshness tolerance", () => {
    expect(forwardReturn([
      { t: -2 * 60_000, price: 100, retrievedAt: -2 * 60_000 + 1_000 },
      { t: 30 * 60_000, price: 102, retrievedAt: 30 * 60_000 + 1_000 },
    ], 0, 30 * 60_000)).toBeNull();
  });
  it.each([30 * 60_000, 4 * 60 * 60_000])("does not score an immature %i ms reaction window", (windowMs) => {
    const outcomeAt = windowMs;
    const observations = [
      { t: 60_000, price: 100, retrievedAt: 61_000 },
      { t: outcomeAt - 60_000, price: 101, retrievedAt: outcomeAt - 59_000 },
    ];

    expect(forwardReturn(observations, 0, windowMs, outcomeAt - 1)).toBeNull();
    expect(forwardReturn(observations, 0, windowMs, outcomeAt)).toBe(1);
  });
  it("rejects a stale terminal quote instead of counting a carried-forward zero", () => {
    expect(forwardReturn([
      { t: 90_000, price: 100, retrievedAt: 91_000 },
      { t: 25 * 60_000 - 1, price: 100, retrievedAt: 25 * 60_000 },
    ], 0, 30 * 60_000)).toBeNull();
  });
  it("rejects prices retrieved long after their observation time", () => {
    expect(forwardReturn([
      { t: 90_000, price: 100, retrievedAt: 90_000 + 60 * 60_000 },
      { t: 30 * 60_000, price: 102, retrievedAt: 30 * 60_000 + 60 * 60_000 },
    ], 0, 30 * 60_000, 2 * 60 * 60_000)).toBeNull();
  });
  it("retains a zero return when both price observations are timely", () => {
    expect(forwardReturn([
      { t: 90_000, price: 100, retrievedAt: 91_000 },
      { t: 30 * 60_000, price: 100, retrievedAt: 30 * 60_000 + 1_000 },
    ], 0, 30 * 60_000)).toBe(0);
  });
  it("rejects a historical backfill fetched long after its price observation", () => {
    expect(forwardReturn([
      { t: 90_000, price: 100, retrievedAt: 90_000 + 60 * 60_000 },
      { t: 30 * 60_000, price: 102, retrievedAt: 30 * 60_000 + 60 * 60_000 },
    ], 0, 30 * 60_000, 2 * 60 * 60_000)).toBeNull();
  });
});

describe("summarizeReactions", () => {
  it("computes medians and directional hit rate", () => {
    const s = summarizeReactions([
      { sentiment: "negative", r30: -1.2, r240: null },
      { sentiment: "negative", r30: -0.4, r240: null },
      { sentiment: "negative", r30: 0.9, r240: null },
      { sentiment: "positive", r30: 0.5, r240: null },
      { sentiment: "neutral", r30: null, r240: null },
    ]);
    expect(s.n30m).toBe(4);
    expect(s.n4h).toBe(0);
    expect(s.median30m).toBe(0.05); // median of [-1.2, -0.4, 0.5, 0.9]
    expect(s.hitRate).toBe(75);
  });
  it("keeps 4h-only observations out of the 30m hit-rate denominator", () => {
    const s = summarizeReactions([
      { sentiment: "positive", r30: 0.2, r240: -1.2 },
      { sentiment: "negative", r30: null, r240: -2.5 },
    ]);
    expect(s.n30m).toBe(1);
    expect(s.n4h).toBe(2);
    expect(s.hitRate).toBe(100);
  });
});

describe("isFinanceRelevant (ingest guard)", () => {
  it("drops word-collision and lifestyle noise from weak sources for free", () => {
    expect(
      isFinanceRelevant({
        title: "Apple pie recipe: the classic dessert everyone loves",
        snippet: "A warm apple dessert with cinnamon.",
        tier: "trade",
        kind: "rss",
        ticker: "AAPL",
      }),
    ).toBe(false);
    expect(
      isFinanceRelevant({
        title: "See the teaser trailer for the new thriller everyone is talking about",
        snippet: "The streaming hit arrives this fall.",
        tier: "trade",
        kind: "rss",
        ticker: "NFLX",
      }),
    ).toBe(false);
  });

  it("admits finance-context headlines and trusted tiers", () => {
    expect(
      isFinanceRelevant({
        title: "Apple suppliers rally on stronger iPhone demand outlook",
        snippet: "",
        tier: "trade",
        kind: "rss",
        ticker: "AAPL",
      }),
    ).toBe(true);
    expect(
      isFinanceRelevant({
        title: "Anything at all",
        snippet: "",
        tier: "wire",
        kind: "rss",
        ticker: "AAPL",
      }),
    ).toBe(true);
    expect(
      isFinanceRelevant({
        title: "$AAPL to the moon, earnings next week",
        snippet: "",
        tier: "social",
        kind: "reddit",
        ticker: "AAPL",
      }),
    ).toBe(true);
  });
});

describe("applyPostRules investor relevance", () => {
  it("excludes consumer/entertainment coverage as off-target", () => {
    const f = applyPostRules(judgment({ investorRelevant: 0.2 }), 1);
    expect(f.exclude).toBe(true);
    expect(applyPostRules(judgment({ investorRelevant: 0.5 }), 1).exclude).toBe(false);
  });
});

describe("hasStrongIdentity (namesake guard)", () => {
  const apple = {
    name: "Apple",
    ticker: "AAPL",
    aliases: ["iPhone", "Tim Cook", "Macbook"],
    ambiguous: true,
  };
  it("rejects food and namesake items from text-matched sources", () => {
    expect(
      hasStrongIdentity({
        company: apple,
        title: "Apple Sauce Recall Issued After FDA Testing Findings",
        snippet: "",
        scoped: false,
      }),
    ).toBe(false);
  });
  it("accepts ticker, corporate suffix, alias, or scoped sources", () => {
    expect(hasStrongIdentity({ company: apple, title: "Apple (AAPL) could be overpriced", snippet: "", scoped: false })).toBe(true);
    expect(hasStrongIdentity({ company: apple, title: "Apple Inc suppliers rally", snippet: "", scoped: false })).toBe(true);
    expect(hasStrongIdentity({ company: apple, title: "iPhone demand signals mixed", snippet: "", scoped: false })).toBe(true);
    expect(hasStrongIdentity({ company: apple, title: "Apple sauce recall", snippet: "", scoped: true })).toBe(true);
  });
  it("passes unambiguous companies unconditionally", () => {
    expect(
      hasStrongIdentity({
        company: { name: "NVIDIA", ticker: "NVDA", aliases: ["Nvidia"], ambiguous: false },
        title: "Anything at all mentioning Nvidia",
        snippet: "",
        scoped: false,
      }),
    ).toBe(true);
  });
  it("ignores the production Apple self-alias but preserves actual issuer evidence", () => {
    const config = JSON.parse(readFileSync(new URL("../config/companies.json", import.meta.url), "utf8")) as {
      companies: Array<{ name: string; ticker: string; aliases: string[]; ambiguous?: boolean }>;
    };
    const productionApple = config.companies.find((company) => company.ticker === "AAPL");
    expect(productionApple).toBeDefined();
    const company = productionApple!;

    expect(company.aliases).toContain(company.name);
    expect(hasStrongIdentity({
      company,
      title: "Rare 150-Lb. McDonald’s Apple Pie Tree Statue Discovered at Auction",
      snippet: "Collectors discuss the unusual apple-themed statue.",
      scoped: false,
    })).toBe(false);
    expect(hasStrongIdentity({ company, title: "AAPL shares rise after earnings", snippet: "", scoped: false })).toBe(true);
    expect(hasStrongIdentity({ company, title: "iPhone demand signals mixed", snippet: "", scoped: false })).toBe(true);
  });
});

describe("applyPostRules strict identity floor", () => {
  it("demotes ambiguous weak-identity items unless about is very high", () => {
    const borderline = judgment({ about: 0.6, investorRelevant: 0.6 });
    expect(applyPostRules(borderline, 1).exclude).toBe(false);
    expect(applyPostRules(borderline, 1, { strictAbout: true }).exclude).toBe(true);
    const clear = judgment({ about: 0.9, investorRelevant: 0.6 });
    expect(applyPostRules(clear, 1, { strictAbout: true }).exclude).toBe(false);
  });
});

describe("rankIC (Spearman)", () => {
  it("returns 1 for perfectly monotonic pairs", () => {
    expect(rankIC([[1, 10], [2, 20], [3, 30], [4, 40]])).toBe(1);
  });
  it("returns -1 for inverted pairs", () => {
    expect(rankIC([[1, 40], [2, 30], [3, 20], [4, 10]])).toBe(-1);
  });
  it("handles ties with average ranks", () => {
    // [1,1,3] vs [10,10,20]: ranks (1.5,1.5,3) both sides -> positive
    expect(rankIC([[1, 10], [1, 10], [3, 20]])).toBe(1);
  });
  it("returns null with too few pairs", () => {
    expect(rankIC([[1, 1]])).toBeNull();
  });
});

describe("shouldAlert (alert gate)", () => {
  const now = 1_000_000_000;
  const base = { now, thresholdScore: 65, thresholdImpact: 55, freshMs: 15 * 60_000 };
  it("fires only on fresh, strong, directional events", () => {
    expect(shouldAlert({ ...base, eventScore: 80, impact: -70, publishedAt: now - 60_000 })).toBe(true);
    expect(shouldAlert({ ...base, eventScore: 80, impact: -70, publishedAt: now - 30 * 60_000 })).toBe(false); // stale
    expect(shouldAlert({ ...base, eventScore: 50, impact: -70, publishedAt: now - 60_000 })).toBe(false); // weak
    expect(shouldAlert({ ...base, eventScore: 80, impact: -20, publishedAt: now - 60_000 })).toBe(false); // small move
  });
  it("rejects future, non-finite, and invalid threshold values", () => {
    expect(shouldAlert({ ...base, eventScore: 80, impact: 70, publishedAt: now + 1 })).toBe(false);
    expect(shouldAlert({ ...base, eventScore: Number.NaN, impact: 70, publishedAt: now - 1 })).toBe(false);
    expect(shouldAlert({ ...base, eventScore: 80, impact: 70, publishedAt: now - 1, thresholdScore: Number.POSITIVE_INFINITY })).toBe(false);
  });
});
