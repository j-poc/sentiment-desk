import type { ReactNode } from "react";

export function SelectedCompanyResearchSections({
  chart,
  afterChart,
  evidence,
}: {
  chart: ReactNode;
  afterChart?: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <section className="selected-company-research" aria-label="Selected company chart and source evidence">
      <div className="selected-company-research-content">
        <div className="selected-company-chart">{chart}{afterChart}</div>
        <div className="selected-company-evidence">{evidence}</div>
      </div>
    </section>
  );
}
