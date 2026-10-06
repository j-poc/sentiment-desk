export function HistoricalJevCaveat() {
  return (
    <aside
      role="note"
      aria-label="Historical Jev chart interpretation"
      className="mx-3 mt-2 rounded-sm border-l-2 border-amber-300/70 bg-amber-300/[0.06] px-3 py-2 text-[12px] leading-relaxed text-amber-50/90"
    >
      <p className="font-semibold text-amber-100">
        Check bucket lineage before interpreting a score.
      </p>
      <p>
        Bars group Jev score-completion time, not publication or investor activity; repeated coverage counts again. Hover a bar or inspect the keyboard table for its receipt links and exact-title repeat cues. A title match does not prove duplicate stories or independent sources. This is not current Luna analysis or validated investor sentiment.
      </p>
    </aside>
  );
}
