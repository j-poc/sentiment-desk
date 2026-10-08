import { describe, expect, it } from "vitest";
import { shouldAutoRouteFirstRunToFilings } from "../web/src/App.js";

describe("first-run research-view routing", () => {
  it("opens Recent Filings only for a ready, genuinely empty untouched session", () => {
    expect(shouldAutoRouteFirstRunToFilings({
      evidence: { state: "ready", eligibleObservationCount: 0 },
      hasExplicitViewChoice: false,
      currentView: "desk",
      localObservationArrived: false,
    })).toBe(true);
  });

  it("preserves saved and current explicit view choices", () => {
    const evidence = { state: "ready" as const, eligibleObservationCount: 0 };
    expect(shouldAutoRouteFirstRunToFilings({
      evidence, hasExplicitViewChoice: true, currentView: "desk", localObservationArrived: false,
    })).toBe(false);
    expect(shouldAutoRouteFirstRunToFilings({
      evidence, hasExplicitViewChoice: false, currentView: "sources", localObservationArrived: false,
    })).toBe(false);
  });

  it.each([
    { evidence: { state: "loading" as const }, localObservationArrived: false },
    { evidence: { state: "error" as const }, localObservationArrived: false },
    { evidence: { state: "ready" as const, eligibleObservationCount: 1 }, localObservationArrived: false },
    { evidence: { state: "ready" as const, eligibleObservationCount: 0 }, localObservationArrived: true },
  ])("does not auto-route while evidence is unavailable or observations exist", ({ evidence, localObservationArrived }) => {
    expect(shouldAutoRouteFirstRunToFilings({
      evidence, hasExplicitViewChoice: false, currentView: "desk", localObservationArrived,
    })).toBe(false);
  });
});
