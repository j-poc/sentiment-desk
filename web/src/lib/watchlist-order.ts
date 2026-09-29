import type { CompanySnapshot } from "./api.js";

export type WatchlistSortMode = "alpha" | "delta";

export function hasComparableDeltas(companies: readonly CompanySnapshot[]): boolean {
  return companies.some((company) => company.delta != null);
}

export function orderWatchlistCompanies(
  companies: readonly CompanySnapshot[],
  sortMode: WatchlistSortMode,
): CompanySnapshot[] {
  const ordered = [...companies];
  if (sortMode === "delta" && hasComparableDeltas(ordered)) {
    ordered.sort((a, b) => {
      if (a.delta == null) return b.delta == null ? a.ticker.localeCompare(b.ticker) : 1;
      if (b.delta == null) return -1;
      return Math.abs(b.delta) - Math.abs(a.delta) || a.ticker.localeCompare(b.ticker);
    });
  } else {
    ordered.sort((a, b) => a.ticker.localeCompare(b.ticker));
  }
  return ordered;
}
