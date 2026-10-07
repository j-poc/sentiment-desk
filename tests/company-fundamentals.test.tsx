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

  it("does not imply saved SEC facts exist when none are available", () => {
    const markup = html({
      ...props("blocked"),
      refreshAllowed: false,
      refreshBlockedReason: "No SEC facts are saved for this company; external requests are disabled.",
    });
    expect(markup).toContain("No SEC facts are saved for this company; external requests are disabled.");
    expect(markup).not.toContain("saved SEC facts remain available");
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
      comparisons: [{ metric: "revenue", state: "comparable", periodAlignment: "calendar_anniversary", currentFactId: fact.id, priorFactId: "prior-fact",
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
    expect(markup).toContain("does not assess cause, materiality, persistence, or narrative counterevidence");
    expect(markup).toContain("Inspect management discussion and segment disclosures for drivers, qualifications, and contrary evidence.");
    expect(markup).toContain("1234567890.125");
    expect(markup).toContain("1356790123.456");
    expect(markup).toContain('aria-label="Returned persisted revenue values"');

    const malformed = html({ ...input, facts: [{ ...fact, reportedDecimals: "19" }] });
    expect(malformed).toContain("SEC precision metadata is malformed or unsupported; comparisons are withheld.");

    const insufficient = html({
      ...input,
      facts: [fact],
      comparisons: [{ metric: "revenue", state: "insufficient", periodAlignment: null, currentFactId: fact.id, priorFactId: null,
        delta: null, percentChange: null, changeInterpretation: "withheld", reason: "No calendar-matched period." }],
    });
    expect(insufficient).toContain("No supported material-change finding: there is no eligible comparable revenue period in the saved SEC facts.");
    expect(insufficient).toContain("Open the cited filing and locate the same metric in an eligible earlier reported period.");
  });

  it("shows the saved Apple 39-week SEC comparison without claiming precision or growth", () => {
    const sourceUrl = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm";
    const priorFact: PersistedFundamentalFact = {
      id: "aapl-real-ytd-2025",
      companyId: "apple",
      cik: "0000320193",
      metric: "revenue",
      value: "313695000000",
      unit: "USD",
      reportedDecimals: null,
      reportedPrecisionStatus: "missing",
      taxonomy: "us-gaap",
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      startDate: "2024-09-29",
      endDate: "2025-06-28",
      filingFocusYear: 2026,
      filingFocusPeriod: "Q3",
      form: "10-Q",
      accession: "0000320193-26-000020",
      filedAt: Date.UTC(2026, 6, 30),
      acceptedAt: Date.UTC(2026, 6, 30, 20, 11),
      retrievedAt: Date.UTC(2026, 7, 1),
      sourceUrl,
      responseSha256: "a".repeat(64),
      companyFactsDeliveryId: "aapl-real-companyfacts-delivery",
      submissionsDeliveryId: "aapl-real-submissions-delivery",
      durationClass: "ytd_q3",
      amended: false,
    };
    const currentFact: PersistedFundamentalFact = {
      ...priorFact,
      id: "aapl-real-ytd-2026",
      value: "364357000000",
      startDate: "2025-09-28",
      endDate: "2026-06-27",
    };
    const priorQuarterFact: PersistedFundamentalFact = {
      ...priorFact,
      id: "54ccbdc1-ea8a-4269-9f0c-b2efca8a540e",
      value: "94036000000",
      startDate: "2025-03-30",
      endDate: "2025-06-28",
      durationClass: "quarter",
    };
    const currentQuarterFact: PersistedFundamentalFact = {
      ...currentFact,
      id: "bac5ed93-bfaf-4eb0-a60c-71e622e80a83",
      value: "109417000000",
      startDate: "2026-03-29",
      durationClass: "quarter",
    };
    const markup = html({
      ...props("partial"),
      companyName: "Apple",
      ticker: "AAPL",
      facts: [priorFact, currentFact, priorQuarterFact, currentQuarterFact],
      comparisons: [
        { metric: "revenue", state: "comparable", periodAlignment: "same_filing_52_week",
          currentFactId: currentFact.id, priorFactId: priorFact.id, delta: "50662000000", percentChange: null,
          changeInterpretation: "reported_values_only",
          reason: "SEC source precision metadata is unavailable; this is arithmetic between returned CompanyFacts values only. Percentage change is withheld because the SEC source precision metadata is unavailable." },
        { metric: "revenue", state: "comparable", periodAlignment: "same_filing_52_week",
          currentFactId: currentQuarterFact.id, priorFactId: priorQuarterFact.id, delta: "15381000000", percentChange: null,
          changeInterpretation: "reported_values_only",
          reason: "SEC source precision metadata is unavailable; this is arithmetic between returned CompanyFacts values only. Percentage change is withheld because the SEC source precision metadata is unavailable." },
      ],
      points: [],
      coverage: [],
    });

    expect(markup).toContain("Quarter · Mar 29, 2026 – Jun 27, 2026 · 10-Q");
    expect(markup).toContain("Year to date · Sep 28, 2025 – Jun 27, 2026 · 10-Q");
    expect(markup).toContain("Same-filing period boundaries 52 weeks apart.");
    expect(markup).toContain("Current period: Mar 29, 2026 – Jun 27, 2026.");
    expect(markup).toContain("Prior period: Mar 30, 2025 – Jun 28, 2025.");
    expect(markup).toContain("Both periods span 91 days.");
    expect(markup).toContain("The returned revenue amounts differ by 15,381,000,000 USD");
    expect(markup).toContain("Current</strong> 109,417,000,000 USD");
    expect(markup).toContain("Matched prior</strong> 94,036,000,000 USD");
    expect(markup).toContain("Arithmetic difference</strong> 15,381,000,000 USD");
    expect(markup).toContain("Both periods span 91 days.");
    expect(markup).toContain("Interpretation limit");
    expect(markup).toContain("SEC coverage and comparison limits");
    expect(markup).toContain("Filed</dt><dd>Jul 30, 2026</dd>");
    expect(markup).toContain("Retrieved</dt><dd>Aug 01, 2026");
    expect(markup).toContain('<details class="cf-evidence">');
    expect(markup).not.toMatch(/<details class="cf-evidence"[^>]*open/);
    expect(markup.indexOf('aria-label="Filing triage"')).toBeLessThan(markup.indexOf('<details class="cf-evidence">'));
    expect(markup).toContain("50,662,000,000 USD");
    expect(markup).toContain("source precision is unavailable; an underlying change is not established");
    expect(markup).toContain("Check the as-filed statement for its unit and reported precision");
    expect(markup).toContain(`href="${sourceUrl}"`);
    expect(markup).toContain("SEC precision metadata is unavailable in this saved fact.");
    expect(markup).not.toContain("%");
    expect(markup).not.toContain("revenue growth");
  });

  it("keeps the newest reported revenue as Current when only an older period has a comparison", () => {
    const base: PersistedFundamentalFact = {
      id: "older-revenue",
      companyId: "company-1",
      cik: "0000000001",
      metric: "revenue",
      value: "100",
      unit: "USD",
      reportedDecimals: "INF",
      reportedPrecisionStatus: "declared",
      taxonomy: "us-gaap",
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      filingFocusYear: 2024,
      filingFocusPeriod: "FY",
      form: "10-K",
      accession: "0000000001-25-000001",
      filedAt: Date.UTC(2025, 1, 1),
      acceptedAt: Date.UTC(2025, 1, 1, 12),
      retrievedAt: Date.UTC(2025, 1, 2, 12),
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000125000001/example.htm",
      responseSha256: "a".repeat(64),
      companyFactsDeliveryId: "facts-older",
      submissionsDeliveryId: "submissions-older",
      durationClass: "annual",
      amended: false,
    };
    const olderPrior: PersistedFundamentalFact = {
      ...base,
      id: "older-prior-revenue",
      value: "90",
      startDate: "2023-01-01",
      endDate: "2023-12-31",
      accession: "0000000001-24-000001",
    };
    const newest: PersistedFundamentalFact = {
      ...base,
      id: "newest-revenue",
      value: "125",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      filingFocusYear: 2025,
      accession: "0000000001-26-000001",
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/example.htm",
      companyFactsDeliveryId: "facts-newest",
      submissionsDeliveryId: "submissions-newest",
    };
    const markup = html({
      ...props("ready"),
      facts: [olderPrior, base, newest],
      comparisons: [{
        metric: "revenue",
        state: "comparable",
        periodAlignment: "calendar_anniversary",
        currentFactId: base.id,
        priorFactId: olderPrior.id,
        delta: "10",
        percentChange: "0.111",
        changeInterpretation: "change_exceeds_precision",
        reason: "Older period comparison.",
      }],
    });

    expect(markup).toContain("Current</strong> 125 USD <span class=\"cf-triage-date\">(Jan 01, 2025 – Dec 31, 2025)</span>");
    expect(markup).toContain("No supported material-change finding: there is no eligible comparable revenue period in the saved SEC facts.");
    expect(markup).not.toContain("Current</strong> 100 USD");
    expect(markup).not.toContain("Matched prior</strong>");
    expect(markup).not.toContain("Arithmetic difference</strong>");
  });

  it("keeps filing triage visible in the scrollable research pane and supports narrow-screen/reduced-motion", () => {
    const markup = html(props("idle"));
    const css = readFileSync(new URL("../web/src/components/company-fundamentals.css", import.meta.url), "utf8");
    expect(markup).toContain('aria-labelledby="company-fundamentals-real"');
    expect(css).toMatch(/\.company-fundamentals\s*\{[^}]*\bflex:\s*0 0 auto\s*;/);
    expect(css).toContain("@media (max-width:560px)");
    expect(css).toContain(".cf-evidence > summary:focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(css).toContain(":focus-visible");
  });
});
