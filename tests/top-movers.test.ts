import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompanySnapshot } from "../web/src/lib/api.js";
import { TopMovers } from "../web/src/components/TopMovers.js";

const unscoredCompany = {
  id: "apple",
  name: "Apple",
  ticker: "AAPL",
  sector: "Consumer Electronics",
  color: "#cbd5e1",
  index: null,
  indexWindow: null,
  indexRecordCount: 0,
  delta: null,
  mentions24h: 0,
  lastMentionAt: null,
  earningsAt: null,
  lastSurprise: null,
} satisfies CompanySnapshot;

const scoredCompany = {
  ...unscoredCompany,
  index: 12,
  mentions24h: 1,
} satisfies CompanySnapshot;

function renderTopMovers(companies: CompanySnapshot[]): string {
  return renderToStaticMarkup(createElement(TopMovers, {
    companies,
    selectedId: null,
    onSelect: () => undefined,
  }));
}

describe("Top Movers empty state", () => {
  it("identifies movement as Jev index change rather than stock-price movement", () => {
    expect(renderTopMovers([{ ...scoredCompany, delta: 12 }])).toContain(
      "Companies ranked by the difference between the current 3-hour and trailing 24-hour weighted Jev means, in impact points",
    );
  });

  it("distinguishes an unscored watchlist from scores without a comparison window", () => {
    expect(renderTopMovers([unscoredCompany])).toContain("No scored sentiment is available yet.");
    expect(renderTopMovers([scoredCompany])).toContain(
      "Current Jev scores exist; no eligible 3h-versus-24h weighted-mean comparison yet.",
    );
  });
});
