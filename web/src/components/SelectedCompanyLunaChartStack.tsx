import type { ReactNode } from "react";

/** Keep the product's primary sentiment chart before optional market context. */
export function SelectedCompanyLunaChartStack({
  sentimentChart,
  marketPriceContext,
}: {
  sentimentChart: ReactNode;
  marketPriceContext: ReactNode;
}) {
  return (
    <section className="luna-price-context-grid" aria-label="Sentiment trend and market price context">
      <div className="luna-sentiment-chart">{sentimentChart}</div>
      <div className="luna-market-price-context">{marketPriceContext}</div>
    </section>
  );
}
