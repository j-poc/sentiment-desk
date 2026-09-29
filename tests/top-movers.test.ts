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
  it("distinguishes an unscored watchlist from scores without a comparison window", () => {
    expect(renderTopMovers([unscoredCompany])).toContain("No scored sentiment is available yet.");
    expect(renderTopMovers([scoredCompany])).toContain(
      "Current scores are available; no prior 24h comparison yet.",
    );
  });
});
