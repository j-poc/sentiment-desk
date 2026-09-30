import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompanySnapshot, Quote } from "../web/src/lib/api.js";
import { Watchlist } from "../web/src/components/Watchlist.js";

const company = {
  id: "apple",
  name: "Apple",
  ticker: "AAPL",
  sector: "Technology",
  color: "#fff",
  index: 18,
  indexWindow: "3h",
  indexRecordCount: 2,
  delta: 8.5,
  sourceRecords24h: 2,
  latestSourceCollectedAt: Date.now(),
  earningsAt: null,
  lastSurprise: null,
} satisfies CompanySnapshot;

describe("watchlist Jev mean labels", () => {
  function renderWatchlist(quotes: Record<string, Quote> = {}) {
    return renderToStaticMarkup(createElement(Watchlist, {
      companies: [company],
      selectedId: company.id,
      sparks: {},
      quotes,
      onSelect: () => undefined,
    }));
  }

  it("gives each company selection button a complete name for its Jev metrics and missing quote", () => {
    const html = renderWatchlist();

    expect(html).toContain('aria-label="Apple (AAPL). Jev weighted item mean +18.0 impact points from 2 scored source records over the latest 3 hours. Current 3-hour weighted Jev mean minus trailing 24-hour weighted Jev mean: +8.5 impact points. Market price unavailable. latest saved source record collected now. Activate to show Apple research."');
    expect(html).toContain("latest source record collected");
    expect(html).toContain('aria-pressed="true"');
  });

  it("keeps source observation time and network retrieval time distinct for a recent quote", () => {
    const now = Date.now();
    const quote = {
      ticker: "AAPL",
      price: 341.07,
      changePct: 1.47,
      currency: "USD",
      at: now - 60_000,
      retrievedAt: now - 30_000,
      lastAttemptAt: now - 30_000,
      delivery: "network",
    } satisfies Quote;
    const html = renderWatchlist({ AAPL: quote });
    const accessibleName = html.match(/<button[^>]*aria-label="([^"]*)"/)?.[1] ?? "";

    expect(accessibleName).toContain("Market price 341.07 USD");
    expect(accessibleName).toContain("source time within the last 15 minutes");
    expect(accessibleName).toContain("network delivery retrieved");
    expect(accessibleName).toContain("price change +1.5 percent");
  });

  it("exposes cache retrieval age even when the quote source time is unknown", () => {
    const quote = {
      ticker: "AAPL",
      price: 341.07,
      changePct: 1.47,
      currency: "USD",
      at: null,
      retrievedAt: Date.now() - 5 * 60_000 - 30_000,
      lastAttemptAt: Date.now() - 5 * 60_000 - 30_000,
      delivery: "cache",
    } satisfies Quote;
    const html = renderWatchlist({ AAPL: quote });
    const accessibleName = html.match(/<button[^>]*aria-label="([^"]*)"/)?.[1] ?? "";

    expect(accessibleName).toContain("source time unknown");
    expect(accessibleName).toContain("cached delivery retrieved");
    expect(html).toMatch(/cached \d+m ago · source time unknown/);
  });
});
