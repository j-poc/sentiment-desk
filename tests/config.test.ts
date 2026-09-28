import { afterAll, describe, expect, it, vi } from "vitest";
import { intersectJevSourceAllowlist } from "../server/collector-policy.js";

// Config resolution must not inspect the real shared-machine credential file
// while these tests exercise explicit or empty environment values.
vi.stubEnv("TYPESAFE_API_KEY", "");
const {
  boundedNonNegativeInt,
  parseExternalSourceCollectors,
  parseExternalRequestsEnabled,
  resolveJevApiKey,
  secContactUserAgent,
} = await import("../server/config.js");
afterAll(() => vi.unstubAllEnvs());

describe("Jev credential resolution", () => {
  it("does not read the fallback file when the environment variable is present", () => {
    const readFallback = vi.fn(() => "fallback-key");
    expect(resolveJevApiKey(" supplied-key ", readFallback)).toBe("supplied-key");
    expect(resolveJevApiKey("", readFallback)).toBe("");
    expect(readFallback).not.toHaveBeenCalled();
  });

  it("reads the fallback only when the environment variable is absent", () => {
    const readFallback = vi.fn(() => " fallback-key ");
    expect(resolveJevApiKey(undefined, readFallback)).toBe("fallback-key");
    expect(readFallback).toHaveBeenCalledOnce();
  });
});

describe("external request mode", () => {
  it("defaults to paused and rejects malformed values", () => {
    expect(parseExternalRequestsEnabled(undefined)).toBe(false);
    expect(parseExternalRequestsEnabled("true")).toBe(true);
    expect(parseExternalRequestsEnabled("false")).toBe(false);
    expect(parseExternalRequestsEnabled(" TRUE ")).toBe(true);
    expect(() => parseExternalRequestsEnabled("off")).toThrow();
  });

  it("requires an explicit collector allowlist and rejects synthetic or unknown collectors", () => {
    expect(parseExternalSourceCollectors(undefined)).toEqual(new Set());
    expect(parseExternalSourceCollectors(" sec_edgar, yahoo_chart,sec_edgar ")).toEqual(
      new Set(["sec_edgar", "yahoo_chart"]),
    );
    expect(() => parseExternalSourceCollectors("demo_simulation")).toThrow();
    expect(() => parseExternalSourceCollectors("not_a_source")).toThrow();
  });

  it("intersects Jev forwarding permission with the active source allowlist", () => {
    expect(intersectJevSourceAllowlist(
      new Set(["google_news_rss", "sec_edgar"]),
      new Set(["sec_edgar"]),
    )).toEqual(new Set(["sec_edgar"]));
    expect(intersectJevSourceAllowlist(
      new Set(["google_news_rss"]),
      new Set(["sec_edgar"]),
    )).toEqual(new Set());
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
