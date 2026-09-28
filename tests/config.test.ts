import { describe, expect, it } from "vitest";
import { boundedNonNegativeInt, parseExternalRequestsEnabled, secContactUserAgent } from "../server/config.js";

describe("external request mode", () => {
  it("defaults to enabled and rejects malformed values", () => {
    expect(parseExternalRequestsEnabled(undefined)).toBe(true);
    expect(parseExternalRequestsEnabled("false")).toBe(false);
    expect(parseExternalRequestsEnabled(" TRUE ")).toBe(true);
    expect(() => parseExternalRequestsEnabled("off")).toThrow();
  });
});

describe("SEC User-Agent configuration", () => {
  it("requires a bounded value with operator contact information", () => {
    expect(secContactUserAgent(undefined)).toBe("");
    expect(secContactUserAgent("generic research desk")).toBe("");
    expect(secContactUserAgent("analyst@example.com")).toBe("");
    expect(secContactUserAgent("Research Desk analyst@example.com")).toBe("Research Desk analyst@example.com");
    expect(secContactUserAgent(`${"x".repeat(250)} a@example.com`)).toBe("");
    expect(secContactUserAgent("Research\nDesk analyst@example.com")).toBe("");
    expect(secContactUserAgent("Research\rDesk analyst@example.com")).toBe("");
  });
});

describe("Jev daily budget caps", () => {
  it("defaults missing limits to zero and accepts only bounded non-negative integers", () => {
    expect(boundedNonNegativeInt(undefined, 100)).toBe(0);
    expect(boundedNonNegativeInt(undefined, 400_000)).toBe(0);
    expect(boundedNonNegativeInt("12", 100)).toBe(12);
    expect(boundedNonNegativeInt("-1", 100)).toBe(0);
    expect(boundedNonNegativeInt("1.5", 100)).toBe(0);
    expect(boundedNonNegativeInt("101", 100)).toBe(0);
  });
});
