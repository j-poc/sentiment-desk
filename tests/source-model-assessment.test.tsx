import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boundModelProviderInput } from "../shared/model-provider-input.js";
import type { Mention } from "../web/src/lib/api.js";
import { SourceModelAssessment } from "../web/src/components/SourceModelAssessment.js";

const mention: Mention = {
  id: "item-1", companyId: "company-1",
  source: { name: "Reuters", url: "https://example.com/item", kind: "rss", tier: "wire", collector: "google_news_rss", publisher: "Reuters", publisherDomain: "reuters.com" },
  title: "Acme reports results", snippet: "Revenue increased.", publishedAt: null, providerObservedAt: null,
  retrievedAt: 1_760_000_000_000, ingestedAt: 1_760_000_000_000, timeBasis: "unknown", collector: "google_news_rss",
  publisherName: "Reuters", publisherDomain: "reuters.com", status: "pending", scoreRetryAt: null,
  usageCheckRequired: false, score: null, error: null,
};

describe("source model assessment request input", () => {
  it("accepts an omitted optional sector without crashing the drawer render", () => {
    const html = renderToStaticMarkup(createElement(SourceModelAssessment, {
      mention, companyName: "Acme Corporation", ticker: "ACME",
    }));
    expect(html).toContain("SOURCE MODEL ASSESSMENT");
    expect(html).toContain("No Google Gemini key is saved");
  });

  it("bounds every OpenAI/Gemini company and source field to the values used in the preview", () => {
    const input = {
      company: { name: "N".repeat(160) + "NAME-TAIL", ticker: "T".repeat(24) + "TICKER-TAIL", sector: "S".repeat(120) + "SECTOR-TAIL" },
      source: { collector: "C".repeat(48) + "COLLECTOR-TAIL", publisher: "P".repeat(120) + "PUBLISHER-TAIL", title: "H".repeat(500) + "TITLE-TAIL", excerpt: "E".repeat(4_000) + "EXCERPT-TAIL" },
    };
    const bounded = boundModelProviderInput(input);
    expect(bounded).toEqual({
      company: { name: "N".repeat(160), ticker: "T".repeat(24), sector: "S".repeat(120) },
      source: { collector: "C".repeat(48), publisher: "P".repeat(120), title: "H".repeat(500), excerpt: "E".repeat(4_000) },
    });
    expect(JSON.stringify(bounded)).not.toMatch(/(?:NAME|TICKER|SECTOR|COLLECTOR|PUBLISHER|TITLE|EXCERPT)-TAIL/);
  });

  it("keeps a missing optional sector empty while still rejecting missing required text", () => {
    const input = {
      company: { name: "Acme", ticker: "ACME" },
      source: { collector: "google_news_rss", publisher: "Reuters", title: "Results", excerpt: "Revenue increased." },
    };
    expect(boundModelProviderInput(input).company.sector).toBe("");
    expect(() => boundModelProviderInput({ ...input, company: { ...input.company, name: undefined! } })).toThrow();
  });
});
