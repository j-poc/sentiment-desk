import { describe, expect, it } from "vitest";
import {
  applyPostRules,
  clusterEvents,
  forwardReturn,
  isFinanceRelevant,
  mentionDigest,
  parseJudgment,
  rankIC,
  hasNearDuplicateTitle,
  hasStrongIdentity,
  shouldAlert,
  smoothedSeries,
  summarizeReactions,
  weightedIndex,
} from "../server/scoring.js";
import type { ParsedJudgment } from "../server/scoring.js";

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
  return {
    sentiment: { choice: "negative", probabilities: { negative: 0.7, neutral: 0.2, positive: 0.1 }, confidence: 0.9 },
    about: { noul: 0.95 },
    material: { noul: 0.8 },
    novel: { noul: 0.6 },
    credible: { noul: 0.9 },
    investor_relevant: { noul: 0.85 },
    event_type: { choice: "legal_regulatory", probabilities: { legal_regulatory: 0.8, other: 0.2 } },
    takeaway: { choice: "legal_hit" },
    magnitude: { noul: 0.7 },
    surprise: { noul: 0.8 },
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

  it("falls back to top probability when choice is missing, alphabetical tie-break", () => {
    const j = parseJudgment(
      answers({
        sentiment: { probabilities: { negative: 0.4, neutral: 0.4, positive: 0.2 } },
      }),
    );
    // negative and neutral tie at 0.4; alphabetical order picks negative.
    expect(j.sentiment).toBe("negative");
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
        { publishedAt: 0, impact: 100, weight: 1 },
        { publishedAt: 0, impact: -100, weight: 3 },
      ]),
    ).toBe(-50);
  });

  it("returns null with no usable weight", () => {
    expect(weightedIndex([])).toBeNull();
    expect(weightedIndex([{ publishedAt: 0, impact: 10, weight: 0 }])).toBeNull();
  });
});

describe("smoothedSeries", () => {
  const fiveMin = 5 * 60_000;

  it("jumps toward the event impact, then decays toward neutral", () => {
    const now = 4 * fiveMin;
    const items = [{ publishedAt: 2.5 * fiveMin, impact: 80, weight: 1 }];
    const s = smoothedSeries(items, 4 * fiveMin, fiveMin, now);
    expect(s[0]?.v).toBeNull();
    expect(s[1]?.v).toBeNull();
    const at = s[2]?.v ?? 0; // alpha = (0.2 + 0.8) * 0.8 -> 80% of the way to 80
    expect(at).toBeCloseTo(64, 0);
    expect(s[3]?.v ?? 0).toBeLessThan(at);
    expect(s[4]?.v ?? 0).toBeLessThan(s[3]?.v ?? 0);
  });

  it("is continuous after the first event: no null gaps for the chart", () => {
    const now = 8 * fiveMin;
    const items = [
      { publishedAt: 1 * fiveMin, impact: -60, weight: 0.8 },
      { publishedAt: 6 * fiveMin, impact: 70, weight: 0.9 },
    ];
    const s = smoothedSeries(items, 8 * fiveMin, fiveMin, now);
    for (const p of s.slice(1)) expect(p.v).not.toBeNull();
  });

  it("weights how hard an event pulls the index", () => {
    const now = 2 * fiveMin;
    const strong = smoothedSeries([{ publishedAt: fiveMin, impact: 80, weight: 1 }], 2 * fiveMin, fiveMin, now);
    const weak = smoothedSeries([{ publishedAt: fiveMin, impact: 80, weight: 0.05 }], 2 * fiveMin, fiveMin, now);
    expect(strong[1]?.v ?? 0).toBeGreaterThan(weak[1]?.v ?? 0);
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
    { t: 0, price: 100 },
    { t: 120_000, price: 101 },
    { t: 600_000, price: 99 },
    { t: 1_830_000, price: 96.57 },
  ];
  it("measures the forward move from the last price at or before the event", () => {
    // p0 = 101 (t=2m, last point within the 90s detection allowance),
    // p1 = 96.57 (t=30.5m, last point within the 30m window).
    expect(forwardReturn(points, 60_000, 30 * 60_000)).toBe(-4.39);
  });
  it("returns null instead of imputing when a side is missing", () => {
    expect(forwardReturn(points, -300_000, 60_000)).toBeNull();
    expect(forwardReturn([], 0, 60_000)).toBeNull();
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
    expect(s.n).toBe(4);
    expect(s.median30m).toBe(0.05); // median of [-1.2, -0.4, 0.5, 0.9]
    expect(s.hitRate).toBe(75);
  });
});

describe("clusterEvents (paraphrase-safe event grouping)", () => {
  const base = { companyId: "qcom", weight: 0.9 };
  it("merges framings of the same event that share no meaningful words", () => {
    const t0 = 1_000_000_000;
    const ms = [
      { ...base, publishedAt: t0 + 14 * 60_000, impact: 57, eventType: "corporate_action", takeaway: "legal_relief" },
      { ...base, publishedAt: t0 + 44 * 60_000, impact: 83, eventType: "corporate_action", takeaway: "product_win" },
      { ...base, publishedAt: t0 + 52 * 60_000, impact: 56, eventType: "corporate_action", takeaway: "legal_relief" },
    ];
    const events = clusterEvents(ms);
    expect(events.length).toBe(1);
    expect(events[0]?.size).toBe(3);
    // impact is the weighted mean of framings, weight the strongest framing's.
    expect(events[0]?.impact).toBeCloseTo(65.33, 1);
    expect(events[0]?.weight).toBe(0.9);
  });

  it("keeps genuinely different events separate", () => {
    const t0 = 1_000_000_000;
    const ms = [
      { ...base, publishedAt: t0, impact: 60, eventType: "results", takeaway: "results_beat" },
      { ...base, publishedAt: t0 + 10 * 60_000, impact: -50, eventType: "legal_regulatory", takeaway: "legal_hit" },
    ];
    expect(clusterEvents(ms).length).toBe(2);
  });

  it("starts a new event after the window passes, even for the same class", () => {
    const t0 = 1_000_000_000;
    const ms = [
      { ...base, publishedAt: t0, impact: 40, eventType: "results", takeaway: "results_beat" },
      { ...base, publishedAt: t0 + 50 * 60_000, impact: 60, eventType: "results", takeaway: "results_beat" },
    ];
    expect(clusterEvents(ms).length).toBe(2);
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
});

describe("mentionDigest (content-keyed)", () => {
  it("collapses the same headline across sources and URLs", () => {
    const t = "Apple (AAPL) Stock Could Be 32% Overpriced After Fresh AI Cost Concerns";
    expect(mentionDigest("rss", "https://news.google.com/rss/articles/abc", t)).toBe(
      mentionDigest("finnhub", "https://www.benzinga.com/x", t),
    );
  });

  it("still separates different headlines", () => {
    expect(mentionDigest("rss", "https://a", "Apple beats quarterly estimates")).not.toBe(
      mentionDigest("rss", "https://b", "Apple cuts quarterly guidance"),
    );
  });
});

describe("hasNearDuplicateTitle (syndication suppression)", () => {
  const syndicated = "Apple (AAPL) Stock Could Be 32% Overpriced After Fresh AI Cost Concerns";
  it("flags the same story from another feed", () => {
    expect(hasNearDuplicateTitle(syndicated, [{ title: syndicated }])).toBe(true);
    expect(
      hasNearDuplicateTitle(syndicated, [
        { title: "Apple AAPL Stock Could Be 32% Overpriced After Fresh AI Cost Worries" },
      ]),
    ).toBe(true);
  });
  it("keeps genuinely different stories", () => {
    expect(
      hasNearDuplicateTitle("Bank of America Flags Mixed iPhone 18 Demand Signal", [
        { title: "Apple suppliers rally on stronger demand outlook" },
      ]),
    ).toBe(false);
  });
});
