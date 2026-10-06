import { describe, expect, it } from "vitest";
import { resetResearchScrollForSelection } from "../web/src/lib/research-scroll.js";

describe("selected-company research navigation", () => {
  it("returns the pane to the company heading when selection changes", () => {
    const region = { scrollTop: 640 };

    expect(resetResearchScrollForSelection(region, "aapl", "adbe")).toBe(true);
    expect(region.scrollTop).toBe(0);
  });

  it("keeps the reading position when the selected company's data refreshes", () => {
    const region = { scrollTop: 640 };

    expect(resetResearchScrollForSelection(region, "adbe", "adbe")).toBe(false);
    expect(region.scrollTop).toBe(640);
  });

  it("returns to the issuer heading when opening Desk for the already selected company", () => {
    const region = { scrollTop: 640 };

    expect(resetResearchScrollForSelection(region, "adbe", "adbe", true)).toBe(true);
    expect(region.scrollTop).toBe(0);
  });

  it("does not fail if the scroll pane is not mounted", () => {
    expect(resetResearchScrollForSelection(null, "aapl", "adbe")).toBe(false);
  });
});
