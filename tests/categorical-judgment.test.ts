import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoricalJudgment } from "../web/src/components/CategoricalJudgment.js";
import type { CategoricalClassification } from "../web/src/lib/api.js";

const missingDirection: CategoricalClassification = {
  attemptId: null,
  provider: "openai_luna", modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna",
  serviceTierRequested: "default", serviceTier: "default", promptVersion: "test", promptSha256: "a".repeat(64), profileSha256: "d".repeat(64),
  schemaVersion: "test", schemaSha256: "b".repeat(64), sentiment: null, eventType: null, takeaway: null,
  about: null, investorRelevant: null, material: null, evidenceSufficient: false, summary: null, supportingExcerpt: null,
  disposition: "review_required", responseId: null, responseSha256: "c".repeat(64), inputTokens: null,
  cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null,
  estimatedCostUsd: null, latencyMs: 1, classifiedAt: 1,
};

describe("categorical judgment status", () => {
  it("shows unsupported direction as review-required rather than inventing a sixth outcome", () => {
    const markup = renderToStaticMarkup(createElement(CategoricalJudgment, { judgment: missingDirection }));
    expect(markup).toContain("Needs evidence review");
    expect(markup).not.toContain("Direction uncertain");
  });
});
