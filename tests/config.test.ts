import { afterAll, describe, expect, it, vi } from "vitest";
import { intersectClassifierSourceAllowlist, intersectCollectorAllowlists, intersectJevSourceAllowlist } from "../server/collector-policy.js";

// Config resolution must not inspect the real shared-machine credential file
// while these tests exercise explicit or empty environment values.
vi.stubEnv("OPENAI_MAX_DAILY_COST_USD", "");
const {
  boundedUsdMicros,
  boundedNonNegativeInt,
  config,
  parseClassificationProvider,
  parseExternalSourceCollectors,
  parseExplicitBoolean,
  parseSourceRightsApprovedCollectors,
  parseExternalRequestsEnabled,
  secContactUserAgent,
} = await import("../server/config.js");
afterAll(() => vi.unstubAllEnvs());

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
    expect(parseExternalSourceCollectors("sec_company_facts")).toEqual(new Set(["sec_company_facts"]));
    expect(() => parseExternalSourceCollectors("demo_simulation")).toThrow();
    expect(() => parseExternalSourceCollectors("not_a_source")).toThrow();
  });

  it("keeps source-use approvals separate from request allowlists", () => {
    expect(parseSourceRightsApprovedCollectors(undefined)).toEqual(new Set());
    expect(parseSourceRightsApprovedCollectors("sec_edgar,yahoo_chart")).toEqual(
      new Set(["sec_edgar", "yahoo_chart"]),
    );
    expect(() => parseSourceRightsApprovedCollectors("demo_simulation")).toThrow();
    expect(intersectCollectorAllowlists(
      new Set(["sec_edgar", "reddit"]),
      new Set(["sec_edgar"]),
    )).toEqual(new Set(["sec_edgar"]));
  });

  it("never treats CompanyFacts payload receipts as classifier input", () => {
    const admitted = new Set(["sec_company_facts", "sec_edgar", "google_news_rss"] as const);
    expect(intersectClassifierSourceAllowlist(admitted, admitted, admitted)).toEqual(new Set(["sec_edgar", "google_news_rss"]));
  });

  it("requires an explicit account-use attestation and rejects malformed values", () => {
    expect(parseExplicitBoolean(undefined)).toBe(false);
    expect(parseExplicitBoolean("TRUE")).toBe(true);
    expect(parseExplicitBoolean("false")).toBe(false);
    expect(() => parseExplicitBoolean("yes")).toThrow();
  });

  it("intersects Jev forwarding permission with the active source allowlist", () => {
    expect(intersectJevSourceAllowlist(
      new Set(["google_news_rss", "sec_edgar"]),
      new Set(["sec_edgar"]),
      new Set(["sec_edgar"]),
    )).toEqual(new Set(["sec_edgar"]));
    expect(intersectJevSourceAllowlist(
      new Set(["google_news_rss"]),
      new Set(["sec_edgar"]),
      new Set(["sec_edgar"]),
    )).toEqual(new Set());
    expect(intersectJevSourceAllowlist(
      new Set(["sec_edgar"]),
      new Set(["sec_edgar"]),
      new Set(),
    )).toEqual(new Set());
    expect(intersectJevSourceAllowlist(
      new Set(["sec_company_facts"]),
      new Set(["sec_company_facts"]),
      new Set(["sec_company_facts"]),
    )).toEqual(new Set());
  });
});

describe("new classifier selection", () => {
  it("uses OpenAI Luna and rejects selecting the retired TypeSafe dispatcher", () => {
    expect(parseClassificationProvider(undefined)).toBe("openai_luna");
    expect(parseClassificationProvider(" openai_luna ")).toBe("openai_luna");
    expect(() => parseClassificationProvider("typesafe")).toThrow(/historical Jev records remain readable/);
  });
});

describe("SEC User-Agent configuration", () => {
  it("requires a bounded value with operator contact information", () => {
    expect(secContactUserAgent(undefined)).toBe("");
    expect(secContactUserAgent("generic research desk")).toBe("");
    expect(secContactUserAgent("analyst@example.com")).toBe("Sentiment Desk/0.2.0 analyst@example.com");
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

describe("OpenAI spending cap", () => {
  it("defaults an absent daily cost cap to zero and never treats the validation ceiling as a configured budget", () => {
    expect(boundedUsdMicros(undefined, 100)).toBe(0);
    expect(config.openai.maxDailyCostMicros).toBe(0);
    expect(boundedUsdMicros("0.25", 100)).toBe(250_000);
    expect(boundedUsdMicros("100.01", 100)).toBe(0);
  });
});
