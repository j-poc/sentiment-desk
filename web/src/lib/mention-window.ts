import type { Mention, MentionPage } from "./api.js";

export function mentionWindowHours(filter: string, selectedHours: number): number {
  return filter === "failed" || filter === "history" ? 0 : selectedHours;
}

export function mentionPageParams(
  filter: string,
  hours: number,
  cursor: MentionPage["nextCursor"] = null,
  limit = 100,
): URLSearchParams {
  const params = new URLSearchParams({ filter, limit: String(limit) });
  if (hours > 0) params.set("hours", String(hours));
  if (cursor != null) params.set("cursor", JSON.stringify(cursor));
  return params;
}

export function mentionIsInWindow(mention: Mention, hours: number, now = Date.now()): boolean {
  return hours === 0
    || (mention.publishedAt ?? mention.providerObservedAt ?? mention.retrievedAt) >= now - hours * 60 * 60 * 1000;
}
