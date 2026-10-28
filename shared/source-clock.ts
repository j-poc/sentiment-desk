export type ValidatedSourceTimeBasis = "publisher_declared" | "aggregator_declared" | "provider_observed" | "unknown";

export interface ValidatedSourceClockInput {
  timeBasis: string;
  collector: string;
  publisherAt: number | null;
  aggregatorAt: number | null;
  providerObservedAt: number | null;
}

export interface ValidatedSourceClock {
  basis: ValidatedSourceTimeBasis;
  label: string;
  at: number | null;
  context: string;
}

const UNKNOWN_CLOCK: ValidatedSourceClock = {
  basis: "unknown",
  label: "source time unknown",
  at: null,
  context: "No validated source timestamp is available.",
};

function validTimestamp(value: number | null): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0;
}

/** Uses only the source clock selected when the observation was stored. Retrieval time is never a source-time fallback. */
export function validatedSourceClock(input: ValidatedSourceClockInput): ValidatedSourceClock {
  if (input.timeBasis === "publisher_declared" && validTimestamp(input.publisherAt)) {
    return { basis: "publisher_declared", label: "publisher time", at: input.publisherAt,
      context: "Publisher-declared time; not independently verified." };
  }
  if (input.timeBasis === "aggregator_declared" && validTimestamp(input.aggregatorAt)) {
    if (input.collector === "google_news_rss") {
      return { basis: "aggregator_declared", label: "Google News feed time", at: input.aggregatorAt,
        context: "Article publication unknown. This is a time declared by the Google News feed, not a publisher-verified publication time." };
    }
    if (input.collector === "yahoo_finance_rss") {
      return { basis: "aggregator_declared", label: "Yahoo Finance feed time", at: input.aggregatorAt,
        context: "Article publication unknown. This is a time declared by the Yahoo Finance feed, not a publisher-verified publication time." };
    }
  }
  if (input.timeBasis === "provider_observed" && validTimestamp(input.providerObservedAt)) {
    return { basis: "provider_observed", label: "provider observed", at: input.providerObservedAt,
      context: "Timestamp observed from the data provider." };
  }
  return UNKNOWN_CLOCK;
}
