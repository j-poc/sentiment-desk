import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectedCompanyResearchSections } from "../web/src/components/SelectedCompanyResearchSections.js";

describe("selected-company responsive research order", () => {
  it("puts the selected-company chart first, followed by status and source evidence", () => {
    const html = renderToStaticMarkup(createElement(SelectedCompanyResearchSections, {
      chart: createElement("div", { id: "selected-company-chart" }, "Saved company chart"),
      afterChart: createElement("div", { id: "current-evidence" }, "Current saved source status"),
      evidence: createElement("div", { id: "selected-company-evidence" }, "Saved source headlines"),
    }));

    const chart = html.indexOf('id="selected-company-chart"');
    const currentEvidence = html.indexOf('id="current-evidence"');
    const evidence = html.indexOf('id="selected-company-evidence"');
    expect(currentEvidence).toBeGreaterThanOrEqual(0);
    expect(currentEvidence).toBeGreaterThan(chart);
    expect(evidence).toBeGreaterThan(chart);
    expect(evidence).toBeGreaterThan(currentEvidence);
    expect(html).toContain('aria-label="Selected company chart and source evidence"');
    expect(html).toContain('class="selected-company-research-content"');
    expect(html).toContain('class="selected-company-chart"');
    expect(html).toContain('class="selected-company-evidence"');
  });
});
