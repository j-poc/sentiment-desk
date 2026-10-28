import type { Mention } from "./api.js";
import { validatedSourceClock } from "../../../shared/source-clock.js";

type MentionClock = Pick<Mention, "collector" | "timeBasis" | "publishedAt" | "aggregatorPublishedAt" | "providerObservedAt">;

export interface SourceClock {
  label: string;
  at: number | null;
  context: string;
}

export function sourceClockForMention(mention: MentionClock): SourceClock {
  const clock = validatedSourceClock({
    timeBasis: mention.timeBasis,
    collector: mention.collector,
    publisherAt: mention.publishedAt,
    aggregatorAt: mention.aggregatorPublishedAt ?? null,
    providerObservedAt: mention.providerObservedAt,
  });
  return { label: clock.label, at: clock.at, context: clock.context };
}
