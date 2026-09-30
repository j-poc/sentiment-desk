import type { Mention } from "./api.js";
import { normalizeExactHeadline } from "./exact-headline-groups.js";

export interface EvidenceBreadthSummary {
  sourceRecordCount: number;
  scoredRecordCount: number;
  latestSourceAt: number | null;
  latestSourceTimeBasis: "publisher" | "provider observed" | "retrieval" | null;
  latestScoreAt: number | null;
  publisherLabelCount: number;
  exactHeadlineCount: number;
  repeatedHeadlineGroupCount: number;
  recordsInRepeatedHeadlineGroups: number;
  mixedJevLabelGroupCount: number;
  sentiment: { positive: number; neutral: number; negative: number };
}

/**
 * Summarize only saved, scored source observations. Exact normalized titles
 * are a duplicate cue, not a semantic story cluster or proof of independent
 * reporting.
 */
export function summarizeEvidenceBreadth(mentions: Mention[]): EvidenceBreadthSummary {
  const scored = mentions.filter((mention) => mention.status === "scored" && mention.score != null);
  const headlines = new Map<string, Mention[]>();
  const publishers = new Set<string>();
  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  const latestSource = mentions.reduce<{ at: number; basis: "publisher" | "provider observed" | "retrieval" } | null>((latest, mention) => {
    const sourceTime = mention.publishedAt ?? mention.providerObservedAt ?? mention.retrievedAt;
    const basis = mention.publishedAt != null ? "publisher"
      : mention.providerObservedAt != null ? "provider observed"
        : "retrieval";
    return latest == null || sourceTime > latest.at ? { at: sourceTime, basis } : latest;
  }, null);
  const latestScoreAt = scored.reduce<number | null>((latest, mention) => {
    const scoreTime = mention.score!.scoredAt;
    return latest == null || scoreTime > latest ? scoreTime : latest;
  }, null);

  for (const mention of scored) {
    const titleKey = normalizeExactHeadline(mention.title);
    if (titleKey) {
      const records = headlines.get(titleKey) ?? [];
      records.push(mention);
      headlines.set(titleKey, records);
    }
    const publisher = mention.publisherDomain || mention.publisherName || mention.source.name;
    const publisherKey = publisher.normalize("NFKC").trim().replace(/^www\./i, "").toLocaleLowerCase("en-US");
    if (publisherKey) publishers.add(publisherKey);
    sentiment[mention.score!.sentiment] += 1;
  }

  const repeatedGroups = [...headlines.values()].filter((records) => records.length > 1);
  return {
    sourceRecordCount: mentions.length,
    scoredRecordCount: scored.length,
    latestSourceAt: latestSource?.at ?? null,
    latestSourceTimeBasis: latestSource?.basis ?? null,
    latestScoreAt,
    publisherLabelCount: publishers.size,
    exactHeadlineCount: headlines.size,
    repeatedHeadlineGroupCount: repeatedGroups.length,
    recordsInRepeatedHeadlineGroups: repeatedGroups.reduce((total, group) => total + group.length, 0),
    mixedJevLabelGroupCount: repeatedGroups.filter((records) =>
      new Set(records.map((mention) => mention.score!.sentiment)).size > 1,
    ).length,
    sentiment,
  };
}
