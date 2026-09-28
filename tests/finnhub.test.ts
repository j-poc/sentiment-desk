import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFinnhubNews, fetchUpcomingEarnings, latestSurprise, type EarningsEntry } from "../server/sources/finnhub.js";

afterEach(() => vi.unstubAllGlobals());

const entries: EarningsEntry[] = [
  { date: Date.parse("2026-06-12"), epsActual: 1.1, epsEstimate: 1.0, period: "2026-Q2" },
  { date: Date.parse("2026-03-10"), epsActual: 0.5, epsEstimate: 0.8, period: "2026-Q1" },
  { date: Date.parse("2025-12-15"), epsActual: 0.9, epsEstimate: null, period: "2025-Q4" },
];

describe("latestSurprise", () => {
  it("returns the most recent quarter with both actual and estimate", () => {
    const s = latestSurprise(entries);
    expect(s?.period).toBe("2026-Q2");
    expect(s?.percent).toBe(10);
  });

  it("handles sign correctly when the estimate is negative", () => {
    const s = latestSurprise([
      { date: Date.parse("2026-06-12"), epsActual: -0.4, epsEstimate: -0.5, period: "2026-Q2" },
    ]);
    // Beat a negative estimate by 0.1 -> +20%.
    expect(s?.percent).toBe(20);
  });

  it("returns null with no usable quarter", () => {
    expect(latestSurprise([{ date: Date.parse("2026-01-01"), epsActual: 1, epsEstimate: null, period: "Q" }])).toBeNull();
    expect(latestSurprise([])).toBeNull();
  });
});

describe("Finnhub response integrity", () => {
  it("retains raw news row counts when malformed entries are discarded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { headline: "Valid headline", url: "https://news.example/story", datetime: 1_790_000_000 },
      { headline: "Headline without URL" },
    ]), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(fetchFinnhubNews("ACME", "test-token")).resolves.toMatchObject({
      providerItemCount: 2,
      malformedItemCount: 1,
      items: [{ headline: "Valid headline", url: "https://news.example/story" }],
    });
  });

  it("rejects malformed calendar rows instead of silently returning a partial map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      earningsCalendar: [{ symbol: "ACME" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(fetchUpcomingEarnings("test-token", new Set(["ACME"])))
      .rejects.toThrow("missing symbol or date");
  });
});
