import { describe, expect, it } from "vitest";
import type { CompanySnapshot } from "../web/src/lib/api.js";
import { hasComparableDeltas, orderWatchlistCompanies } from "../web/src/lib/watchlist-order.js";

function company(ticker: string, delta: number | null): CompanySnapshot {
  return {
    id: ticker.toLowerCase(),
    name: ticker,
    ticker,
    sector: "Test sector",
    color: "#ffffff",
    index: null,
    delta,
    mentions24h: 0,
    lastMentionAt: null,
    earningsAt: null,
    lastSurprise: null,
  };
}

describe("watchlist ordering", () => {
  it("uses alphabetical order and reports no comparison when every delta is missing", () => {
    const companies = [company("TSLA", null), company("AAPL", null)];
    expect(hasComparableDeltas(companies)).toBe(false);
    expect(orderWatchlistCompanies(companies, "delta").map((item) => item.ticker)).toEqual([
      "AAPL",
      "TSLA",
    ]);
    expect(companies.map((item) => item.ticker)).toEqual(["TSLA", "AAPL"]);
  });

  it("sorts comparable movement by magnitude, puts missing deltas last, and breaks ties alphabetically", () => {
    const companies = [
      company("ZZZ", null),
      company("MSFT", 1),
      company("GOOG", 4),
      company("AAPL", -4),
      company("AMZN", null),
    ];
    expect(hasComparableDeltas(companies)).toBe(true);
    expect(orderWatchlistCompanies(companies, "delta").map((item) => item.ticker)).toEqual([
      "AAPL",
      "GOOG",
      "MSFT",
      "AMZN",
      "ZZZ",
    ]);
  });
});
