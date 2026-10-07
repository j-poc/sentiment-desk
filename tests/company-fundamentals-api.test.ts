import { afterEach, describe, expect, it, vi } from "vitest";
import { getCompanyFundamentals, getCompanySavedHistoryPage, isCurrentCompanySelection, refreshCompanyFundamentals } from "../web/src/lib/api.js";
import type { MentionPage } from "../web/src/lib/api.js";
import type { CompanyFundamentalsView, FundamentalRefreshResult } from "../shared/company-fundamentals.js";

const emptyView = (companyId: string): CompanyFundamentalsView => ({
  companyId, state: "empty", periodComparisonPolicyVersion: "sec-period-comparison/2",
  snapshotId: null, facts: [], comparisons: [], points: [], coverage: [],
  refreshAllowed: false, refreshBlockedReason: "SEC refresh is not enabled.", lastRefreshError: null,
  staleReason: null, latestAttemptAt: null, retrievedAt: null,
});

afterEach(() => vi.unstubAllGlobals());

describe("company fundamentals API integration", () => {
  it("reads retained company history with an optional cursor through GET only", async () => {
    const page: MentionPage = { items: [], nextCursor: { orderAt: 123, ingestedAt: 124, id: "row-1" }, setAsideCount: 0, issuerIdentityReviewCount: 0 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(page), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cursor = { orderAt: 125, ingestedAt: 126, id: "row/2" };
    const controller = new AbortController();

    await expect(getCompanySavedHistoryPage("issuer/one", cursor, controller.signal)).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/companies/issuer%2Fone/mentions-page?filter=history&limit=100&includeDismissed=true&cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

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
