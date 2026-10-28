import type { ReactNode } from "react";

export function SelectedCompanyResearchSections({
  fundamentals,
  chart,
  afterChart,
  modelAssessments,
  evidence,
}: {
  fundamentals?: ReactNode;
  chart: ReactNode;
  afterChart?: ReactNode;
  modelAssessments?: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <>
      <section className="selected-company-research" aria-label="Selected company sentiment chart and source evidence">
        <div className="selected-company-research-content">
          <div className="selected-company-chart">{chart}{afterChart}{modelAssessments}</div>
          <div className="selected-company-evidence">{evidence}</div>
        </div>
      </section>
      {fundamentals}
    </>
  );
}
