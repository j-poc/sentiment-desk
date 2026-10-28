/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecIssuerDirectoryView } from "../shared/sec-issuer-directory.js";
import { SecVerifiedTradingViewChart, exactSecIssuerMatch } from "../web/src/components/SecVerifiedTradingViewChart.js";

const api = vi.hoisted(() => ({
  getSecIssuerDirectory: vi.fn(),
  refreshSecIssuerDirectory: vi.fn(),
}));
vi.mock("../web/src/lib/api.js", () => api);

const currentDirectory = (entry: { cik: string; ticker: string; exchange: string | null }): SecIssuerDirectoryView => ({
  state: "ready",
  freshness: "current",
  query: entry.ticker,
  rows: [{ ...entry, name: "Apple Inc." }],
  receipt: {
    source: "https://www.sec.gov/files/company_tickers_exchange.json",
    retrievedAt: "2026-10-13T09:00:00.000Z",
    sha256: "a".repeat(64),
    rowCount: 1,
  },
  canRefresh: true,
  nextRefreshAt: null,
  message: null,
});

describe("SEC-verified TradingView chart", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    api.getSecIssuerDirectory.mockReset();
    api.refreshSecIssuerDirectory.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("requires an exact SEC CIK and ticker match before offering the chart", async () => {
    api.getSecIssuerDirectory.mockResolvedValue(currentDirectory({ cik: "0000320193", ticker: "AAPL", exchange: "Nasdaq" }));
    await act(async () => root.render(
      <SecVerifiedTradingViewChart companyId="apple" companyName="Apple" ticker="AAPL" cik="320193" onRefreshFacts={vi.fn()} />,
    ));
    const verify = [...container.querySelectorAll("button")].find((button) => button.textContent === "Verify issuer and prepare chart");
    await act(async () => { await verify!.click(); });

    expect(container.textContent).toContain("CIK 0000320193 · Nasdaq");
    expect(container.textContent).toContain("TradingView supplies this display-only chart");
    expect(container.querySelector("iframe")).toBeNull();
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Load chart from TradingView")!.click(); });
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain('"symbol":"NASDAQ:AAPL"');
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
  });

  it("withholds the chart when the SEC CIK does not match the selected company facts", async () => {
    api.getSecIssuerDirectory.mockResolvedValue(currentDirectory({ cik: "0000789019", ticker: "AAPL", exchange: "Nasdaq" }));
    await act(async () => root.render(
      <SecVerifiedTradingViewChart companyId="apple" companyName="Apple" ticker="AAPL" cik="0000320193" onRefreshFacts={vi.fn()} />,
    ));
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Verify issuer and prepare chart")!.click(); });

    expect(container.textContent).toContain("did not confirm this ticker and CIK together");
    expect(container.textContent).not.toContain("Load chart from TradingView");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("rejects ambiguous or ticker-only SEC mappings", () => {
    const entries = [
      { cik: "0000320193", ticker: "AAPL", name: "Apple Inc.", exchange: "Nasdaq" },
      { cik: "0000789019", ticker: "AAPL", name: "Other Inc.", exchange: "NYSE" },
    ];
    expect(exactSecIssuerMatch(entries, "AAPL", "0000320193")?.exchange).toBe("Nasdaq");
    expect(exactSecIssuerMatch(entries, "AAPL", "0009999999")).toBeNull();
    expect(exactSecIssuerMatch(entries, "MSFT", "0000320193")).toBeNull();
  });

  it("withholds a previously verified chart when the selected issuer changes", async () => {
    api.getSecIssuerDirectory.mockResolvedValue(currentDirectory({ cik: "0000320193", ticker: "AAPL", exchange: "Nasdaq" }));
    await act(async () => root.render(
      <SecVerifiedTradingViewChart companyId="apple" companyName="Apple" ticker="AAPL" cik="0000320193" onRefreshFacts={vi.fn()} />,
    ));
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Verify issuer and prepare chart")!.click(); });
    expect(container.textContent).toContain("CIK 0000320193 · Nasdaq");

    await act(async () => root.render(
      <SecVerifiedTradingViewChart companyId="microsoft" companyName="Microsoft" ticker="MSFT" cik="0000789019" onRefreshFacts={vi.fn()} />,
    ));
    expect(container.textContent).not.toContain("CIK 0000320193");
    expect(container.textContent).not.toContain("Load chart from TradingView");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Verify issuer and prepare chart")).toBe(true);
  });

  it("does not apply a slow SEC identity response after the company changes", async () => {
    let resolveDirectory!: (value: SecIssuerDirectoryView) => void;
    api.getSecIssuerDirectory.mockImplementation(() => new Promise((resolve) => { resolveDirectory = resolve; }));
    await act(async () => root.render(
      <SecVerifiedTradingViewChart companyId="apple" companyName="Apple" ticker="AAPL" cik="0000320193" onRefreshFacts={vi.fn()} />,
    ));
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Verify issuer and prepare chart")!.click(); });
    await act(async () => root.render(
      <SecVerifiedTradingViewChart companyId="microsoft" companyName="Microsoft" ticker="MSFT" cik="0000789019" onRefreshFacts={vi.fn()} />,
    ));
    await act(async () => { resolveDirectory(currentDirectory({ cik: "0000320193", ticker: "AAPL", exchange: "Nasdaq" })); await Promise.resolve(); });
    expect(container.textContent).not.toContain("CIK 0000320193");
    expect(container.textContent).not.toContain("Load chart from TradingView");
  });
});
