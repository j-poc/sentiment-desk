import { describe, expect, it, vi } from "vitest";
import { historicalJevRevealTarget, revealScrollTarget } from "../web/src/lib/reveal-scroll-target.js";

function surface(targetTop: number, targetHeight: number) {
  const scrollBy = vi.fn();
  const region = {
    clientHeight: 600,
    clientTop: 0,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollBy,
  };
  const target = {
    getBoundingClientRect: () => ({ top: targetTop, bottom: targetTop + targetHeight, height: targetHeight }),
  };
  return { region, target, scrollBy };
}

describe("revealScrollTarget", () => {
  it("prefers the historical chart over an earlier status notice", () => {
    const chart = {} as HTMLElement;
    const emptyState = {} as HTMLElement;
    const panel = {
      querySelector: (selector: string) => selector === "#historical-jev-chart" ? chart
        : selector === "[data-historical-jev-empty-state]" ? emptyState : null,
    } as unknown as ParentNode;
    expect(historicalJevRevealTarget(panel)).toBe(chart);
  });

  it("reveals the empty-state recovery action when no Jev chart exists", () => {
    const emptyState = {} as HTMLElement;
    const panel = {
      querySelector: (selector: string) => selector === "[data-historical-jev-empty-state]" ? emptyState : null,
    } as unknown as ParentNode;
    expect(historicalJevRevealTarget(panel)).toBe(emptyState);
  });

  it("keeps a valid navigation target while the archive chart is loading", () => {
    const navigation = {} as HTMLElement;
    const panel = {
      querySelector: (selector: string) => selector === '[aria-label="Saved Jev history navigation"]' ? navigation : null,
    } as unknown as ParentNode;
    expect(historicalJevRevealTarget(panel)).toBe(navigation);
  });

  it("scrolls a clipped panel to the top of its own scroll region", () => {
    const { region, target, scrollBy } = surface(730, 450);
    expect(revealScrollTarget(region, target, false)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith({ top: 622, behavior: "smooth" });
  });

  it("does not move the page when the target fits in view", () => {
    const { region, target, scrollBy } = surface(200, 300);
    expect(revealScrollTarget(region, target, false)).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("uses immediate movement when reduced motion is requested", () => {
    const { region, target, scrollBy } = surface(730, 450);
    expect(revealScrollTarget(region, target, true)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith({ top: 622, behavior: "auto" });
  });
});
