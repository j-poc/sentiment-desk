import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CategoricalClassification, Mention } from "../web/src/lib/api.js";
import { CategoricalJudgment } from "../web/src/components/CategoricalJudgment.js";
import { filterMentionFeed, matchesMentionFeedFilter } from "../web/src/lib/mention-filters.js";
import { retryAvailabilityFor } from "../web/src/lib/retryAvailability.js";

// Isolated UI contract fixture; never inserted into a product database or preview.
const judgment: CategoricalClassification = {
  provider: "openai_luna", modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna",
  serviceTierRequested: "default", serviceTier: "default", cacheWriteInputTokens: 0,
  promptVersion: "test", promptSha256: "a".repeat(64), schemaVersion: "test", schemaSha256: "b".repeat(64),
  sentiment: "positive", eventType: "product", takeaway: "product_win", about: true,
  investorRelevant: true, material: true, evidenceSufficient: true,
  summary: "The supplied excerpt describes a product launch.", supportingExcerpt: "Product launch",
  disposition: "classified", responseId: "test-response", responseSha256: "c".repeat(64),
  inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0, totalTokens: 150,
  estimatedCostUsd: 0.000035, latencyMs: 25, classifiedAt: 1000,
};

function categoryMention(disposition: CategoricalClassification["disposition"]): Mention {
  return { status: disposition, score: null, classification: { ...judgment, disposition } } as Mention;
}

describe("Luna category presentation", () => {
  it("shows category and provenance without invented Jev probabilities or impact", () => {
    const html = renderToStaticMarkup(createElement(CategoricalJudgment, { judgment, detail: true }));
    expect(html).toContain("positive");
    expect(html).toContain("test-response");
    expect(html).toContain("No probability, confidence percentage or Jev impact value is assigned");
    expect(html).not.toContain("directional impact");
    expect(html).not.toContain("100%");
    expect(html).toContain("not an invoice");
  });

  it("keeps missing evidence under review rather than assigning neutral", () => {
    const html = renderToStaticMarkup(createElement(CategoricalJudgment, {
      judgment: { ...judgment, disposition: "review_required", sentiment: null, evidenceSufficient: false },
    }));
    expect(html).toContain("Needs evidence review");
    expect(html).not.toContain("neutral");
  });

  it("keeps missing usage, model tier and costs visible instead of substituting zero", () => {
    const html = renderToStaticMarkup(createElement(CategoricalJudgment, {
      judgment: { ...judgment, inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null,
        reasoningTokens: null, outputTokens: null, totalTokens: null, serviceTier: null, estimatedCostUsd: null },
      detail: true,
    }));
    expect(html).toContain("Unknown / Unknown tokens");
    expect(html).toContain("Estimated total</dt><dd>Unknown");
    expect(html).toContain("Not recorded · requested default");
    expect(html).not.toContain("$0.000000");
  });

  it("routes categories to matching filters and excludes unresolved or off-target labels", () => {
    expect(matchesMentionFeedFilter(categoryMention("classified"), "bull")).toBe(true);
    expect(matchesMentionFeedFilter(categoryMention("classified"), "material")).toBe(true);
    expect(matchesMentionFeedFilter(categoryMention("classified"), "failed")).toBe(false);
    expect(matchesMentionFeedFilter(categoryMention("review_required"), "failed")).toBe(true);
    expect(matchesMentionFeedFilter(categoryMention("review_required"), "bull")).toBe(false);
    expect(matchesMentionFeedFilter(categoryMention("excluded"), "offtarget")).toBe(true);
    expect(matchesMentionFeedFilter(categoryMention("excluded"), "material")).toBe(false);
  });

  it("retains fetched Luna records through the displayed feed filter and hides exclusions by default", () => {
    const positive = { ...categoryMention("classified"), id: "positive" };
    const negative = { ...categoryMention("classified"), id: "negative", classification: { ...judgment, sentiment: "negative" as const, material: false } };
    const excluded = { ...categoryMention("excluded"), id: "excluded" };
    const review = { ...categoryMention("review_required"), id: "review" };
    const historicalExcluded = { id: "legacy-offtarget", status: "off_target", score: null } as Mention;
    const page = [positive, negative, excluded, review, historicalExcluded];
    const ids = (filter: Parameters<typeof filterMentionFeed>[1]) => filterMentionFeed(page, filter).map(({ id }) => id);
    expect(ids("all")).toEqual(["positive", "negative", "review"]);
    expect(ids("bull")).toEqual(["positive"]);
    expect(ids("bear")).toEqual(["negative"]);
    expect(ids("material")).toEqual(["positive"]);
    expect(ids("offtarget")).toEqual(["excluded", "legacy-offtarget"]);
    expect(ids("failed")).toEqual(["review"]);
  });

  it("uses the selected provider's retry gates even when legacy Jev is enabled", () => {
    const classifier = {
      provider: "openai_luna" as const, model: "gpt-6-luna", configured: false,
      enabled: false, blockedReason: "OpenAI API key missing", ok: 0, fail: 0,
      lastOkAt: null, lastErrorAt: null, lastError: null,
    };
    const blocked = retryAvailabilityFor({ externalRequestsEnabled: true, health: { jev: { enabled: true }, classifier } });
    expect(blocked.kind).toBe("unavailable");
    if (blocked.kind === "unavailable") expect(blocked.reason).toContain("OpenAI API key missing");
    const enabled = retryAvailabilityFor({ externalRequestsEnabled: true, health: { jev: { enabled: false }, classifier: { ...classifier, configured: true, enabled: true, blockedReason: null } } });
    expect(enabled).toEqual({ kind: "available", providerLabel: "Luna", providerName: "OpenAI" });
  });
});
