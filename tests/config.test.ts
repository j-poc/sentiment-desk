import { afterAll, describe, expect, it, vi } from "vitest";
import { intersectClassifierSourceAllowlist, intersectCollectorAllowlists, intersectJevSourceAllowlist, secFilingsInboxRequestsEnabled } from "../server/collector-policy.js";

// Config resolution must not inspect the real shared-machine credential file
// while these tests exercise explicit or empty environment values.
const {
  boundedNonNegativeInt,
  config,
  parseClassificationProvider,
  parseChatGPTPlanBudget,
  parseChatGPTPlanLocalOrigin,
  parseExternalSourceCollectors,
  parseOpenAILunaAllowedCollectors,
  parseExplicitBoolean,
  parseSourceRightsApprovedCollectors,
  parseExternalRequestsEnabled,
  secContactUserAgent,
  parseSecUserAgent,
} = await import("../server/config.js");
afterAll(() => vi.unstubAllEnvs());

describe("external request mode", () => {
  it("keeps external requests off until explicitly enabled and rejects malformed values", () => {
    expect(parseExternalRequestsEnabled(undefined)).toBe(false);
    expect(parseExternalRequestsEnabled("true")).toBe(true);
    expect(parseExternalRequestsEnabled("false")).toBe(false);
    expect(parseExternalRequestsEnabled(" TRUE ")).toBe(true);
    expect(() => parseExternalRequestsEnabled("off")).toThrow();
  });

  it("defaults source collection to official SEC APIs and rejects synthetic or unknown collectors", () => {
    expect(parseExternalSourceCollectors(undefined)).toEqual(new Set(["sec_edgar", "sec_company_facts"]));
    expect(parseExternalSourceCollectors(" sec_edgar, yahoo_chart,sec_edgar ")).toEqual(
      new Set(["sec_edgar", "yahoo_chart"]),
    );
    expect(parseExternalSourceCollectors("sec_company_facts")).toEqual(new Set(["sec_company_facts"]));
    expect(parseExternalSourceCollectors("nasdaq_symbol_directories")).toEqual(new Set(["nasdaq_symbol_directories"]));
    expect(() => parseExternalSourceCollectors("demo_simulation")).toThrow();
    expect(() => parseExternalSourceCollectors("not_a_source")).toThrow();
  });

  it("keeps source-use approvals separate from request allowlists", () => {
    expect(parseSourceRightsApprovedCollectors(undefined)).toEqual(new Set(["sec_edgar", "sec_company_facts"]));
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
    const admitted = new Set(["sec_company_facts", "nasdaq_symbol_directories", "sec_edgar", "google_news_rss"] as const);
    expect(intersectClassifierSourceAllowlist(admitted, admitted, admitted)).toEqual(new Set(["sec_edgar", "google_news_rss"]));
  });

  it("requires separate request and rights approval for both SEC filings and Nasdaq listing verification", () => {
    const secOnly = new Set(["sec_latest_filings_8k"] as const);
    const nasdaqOnly = new Set(["nasdaq_symbol_directories"] as const);
    const both = new Set(["sec_latest_filings_8k", "nasdaq_symbol_directories"] as const);
    expect(secFilingsInboxRequestsEnabled(false, both)).toBe(false);
    expect(secFilingsInboxRequestsEnabled(true, secOnly)).toBe(false);
    expect(secFilingsInboxRequestsEnabled(true, nasdaqOnly)).toBe(false);
    expect(secFilingsInboxRequestsEnabled(true, both)).toBe(true);
  });

  it("never forwards Nasdaq symbol-directory rows to a classifier", () => {
    const admitted = new Set(["nasdaq_symbol_directories", "sec_edgar"] as const);
    expect(intersectClassifierSourceAllowlist(admitted, admitted, admitted)).toEqual(new Set(["sec_edgar"]));
  });

  it("requires an explicit account-use attestation and rejects malformed values", () => {
    expect(parseExplicitBoolean(undefined)).toBe(false);
    expect(parseExplicitBoolean("TRUE")).toBe(true);
    expect(parseExplicitBoolean("false")).toBe(false);
    expect(() => parseExplicitBoolean("yes")).toThrow();
  });

  it("keeps API-key billing configuration out of the ChatGPT-plan inference route", () => {
    expect(config.openai).not.toHaveProperty("apiKey");
    expect(config.openai).not.toHaveProperty("maxDailyCostMicros");
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

describe("ChatGPT local browser origin", () => {
  it("defaults to the API origin and accepts only exact loopback HTTP origins", () => {
    expect(parseChatGPTPlanLocalOrigin(undefined, "http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(parseChatGPTPlanLocalOrigin("http://127.0.0.1:5175", "http://127.0.0.1:8787")).toBe("http://127.0.0.1:5175");
    expect(parseChatGPTPlanLocalOrigin("http://localhost:5173", "http://127.0.0.1:8787")).toBe("http://localhost:5173");
    expect(() => parseChatGPTPlanLocalOrigin("https://example.com", "http://127.0.0.1:8787")).toThrow(/loopback HTTP origin/);
    expect(() => parseChatGPTPlanLocalOrigin("http://127.0.0.1:5175/settings", "http://127.0.0.1:8787")).toThrow(/loopback HTTP origin/);
    expect(() => parseChatGPTPlanLocalOrigin("http://127.0.0.1:5175/?next=evil", "http://127.0.0.1:8787")).toThrow(/loopback HTTP origin/);
  });
});

describe("new classifier selection", () => {
  it("uses OpenAI Luna and rejects selecting the retired TypeSafe dispatcher", () => {
    expect(parseClassificationProvider(undefined)).toBe("openai_luna");
    expect(parseClassificationProvider(" openai_luna ")).toBe("openai_luna");
    expect(() => parseClassificationProvider("typesafe")).toThrow(/historical Jev records remain readable/);
  });

  it("defaults Luna forwarding to public RSS while preserving explicit source gates", () => {
    const feeds = new Set(["google_news_rss", "yahoo_finance_rss"]);
    expect(parseOpenAILunaAllowedCollectors(undefined)).toEqual(feeds);
    expect(parseOpenAILunaAllowedCollectors("")).toEqual(feeds);
    expect(parseOpenAILunaAllowedCollectors("sec_edgar")).toEqual(new Set(["sec_edgar"]));
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

  it("keeps SEC disabled when no real contact-bearing User-Agent is configured", () => {
    expect(parseSecUserAgent(undefined)).toBe("");
    expect(parseSecUserAgent("")).toBe("");
    expect(parseSecUserAgent("Sentiment Desk/0.2.0 contact@example.com")).toBe("");
    expect(parseSecUserAgent("Sentiment Desk/0.2.0 operator@service.example")).toBe("");
    expect(parseSecUserAgent("Sentiment Desk/0.2.0 operator@company.com")).toBe("Sentiment Desk/0.2.0 operator@company.com");
  });
});

describe("ChatGPT-plan daily budget caps", () => {
  it("defaults missing limits to zero and accepts only bounded non-negative integers", () => {
    expect(boundedNonNegativeInt(undefined, 100)).toBe(0);
    expect(boundedNonNegativeInt(undefined, 400_000)).toBe(0);
    expect(boundedNonNegativeInt("12", 100)).toBe(12);
    expect(boundedNonNegativeInt("-1", 100)).toBe(0);
    expect(boundedNonNegativeInt("1.5", 100)).toBe(0);
    expect(boundedNonNegativeInt("101", 100)).toBe(0);
  });

  it("uses bounded one-day classification capacity independent of legacy API-billing variables", () => {
    expect(parseChatGPTPlanBudget({})).toEqual({ maxRequestsPerDay: 100, maxRequestBytesPerDay: 1_638_400 });
    expect(parseChatGPTPlanBudget({ OPENAI_MAX_REQUESTS_PER_DAY: "1", OPENAI_MAX_REQUEST_BYTES_PER_DAY: "260000" }))
      .toEqual({ maxRequestsPerDay: 100, maxRequestBytesPerDay: 1_638_400 });
    expect(parseChatGPTPlanBudget({ CHATGPT_PLAN_MAX_REQUESTS_PER_DAY: "10", CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY: "200000" }))
      .toEqual({ maxRequestsPerDay: 10, maxRequestBytesPerDay: 200_000 });
    expect(parseChatGPTPlanBudget({ CHATGPT_PLAN_MAX_REQUESTS_PER_DAY: "0", CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY: "invalid" }))
      .toEqual({ maxRequestsPerDay: 0, maxRequestBytesPerDay: 0 });
  });
});
