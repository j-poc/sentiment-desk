export const QUOTE_FRESHNESS_BUDGET_MS = 15 * 60 * 1_000;

export function quoteWithinFreshnessBudget(retrievedAt: number, now = Date.now()): boolean {
  const ageMs = now - retrievedAt;
  return Number.isFinite(retrievedAt) && ageMs >= 0 && ageMs <= QUOTE_FRESHNESS_BUDGET_MS;
}

export function filterFreshQuotes<T extends { retrievedAt: number }>(
  quotes: Record<string, T>,
  now = Date.now(),
): Record<string, T> {
  return Object.fromEntries(Object.entries(quotes).filter(([, quote]) => quoteWithinFreshnessBudget(quote.retrievedAt, now)));
}

export function nextQuoteExpiryDelayMs<T extends { retrievedAt: number }>(
  quotes: Record<string, T>,
  now = Date.now(),
): number | null {
  const expiresAt = Object.values(quotes)
    .filter((quote) => Number.isFinite(quote.retrievedAt))
    .map((quote) => quote.retrievedAt > now ? now : quote.retrievedAt + QUOTE_FRESHNESS_BUDGET_MS + 1);
  if (expiresAt.length === 0) return null;
  return Math.max(0, Math.min(...expiresAt) - now);
}
