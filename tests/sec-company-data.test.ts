import { describe, expect, it } from "vitest";
import { parse as parseLosslessJson } from "lossless-json";
import {
  parseSecCompanyFacts,
  parseSecSubmissions,
  SecCompanyDataParseError,
} from "../supabase/functions/_shared/sec-company-data.js";

describe("SEC company data adapters", () => {
  it("keeps bounded, issuer-matched reported research facts with source periods and filing identity", () => {
    const body = {
      cik: 320193,
      entityName: "Example Issuer",
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: [
            { val: 100, start: "2024-01-01", end: "2024-12-31", filed: "2025-02-01", form: "10-K", accn: "0000320193-25-000001", fy: 2024, fp: "FY", dec: "-6", frame: "CY2024" },
            { val: 90, start: "2023-01-01", end: "2023-12-31", filed: "2024-02-01", form: "10-K", accn: "0000320193-24-000001", fy: 2023, fp: "FY", dec: "-6" },
            { val: 1, start: "2024-01-01", end: "2024-03-31", filed: "2025-05-01", form: "8-K", accn: "0000320193-25-000002" },
          ] } },
          Assets: { units: { USD: [{ val: 50, end: "2024-12-31", filed: "2025-02-01", form: "10-K", accn: "0000320193-25-000001" }] } },
        },
      },
    };
    const facts = parseSecCompanyFacts(body, "0000320193");
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ cik: "0000320193", concept: "Revenues", value_text: "100", period_start: "2024-01-01",
      period_end: "2024-12-31", filed_at: "2025-02-01", accession: "0000320193-25-000001", fiscal_year: 2024,
      fiscal_period: "FY", reported_decimals: "-6", frame: "CY2024" });
  });

  it("rejects a mismatched issuer, impossible dates, empty concepts, and malformed top-level shape", () => {
    expect(() => parseSecCompanyFacts({ cik: 320194, facts: {} }, "0000320193"))
      .toThrowError(SecCompanyDataParseError);
    expect(() => parseSecCompanyFacts({ cik: 320193, facts: { "us-gaap": { Revenues: { units: { USD: [
      { val: 1, start: "2023-02-29", end: "2024-01-01", filed: "2024-02-01", form: "10-K", accn: "0000320193-24-000001" },
    ] } } } } }, "0000320193")).toThrowError("companyfacts_no_supported_research_facts");
    expect(() => parseSecCompanyFacts([], "0000320193")).toThrowError("companyfacts_shape_invalid");
    expect(parseSecCompanyFacts({ cik: 1786108, facts: { "us-gaap": { Revenues: { units: { USD: [
      { val: 1, end: "2024-12-31", filed: "2025-02-01", form: "10-K", accn: "0001193125-25-000001" },
    ] } } } } }, "0001786108")).toHaveLength(1);
  });

  it("preserves exact numeric tokens from SEC JSON", () => {
    const body = parseLosslessJson('{"cik":320193,"facts":{"us-gaap":{"Revenues":{"units":{"USD":[{"val":9007199254740993,"end":"2024-12-31","filed":"2025-02-01","form":"10-K","accn":"0000320193-25-000001"}]}}}}}');
    expect(parseSecCompanyFacts(body, "0000320193")[0]?.value_text).toBe("9007199254740993");
  });

  it("maps recent SEC submissions by accession with report, accepted, retrieval-source, and filing times", () => {
    const filings = parseSecSubmissions({ cik: 320193, filings: { recent: {
      accessionNumber: ["0000320193-26-000001", "0000320193-26-000002"],
      form: ["10-K", "8-K"], filingDate: ["2026-02-01", "2026-03-02"],
      reportDate: ["2025-12-31", "2026-02-27"], acceptanceDateTime: ["2026-02-01T20:00:00.000Z", "2026-03-02T18:00:00.000Z"],
      primaryDocument: ["annual-report.htm", "current-report.htm"],
    } } }, "0000320193");
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({ cik: "0000320193", accession: "0000320193-26-000001", form: "10-K",
      filed_at: "2026-02-01", report_period: "2025-12-31", accepted_at: "2026-02-01T20:00:00.000Z",
      primary_document: "annual-report.htm", source_url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/annual-report.htm" });
  });

  it("uses the response issuer CIK for the archive path even when the accession prefix differs", () => {
    const filings = parseSecSubmissions({ cik: 1786108, filings: { recent: {
      accessionNumber: ["0001193125-26-418097"], form: ["8-K"], filingDate: ["2026-10-08"],
      reportDate: ["2026-10-08"], acceptanceDateTime: ["2026-10-09T01:30:13.000Z"],
      primaryDocument: ["trin-20261008.htm"],
    } } }, "0001786108");
    expect(filings[0]).toMatchObject({ cik: "0001786108", accession: "0001193125-26-418097",
      source_url: "https://www.sec.gov/Archives/edgar/data/1786108/000119312526418097/trin-20261008.htm" });
  });

  it("rejects submissions when the response CIK differs or parallel recent arrays are misaligned", () => {
    const recent = { accessionNumber: ["0000320193-26-000001"], form: ["10-K"], filingDate: ["2026-02-01"],
      reportDate: ["2025-12-31"], acceptanceDateTime: ["2026-02-01T20:00:00.000Z"], primaryDocument: ["annual-report.htm"] };
    expect(() => parseSecSubmissions({ cik: 320194, filings: { recent } }, "0000320193"))
      .toThrowError("submissions_cik_mismatch");
    expect(() => parseSecSubmissions({ cik: 320193, filings: { recent: { ...recent, form: [] } } }, "0000320193"))
      .toThrowError("submissions_recent_fields_misaligned");
  });
});
