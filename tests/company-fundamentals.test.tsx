import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CompanyFundamentals, type CompanyFundamentalsProps, type PersistedFundamentalFact } from "../web/src/components/CompanyFundamentals.js";

function props(state: CompanyFundamentalsProps["state"]): CompanyFundamentalsProps {
  return {
    companyName: "Selected company",
    ticker: "REAL",
    state,
    facts: [],
    comparisons: [],
    points: [],
    coverage: [],
    refreshAllowed: true,
    onRefresh: vi.fn(),
  };
}

function html(input: CompanyFundamentalsProps) {
  return renderToStaticMarkup(createElement(CompanyFundamentals, input));
}

describe("CompanyFundamentals", () => {
  it("renders a truthful empty state without inventing values or chart marks", () => {
    const markup = html(props("empty"));
    expect(markup).toContain("No eligible SEC facts are saved for this company yet.");
    expect(markup).toContain("No saved values or chart are shown without persisted SEC facts.");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("$0");
  });

  it("distinguishes loading and refreshing states accessibly", () => {
    expect(html(props("loading"))).toContain('role="status">Loading saved SEC facts');
    expect(html(props("refreshing"))).toContain("Previously saved facts remain available.");
  });

  it("keeps refresh disabled and explains the precise blocked reason", () => {
    const input = { ...props("blocked"), refreshAllowed: false, refreshBlockedReason: "SEC identity is not configured." };
    const markup = html(input);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('<p id="cf-refresh-reason" class="cf-refresh-reason" role="status">SEC identity is not configured.</p>');
    expect(markup.match(/SEC identity is not configured\./g)).toHaveLength(1);
    expect(markup).toContain('aria-describedby="cf-refresh-reason"');
    expect(markup).not.toContain("SEC refresh is blocked by the current source or account controls.");
  });

  it("shows stale and failed conditions without claiming fresh data", () => {
    const stale = html({ ...props("stale"), staleReason: "Saved evidence is older than the freshness target." });
    const failed = html({ ...props("failed"), lastRefreshError: "The SEC request was unavailable." });
    expect(stale).toContain("Saved evidence is older than the freshness target.");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Previously saved facts, if any, are retained.");
    expect(failed).toContain("The SEC request was unavailable.");
  });

  it("does not render a chart when no persisted points are provided", () => {
    const markup = html(props("ready"));
    expect(markup).toContain("No saved values or chart are shown without persisted SEC facts.");
    expect(markup).not.toContain("<svg");
  });

  it("keeps the filed date date-only and exposes the chart scale and exact values", () => {
    const fact: PersistedFundamentalFact = {
      id: "presentation-only-fact",
      companyId: "presentation-only-company",
      cik: "0000000001",
      metric: "revenue",
      value: "1356790123.456",
      unit: "USD",
      reportedDecimals: "-6",
      reportedPrecisionStatus: "declared",
      taxonomy: "us-gaap",
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      filingFocusYear: 2025,
      filingFocusPeriod: "FY",
      form: "10-K",
      accession: "0000000001-26-000001",
      filedAt: Date.UTC(2026, 0, 1),
      acceptedAt: Date.UTC(2026, 0, 1, 17, 16),
      retrievedAt: Date.UTC(2026, 0, 2, 9, 4),
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/example.htm",
      responseSha256: "a".repeat(64),
      companyFactsDeliveryId: "presentation-only-facts-delivery",
      submissionsDeliveryId: "presentation-only-submissions-delivery",
      durationClass: "annual",
      amended: false,
    };
    const priorFact: PersistedFundamentalFact = {
      ...fact,
      id: "prior-fact",
      value: "1234567890.125",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      filingFocusYear: 2025,
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/example.htm",
    };
    const input: CompanyFundamentalsProps = {
      ...props("ready"),
      facts: [priorFact, fact],
      comparisons: [{ metric: "revenue", state: "comparable", currentFactId: fact.id, priorFactId: "prior-fact",
        delta: "2000001", percentChange: "0.15", changeInterpretation: "change_exceeds_precision",
        reason: "Reported precision fields -6 and -6; calculation uses returned values without rescaling." }],
      points: [
        { periodEnd: "2024-12-31", metric: "revenue", value: "1234567890.125", unit: "USD", reportedDecimals: "-6", reportedPrecisionStatus: "declared" },
        { periodEnd: "2025-12-31", metric: "revenue", value: "1356790123.456", unit: "USD", reportedDecimals: "-6", reportedPrecisionStatus: "declared" },
      ],
    };
    const markup = html(input);
    expect(markup).toContain("<dt>Filed</dt><dd>Jan 01, 2026</dd>");
    expect(markup).not.toMatch(/<dt>Filed<\/dt><dd>[^<]*(?:AM|PM|UTC)/);
    expect(markup).toMatch(/<dt>Accepted<\/dt><dd>[^<]*(?:AM|PM)/);
    expect(markup).toContain("USD · linear scale");
    expect(markup).toContain("SEC precision scale $1M (decimals −6).");
    expect(markup).toContain("$1.2B");
    expect(markup).toContain("$1.4B");
    expect(markup).toContain("Reported-value difference exceeds the combined precision bound");
    expect(markup).not.toContain("(0.15%)");
    expect(markup).toContain("Percentage change is withheld because both reported amounts are not declared exact in XBRL.");
    expect(markup).toContain("Inspect source values and reporting precision");
    expect(markup).toContain('aria-label="Filing triage"');
    expect(markup).toContain("FILING TRIAGE");
    expect(markup).toContain("the reported gap exceeds the combined precision bound");
    expect(markup).toContain("does not assess operating drivers, materiality, persistence, or narrative counterevidence");
    expect(markup).toContain("Inspect management discussion and segment disclosures for drivers, qualifications, and contrary evidence.");
    expect(markup).toContain("1234567890.125");
    expect(markup).toContain("1356790123.456");
    expect(markup).toContain('aria-label="Returned persisted revenue values"');

    const malformed = html({ ...input, facts: [{ ...fact, reportedDecimals: "19" }] });
    expect(malformed).toContain("SEC precision metadata is malformed or unsupported; comparisons are withheld.");

    const insufficient = html({
      ...input,
      facts: [fact],
      comparisons: [{ metric: "revenue", state: "insufficient", currentFactId: fact.id, priorFactId: null,
        delta: null, percentChange: null, changeInterpretation: "withheld", reason: "No calendar-matched period." }],
    });
    expect(insufficient).toContain("No supported material-change finding: there is no eligible comparable revenue period in the saved SEC facts.");
    expect(insufficient).toContain("Open the cited filing and locate the same metric in a calendar-matched prior-year statement.");
  });

  it("provides a named section, semantic disclosure, and narrow-screen/reduced-motion rules", () => {
    const markup = html(props("idle"));
    const css = readFileSync(new URL("../web/src/components/company-fundamentals.css", import.meta.url), "utf8");
    expect(markup).toContain('aria-labelledby="company-fundamentals-real"');
    expect(markup).toContain("<details class=\"cf-coverage\">");
    expect(markup).toContain("custom tags and dimensional disclosures");
    expect(css).toContain("@media (max-width:560px)");
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(css).toContain(":focus-visible");
  });
});
