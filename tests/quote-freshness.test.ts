import { describe, expect, it } from "vitest";
import { nextQuoteExpiryDelayMs, QUOTE_FRESHNESS_BUDGET_MS } from "../shared/quote-freshness.js";

describe("live quote expiry scheduling", () => {
  it("schedules removal immediately after the exact retrieval-age budget", () => {
    const quotes = { AAPL: { retrievedAt: 1_000 } };

    expect(nextQuoteExpiryDelayMs(quotes, 1_000)).toBe(QUOTE_FRESHNESS_BUDGET_MS + 1);
    expect(nextQuoteExpiryDelayMs(quotes, 1_000 + QUOTE_FRESHNESS_BUDGET_MS)).toBe(1);
    expect(nextQuoteExpiryDelayMs(quotes, 1_001 + QUOTE_FRESHNESS_BUDGET_MS)).toBe(0);
  });

  it("schedules the oldest quote first and immediately removes future retrieval clocks", () => {
    const quotes = {
      AAPL: { retrievedAt: 1_000 },
      MSFT: { retrievedAt: 2_000 },
    };

    expect(nextQuoteExpiryDelayMs(quotes, 2_000)).toBe(QUOTE_FRESHNESS_BUDGET_MS - 999);
    expect(nextQuoteExpiryDelayMs({ AAPL: { retrievedAt: 1_001 } }, 1_000)).toBe(0);
  });
});
