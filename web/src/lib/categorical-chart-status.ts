import type { CategoricalChartSnapshot } from "./chart-view-preference.js";
import { timeAgo } from "./format.js";

export function categoricalChartStatusLabel(
  snapshot: CategoricalChartSnapshot | null,
  windowLabel: string,
  now: number,
  defaultProvider: CategoricalChartSnapshot["provider"] = "google_gemini",
): string {
  const model = snapshot?.provider === "google_gemini" || (snapshot == null && defaultProvider === "google_gemini")
    ? "Gemini 3.8 Flash"
    : "GPT-6 Luna";
  if (snapshot == null) return `${model} ${windowLabel} snapshot not confirmed`;

  const count = snapshot.eligibleObservationCount?.toLocaleString() ?? null;
  if (snapshot.status === "ready") return `${model}: ${count ?? "unknown"} in ${windowLabel}`;

  const lastConfirmed = count == null ? "" : ` · last confirmed ${count} in ${windowLabel}`;
  const lastSuccessfulRead = snapshot.observedAt == null
    ? ""
    : ` · last successful read ${timeAgo(snapshot.observedAt, now)}`;
  const state = snapshot.status === "loading" ? `Loading saved ${model} history` : `Saved ${model} history unavailable`;
  return `${state}${lastConfirmed}${lastSuccessfulRead}`;
}
