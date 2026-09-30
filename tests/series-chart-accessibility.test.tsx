import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { SeriesChart } from "../web/src/components/SeriesChart.js";

describe("chart keyboard data inspection", () => {
  it("exposes each saved comparison price with currency, provider time, and collected time", () => {
    const sourceAt = Date.parse("2026-09-29T14:30:00.000Z");
    const retrievedAt = Date.parse("2026-09-29T14:31:12.000Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[{
          t: sourceAt,
          v: 24,
          n: 2,
          itemImpactMin: -12,
          itemImpactMax: 40,
          lastScoredAt: sourceAt,
        }]}
        hours={24}
        loading={false}
        mode="comparison"
        price={[{
          t: sourceAt,
          price: 184.52,
          currency: "USD",
          collector: "yahoo_chart",
          retrievedAt,
          adapterVersion: "fixture",
          deliveryId: "test-delivery",
        }]}
        currency="USD"
        latestPriceAt={sourceAt}
        latestScoreAvailableAt={sourceAt}
      />,
    );

    assert.match(html, /Inspect plotted data by keyboard/);
    assert.match(html, /Plotted share-price observations/);
    assert.match(html, /Saved Yahoo share-price observations/);
    assert.match(html, /Provider source time/);
    assert.match(html, /Collected time/);
    assert.match(html, /USD 184\.52/);
    assert.match(html, /2026-09-29T14:30:00\.000Z/);
    assert.match(html, /2026-09-29T14:31:12\.000Z/);
  });

  it("reports a confirmed empty price window without implying missing score history", () => {
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[{
          t: Date.parse("2026-09-29T14:30:00.000Z"),
          v: -8,
          n: 1,
          itemImpactMin: -8,
          itemImpactMax: -8,
          lastScoredAt: Date.parse("2026-09-29T14:30:00.000Z"),
        }]}
        hours={24}
        loading={false}
        mode="comparison"
        price={[]}
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={null}
      />,
    );

    assert.match(html, /No saved Yahoo price points in this window/);
    assert.doesNotMatch(html, /Price history unavailable/);
  });

  it("keeps price-only comparison data keyboard-accessible without Jev scores", () => {
    const sourceAt = Date.parse("2026-09-29T14:30:00.000Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[]}
        hours={24}
        loading={false}
        mode="comparison"
        price={[
          {
            t: sourceAt,
            price: 184.52,
            currency: "USD",
            collector: "yahoo_chart",
            retrievedAt: sourceAt + 60_000,
            adapterVersion: "fixture",
            deliveryId: "test-delivery-1",
          },
          {
            t: sourceAt + 15 * 60_000,
            price: 185.04,
            currency: "USD",
            collector: "yahoo_chart",
            retrievedAt: sourceAt + 16 * 60_000,
            adapterVersion: "fixture",
            deliveryId: "test-delivery-2",
          },
        ]}
        currency="USD"
        latestPriceAt={sourceAt + 15 * 60_000}
        latestScoreAvailableAt={null}
      />,
    );

    assert.match(html, /Inspect plotted data by keyboard/);
    assert.match(html, /No saved Jev score buckets are available in this window\./);
    assert.match(html, /Saved Yahoo share-price observations/);
    assert.match(html, /USD 184\.52/);
    assert.match(html, /USD 185\.04/);
    assert.doesNotMatch(html, /Saved Jev score buckets in the selected chart window/);
  });

  it("preserves price loading and failure states instead of reporting an empty window", () => {
    const base = {
      points: [],
      hours: 24,
      loading: false,
      mode: "comparison" as const,
      price: [],
      currency: null,
      latestPriceAt: null,
      latestScoreAvailableAt: null,
    };

    const loadingMarkup = renderToStaticMarkup(
      <SeriesChart {...base} priceLoading />,
    );
    assert.match(loadingMarkup, /Loading saved price history/);
    assert.doesNotMatch(loadingMarkup, /No saved Yahoo price points in this window/);

    const failedMarkup = renderToStaticMarkup(
      <SeriesChart {...base} priceError />,
    );
    assert.match(failedMarkup, /Price history unavailable/);
    assert.doesNotMatch(failedMarkup, /No saved Yahoo price points in this window/);
  });

  it("preserves Jev loading and failure states when the price pane has data", () => {
    const sourceAt = Date.parse("2026-09-29T14:30:00.000Z");
    const price = [{
      t: sourceAt,
      price: 184.52,
      currency: "USD",
      collector: "yahoo_chart" as const,
      retrievedAt: sourceAt + 60_000,
      adapterVersion: "fixture",
      deliveryId: "test-delivery",
    }];
    const base = {
      points: [],
      hours: 24,
      loading: false,
      mode: "comparison" as const,
      price,
      currency: "USD",
      latestPriceAt: sourceAt,
      latestScoreAvailableAt: null,
    };

    const loadingMarkup = renderToStaticMarkup(
      <SeriesChart {...base} seriesReady={false} />,
    );
    assert.match(loadingMarkup, /Loading saved Jev score history/);
    assert.doesNotMatch(loadingMarkup, /No saved Jev score buckets are available/);

    const failedMarkup = renderToStaticMarkup(
      <SeriesChart {...base} seriesReady={false} seriesError />,
    );
    assert.match(failedMarkup, /Saved Jev score history could not be loaded/);
    assert.doesNotMatch(failedMarkup, /No saved Jev score buckets are available/);
    assert.match(failedMarkup, /Saved Yahoo share-price observations/);
  });
});
