import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bucketClassifiedAssessmentsBySourceDay,
  ModelProviderCompanySummary,
} from "../web/src/components/ModelProviderCompanySummary.js";

describe("model assessment company chart time", () => {
  it("does not substitute retrieval time for a missing source timestamp", () => {
    const day = Date.UTC(2026, 9, 10);
    const buckets = bucketClassifiedAssessmentsBySourceDay([
      { sourceTimeAt: null, disposition: "classified", sentiment: "positive" },
      { sourceTimeAt: day + 60_000, disposition: "classified", sentiment: "neutral" },
      { sourceTimeAt: day + 120_000, disposition: "review_required", sentiment: "negative" },
    ], [day]);

    expect(buckets).toEqual([{ day, positive: 0, neutral: 1, negative: 0 }]);
  });

  it("distinguishes optional API-key assessments from the Luna subscription chart", () => {
    const html = renderToStaticMarkup(createElement(ModelProviderCompanySummary, {
      companyId: "apple",
      companyName: "Apple (AAPL)",
      onManageKeys: () => undefined,
    }));

    expect(html).toContain("OPTIONAL SOURCE ASSESSMENTS · API-KEY PROVIDERS");
    expect(html).toContain("Separate from the main provider-specific sentiment chart and Historical Jev");
    expect(html).toContain("Manage optional API-key providers");
    expect(html).not.toContain("YOUR MODEL ASSESSMENTS");
  });
});
