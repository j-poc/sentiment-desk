import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SavedPriceHistoryControl } from "../web/src/components/SavedPriceHistoryControl.js";

describe("saved price history control", () => {
  it("stays available beside a populated sentiment chart when the selected comparison window has no prices", () => {
    const now = Date.parse("2026-09-28T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const markup = renderToStaticMarkup(createElement(SavedPriceHistoryControl, {
        comparison: true,
        savedPriceCount: 0,
        latestPriceAt: now - 36 * 60 * 60 * 1000,
        hours: 24,
        onViewHistory: () => undefined,
      }));

      expect(markup).toContain("View 7D saved price history");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not offer history in sentiment-only mode or when no older saved prices exist", () => {
    const now = Date.parse("2026-09-28T08:00:00.000Z");
    const render = (props: { comparison: boolean; savedPriceCount: number; latestPriceAt: number | null }) => renderToStaticMarkup(createElement(SavedPriceHistoryControl, {
      ...props, hours: 24, onViewHistory: () => undefined,
    }));

    expect(render({ comparison: false, savedPriceCount: 0, latestPriceAt: now - 36 * 60 * 60 * 1000 })).toBe("");
    expect(render({ comparison: true, savedPriceCount: 0, latestPriceAt: null })).toBe("");
    expect(render({ comparison: true, savedPriceCount: 2, latestPriceAt: now - 36 * 60 * 60 * 1000 })).toBe("");
  });
});
