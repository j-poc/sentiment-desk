import { describe, expect, it } from "vitest";
import { parseExternalRequestsEnabled, secContactUserAgent } from "../server/config.js";

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
