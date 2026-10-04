import type { Mention, MentionPage } from "./api.js";

export function mentionWindowHours(filter: string, selectedHours: number): number {
  return filter === "failed" || filter === "history" || filter === "identity_review" ? 0 : selectedHours;
}

export function mentionPageParams(
  filter: string,
  hours: number,
  cursor: MentionPage["nextCursor"] = null,
  limit = 100,
  includeDismissed = false,
): URLSearchParams {
  const params = new URLSearchParams({ filter, limit: String(limit) });
  if (hours > 0) params.set("hours", String(hours));
  if (cursor != null) params.set("cursor", JSON.stringify(cursor));
  if (includeDismissed) params.set("includeDismissed", "true");
  return params;
}

export function mentionIsInWindow(mention: Mention, hours: number, now = Date.now()): boolean {
  return hours === 0
    || (mention.publishedAt ?? mention.providerObservedAt ?? mention.retrievedAt) >= now - hours * 60 * 60 * 1000;
}
