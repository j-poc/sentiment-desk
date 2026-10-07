import type { CategoricalChartSnapshot } from "./chart-view-preference.js";
import { timeAgo } from "./format.js";

export function categoricalChartStatusLabel(
  snapshot: CategoricalChartSnapshot | null,
  windowLabel: string,
  now: number,
): string {
  if (snapshot == null) return `GPT-6 Luna ${windowLabel} snapshot not confirmed`;

  const count = snapshot.eligibleObservationCount?.toLocaleString() ?? null;
  if (snapshot.status === "ready") return `GPT-6 Luna: ${count ?? "unknown"} in ${windowLabel}`;

  const lastConfirmed = count == null ? "" : ` · last confirmed ${count} in ${windowLabel}`;
  const lastSuccessfulRead = snapshot.observedAt == null
    ? ""
    : ` · last successful read ${timeAgo(snapshot.observedAt, now)}`;
  const state = snapshot.status === "loading" ? "Loading saved Luna history" : "Saved Luna history unavailable";
  return `${state}${lastConfirmed}${lastSuccessfulRead}`;
}
