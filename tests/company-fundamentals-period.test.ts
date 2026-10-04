import { describe, expect, it } from "vitest";
import { addOneCalendarYear, companyFactsPeriodIdentity, interpretReportedDifference, parseReportedDecimals } from "../server/company-fundamentals.js";

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
