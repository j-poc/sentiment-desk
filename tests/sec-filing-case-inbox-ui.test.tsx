/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import type { SecFilingResearchCase } from "../shared/sec-filing-research-cases.js";
import { hasFreshListingEvidence, SecFilingsInbox } from "../web/src/components/SecFilingsInbox.js";

const api = vi.hoisted(() => ({
  getInbox: vi.fn(),
  getTasks: vi.fn(),
  getCases: vi.fn(),
  createCase: vi.fn(),
  getCase: vi.fn(),
  activate: vi.fn(),
  inspect: vi.fn(),
  removeTask: vi.fn(),
  saveTask: vi.fn(),
}));

vi.mock("../web/src/lib/api.js", () => ({
  getSecFilingsInbox: api.getInbox,
  getSecFilingResearchTasks: api.getTasks,
  getSecFilingResearchCases: api.getCases,
  createSecFilingResearchCase: api.createCase,
  getSecFilingResearchCase: api.getCase,
  activateSecFilingsInbox: api.activate,
  inspectSecFiling: api.inspect,
  removeSecFilingResearchTask: api.removeTask,
  saveSecFilingResearchTask: api.saveTask,
}));

vi.mock("../web/src/components/SecFilingResearchCasePanel.js", () => ({
  SecFilingResearchCasePanel: ({ initialCase }: { initialCase: SecFilingResearchCase }) =>
    <section data-testid="opened-case">{initialCase.id} · {initialCase.cik} · {initialCase.triggeringAccession}</section>,
}));

function caseRecord(): SecFilingResearchCase {
  const now = new Date().toISOString();
  return {
    kind: "sec_filing_case", id: "saved-case-1", cik: "0001786108", triggeringAccession: "0001786108-26-000001",
    filingSymbol: "TRIN", filingIssuer: "Trinity Capital Inc.",
    filingUrl: "https://www.sec.gov/Archives/edgar/data/1786108/000178610826000001/0001786108-26-000001-index.htm",
    listingProof: { retrievedAt: now, directoryCreatedAt: now,
      sources: ["nasdaqlisted.txt", "otherlisted.txt"].map((source) => ({ source, createdAt: now, retrievedAt: now })), sha256: "a".repeat(64) },
    identity: { status: "unverified", ticker: null, issuerName: null, receipt: null }, createdAt: Date.now(),
  };
}

function inbox(stale = false): SecFilingsInboxView {
  const now = Date.now();
  const iso = (value: number) => new Date(value).toISOString();
  const retrievedAt = iso(now - (stale ? 25 : 1) * 60_000);
  const directoryCreatedAt = iso(now - (stale ? 25 * 60 : 1) * 60_000);
  const directories = [
    { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", createdAt: directoryCreatedAt, retrievedAt },
    { source: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", createdAt: directoryCreatedAt, retrievedAt },
  ];
  const row = {
    cik: "0001786108", accession: "0001786108-26-000001", form: "8-K" as const,
    issuer: "Trinity Capital Inc.",
    filingUrl: "https://www.sec.gov/Archives/edgar/data/1786108/000178610826000001/0001786108-26-000001-index.htm",
    filedOn: iso(now), acceptedAt: iso(now), feedPublishedAt: null, feedUpdatedAt: iso(now - 1_000),
    listing: { symbol: "TRIN", exchange: "Nasdaq" as const, securityName: "Trinity Capital Inc. - Common Stock",
      directoryCreatedAt, directoryRetrievedAt: retrievedAt,
      directories },
  };
  return {
    state: "ready", freshness: stale ? "stale" : "current", rows: [row], receiptId: "real-sec-receipt",
    retrievedAt: iso(now - 1_000), feedUpdatedAt: iso(now - 1_000), jobStatus: "succeeded",
    canActivate: true, nextRefreshAt: null, message: null,
    listingDirectoryCreatedAt: directoryCreatedAt,
    listingDirectoryRetrievedAt: retrievedAt,
    listingDirectories: directories,
  };
}

describe("current SEC filing to research-case UI path", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.getTasks.mockResolvedValue([]);
    api.getCases.mockResolvedValue([]);
    api.getCase.mockResolvedValue({ case: caseRecord(), fundamentals: null, brief: null });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it("opens a case from one exact current, listed SEC accession", async () => {
    const view = inbox();
    expect(hasFreshListingEvidence(view, Date.now())).toBe(true);
    const saved = caseRecord();
    api.getInbox.mockResolvedValue(view);
    api.createCase.mockResolvedValue({ case: saved, created: true });

    await act(async () => {
      root.render(<SecFilingsInbox />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const action = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Start SEC research case");
    expect(action?.disabled).toBe(false);

    await act(async () => {
      action!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(api.createCase).toHaveBeenCalledOnce();
    expect(api.createCase).toHaveBeenCalledWith("0001786108", "0001786108-26-000001");
    expect(container.querySelector("[data-testid='opened-case']")?.textContent)
      .toBe("saved-case-1 · 0001786108 · 0001786108-26-000001");
  });

  it("keeps case creation disabled when current listing proof is stale", async () => {
    api.getInbox.mockResolvedValue(inbox(true));

    await act(async () => {
      root.render(<SecFilingsInbox />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const action = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Start SEC research case");
    expect(action?.disabled).toBe(true);
    expect(api.createCase).not.toHaveBeenCalled();
  });
});
