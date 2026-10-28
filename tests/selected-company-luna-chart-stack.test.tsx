import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectedCompanyLunaChartStack } from "../web/src/components/SelectedCompanyLunaChartStack.js";

describe("selected-company Luna chart priority", () => {
  it("renders the GPT-6 Luna sentiment chart before supporting share-price context", () => {
    const html = renderToStaticMarkup(createElement(SelectedCompanyLunaChartStack, {
      sentimentChart: createElement("div", { id: "gpt-6-luna-sentiment-chart" }, "Saved Luna categories"),
      marketPriceContext: createElement("div", { id: "share-price-context-chart" }, "Verified price history"),
    }));

    const sentiment = html.indexOf('id="gpt-6-luna-sentiment-chart"');
    const price = html.indexOf('id="share-price-context-chart"');
    expect(sentiment).toBeGreaterThanOrEqual(0);
    expect(sentiment).toBeLessThan(price);
    expect(html).toContain('aria-label="Sentiment trend and market price context"');
  });
});
