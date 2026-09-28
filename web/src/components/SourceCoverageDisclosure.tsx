export function SourceCoverageDisclosure({ externalRequestsEnabled = true }: { externalRequestsEnabled?: boolean }) {
  return (
    <div className="mb-1.5 shrink-0 px-1 text-[10.5px] leading-relaxed text-white/55">
      <p role="note">Configured feeds only. This desk does not cover the entire public web or all investor activity.</p>
      {!externalRequestsEnabled && <p role="status" className="text-amber-200/80">External requests are paused. This view uses only data and price history already saved locally.</p>}
    </div>
  );
}
