/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudTradingViewChart, tradingViewEmbedDocument, tradingViewSymbol } from "../web/src/components/CloudTradingViewChart.js";

describe("cloud stock chart source boundary", () => {
  it("maps only supported SEC exchange labels and safe tickers", () => {
    expect(tradingViewSymbol("aapl", "Nasdaq")).toBe("NASDAQ:AAPL");
    expect(tradingViewSymbol("BRK.B", "NYSE")).toBe("NYSE:BRK.B");
    expect(tradingViewSymbol("BRK-B", "NYSE")).toBe("NYSE:BRK.B");
    expect(tradingViewSymbol("UEC", "NYSE MKT")).toBe("AMEX:UEC");
    expect(tradingViewSymbol("ABC", "NYSE Arca")).toBeNull();
    expect(tradingViewSymbol("ABC", "Unverified Exchange")).toBeNull();
    expect(tradingViewSymbol("AAPL<script>", "Nasdaq")).toBeNull();
    expect(tradingViewSymbol("AAPL", null)).toBeNull();
  });

  it("builds an isolated, attributed embed for the selected symbol only", () => {
    const html = tradingViewEmbedDocument("NASDAQ:AAPL");
    expect(html).toContain('"symbol":"NASDAQ:AAPL"');
    expect(html).toContain('"range":"12M"');
    expect(html).toContain('https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js');
    expect(html).toContain("AAPL chart");
    expect(html).toContain("by TradingView");
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(() => tradingViewEmbedDocument('NASDAQ:AAPL</script><script>alert(1)</script>')).toThrow("Unsupported TradingView symbol.");
  });

  it("waits for the user to load TradingView and never loads it for unsupported identity", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await act(async () => { root.render(<CloudTradingViewChart ticker="AAPL" exchange="Nasdaq" companyName="Apple Inc." />); });
      expect(container.textContent).toContain("exchange-delayed, not real time");
      expect(container.textContent).toContain("page URL too");
      expect(container.querySelector("iframe")).toBeNull();
      await act(async () => { container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("NASDAQ:AAPL");
      await act(async () => { root.render(<CloudTradingViewChart ticker="BAD" exchange="Unverified Exchange" companyName="Unsupported Inc." />); });
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.textContent).toContain("A stock chart is unavailable");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      error.mockRestore();
    }
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});
