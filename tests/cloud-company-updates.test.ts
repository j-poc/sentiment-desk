import { describe, expect, it } from "vitest";
import { buildCloudCompanyUpdates, type CloudCompanyFact, type CloudCompanyFiling } from "../shared/cloud-company-updates.js";

const cik = "0000320193";

function fact(overrides: Partial<CloudCompanyFact> = {}): CloudCompanyFact {
  return {
    id: "current-revenue", cik, taxonomy: "us-gaap", concept: "Revenues", unit: "USD", value_text: "120000000",
    period_start: "2025-10-01", period_end: "2025-12-31", filed_at: "2026-01-30", form: "10-Q",
    accession: "0001193125-26-000001", reported_decimals: "INF", ...overrides,
  };
}

const prior = (overrides: Partial<CloudCompanyFact> = {}) => fact({
    id: "prior-revenue", value_text: "100000000", period_start: "2024-10-01", period_end: "2024-12-31",
  filed_at: "2026-01-30", accession: "0001193125-26-000001", ...overrides,
});

function filing(overrides: Partial<CloudCompanyFiling> = {}): CloudCompanyFiling {
  return {
    id: "current-filing", cik, accession: "0001193125-26-000001", form: "10-Q", filed_at: "2026-01-30",
    accepted_at: "2026-01-30T15:00:00.000Z",
    primary_document: "aapl-20251231.htm",
    source_url: "https://www.sec.gov/Archives/edgar/data/1193125/000119312526000001/aapl-20251231.htm", ...overrides,
  };
}

describe("cloud SEC company updates", () => {
  it("shows an exact same-metric, same-unit, same-period increase with SEC source links", () => {
    const result = buildCloudCompanyUpdates({ cik, facts: [fact(), prior()], filings: [filing()] });
    expect(result.state).toBe("updates");
    if (result.state !== "updates") return;
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ metric: "Revenue", direction: "increase", precision: "change_exceeds_precision",
      delta: "20000000", percentChange: "20", unit: "USD",
      current: { factId: "current-revenue", value: "120000000", periodEnd: "2025-12-31", sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000119312526000001/aapl-20251231.htm" },
      prior: { factId: "prior-revenue", value: "100000000", periodEnd: "2024-12-31", sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000119312526000001/aapl-20251231.htm" } });
  });

  it("uses the SEC-reported filing date and archive accession when the submissions snapshot omits a row", () => {
    const result = buildCloudCompanyUpdates({ cik, facts: [fact(), prior()], filings: [] });
    expect(result.state).toBe("updates");
    if (result.state !== "updates") return;
    expect(result.updates[0]?.current.sourceUrl).toBe("https://www.sec.gov/Archives/edgar/data/320193/000119312526000001/index.json");
    expect(result.updates[0]?.prior.sourceUrl).toBe("https://www.sec.gov/Archives/edgar/data/320193/000119312526000001/index.json");
  });

  it("withholds direction when the change is within SEC precision or precision is missing", () => {
    const rounded = buildCloudCompanyUpdates({ cik, facts: [fact({ value_text: "1001", reported_decimals: "0" }), prior({ value_text: "1000", reported_decimals: "0" })], filings: [filing()] });
    const missing = buildCloudCompanyUpdates({ cik, facts: [fact({ reported_decimals: null }), prior({ reported_decimals: null })], filings: [filing()] });
    expect(rounded.state).toBe("updates");
    if (rounded.state === "updates") expect(rounded.updates[0]).toMatchObject({ direction: null, precision: "within_reported_precision", percentChange: null });
    expect(missing.state).toBe("updates");
    if (missing.state === "updates") expect(missing.updates[0]).toMatchObject({ direction: null, precision: "reported_values_only", percentChange: null });
  });

  it("does not compare unrelated periods, units, concepts, issuers, or amended forms", () => {
    const variants = [
      prior({ period_start: "2024-09-15", period_end: "2024-12-31" }),
      prior({ unit: "shares" }),
      prior({ concept: "SalesRevenueNet" }),
      prior({ cik: "0000789019" }),
      prior({ form: "10-Q/A" }),
      prior({ period_end: "2024-12-31", period_start: null }),
      prior({ accession: "0000320193-25-000001", filed_at: "2025-01-30" }),
    ];
    for (const oldFact of variants) {
      const result = buildCloudCompanyUpdates({ cik, facts: [fact(), oldFact], filings: [filing()] });
      expect(result.state).toBe("no_comparable_change");
    }
  });

  it("matches a same-filing 52-week fiscal period when dates shift by exactly 364 days", () => {
    const result = buildCloudCompanyUpdates({ cik, facts: [
      fact({ period_start: "2025-03-30", period_end: "2025-06-28", form: "10-Q" }),
      prior({ period_start: "2024-03-31", period_end: "2024-06-29", form: "10-Q" }),
    ], filings: [filing()] });
    expect(result.state).toBe("updates");
    if (result.state === "updates") expect(result.updates[0]).toMatchObject({ direction: "increase", current: { accession: "0001193125-26-000001" }, prior: { accession: "0001193125-26-000001" } });
  });

  it("uses a canonical SEC index when a saved filing URL is not a valid SEC source", () => {
    const result = buildCloudCompanyUpdates({ cik, facts: [fact(), prior()], filings: [filing({ source_url: "https://example.com/not-a-sec-link" })] });
    expect(result.state).toBe("updates");
    if (result.state === "updates") expect(result.updates[0]).toMatchObject({ direction: "increase", current: { sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000119312526000001/index.json" } });
    expect(JSON.stringify(result)).not.toMatch(/bullish|bearish|material/i);
  });

  it("returns an explicit empty state instead of treating missing comparisons as neutral", () => {
    expect(buildCloudCompanyUpdates({ cik, facts: [fact()], filings: [] })).toMatchObject({
      state: "no_comparable_change", reason: expect.stringContaining("does not mean the business did not change"),
    });
  });
});
