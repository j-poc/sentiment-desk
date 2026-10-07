import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectedCompanyResearchSections } from "../web/src/components/SelectedCompanyResearchSections.js";

describe("selected-company responsive research order", () => {
  const renderSections = () => renderToStaticMarkup(createElement(SelectedCompanyResearchSections, {
    fundamentals: createElement("div", { id: "sec-triage" }, "SEC triage"),
    evidenceFirst: false,
    chart: createElement("div", { id: "selected-company-chart" }, "Saved company chart"),
    afterChart: createElement("div", { id: "current-evidence" }, "Current saved source status"),
    evidence: createElement("div", { id: "selected-company-evidence" }, "Saved source headlines"),
  }));

  it("keeps the price and source evidence panels ahead of the detailed filing summary", () => {
    const html = renderSections();

    const chart = html.indexOf('id="selected-company-chart"');
    const section = html.indexOf('<section class="selected-company-research"');
    const currentEvidence = html.indexOf('id="current-evidence"');
    const evidence = html.indexOf('id="selected-company-evidence"');
    const fundamentals = html.indexOf('id="sec-triage"');
    expect(section).toBeGreaterThanOrEqual(0);
    expect(currentEvidence).toBeGreaterThanOrEqual(0);
    expect(section).toBeLessThan(fundamentals);
    expect(currentEvidence).toBeGreaterThan(chart);
    expect(evidence).toBeGreaterThan(chart);
    expect(evidence).toBeGreaterThan(currentEvidence);
    expect(fundamentals).toBeGreaterThan(evidence);
    expect(html).toContain('aria-label="Selected company chart and source evidence"');
    expect(html).toContain('class="selected-company-research-content"');
    expect(html).toContain('class="selected-company-chart"');
    expect(html).toContain('class="selected-company-evidence"');
  });

  it("leads with current source evidence while keeping the company chart and its controls visible", () => {
    const html = renderToStaticMarkup(createElement(SelectedCompanyResearchSections, {
      evidenceFirst: true,
      chart: createElement("div", { id: "selected-company-chart" }, "Saved company chart"),
      afterChart: createElement("div", { id: "current-evidence" }, "Current saved source status"),
      evidence: createElement("div", { id: "selected-company-evidence" }, "Saved source headlines"),
    }));

    expect(html.indexOf('id="selected-company-evidence"')).toBeLessThan(html.indexOf('id="selected-company-chart"'));
    expect(html).toContain('aria-label="Current source evidence and company chart"');
    expect(html).toContain('id="selected-company-chart"');
    expect(html).toContain('id="current-evidence"');
  });

  it("keeps a populated, explicitly selected historical Jev chart ahead of source evidence", () => {
    const html = renderToStaticMarkup(createElement(SelectedCompanyResearchSections, {
      evidenceFirst: false,
      chart: createElement("div", { id: "selected-company-chart" }, "Populated Historical Jev chart"),
      evidence: createElement("div", { id: "selected-company-evidence" }, "Saved source headlines"),
    }));

    expect(html.indexOf("Populated Historical Jev chart")).toBeLessThan(html.indexOf("Saved source headlines"));
  });
});
