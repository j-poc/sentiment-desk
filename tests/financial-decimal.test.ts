import { describe, expect, it } from "vitest";
import { decimalComparison, exactDecimalIsPositive, interpretReportedDifference, normalizeExactDecimal } from "../shared/financial-decimal.js";

describe("shared financial decimal calculations", () => {
  it("normalizes exponent values without converting through binary floating point", () => {
    expect(normalizeExactDecimal("1.2300e3")).toBe("1230");
    expect(normalizeExactDecimal("-0.000e9")).toBe("0");
    expect(normalizeExactDecimal("1e999")).toBeNull();
  });

  it("calculates exact change and withholds percentages for non-positive prior values", () => {
    expect(decimalComparison("12345678901234567890.25", "12345678901234567800.25"))
      .toEqual({ delta: "90", percentChange: "0" });
    expect(decimalComparison("-2", "0")).toEqual({ delta: "-2", percentChange: null });
    expect(exactDecimalIsPositive("0")).toBe(false);
    expect(exactDecimalIsPositive("bad")).toBeNull();
  });

  it("uses both SEC precision quanta before assigning a direction", () => {
    expect(interpretReportedDifference("1", "0", "0")).toBe("within_reported_precision");
    expect(interpretReportedDifference("3", "0", "0")).toBe("change_exceeds_precision");
    expect(interpretReportedDifference("0", "INF", "INF")).toBe("no_reported_difference");
  });
});
