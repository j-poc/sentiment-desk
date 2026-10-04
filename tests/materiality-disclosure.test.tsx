import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CategoricalClassification } from "../web/src/lib/api.js";
import { CategoricalJudgment } from "../web/src/components/CategoricalJudgment.js";
import { MaterialFilterDisclosure } from "../web/src/components/MaterialFilterDisclosure.js";

const lunaMaterial: CategoricalClassification = {
  attemptId: "attempt-1",
  provider: "openai_luna",
  modelRequested: "gpt-6-luna",
  modelReturned: "gpt-6-luna",
  serviceTierRequested: "default",
  serviceTier: "default",
  promptVersion: "fixture",
  promptSha256: "a".repeat(64),
  profileSha256: "b".repeat(64),
  schemaVersion: "fixture",
  schemaSha256: "c".repeat(64),
  sentiment: "positive",
  eventType: "product",
  takeaway: "product_win",
  about: true,
  investorRelevant: true,
  material: true,
  evidenceSufficient: true,
  summary: null,
  supportingExcerpt: null,
  disposition: "classified",
  responseId: "response-1",
  responseSha256: "d".repeat(64),
  inputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 1,
  reasoningTokens: 0,
  totalTokens: 2,
  estimatedCostUsd: 0,
  latencyMs: 1,
  classifiedAt: 1,
};

describe("model material filter disclosure", () => {
  it("names both model rules and says they are not independently validated findings", () => {
    const markup = renderToStaticMarkup(createElement(MaterialFilterDisclosure));

    expect(markup).toContain("Model-flagged material.");
    expect(markup).toContain("historical Jev material score of 0.60 or higher");
    expect(markup).toContain("Luna classification marked material");
    expect(markup).toContain("Neither is independently validated as a materiality finding");
  });

  it("identifies Luna material as a model-marked value beside its Luna label", () => {
    const markup = renderToStaticMarkup(createElement(CategoricalJudgment, { judgment: lunaMaterial, detail: true }));

    expect(markup).toContain("LUNA");
    expect(markup).toContain("Model-marked material");
    expect(markup).toContain("Categorical model judgment · independently unvalidated");
    expect(markup).toContain("title=\"Luna model label; not independently validated.\"");
  });
});
