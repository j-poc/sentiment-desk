import { describe, expect, it } from "vitest";
import { applyPostRules, bucketSeries, mentionDigest, parseJudgment, weightedIndex } from "../server/scoring.js";
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
