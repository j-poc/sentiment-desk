import type { Mention } from "./api.js";
import { normalizeExactHeadline } from "../../../shared/score-bucket-coverage.js";

export { normalizeExactHeadline } from "../../../shared/score-bucket-coverage.js";

export type MentionFeedEntry =
  | { kind: "mention"; mention: Mention }
  | {
      kind: "exact-title-repeats";
      title: string;
      mentions: Mention[];
      publisherLabelCount: number;
      directions: { positive: number; neutral: number; negative: number };
      impactMin: number;
      impactMax: number;
    };

export type ExactTitleGroupFilter = "repeated" | "mixed" | null;

function publisherKey(mention: Mention): string {
  const value = mention.publisherDomain || mention.publisherName || mention.source.name;
  return value.normalize("NFKC").trim().replace(/^www\./i, "").toLocaleLowerCase("en-US");
}

/**
 * Collapse only duplicate scored headlines after Unicode/case/whitespace
 * normalization. This is a presentation aid, not semantic event clustering or
 * evidence that publisher labels represent independent reporting.
 */
export function groupExactHeadlineRepeats(mentions: Mention[]): MentionFeedEntry[] {
  const occurrences = new Map<string, Mention[]>();
  for (const mention of mentions) {
    if (mention.status !== "scored" || mention.score == null) continue;
    const key = normalizeExactHeadline(mention.title);
    if (!key) continue;
    const group = occurrences.get(key) ?? [];
    group.push(mention);
    occurrences.set(key, group);
  }

  const emitted = new Set<string>();
  const entries: MentionFeedEntry[] = [];
  for (const mention of mentions) {
    if (mention.status !== "scored" || mention.score == null) {
      entries.push({ kind: "mention", mention });
      continue;
    }
    const key = normalizeExactHeadline(mention.title);
    const group = key ? occurrences.get(key) : undefined;
    if (group && group.length > 1 && emitted.has(key)) continue;
    if (!group || group.length < 2) {
      entries.push({ kind: "mention", mention });
      continue;
    }
    emitted.add(key);
    const impacts = group.map((item) => item.score!.impact);
    entries.push({
      kind: "exact-title-repeats",
      title: mention.title,
      mentions: group,
      publisherLabelCount: new Set(group.map(publisherKey).filter(Boolean)).size,
      directions: {
        positive: group.filter((item) => item.score!.sentiment === "positive").length,
        neutral: group.filter((item) => item.score!.sentiment === "neutral").length,
        negative: group.filter((item) => item.score!.sentiment === "negative").length,
      },
      impactMin: Math.min(...impacts),
      impactMax: Math.max(...impacts),
    });
  }
  return entries;
}

export function filterExactHeadlineGroups(
  entries: MentionFeedEntry[],
  filter: ExactTitleGroupFilter,
): MentionFeedEntry[] {
  if (filter == null) return entries;
  return entries.filter((entry) => {
    if (entry.kind !== "exact-title-repeats") return false;
    if (filter === "repeated") return true;
    return [entry.directions.positive, entry.directions.neutral, entry.directions.negative]
      .filter((count) => count > 0).length > 1;
  });
}
