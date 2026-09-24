import { describe, expect, it } from "vitest";
import {
  applyPostRules,
  bucketSeries,
  clusterConfirmations,
  forwardReturn,
  mentionDigest,
  parseJudgment,
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
    eventType: "legal_regulatory",
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
    event_type: { choice: "legal_regulatory", probabilities: { legal_regulatory: 0.8, other: 0.2 } },
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

describe("bucketSeries", () => {
  it("buckets by time and leaves gaps null", () => {
    const fiveMin = 5 * 60_000;
    const now = 4 * fiveMin; // 20-minute window ending now
    const items = [
      { publishedAt: 3.5 * fiveMin, impact: 50, weight: 1 },
      { publishedAt: 0.5 * fiveMin, impact: -50, weight: 1 },
    ];
    const s = bucketSeries(items, 4 * fiveMin, fiveMin, now);
    expect(s.length).toBe(5);
    expect(s[0]).toMatchObject({ v: -50, n: 1 });
    expect(s[1]).toMatchObject({ v: null, n: 0 });
    expect(s[3]).toMatchObject({ v: 50, n: 1 });
    expect(s[4]).toMatchObject({ v: null, n: 0 });
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

describe("clusterConfirmations", () => {
  it("groups near-duplicate titles within the window across sources", () => {
    const t0 = 1_000_000;
    const ms = [
      { id: "a", title: "Nvidia beats quarterly estimates on data center demand", publishedAt: t0, companyId: "nvidia" },
      { id: "b", title: "Nvidia beats quarterly estimates on data center demand", publishedAt: t0 + 120_000, companyId: "nvidia" },
      { id: "c", title: "Apple unveils new M5 macbook pro lineup", publishedAt: t0 + 60_000, companyId: "apple" },
      { id: "d", title: "Nvidia CFO says supply constraints ease into next year", publishedAt: t0 + 300_000, companyId: "nvidia" },
    ];
    const sizes = clusterConfirmations(ms);
    expect(sizes.get("a")).toBe(2);
    expect(sizes.get("b")).toBe(2);
    expect(sizes.get("c")).toBe(1);
    expect(sizes.get("d")).toBe(1);
  });
});

describe("mentionDigest", () => {
  it("is stable and ignores utm parameters", () => {
    expect(mentionDigest("rss", "https://x.com/a?utm_source=f", "T")).toBe(
      mentionDigest("rss", "https://x.com/a", "T"),
    );
    expect(mentionDigest("rss", "https://x.com/a", "T")).not.toBe(
      mentionDigest("rss", "https://x.com/b", "T"),
    );
  });
});
