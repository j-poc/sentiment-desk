import type { CollectorId } from "./types.js";

/** Hide the aggregator host wrongly stored as publisher on historical Google News rows. */
export function researchPublisherDomain(collector: CollectorId | string, domain: string | null): string | null {
  const normalized = domain?.trim().toLocaleLowerCase("en-US").replace(/^www\./, "") || null;
  if (normalized == null) return null;
  if (collector === "google_news_rss" && normalized === "news.google.com") return null;
  return normalized;
}
