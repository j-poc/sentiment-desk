import type { Mention } from "./api.js";

type MentionClock = Pick<Mention, "collector" | "publishedAt" | "aggregatorPublishedAt" | "providerObservedAt">;

export interface SourceClock {
  label: string;
  at: number | null;
  context: string;
}

export function sourceClockForMention(mention: MentionClock): SourceClock {
  if (mention.publishedAt != null) {
    return { label: "publisher time", at: mention.publishedAt, context: "Publisher-declared time; not independently verified." };
  }
  if (mention.collector === "google_news_rss" && mention.aggregatorPublishedAt != null) {
    return {
      label: "Google News feed time",
      at: mention.aggregatorPublishedAt,
      context: "Article publication unknown. This is a time declared by the Google News feed, not a publisher-verified publication time.",
    };
  }
  if (mention.collector === "yahoo_finance_rss" && mention.aggregatorPublishedAt != null) {
    return {
      label: "Yahoo Finance feed time",
      at: mention.aggregatorPublishedAt,
      context: "Article publication unknown. This is a time declared by the Yahoo Finance feed, not a publisher-verified publication time.",
    };
  }
  if (mention.providerObservedAt != null) {
    return { label: "provider observed", at: mention.providerObservedAt, context: "Timestamp observed from the data provider." };
  }
  return { label: "source time unknown", at: null, context: "No source timestamp is available." };
}
