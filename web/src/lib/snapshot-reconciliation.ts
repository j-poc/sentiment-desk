import type { Mention } from "./api.js";

export type SequencedMention = { sequence: number; mention: Mention };

export function remainingLookupFailuresAfterStream(
  failedIds: Iterable<string>,
  latestStreamed: ReadonlyMap<string, SequencedMention>,
  sequenceAtStart: number,
): Set<string> {
  const streamedIds = new Set(
    [...latestStreamed]
      .filter(([, update]) => update.sequence > sequenceAtStart)
      .map(([id]) => id),
  );
  return new Set([...failedIds].filter((id) => !streamedIds.has(id)));
}

export function hasUnrefreshedRecord(
  rows: ReadonlyArray<Pick<Mention, "id">>,
  failedIds: ReadonlySet<string>,
): boolean {
  return rows.some((row) => failedIds.has(row.id));
}

export type ReconnectableMentionList = {
  companyId: string;
  items: Mention[];
  loaded: boolean;
};

export type ReconnectableMentionPage = ReconnectableMentionList & {
  nextCursor: unknown;
};

export type ReconnectableScoreBucket = {
  companyId: string;
  bucketFromMs: number;
  bucketThroughMs: number;
  items: Mention[];
  snapshotStale?: boolean;
  expectedCountFreshness?: "current" | "refreshing" | "error";
};

export function mergeMentionPages(...pages: Mention[][]): Mention[] {
  const byId = new Map<string, Mention>();
  for (const page of pages) for (const mention of page) byId.set(mention.id, mention);
  return [...byId.values()].sort((a, b) =>
    (b.publishedAt ?? b.providerObservedAt ?? b.retrievedAt) - (a.publishedAt ?? a.providerObservedAt ?? a.retrievedAt)
    || b.ingestedAt - a.ingestedAt
    || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1),
  );
}

export function reconcileMentionPageOnReconnect<T extends ReconnectableMentionList>(
  current: T,
  snapshot: Mention[],
  latestStreamed: Map<string, SequencedMention>,
  sequenceAtStart: number,
  isIncluded: (mention: Mention) => boolean,
  refreshedIds: Iterable<string> = [],
): T {
  if (!current.loaded) return current;

  const companySnapshot = snapshot.filter((mention) => mention.companyId === current.companyId);
  const snapshotIds = new Set([...companySnapshot.map((mention) => mention.id), ...refreshedIds]);
  const streamedAfterSnapshot = new Map(
    [...latestStreamed.entries()]
      .filter(([, { sequence, mention }]) => sequence > sequenceAtStart && mention.companyId === current.companyId),
  );
  const updatedIds = new Set(streamedAfterSnapshot.keys());
  const retainedPages = current.items.filter((mention) =>
    !snapshotIds.has(mention.id) && !updatedIds.has(mention.id),
  );
  const refreshedRows = companySnapshot.map((mention) =>
    streamedAfterSnapshot.get(mention.id)?.mention ?? mention,
  );
  const newStreamRows = [...streamedAfterSnapshot]
    .filter(([id]) => !snapshotIds.has(id))
    .map(([, { mention }]) => mention);
  const reconciledRows = [...refreshedRows, ...newStreamRows].filter(isIncluded);

  return {
    ...current,
    items: mergeMentionPages(retainedPages, reconciledRows),
  };
}

export function reconcileDrawerMentionOnReconnect(
  current: Mention | null,
  snapshot: Mention[],
  runtimeChanged: boolean,
  latestStreamed: Map<string, SequencedMention>,
  sequenceAtStart: number,
  refreshedIds: ReadonlySet<string> = new Set(),
): Mention | null {
  if (!current) return null;
  const streamed = latestStreamed.get(current.id);
  if (streamed && streamed.sequence > sequenceAtStart) return streamed.mention;
  return snapshot.find((mention) => mention.id === current.id)
    ?? (runtimeChanged || refreshedIds.has(current.id) ? null : current);
}

export function scoreBucketContainsMention(
  bucket: Pick<ReconnectableScoreBucket, "companyId" | "bucketFromMs" | "bucketThroughMs">,
  mention: Mention,
): boolean {
  const scoredAt = mention.score?.scoredAt;
  if (mention.companyId !== bucket.companyId || mention.status !== "scored" || scoredAt == null
    || mention.score == null || mention.score.weight < 0 || mention.score.impact < -100 || mention.score.impact > 100) return false;
  return scoredAt >= bucket.bucketFromMs && scoredAt < bucket.bucketThroughMs;
}

export function reconcileScoreBucketOnMention<T extends ReconnectableScoreBucket>(
  current: T | null,
  mention: Mention,
): T | null {
  if (!current || current.companyId !== mention.companyId) return current;
  const wasIncluded = current.items.some((item) => item.id === mention.id);
  const isIncluded = scoreBucketContainsMention(current, mention);
  if (!isIncluded) {
    if (!wasIncluded) return current;
    return {
      ...current,
      items: current.items.filter((item) => item.id !== mention.id),
      snapshotStale: true,
      expectedCountFreshness: "refreshing",
    };
  }
  return {
    ...current,
    items: mergeScoreBucketItems(current.items, [mention]),
    snapshotStale: true,
    expectedCountFreshness: "refreshing",
  };
}

export function reconcileScoreBucketOnReconnect<T extends ReconnectableScoreBucket>(
  current: T | null,
  snapshot: Mention[],
  refreshedIds: ReadonlySet<string>,
  latestStreamed: Map<string, SequencedMention>,
  sequenceAtStart: number,
): T | null {
  if (!current) return null;
  const snapshotRows = snapshot.filter((mention) => mention.companyId === current.companyId);
  const snapshotIds = new Set(snapshotRows.map((mention) => mention.id));
  const streamedAfterSnapshot = [...latestStreamed.values()]
    .filter(({ sequence, mention }) => sequence > sequenceAtStart && mention.companyId === current.companyId);
  const updatedIds = new Set(streamedAfterSnapshot.map(({ mention }) => mention.id));
  let result = {
    ...current,
    items: current.items.filter((mention) =>
      !refreshedIds.has(mention.id) && !snapshotIds.has(mention.id) && !updatedIds.has(mention.id),
    ),
  };
  for (const mention of snapshotRows) {
    result = reconcileScoreBucketOnMention(result, mention) ?? result;
  }
  for (const { mention } of streamedAfterSnapshot) {
    result = reconcileScoreBucketOnMention(result, mention) ?? result;
  }
  return result;
}

function mergeScoreBucketItems(current: Mention[], updates: Mention[]): Mention[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const mention of updates) byId.set(mention.id, mention);
  return [...byId.values()].sort((a, b) =>
    (b.score?.scoredAt ?? 0) - (a.score?.scoredAt ?? 0)
    || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1),
  );
}
