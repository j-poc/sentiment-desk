/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SecFilingResearchCase,
  SecFilingResearchCaseDetail,
  SecFilingResearchFundamentalsView,
} from "../shared/sec-filing-research-cases.js";
import { SecFilingResearchCasePanel } from "../web/src/components/SecFilingResearchCasePanel.js";

const api = vi.hoisted(() => ({
  getCase: vi.fn(),
  verifyIdentity: vi.fn(),
  refreshFacts: vi.fn(),
  saveDecision: vi.fn(),
}));

vi.mock("../web/src/lib/api.js", () => ({
  getSecFilingResearchCase: api.getCase,
  verifySecFilingResearchCaseIdentity: api.verifyIdentity,
  refreshSecFilingResearchCaseFundamentals: api.refreshFacts,
  saveSecFilingResearchCaseDecision: api.saveDecision,
}));

vi.mock("../web/src/components/CompanyFundamentals.js", () => ({
  CompanyFundamentals: (props: { refreshAllowed: boolean; facts: unknown[]; onRefresh: () => void; refreshBlockedReason: string | null }) =>
    createElement("div", { "data-testid": "company-fundamentals", "data-refresh-allowed": String(props.refreshAllowed) },
      createElement("span", null, `SEC facts: ${props.facts.length}`),
      createElement("span", null, props.refreshBlockedReason ?? ""),
      props.refreshAllowed ? createElement("button", { type: "button", onClick: props.onRefresh }, "Refresh SEC facts") : null),
}));

const caseRecord = (status: SecFilingResearchCase["identity"]["status"]): SecFilingResearchCase => ({
  kind: "sec_filing_case",
  id: "case-1",
  cik: "0001786108",
  triggeringAccession: "0001786108-26-000001",
  filingSymbol: "TRIN",
  filingIssuer: "Trinity Capital Inc.",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/1786108/000178610826000001/0001786108-26-000001-index.htm",
  listingProof: {
    retrievedAt: "2026-10-08T12:00:00.000Z",
    directoryCreatedAt: "2026-10-08T11:59:00.000Z",
    sources: [{ source: "Nasdaq", createdAt: "2026-10-08T11:59:00.000Z", retrievedAt: "2026-10-08T12:00:00.000Z" }],
    sha256: "a".repeat(64),
  },
  identity: {
    status,
    ticker: status === "verified" ? "TRIN" : null,
    issuerName: status === "verified" ? "Trinity Capital Inc." : null,
    receipt: status === "verified" ? { url: "https://www.sec.gov/files/company_tickers_exchange.json", retrievedAt: "2026-10-08T12:01:00.000Z", sha256: "b".repeat(64) } : null,
  },
  createdAt: 1_791_441_000_000,
});

function fundamentals(caseId = "case-1", facts: SecFilingResearchFundamentalsView["facts"] = []): SecFilingResearchFundamentalsView {
  return {
    kind: "sec_filing_case_fundamentals",
    caseId,
    state: facts.length ? "ready" : "empty",
    periodComparisonPolicyVersion: "sec-period-comparison/2",
    snapshotId: facts.length ? "snapshot-1" : null,
    facts,
    comparisons: [],
    points: [],
    coverage: facts.length ? ["SEC CompanyFacts"] : [],
    refreshAllowed: true,
    refreshBlockedReason: null,
    lastRefreshError: null,
    staleReason: null,
    latestAttemptAt: null,
    retrievedAt: null,
  };
}

function detail(value: SecFilingResearchCase, facts = fundamentals()): SecFilingResearchCaseDetail {
  return { case: value, fundamentals: facts, brief: null };
}

describe("SEC filing research case panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it("requires a deliberate SEC identity check before requesting or displaying issuer facts", async () => {
    const unverified = detail(caseRecord("unverified"));
    const verified = detail(caseRecord("verified"));
    api.getCase.mockResolvedValueOnce(unverified).mockResolvedValueOnce(verified);
    api.verifyIdentity.mockResolvedValue({ case: verified.case });

    await act(async () => {
      root.render(<SecFilingResearchCasePanel initialCase={unverified.case} onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(api.getCase).toHaveBeenCalledOnce();
    expect(api.verifyIdentity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Confirm this listed ticker against the SEC’s current issuer directory");
    expect(container.textContent).toContain("it does not invoke Luna");
    expect(container.querySelector("[data-testid='company-fundamentals']")?.getAttribute("data-refresh-allowed")).toBe("false");
    expect(container.textContent).toContain("Verify the listed ticker and CIK with SEC first.");
    expect(container.textContent).not.toContain("Save decision");

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Verify with SEC")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.verifyIdentity).toHaveBeenCalledWith("case-1");
    expect(api.getCase).toHaveBeenCalledTimes(2);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Verify with SEC")).toBe(false);
    expect(container.querySelector("[data-testid='company-fundamentals']")?.getAttribute("data-refresh-allowed")).toBe("true");
  });

  it("withholds facts after an identity mismatch until the analyst explicitly rechecks SEC", async () => {
    const mismatched = detail(caseRecord("mismatch"));
    const verified = detail(caseRecord("verified"));
    api.getCase.mockResolvedValueOnce(mismatched).mockResolvedValueOnce(verified);
    api.verifyIdentity.mockResolvedValue({ case: verified.case });

    await act(async () => {
      root.render(<SecFilingResearchCasePanel initialCase={mismatched.case} onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Facts and decisions remain withheld.");
    expect(container.textContent).toContain("the prior receipt will be retained");
    expect(container.textContent).not.toContain("Save decision");
    expect(container.querySelector("[data-testid='company-fundamentals']")?.getAttribute("data-refresh-allowed")).toBe("false");
    expect(api.verifyIdentity).not.toHaveBeenCalled();

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Re-check with SEC")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.verifyIdentity).toHaveBeenCalledWith("case-1");
    expect(api.getCase).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='company-fundamentals']")?.getAttribute("data-refresh-allowed")).toBe("true");
  });
});
