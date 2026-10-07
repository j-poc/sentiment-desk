import type { ReactNode } from "react";

export function SelectedCompanyResearchSections({
  fundamentals,
  evidenceFirst = false,
  chart,
  afterChart,
  evidence,
}: {
  fundamentals?: ReactNode;
  evidenceFirst?: boolean;
  chart: ReactNode;
  afterChart?: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <>
      <section
        className="selected-company-research"
        aria-label={evidenceFirst ? "Current source evidence and company chart" : "Selected company chart and source evidence"}
      >
        <div className={`selected-company-research-content${evidenceFirst ? " selected-company-research-evidence-first" : ""}`}>
          {evidenceFirst ? (
            <>
              <div className="selected-company-evidence">{evidence}</div>
              <div className="selected-company-chart">{chart}{afterChart}</div>
            </>
          ) : (
            <>
              <div className="selected-company-chart">{chart}{afterChart}</div>
              <div className="selected-company-evidence">{evidence}</div>
            </>
          )}
        </div>
      </section>
      {fundamentals}
    </>
  );
}
