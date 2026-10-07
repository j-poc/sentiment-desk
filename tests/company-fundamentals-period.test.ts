import { describe, expect, it } from "vitest";
import { addOneCalendarYear, classifyPeriodAlignment, companyFactsPeriodIdentity, interpretReportedDifference, parseReportedDecimals, type FundamentalPeriodFact } from "../server/company-fundamentals.js";

const applePeriod = (overrides: Partial<FundamentalPeriodFact>): FundamentalPeriodFact => ({
  companyId: "apple",
  cik: "0000320193",
  metric: "revenue",
  taxonomy: "us-gaap",
  concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
  unit: "USD",
  startDate: "2025-03-30",
  endDate: "2025-06-28",
  durationClass: "quarter",
  form: "10-Q",
  accession: "0000320193-26-000020",
  acceptedAt: Date.UTC(2026, 6, 30, 20, 11),
  amended: false,
  ...overrides,
});

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe("SEC reported-period metadata", () => {
  it("identifies a fact period from its dates rather than report fiscal-focus metadata", () => {
    const period = {
      metric: "revenue" as const,
      taxonomy: "us-gaap",
      concept: "Revenues",
      unit: "USD",
      startDate: "2023-01-01",
      endDate: "2023-12-31",
      durationClass: "annual" as const,
    };
    const filedUnder2023Focus = { ...period, filingFocusYear: 2023, filingFocusPeriod: "FY" };
    const filedUnder2024Focus = { ...period, filingFocusYear: 2024, filingFocusPeriod: "FY" };
    expect(companyFactsPeriodIdentity(filedUnder2023Focus)).toBe(companyFactsPeriodIdentity(filedUnder2024Focus));
  });

  it("uses exact calendar windows and clamps leap day to the final day of February", () => {
    expect(addOneCalendarYear("2024-02-29")).toBe("2025-02-28");
    expect(addOneCalendarYear("2024-09-28")).toBe("2025-09-28");
    expect(addOneCalendarYear("2024-09-28")).not.toBe("2025-09-27");
    expect(addOneCalendarYear(null)).toBeNull();
  });

  it("matches Apple's reported same-filing 13-week period when both dates shift exactly 52 weeks", () => {
    const prior = applePeriod({ startDate: "2025-03-30", endDate: "2025-06-28" });
    const current = applePeriod({ startDate: "2026-03-29", endDate: "2026-06-27" });
    expect(classifyPeriodAlignment(prior, current)).toBe("same_filing_52_week");
    expect(prior.accession).toBe(current.accession);
  });

  it("matches Apple's reported 39-week year-to-date periods without using filing focus metadata", () => {
    const prior = applePeriod({
      startDate: "2024-09-29", endDate: "2025-06-28", durationClass: "ytd_q3",
      form: "10-Q", accession: "0000320193-26-000020",
    });
    const current = applePeriod({
      startDate: "2025-09-28", endDate: "2026-06-27", durationClass: "ytd_q3",
      form: "10-Q", accession: "0000320193-26-000020",
    });
    expect(classifyPeriodAlignment(prior, current)).toBe("same_filing_52_week");
  });

  it("retains exact calendar-anniversary matching", () => {
    const prior = applePeriod({ startDate: "2025-03-01", endDate: "2025-05-31" });
    const current = applePeriod({ startDate: "2026-03-01", endDate: "2026-05-31" });
    expect(classifyPeriodAlignment(prior, current)).toBe("calendar_anniversary");
  });

  it("accepts an exact 53-week boundary shift but rejects other and asymmetric shifts", () => {
    const prior = applePeriod({ startDate: "2025-03-30", endDate: "2025-06-28" });
    const current53Week = applePeriod({
      startDate: shiftDate(prior.startDate!, 371), endDate: shiftDate(prior.endDate, 371),
    });
    expect(classifyPeriodAlignment(prior, current53Week)).toBe("same_filing_53_week");

    const current363Day = applePeriod({
      startDate: shiftDate(prior.startDate!, 363), endDate: shiftDate(prior.endDate, 363),
    });
    expect(classifyPeriodAlignment(prior, current363Day)).toBeNull();

    const asymmetric = applePeriod({
      startDate: shiftDate(prior.startDate!, 364), endDate: shiftDate(prior.endDate, 365),
    });
    expect(classifyPeriodAlignment(prior, asymmetric)).toBeNull();
  });

  it("withholds annual matches with a seven-day gap despite a 53-week date shift", () => {
    const prior = applePeriod({
      startDate: "2024-10-06", endDate: "2025-10-04", durationClass: "annual", form: "10-K",
      accession: "0000320193-26-000020",
    });
    const current = applePeriod({
      startDate: "2025-10-12", endDate: "2026-10-10", durationClass: "annual", form: "10-K",
      accession: "0000320193-26-000020",
    });
    expect(classifyPeriodAlignment(prior, current)).toBeNull();
  });

  it("withholds cross-issuer, cross-filing, concept, unit, duration, acceptance, and amended rows", () => {
    const prior = applePeriod({ startDate: "2025-03-30", endDate: "2025-06-28" });
    const current = applePeriod({ startDate: "2026-03-29", endDate: "2026-06-27" });
    const ineligible: Partial<FundamentalPeriodFact>[] = [
      { companyId: "other-company" },
      { cik: "0000000001" },
      { metric: "net_income" },
      { taxonomy: "custom" },
      { concept: "OtherRevenue" },
      { unit: "EUR" },
      { durationClass: "ytd_q3" },
      { form: "10-K" },
      { accession: "0000320193-26-000021" },
      { acceptedAt: current.acceptedAt! + 1 },
      { amended: true },
    ];
    for (const change of ineligible) {
      expect(classifyPeriodAlignment(applePeriod(change), current)).toBeNull();
    }
  });

  it("preserves declared SEC precision and represents absent or malformed metadata honestly", () => {
    expect(parseReportedDecimals("-6")).toEqual({ value: "-6", status: "declared" });
    expect(parseReportedDecimals("INF")).toEqual({ value: "INF", status: "declared" });
    expect(parseReportedDecimals(null)).toEqual({ value: null, status: "missing" });
    expect(parseReportedDecimals("19")).toEqual({ value: null, status: "invalid" });
    expect(parseReportedDecimals("1.5")).toEqual({ value: null, status: "invalid" });
  });

  it("withholds directional changes within the full SEC precision bound", () => {
    expect(interpretReportedDifference("2000000", "-6", "-6")).toBe("within_reported_precision");
    expect(interpretReportedDifference("-2000000", "-6", "-6")).toBe("within_reported_precision");
    expect(interpretReportedDifference("2000001", "-6", "-6")).toBe("change_exceeds_precision");
    expect(interpretReportedDifference("1.001", "-3", "-6")).toBe("within_reported_precision");
    expect(interpretReportedDifference("0", "INF", "INF")).toBe("no_reported_difference");
    expect(interpretReportedDifference("0.01", "INF", "INF")).toBe("change_exceeds_precision");
    expect(interpretReportedDifference("1", "unknown", "0")).toBeNull();
  });
});
