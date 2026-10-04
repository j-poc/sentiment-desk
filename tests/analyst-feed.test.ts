import { describe, expect, it } from "vitest";
import { applyDispositionChange, researchDispositionFor, visibleInWorkingScan } from "../web/src/lib/analyst-feed.js";
import { matchesMentionFeedFilter } from "../web/src/lib/mention-filters.js";

describe("analyst disposition in the working scan", () => {
  it("offers a held-only identity review without treating weak matches as unrelated", () => {
    const weak = { id: "weak-row", issuerIdentityStrong: false };
    const strong = { id: "strong-row", issuerIdentityStrong: true };
    const unknown = { id: "unknown-row" };
    const overrides = new Map();

    expect(matchesMentionFeedFilter(weak as never, "identity_review")).toBe(true);
    expect(matchesMentionFeedFilter(strong as never, "identity_review")).toBe(false);
    expect(matchesMentionFeedFilter(unknown as never, "identity_review")).toBe(false);
    expect(visibleInWorkingScan(weak, false, overrides, true)).toBe(true);
  });

  it("hides set-aside source rows only from the default scan and lets newer restores win", () => {
    const overrides = new Map();
    const row = { id: "real-source-row", analystResearchDisposition: null as "investigate" | "dismissed" | null };
    const dismissed = { observationId: row.id, companyId: "apple", disposition: "dismissed" as const, updatedAt: 10 };

    expect(applyDispositionChange(overrides, dismissed)).toBe(true);
    expect(visibleInWorkingScan(row, false, overrides)).toBe(false);
    expect(visibleInWorkingScan(row, true, overrides)).toBe(true);
    expect(researchDispositionFor(row, overrides)).toBe("dismissed");

    expect(applyDispositionChange(overrides, { ...dismissed, disposition: "investigate", updatedAt: 11 })).toBe(true);
    expect(visibleInWorkingScan(row, false, overrides)).toBe(true);
    expect(applyDispositionChange(overrides, dismissed)).toBe(false);
    expect(visibleInWorkingScan(row, false, overrides)).toBe(true);
  });
});
