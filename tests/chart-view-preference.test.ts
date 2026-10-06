import { describe, expect, it } from "vitest";
import { automaticHistoricalArchiveLookupAction, chartViewPreferenceAfterCompanySelection, deriveChartView, shouldLoadHistoricalJevForVisibleTab, shouldLookupHistoricalJev, shouldRefreshInactiveLunaSnapshot } from "../web/src/lib/chart-view-preference.js";

const matchingZero = {
  companyId: "adbe",
  windowHours: 168,
  status: "ready" as const,
  eligibleObservationCount: 0,
  observedAt: 1_791_222_000_000,
};

describe("chart view preference", () => {
  it("keeps current Luna primary by default and only looks up same-company history after a confirmed zero", () => {
    expect(deriveChartView({ kind: "automatic" })).toBe("luna");
    expect(shouldLookupHistoricalJev({ kind: "automatic" }, matchingZero, "adbe")).toBe(true);
    expect(shouldLookupHistoricalJev({ kind: "automatic" }, matchingZero, "adbe", 24)).toBe(false);
    expect(shouldLookupHistoricalJev({ kind: "automatic" }, { ...matchingZero, eligibleObservationCount: 1 }, "adbe")).toBe(false);
    expect(shouldLookupHistoricalJev({ kind: "automatic" }, { ...matchingZero, status: "failed" }, "adbe")).toBe(false);
    expect(shouldLookupHistoricalJev({ kind: "manual", view: "jev" }, matchingZero, "adbe")).toBe(false);
  });

  it("does not replace a current empty Luna state with an older Jev archive automatically", () => {
    expect(deriveChartView({ kind: "automatic" })).toBe("luna");
    expect(deriveChartView({ kind: "manual", view: "jev" })).toBe("jev");
  });

  it("preserves an explicit choice over automatic fallback conditions", () => {
    const context = {
      companyId: "adbe",
      windowHours: 168,
      categoricalSnapshot: matchingZero,
      historicalJevArchive: { companyId: "adbe", scoredRecordCount: 51 },
    };
    expect(deriveChartView({ kind: "manual", view: "luna" })).toBe("luna");
    expect(deriveChartView({ kind: "manual", view: "jev" })).toBe("jev");
    expect(deriveChartView({ kind: "manual", view: "luna" })).toBe("luna");
    expect(deriveChartView({ kind: "manual", view: "jev" })).toBe("jev");
  });

  it("keeps a manual chart choice for the same company and resets it for a newly selected company", () => {
    const historical = { kind: "manual", view: "jev" } as const;
    expect(chartViewPreferenceAfterCompanySelection(historical, "adbe", "adbe")).toBe(historical);
    const nextCompany = chartViewPreferenceAfterCompanySelection(historical, "adbe", "aapl");
    expect(nextCompany).toEqual({ kind: "automatic" });
    expect(deriveChartView(nextCompany)).toBe("luna");
  });

  it("refreshes the inactive Luna chart while the same company’s historical archive is visible", () => {
    const update = { companyId: "adbe", provider: "openai_luna", classifiedAt: 1_791_222_000_000 };
    expect(shouldRefreshInactiveLunaSnapshot("jev", "adbe", update)).toBe(true);
    expect(shouldRefreshInactiveLunaSnapshot("luna", "adbe", update)).toBe(false);
    expect(shouldRefreshInactiveLunaSnapshot("jev", "aapl", update)).toBe(false);
    expect(shouldRefreshInactiveLunaSnapshot("jev", "adbe", { ...update, provider: "jev" })).toBe(false);
    expect(shouldRefreshInactiveLunaSnapshot("jev", "adbe", { ...update, classifiedAt: null })).toBe(false);
  });

  it("keeps failed Luna reads distinct and permits an explicitly selected historical chart", () => {
    const failedAfterZero = { ...matchingZero, status: "failed" as const };
    expect(deriveChartView({ kind: "automatic" })).toBe("luna");
    expect(deriveChartView({ kind: "manual", view: "jev" })).toBe("jev");
    expect(shouldLookupHistoricalJev({ kind: "automatic" }, failedAfterZero, "adbe")).toBe(false);
  });

  it("bounds archive lookup retries and permits a fresh attempt after backend runtime changes", () => {
    expect(automaticHistoricalArchiveLookupAction("adbe:runtime-1", null, null, { loading: false, failed: false })).toBe("lookup");
    expect(automaticHistoricalArchiveLookupAction("adbe:runtime-1", "adbe:runtime-1", null, { loading: true, failed: false })).toBe("skip");
    expect(automaticHistoricalArchiveLookupAction("adbe:runtime-1", "adbe:runtime-1", null, { loading: false, failed: true })).toBe("retry");
    expect(automaticHistoricalArchiveLookupAction("adbe:runtime-1", "adbe:runtime-1", "adbe:runtime-1", { loading: false, failed: true })).toBe("skip");
    expect(automaticHistoricalArchiveLookupAction("adbe:runtime-2", "adbe:runtime-1", "adbe:runtime-1", { loading: false, failed: true })).toBe("lookup");
    expect(automaticHistoricalArchiveLookupAction("adbe:runtime-1", "adbe:runtime-1", "adbe:runtime-1", { loading: false, failed: false })).toBe("skip");
  });

  it("loads history when the investor explicitly opens an unrequested historical tab, without duplicating known states", () => {
    const request = {
      chartView: "jev" as const,
      companyId: "adbe",
      lookupKey: "adbe:runtime-1",
      attemptedKey: null,
      archive: null,
    };
    expect(shouldLoadHistoricalJevForVisibleTab(request)).toBe(true);
    expect(shouldLoadHistoricalJevForVisibleTab({ ...request, chartView: "luna" })).toBe(false);
    expect(shouldLoadHistoricalJevForVisibleTab({ ...request, companyId: null })).toBe(false);
    expect(shouldLoadHistoricalJevForVisibleTab({ ...request, attemptedKey: request.lookupKey })).toBe(false);
    for (const archive of [
      { companyId: "adbe", loading: true, hasResult: false, confirmedEmpty: false, failed: false },
      { companyId: "adbe", loading: false, hasResult: true, confirmedEmpty: false, failed: false },
      { companyId: "adbe", loading: false, hasResult: false, confirmedEmpty: true, failed: false },
      { companyId: "adbe", loading: false, hasResult: false, confirmedEmpty: false, failed: true },
    ]) {
      expect(shouldLoadHistoricalJevForVisibleTab({ ...request, archive })).toBe(false);
    }
  });
});
