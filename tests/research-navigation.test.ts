/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { focusCompanyResearchBrief, mentionDrawerReturnTarget, researchViewAfterMentionClose, revealCompanyPrivateEvidence, selectCompanyForResearch } from "../web/src/lib/research-navigation.js";

describe("company selection navigation", () => {
  it("opens the selected issuer in Desk from My Research", () => {
    expect(selectCompanyForResearch({ selectedCompanyId: "aapl", view: "queue" }, "adbe"))
      .toEqual({ selectedCompanyId: "adbe", view: "desk" });
  });

  it("keeps Desk open when selecting another issuer there", () => {
    expect(selectCompanyForResearch({ selectedCompanyId: "aapl", view: "desk" }, "adbe"))
      .toEqual({ selectedCompanyId: "adbe", view: "desk" });
  });

  it("opens issuer research from another company-oriented view", () => {
    expect(selectCompanyForResearch({ selectedCompanyId: "aapl", view: "radar" }, "adbe"))
      .toEqual({ selectedCompanyId: "adbe", view: "desk" });
  });

  it("opens an issuer source in its company research workspace from Saved Sources", () => {
    expect(selectCompanyForResearch({ selectedCompanyId: null, view: "sources" }, "aapl"))
      .toEqual({ selectedCompanyId: "aapl", view: "desk" });
  });

  it("returns to the saved-source list and its scroll position after reviewing a record", () => {
    const returnTarget = mentionDrawerReturnTarget("sources", 740, "source-42");
    expect(returnTarget).toEqual({ view: "sources", scrollTop: 740, mentionId: "source-42" });
    expect(researchViewAfterMentionClose("desk", returnTarget)).toBe("sources");
  });

  it("does not redirect to Saved Sources when a record was opened from another view", () => {
    expect(mentionDrawerReturnTarget("desk", 740, "source-42")).toBeNull();
    expect(researchViewAfterMentionClose("desk", null)).toBe("desk");
  });

  it("retains the exact saved row identity for focus restoration after a detail review", () => {
    const returnTarget = mentionDrawerReturnTarget("sources", 1_280, "source-128");
    expect(returnTarget?.mentionId).toBe("source-128");
    expect(researchViewAfterMentionClose("desk", returnTarget)).toBe("sources");
  });

  it("scrolls to and focuses the selected issuer's research brief", () => {
    const section = document.createElement("section");
    section.id = "company-research-brief-apple";
    const heading = document.createElement("h2");
    heading.tabIndex = -1;
    section.append(heading);
    document.body.append(section);
    const scroll = vi.fn();
    Object.defineProperty(section, "scrollIntoView", { value: scroll });

    expect(focusCompanyResearchBrief("apple")).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(heading);
    section.remove();
  });

  it("opens, scrolls to, and focuses only the selected issuer's private notes", () => {
    const section = document.createElement("details");
    section.id = "private-evidence-adobe";
    const summary = document.createElement("summary");
    section.append(summary);
    document.body.append(section);
    const scroll = vi.fn();
    Object.defineProperty(section, "scrollIntoView", { value: scroll });

    expect(revealCompanyPrivateEvidence("adobe")).toBe(true);
    expect(section.open).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(summary);
    expect(revealCompanyPrivateEvidence("apple")).toBe(false);
    section.remove();
  });
});
