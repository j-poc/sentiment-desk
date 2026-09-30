import { hasOlderSavedPriceHistory } from "../lib/series-chart-state.js";

export function SavedPriceHistoryControl({
  comparison,
  savedPriceCount,
  latestPriceAt,
  hours,
  onViewHistory,
}: {
  comparison: boolean;
  savedPriceCount: number;
  latestPriceAt: number | null;
  hours: number;
  onViewHistory?: () => void;
}) {
  if (!comparison || savedPriceCount > 0 || !onViewHistory || !hasOlderSavedPriceHistory(latestPriceAt, hours, Date.now())) return null;
  return (
    <button
      type="button"
      onClick={onViewHistory}
      className="shrink-0 rounded border border-white/10 px-2 py-1 text-white/75 hover:bg-white/[0.05]"
    >
      View 7D saved price history
    </button>
  );
}
