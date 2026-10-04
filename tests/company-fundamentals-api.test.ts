import { afterEach, describe, expect, it, vi } from "vitest";
import { getCompanyFundamentals, isCurrentCompanySelection, refreshCompanyFundamentals } from "../web/src/lib/api.js";
import type { CompanyFundamentalsView, FundamentalRefreshResult } from "../shared/company-fundamentals.js";

const emptyView = (companyId: string): CompanyFundamentalsView => ({
  companyId, state: "empty", snapshotId: null, facts: [], comparisons: [], points: [], coverage: [],
  refreshAllowed: false, refreshBlockedReason: "SEC refresh is not enabled.", lastRefreshError: null,
  staleReason: null, latestAttemptAt: null, retrievedAt: null,
});

afterEach(() => vi.unstubAllGlobals());

describe("company fundamentals API integration", () => {
  it("loads only the saved view with an abortable GET", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(emptyView("issuer/one")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(getCompanyFundamentals("issuer/one", controller.signal)).resolves.toMatchObject({ companyId: "issuer/one", facts: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/companies/issuer%2Fone/fundamentals");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("sends refresh only through an explicit POST with the stable idempotency key", async () => {
    const result: FundamentalRefreshResult = { ...emptyView("issuer-one"), refresh: "completed" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCompanyFundamentals("issuer-one", "request-key-1")).resolves.toMatchObject({ refresh: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/companies/issuer-one/fundamentals/refresh");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ requestKey: "request-key-1" }) });
  });

  it("rejects a delayed prior-company response from the active selection", () => {
    // Selection A starts a request, then the user selects B before A resolves.
    const responseCompanyId = "company-a";
    const selectedCompanyId = "company-b";
    expect(isCurrentCompanySelection(responseCompanyId, selectedCompanyId)).toBe(false);
    expect(isCurrentCompanySelection("company-b", selectedCompanyId)).toBe(true);
    expect(isCurrentCompanySelection("company-b", null)).toBe(false);
  });
});
