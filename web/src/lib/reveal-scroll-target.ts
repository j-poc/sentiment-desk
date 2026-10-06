type ScrollRect = Pick<DOMRect, "top" | "bottom" | "height">;

type ScrollRegion = {
  clientHeight: number;
  clientTop: number;
  getBoundingClientRect: () => Pick<DOMRect, "top">;
  scrollBy: (options: ScrollToOptions) => void;
};

type ScrollTarget = {
  getBoundingClientRect: () => ScrollRect;
};

export function historicalJevRevealTarget(panel: ParentNode): HTMLElement | null {
  return panel.querySelector<HTMLElement>("#historical-jev-chart")
    ?? panel.querySelector<HTMLElement>('[aria-label="Saved Jev history navigation"]')
    ?? panel.querySelector<HTMLElement>("[data-historical-jev-empty-state]");
}

/** Reveal a target inside its own scroll region when clipping hides the useful content. */
export function revealScrollTarget(
  region: ScrollRegion,
  target: ScrollTarget,
  reducedMotion: boolean,
  margin = 8,
): boolean {
  const regionTop = region.getBoundingClientRect().top + region.clientTop;
  const regionBottom = regionTop + region.clientHeight;
  const targetRect = target.getBoundingClientRect();
  const availableHeight = Math.max(0, regionBottom - Math.max(regionTop, targetRect.top));
  const isClippedAbove = targetRect.top < regionTop + margin;
  const doesNotFitBelow = targetRect.height > availableHeight - margin;

  if (!isClippedAbove && !doesNotFitBelow) return false;

  const top = targetRect.top - regionTop - margin;
  if (Math.abs(top) < 1) return false;
  region.scrollBy({ top, behavior: reducedMotion ? "auto" : "smooth" });
  return true;
}
