// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoricalTrendChart } from "../web/src/components/CategoricalTrendChart.js";

vi.mock("../web/src/lib/api.js", () => ({
  getCategoricalBucket: vi.fn(),
  getCategoricalTrend: vi.fn(() => new Promise(() => {})),
  getGoogleGeminiCategoricalTrend: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../web/src/components/MentionFeed.js", () => ({ MentionFeed: () => null }));

describe("sentiment provider choice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let preferenceStorage: Map<string, string>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    preferenceStorage = new Map();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => preferenceStorage.get(key) ?? null,
      setItem: (key: string, value: string) => preferenceStorage.set(key, value),
    } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("defaults to Luna and keeps the explicit provider choice across company remounts", async () => {
    const renderChart = (companyId: string, hours: number) => createElement(CategoricalTrendChart, {
      key: companyId,
      companyId,
      hours,
      active: true,
      classifierEnabled: false,
      onOpenMention: vi.fn(),
      onViewHistoricalJev: vi.fn(),
      onReviewSourceRecords: vi.fn(),
      onSnapshot: vi.fn(),
      historicalJevSummary: "",
    });

    await act(async () => root.render(renderChart("apple", 6)));
    const lane = () => container.querySelector('[aria-label="Sentiment classifier lane"]')!;
    const buttonFor = (provider: string) => [...lane().querySelectorAll("button")].find((button) => button.textContent?.includes(provider))!;
    const lunaButton = () => buttonFor("GPT-6 Luna");
    const geminiButton = () => buttonFor("Gemini 3.8 Flash");

    expect(lunaButton().getAttribute("aria-pressed")).toBe("true");
    await act(async () => geminiButton().click());
    expect(geminiButton().getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.render(renderChart("amd", 24)));
    expect(geminiButton().getAttribute("aria-pressed")).toBe("true");
    await act(async () => lunaButton().click());
    expect(lunaButton().getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.render(renderChart("apple", 24)));
    expect(lunaButton().getAttribute("aria-pressed")).toBe("true");
  });
});
