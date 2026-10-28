/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEC_ISSUER_DIRECTORY_URL } from "../shared/sec-issuer-directory.js";
import { SecIssuerDirectory } from "../web/src/components/SecIssuerDirectory.js";

const api = vi.hoisted(() => ({
  getDirectory: vi.fn(), refreshDirectory: vi.fn(), getSubjects: vi.fn(),
  getFundamentals: vi.fn(), getBrief: vi.fn(), refreshFundamentals: vi.fn(), refreshUpdates: vi.fn(), saveSubject: vi.fn(),
}));

vi.mock("../web/src/lib/api.js", () => ({
  getSecIssuerDirectory: api.getDirectory,
  refreshSecIssuerDirectory: api.refreshDirectory,
  getSecIssuerResearchSubjects: api.getSubjects,
  getCompanyFundamentals: api.getFundamentals,
  refreshCompanyFundamentals: api.refreshFundamentals,
  refreshCompanyUpdates: api.refreshUpdates,
  saveSecIssuerResearchSubject: api.saveSubject,
}));
vi.mock("../web/src/components/CompanyFundamentals.js", () => ({ CompanyFundamentals: () => null }));
vi.mock("../web/src/components/CompanyResearchBriefPanel.js", () => ({ CompanyResearchBriefPanel: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function viewFor(query: string) {
  const apple = query.toUpperCase() === "AAPL";
  return {
    state: "ready" as const,
    freshness: "current" as const,
    query,
    rows: query.length < 2 ? [] : [{ cik: apple ? "0000320193" : "0000789019", ticker: apple ? "AAPL" : "MSFT",
      name: apple ? "Apple Inc." : "Microsoft Corporation", exchange: "Nasdaq" }],
    receipt: { source: SEC_ISSUER_DIRECTORY_URL, retrievedAt: new Date().toISOString(), sha256: "a".repeat(64), rowCount: 2 },
    canRefresh: true,
    nextRefreshAt: null,
    message: null,
  };
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("local SEC issuer search", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    api.getDirectory.mockReset();
    api.refreshDirectory.mockReset();
    api.getSubjects.mockReset();
    api.getFundamentals.mockReset();
    api.getBrief.mockReset();
    api.refreshFundamentals.mockReset();
    api.refreshUpdates.mockReset();
    api.saveSubject.mockReset();
    api.getDirectory.mockImplementation(async (query: string) => viewFor(query));
    api.getSubjects.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps rows aligned with the latest query when a directory refresh finishes late", async () => {
    const refreshResponse = deferred<{ receipt: { retrievedAt: string } | null }>();
    api.refreshDirectory.mockReturnValue(refreshResponse.promise);
    await act(async () => {
      root.render(<SecIssuerDirectory />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });

    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      setValue(input, "AAPL");
      await new Promise((resolve) => setTimeout(resolve, 190));
    });
    expect(container.textContent).toContain("Apple Inc.");

    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "Update company list")!;
    await act(async () => refresh.click());
    await act(async () => {
      setValue(input, "MSFT");
      await new Promise((resolve) => setTimeout(resolve, 190));
    });
    const search = container.querySelector<HTMLElement>("[aria-labelledby='sec-issuer-search-heading']")!;
    expect(search.textContent).toContain("Microsoft Corporation");

    await act(async () => {
      refreshResponse.resolve({ receipt: { retrievedAt: new Date().toISOString() } });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(input.value).toBe("MSFT");
    expect(search.textContent).toContain("Microsoft Corporation");
    expect(search.textContent).not.toContain("Apple Inc. AAPL");
  });

  it("uses the query-owned initial read so a delayed bootstrap cannot overwrite a later search", async () => {
    const initialRead = deferred<ReturnType<typeof viewFor>>();
    api.getDirectory.mockImplementation((query: string) => query === "" ? initialRead.promise : Promise.resolve(viewFor(query)));

    await act(async () => {
      root.render(<SecIssuerDirectory />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });

    expect(api.getDirectory).toHaveBeenCalledTimes(1);
    expect(api.getDirectory).toHaveBeenCalledWith("", expect.any(AbortSignal));
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input.disabled).toBe(true);

    await act(async () => {
      initialRead.resolve(viewFor(""));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input.disabled).toBe(false);

    await act(async () => {
      setValue(input, "MSFT");
      await new Promise((resolve) => setTimeout(resolve, 190));
    });
    const search = container.querySelector<HTMLElement>("[aria-labelledby='sec-issuer-search-heading']")!;
    expect(search.textContent).toContain("Microsoft Corporation");
    expect(search.textContent).not.toContain("Apple Inc. AAPL");
  });

  it("clears automatic-refresh busy state when a retry restarts the directory query", async () => {
    let directoryReady = false;
    const savedSubjects = deferred<never[]>();
    const autoRefresh = deferred<{ receipt: { retrievedAt: string } | null }>();
    api.getSubjects.mockReturnValue(savedSubjects.promise);
    api.getDirectory.mockImplementation(async (query: string) => {
      if (query === "" && !directoryReady) return { ...viewFor(""), state: "not_loaded", freshness: "unknown", receipt: null, canRefresh: true };
      return viewFor(query);
    });
    api.refreshDirectory.mockReturnValue(autoRefresh.promise);

    await act(async () => {
      root.render(<SecIssuerDirectory />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(api.refreshDirectory).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Updating company list…")).toBe(true);

    await act(async () => { savedSubjects.reject(new Error("saved read failed")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry saved issuer reads")!;
    await act(async () => retry.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(api.refreshDirectory).toHaveBeenCalledTimes(1);

    directoryReady = true;
    await act(async () => { autoRefresh.resolve({ receipt: { retrievedAt: new Date().toISOString() } }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    const updateButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Update company list");
    expect(updateButton).toBeDefined();
    expect(updateButton!.disabled).toBe(false);
  });

  it("shows a read failure instead of a false no-match result and recovers on retry", async () => {
    let failSearch = true;
    api.getDirectory.mockImplementation(async (query: string) => {
      if (query === "ZZZ" && failSearch) { failSearch = false; throw new Error("directory read failed"); }
      return viewFor(query);
    });
    await act(async () => {
      root.render(<SecIssuerDirectory />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { setValue(input, "ZZZ"); await new Promise((resolve) => setTimeout(resolve, 190)); });
    const search = container.querySelector<HTMLElement>("[aria-labelledby='sec-issuer-search-heading']")!;
    expect(search.textContent).toContain("Company search could not finish");
    expect(search.textContent).not.toContain("No matching company was found");

    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry saved issuer reads")!;
    await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(search.textContent).toContain("Microsoft Corporation");
    expect(search.textContent).not.toContain("Company search could not finish");
  });

  it("does not open a company after a pending save resolves after unmount", async () => {
    const pendingSave = deferred<any>();
    api.saveSubject.mockReturnValue(pendingSave.promise);
    const onOpenCompany = vi.fn();
    await act(async () => {
      root.render(<SecIssuerDirectory onOpenCompany={onOpenCompany} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { setValue(input, "AAPL"); await new Promise((resolve) => setTimeout(resolve, 190)); });
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load company Desk")!;
    await act(async () => save.click());
    expect(api.saveSubject).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    pendingSave.resolve({ item: { companyId: "sec-0000320193" } });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onOpenCompany).not.toHaveBeenCalled();
  });

  it("keeps a stale ticker match in CIK-scoped SEC research when saved facts identify another issuer", async () => {
    api.getFundamentals.mockResolvedValue({ facts: [{ cik: "0000789019" }] });
    api.saveSubject.mockResolvedValue({ item: { companyId: "sec-0000320193" } });
    const onOpenCompany = vi.fn();
    await act(async () => {
      root.render(<SecIssuerDirectory companies={[{ id: "desk-apple", name: "Old Apple", ticker: "AAPL" }]} onOpenCompany={onOpenCompany} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { setValue(input, "AAPL"); await new Promise((resolve) => setTimeout(resolve, 190)); });
    const open = [...container.querySelectorAll("button")].find((button) => button.textContent === "Open company research")!;
    await act(async () => { open.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(api.getFundamentals).toHaveBeenCalledWith("desk-apple");
    expect(onOpenCompany).not.toHaveBeenCalledWith("desk-apple");
    expect(onOpenCompany).toHaveBeenCalledWith("sec-0000320193");
    expect(api.saveSubject).toHaveBeenCalledWith(expect.objectContaining({ cik: "0000320193", ticker: "AAPL" }));
  });

  it("opens a ticker-matched Desk only when its saved CompanyFacts CIK matches the SEC result", async () => {
    api.getFundamentals.mockResolvedValue({ facts: [{ cik: "0000320193" }, { cik: "0000320193" }] });
    const onOpenCompany = vi.fn();
    await act(async () => {
      root.render(<SecIssuerDirectory companies={[{ id: "desk-apple", name: "Apple Inc.", ticker: "AAPL" }]} onOpenCompany={onOpenCompany} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { setValue(input, "AAPL"); await new Promise((resolve) => setTimeout(resolve, 190)); });
    const open = [...container.querySelectorAll("button")].find((button) => button.textContent === "Open company research")!;
    await act(async () => { open.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(onOpenCompany).toHaveBeenCalledOnce();
    expect(onOpenCompany).toHaveBeenCalledWith("desk-apple");
    expect(api.saveSubject).not.toHaveBeenCalled();
  });
});
