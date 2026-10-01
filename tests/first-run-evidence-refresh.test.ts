import { describe, expect, it } from "vitest";
import { shouldRefreshDeskOnFirstEvidence } from "../web/src/lib/firstRunEvidence.js";

describe("first saved evidence refresh", () => {
  it("refreshes company and feed snapshots when evidence arrives after an empty check", () => {
    expect(shouldRefreshDeskOnFirstEvidence(0, 1, false)).toBe(true);
  });

  it("does not repeat the recovery refresh for each new record", () => {
    expect(shouldRefreshDeskOnFirstEvidence(1, 2, true)).toBe(false);
  });

  it("refreshes an initially positive result only if the company snapshot has not caught up", () => {
    expect(shouldRefreshDeskOnFirstEvidence(null, 1, false)).toBe(true);
    expect(shouldRefreshDeskOnFirstEvidence(null, 1, true)).toBe(false);
  });

  it("does not refresh while the verified history is empty", () => {
    expect(shouldRefreshDeskOnFirstEvidence(null, 0, false)).toBe(false);
    expect(shouldRefreshDeskOnFirstEvidence(0, 0, false)).toBe(false);
  });
});
