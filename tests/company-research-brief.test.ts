import { describe, expect, it } from "vitest";
import { compileCompanyResearchBrief } from "../server/company-research-brief.js";
import type { CompanyResearchBriefInput } from "../shared/company-research-brief.js";
import type { FundamentalComparison, PersistedFundamentalFact } from "../shared/company-fundamentals.js";

const asOfMs = 1_800_000_000_000;
const company = { companyId: "co-1", name: "Example Corp", ticker: "EXM", cik: "0000000001" };
const fact = (id: string, endDate: string, value: string): PersistedFundamentalFact => ({
  id, companyId: "co-1", cik: "0000000001", metric: "revenue", value, unit: "USD", reportedDecimals: "INF",
  reportedPrecisionStatus: "declared", taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
  startDate: `${endDate.slice(0, 4)}-01-01`, endDate, filingFocusYear: Number(endDate.slice(0, 4)), filingFocusPeriod: "FY",
  form: "10-K", accession: "0000000001-25-000001", filedAt: asOfMs - 1000, acceptedAt: asOfMs - 900,
  retrievedAt: asOfMs - 500, sourceUrl: `https://www.sec.gov/Archives/${id}`, responseSha256: `sha-${id}`,
  companyFactsDeliveryId: "facts-delivery", submissionsDeliveryId: "submissions-delivery", durationClass: "annual", amended: false,
});
const comparison: FundamentalComparison = {
  metric: "revenue", state: "comparable", periodAlignment: "calendar_anniversary", currentFactId: "f2", priorFactId: "f1",
  delta: "200", percentChange: "20", changeInterpretation: "change_exceeds_precision", reason: null,
};
const observation = {
  id: "obs-1", companyId: "co-1", title: "Example headline", publisher: "Example Publisher", sourceUrl: "https://example.com/story",
  sourceTime: asOfMs - 3000, retrievedAt: asOfMs - 2000, deliveryId: "delivery-1", ingestedAt: asOfMs - 1000,
  snippet: "Exact saved excerpt for review.", status: "pending", collector: "google_news_rss",
  timeBasis: "aggregator_declared", deliveryCompletedAt: asOfMs - 1500, ingestionCompletedAt: asOfMs - 1000,
  sentiment: -98,
};
function input(overrides: Partial<CompanyResearchBriefInput> = {}): CompanyResearchBriefInput {
  return {
    company, asOfMs, snapshotId: "snapshot-1", facts: [fact("f1", "2024-12-31", "1000"), fact("f2", "2025-12-31", "1200")],
    comparisons: [comparison], observations: [observation], coverage: { sec: "complete", publicObservations: "complete", reasons: [] },
    ...overrides,
  };
}

describe("compileCompanyResearchBrief", () => {
  it("marks empty and partial coverage explicitly and gives no question without evidence", () => {
    const brief = compileCompanyResearchBrief(input({ facts: [], comparisons: [], observations: [], coverage: { sec: "empty", publicObservations: "empty", reasons: ["feed paused"] } }));
    expect(brief.coverage).toEqual({ sec: "empty", publicObservations: "empty", reasons: ["feed paused"] });
    expect(brief.nextResearchQuestion).toBeNull();
    expect(brief.missingEvidenceReason).toContain("No valid comparable SEC metric");

    const partial = compileCompanyResearchBrief(input({ coverage: { sec: "partial", publicObservations: "partial", reasons: ["one source unavailable"] } }));
    expect(partial.coverage.sec).toBe("partial");
    expect(partial.coverage.publicObservations).toBe("partial");
  });

  it("preserves exact fact, comparison, source and all provenance clocks with the snapshot cutoff", () => {
    const source = observation;
    const brief = compileCompanyResearchBrief(input());
    expect(brief.asOfMs).toBe(asOfMs);
    expect(brief.snapshotId).toBe("snapshot-1");
    expect(brief.facts).toEqual([fact("f1", "2024-12-31", "1000"), fact("f2", "2025-12-31", "1200")]);
    expect(brief.comparisons).toEqual([comparison]);
    expect(brief.observations).toEqual([source]);
    expect(brief.observations[0]!).toMatchObject({ id: "obs-1", sourceUrl: "https://example.com/story", sourceTime: source.sourceTime, retrievedAt: source.retrievedAt, deliveryId: "delivery-1", ingestedAt: source.ingestedAt });
    expect(compileCompanyResearchBrief(input())).toEqual(brief);
  });

  it("does not turn negative sentiment into support, counterevidence, or worthiness", () => {
    const brief = compileCompanyResearchBrief(input());
    expect(brief.observations[0]!.sentiment).toBe(-98);
    expect(brief).not.toHaveProperty("thesis");
    expect(brief).not.toHaveProperty("materialSupport");
    expect(brief).not.toHaveProperty("companyWorthiness");
    expect(brief.interpretationLimits.join(" ")).toMatch(/Sentiment labels do not establish factual support/);
  });

  it("makes the next check specific to the reported arithmetic change without claiming its cause", () => {
    const brief = compileCompanyResearchBrief(input());
    expect(brief.nextResearchQuestion?.question).toContain("difference of 200 USD (20%)");
    expect(brief.nextResearchQuestion?.question).toContain("2024-12-31 to 2025-12-31");
    expect(brief.nextResearchQuestion?.question).toContain("supports or challenges");
  });

  it("keeps an absolute SEC question when source precision is missing, without inventing a percentage", () => {
    // Fixed regression derived from the saved Apple SEC CompanyFacts response
    // and same-filing pair observed on 2026-10-08. These rows are test-only.
    const prior: PersistedFundamentalFact = {
      ...fact("4ed7e624-2741-490e-8e65-1328cb06f1b3", "2025-06-28", "84544000000"),
      companyId: "apple", cik: "0000320193", metric: "net_income", unit: "USD", reportedDecimals: null,
      reportedPrecisionStatus: "missing", taxonomy: "us-gaap", concept: "NetIncomeLoss",
      startDate: "2024-09-29", endDate: "2025-06-28", filingFocusYear: 2026, filingFocusPeriod: "Q3",
      form: "10-Q", accession: "0000320193-26-000020", acceptedAt: 1785506462000,
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm", durationClass: "ytd_q3",
    };
    const current: PersistedFundamentalFact = {
      ...fact("956cf460-51e8-4bd9-baed-e2d89a26cbc8", "2026-06-27", "101464000000"),
      companyId: "apple", cik: "0000320193", metric: "net_income", unit: "USD", reportedDecimals: null,
      reportedPrecisionStatus: "missing", taxonomy: "us-gaap", concept: "NetIncomeLoss",
      startDate: "2025-09-28", endDate: "2026-06-27", filingFocusYear: 2026, filingFocusPeriod: "Q3",
      form: "10-Q", accession: "0000320193-26-000020", acceptedAt: 1785506462000,
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm", durationClass: "ytd_q3",
    };
    const appleInput = input({
      company: { companyId: "apple", name: "Apple", ticker: "AAPL", cik: "0000320193" },
      facts: [prior, current],
      comparisons: [{ metric: "net_income", state: "comparable", periodAlignment: "same_filing_52_week",
        currentFactId: current.id, priorFactId: prior.id, delta: "16920000000", percentChange: null,
        changeInterpretation: "reported_values_only", reason: "SEC source precision metadata is unavailable." }],
    });

    const brief = compileCompanyResearchBrief(appleInput);
    expect(brief.nextResearchQuestion).toMatchObject({ metric: "net_income", currentFactId: current.id, priorFactId: prior.id });
    expect(brief.nextResearchQuestion?.question).toContain("difference of 16920000000 USD");
    expect(brief.nextResearchQuestion?.question).not.toMatch(/\(\d+(?:\.\d+)?%\)/u);
    expect(brief.missingEvidenceReason).toBeNull();
  });

  it("continues to a valid newer comparison when an earlier candidate is malformed", () => {
    const malformed = { ...comparison, currentFactId: "missing", priorFactId: "also-missing" };
    const brief = compileCompanyResearchBrief(input({ comparisons: [malformed, comparison] }));
    expect(brief.nextResearchQuestion?.question).toContain("difference of 200 USD (20%)");
  });

  it.each([
    ["within_reported_precision", "200", "20", false],
    ["no_reported_difference", "0", "0", true],
    ["reported_values_only", "0", "0", true],
  ] as const)("does not prompt a driver investigation for a non-signal comparison (%s)", (changeInterpretation, delta, percentChange, unchanged) => {
    const facts = unchanged ? [fact("f1", "2024-12-31", "1000"), fact("f2", "2025-12-31", "1000")] : undefined;
    const brief = compileCompanyResearchBrief(input({
      ...(facts ? { facts } : {}),
      comparisons: [{ ...comparison, changeInterpretation, delta, percentChange }],
    }));
    expect(brief.nextResearchQuestion).toBeNull();
    expect(brief.missingEvidenceReason).toContain("No valid comparable SEC metric");
  });

  it("withholds the deterministic next question when comparisons are invalid or linked facts are missing/mismatched", () => {
    const invalidState = { ...comparison, state: "insufficient" as const };
    expect(compileCompanyResearchBrief(input({ comparisons: [invalidState] })).nextResearchQuestion).toBeNull();
    expect(compileCompanyResearchBrief(input({ comparisons: [{ ...comparison, currentFactId: "missing" }] })).nextResearchQuestion).toBeNull();
    expect(compileCompanyResearchBrief(input({ comparisons: [{ ...comparison, delta: "999", percentChange: "99.9" }] })).nextResearchQuestion).toBeNull();
    const mismatch = fact("f2", "2025-12-31", "1200");
    expect(compileCompanyResearchBrief(input({ facts: [fact("f1", "2024-12-31", "1000"), { ...mismatch, unit: "shares" }] })).nextResearchQuestion).toBeNull();
    expect(compileCompanyResearchBrief(input({ facts: [fact("f1", "2024-12-31", "1000"), { ...mismatch, cik: "0000000099" }] })).nextResearchQuestion).toBeNull();
    expect(compileCompanyResearchBrief(input({ comparisons: [{ ...comparison, delta: "NaN" }] })).nextResearchQuestion).toBeNull();
  });
});
