import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { SeriesChart } from "../web/src/components/SeriesChart.js";
import type { SeriesPoint } from "../web/src/lib/api.js";

function scorePoint(
  t: number,
  v: number | null,
  n: number,
  min: number | null,
  max: number | null,
  latest: number | null,
  sourceLineage?: SeriesPoint["sourceLineage"],
): SeriesPoint {
  return {
    bucketStartAtMs: t - 15 * 60_000,
    bucketEndAtMs: t,
    bucketSnapshotKey: n > 0 ? "a".repeat(64) : null,
    weightedMeanImpact: v,
    scoredRecordCount: n,
    recordImpactMin: min,
    recordImpactMax: max,
    latestRecordScoredAtMs: latest,
    ...(sourceLineage ? { sourceLineage } : {}),
    t, v, n, itemImpactMin: min, itemImpactMax: max, lastScoredAt: latest,
  };
}

function htmlDivRegion(html: string, marker: string): string {
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker}`);
  const openTagStart = html.lastIndexOf("<div", markerIndex);
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = openTagStart;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) != null) {
    if (match[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(openTagStart, tags.lastIndex);
  }
  assert.fail(`unclosed div containing ${marker}`);
}

describe("chart keyboard data inspection", () => {
  it("anchors plot overlays to the canvas and keeps controls outside that frame", () => {
    const timestamp = Date.parse("2026-09-28T10:15:00.000Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(timestamp, 42, 1, 42, 42, timestamp)]}
        hours={168}
        range={{ fromMs: Date.parse("2026-09-28T00:00:00.000Z"), throughMs: Date.parse("2026-10-05T00:00:00.000Z") }}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={timestamp}
      />,
    );

    const frame = htmlDivRegion(html, 'data-chart-overlay-frame="true"');
    assert.match(frame, /Discrete histogram of observed Jev score-time buckets/);
    assert.match(html, /grouped by Jev score-completion time, not article publication, public-discussion volume, investor activity, or share-price changes/);
    assert.match(html, /Select a bucket to inspect source clocks, repeated-title cues, and delivery-receipt links/);
    assert.match(frame, /SCORED RECORDS \/ 15M/);
    assert.match(frame, /chart-canvas-tooltip/);
    assert.doesNotMatch(frame, /aria-label="Chart time range"/);
    assert.ok(html.indexOf('aria-label="Chart time range"') > html.indexOf(frame) + frame.length);
  });

  it("offers a fit-to-scores view without discarding the selected archive week", () => {
    const timestamp = Date.parse("2026-09-28T10:15:00.000Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(timestamp, 42, 1, 42, 42, timestamp)]}
        hours={168}
        range={{ fromMs: Date.parse("2026-09-28T00:00:00.000Z"), throughMs: Date.parse("2026-10-05T00:00:00.000Z") }}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={timestamp}
      />,
    );

    assert.match(html, /aria-label="Chart time range"/);
    assert.match(html, /aria-pressed="true"[^>]*>Fit scores/);
    assert.match(html, /aria-pressed="false"[^>]*>Full week/);
    assert.ok(html.indexOf('role="img" aria-label="Discrete histogram of observed Jev score-time buckets.') < html.indexOf('aria-label="Chart time range"'));
    assert.match(html, /Plot span \(UTC, end exclusive\) · Sep 28 09:07:30 to before 11:07:30/);
    assert.match(html, /Plot · Sep 28 09:07–11:07 UTC/);
    assert.match(html, /visible plot span is 2026-09-28T09:07:30\.000Z to before 2026-09-28T11:07:30\.000Z; the selected archive week is 2026-09-28T00:00:00\.000Z to before 2026-10-05T00:00:00\.000Z/);
  });

  it("shows each archive bucket's receipt and repeated-title cues in its keyboard data row", () => {
    const timestamp = Date.parse("2026-09-28T10:15:00.000Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(timestamp, -23.2, 50, -100, 97, timestamp, {
          recordCount: 50,
          receiptLinkedRecordCount: 0,
          repeatedTitleRecordCount: 11,
          exactNormalizedTitleCount: 44,
        })]}
        hours={168}
        range={{ fromMs: Date.parse("2026-09-28T00:00:00.000Z"), throughMs: Date.parse("2026-10-05T00:00:00.000Z") }}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={timestamp}
      />,
    );

    assert.match(html, /Source delivery lineage/);
    assert.match(html, /0\/50 receipt-linked/);
    assert.match(html, /11\/50 rows in repeated exact-title groups/);
    assert.match(html, /Repeated-title counts are cues only/);
    assert.match(html, /do not prove duplicate stories or independent publishers/);
  });

  it("contains duplicate timestamps and withholds those rows accessibly", () => {
    const boundary = Date.parse("2026-09-29T14:45:00.420Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[
          scorePoint(boundary, -12, 1, -12, -12, boundary),
          scorePoint(boundary, 34, 1, 34, 34, boundary),
        ]}
        hours={24}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={boundary}
      />,
    );

    assert.match(html, /role="alert"/);
    assert.match(html, /Score history is withheld because the response contains invalid score timestamps or duplicate UTC bucket times/);
    assert.doesNotMatch(html, /View 1 source record/);
  });

  it("withholds malformed out-of-range bucket and freshness timestamps without crashing", () => {
    const valid = Date.parse("2026-09-29T14:45:00.420Z");
    const malformed = scorePoint(Number.MAX_SAFE_INTEGER, 12, 1, 12, 12, Number.MAX_SAFE_INTEGER);
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[malformed]}
        hours={24}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={valid}
      />,
    );

    assert.match(html, /role="alert"/);
    assert.match(html, /invalid score timestamps or duplicate UTC bucket times/);
    assert.doesNotMatch(html, /View 1 source record/);
  });

  it("keeps both exact source rows inspectable when adjacent bucket ends share a display second", () => {
    const boundary = Date.parse("2026-09-29T14:45:00.000Z");
    const previous = scorePoint(boundary, -12, 1, -12, -12, boundary);
    const current = scorePoint(boundary + 420, 34, 1, 34, 34, boundary + 420);
    current.bucketStartAtMs = boundary;
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[previous, current]}
        hours={24}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={boundary + 420}
      />,
    );

    assert.match(html, /Plot positions preserve each bucket/);
    assert.equal((html.match(/View 1 source record/g) ?? []).length, 2);
    assert.match(html, /-12\.0/);
    assert.match(html, /34\.0/);
  });

  it("exposes each saved comparison price with currency, provider time, and collected time", () => {
    const sourceAt = Date.parse("2026-09-29T14:30:00.000Z");
    const retrievedAt = Date.parse("2026-09-29T14:31:12.000Z");
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(sourceAt, 24, 2, -12, 40, sourceAt)]}
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
    assert.match(html, /Weighted mean impact/);
    assert.match(html, /Record spread \(impact points\)/);
    assert.match(html, /not a confidence interval/i);
    assert.doesNotMatch(html, /modeled decay/i);
  });

  it("reports a confirmed empty price window without implying missing score history", () => {
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(Date.parse("2026-09-29T14:30:00.000Z"), -8, 1, -8, -8, Date.parse("2026-09-29T14:30:00.000Z"))]}
        hours={24}
        loading={false}
        mode="comparison"
        price={[]}
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={null}
      />,
    );

    assert.match(html, /No verified Yahoo price points are saved in this window/);
    assert.doesNotMatch(html, /Price history unavailable/);
  });

  it("explains that legacy rows are quarantined across all saved history when the verified window is empty", () => {
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(Date.parse("2026-09-29T14:30:00.000Z"), -8, 1, -8, -8, Date.parse("2026-09-29T14:30:00.000Z"))]}
        hours={24} loading={false} mode="comparison" price={[]} currency={null}
        latestPriceAt={null} latestScoreAvailableAt={null}
        priceQuarantine={{ legacyUnknownRows: 2883, scope: "all_saved_history" }}
      />,
    );
    assert.match(html, /No verified Yahoo price points are saved in this window/);
    assert.match(html, /2,883 legacy price rows are excluded because their source provenance is incomplete/);
    assert.match(html, /count covers all saved history for this ticker/);
  });

  it("distinguishes a confirmed zero legacy count from unavailable or malformed metadata", () => {
    const base = {
      points: [], hours: 24, loading: false, mode: "comparison" as const, price: [], currency: null,
      latestPriceAt: null, latestScoreAvailableAt: null,
    };
    const zero = renderToStaticMarkup(<SeriesChart {...base} priceQuarantine={{ legacyUnknownRows: 0, scope: "all_saved_history" }} />);
    const missing = renderToStaticMarkup(<SeriesChart {...base} />);
    const malformed = renderToStaticMarkup(<SeriesChart {...base} priceQuarantine={{ legacyUnknownRows: -1, scope: "all_saved_history" } as never} />);
    assert.match(zero, /No legacy unknown-source price rows were found in all saved history for this ticker/);
    assert.match(missing, /Legacy unknown-source price row count is unavailable/);
    assert.match(malformed, /Legacy unknown-source price row count is unavailable/);
    assert.doesNotMatch(missing, /0 legacy price rows/);
    assert.doesNotMatch(malformed, /0 legacy price rows/);
  });

  it("does not show a prior quarantine count during loading or after a stale transport error", () => {
    const base = {
      points: [], hours: 24, loading: false, mode: "comparison" as const, price: [], currency: null,
      latestPriceAt: null, latestScoreAvailableAt: null,
      priceQuarantine: { legacyUnknownRows: 2883, scope: "all_saved_history" as const },
    };
    const loading = renderToStaticMarkup(<SeriesChart {...base} priceLoading />);
    const error = renderToStaticMarkup(<SeriesChart {...base} priceError />);
    assert.doesNotMatch(loading, /2,883 legacy price rows/);
    assert.doesNotMatch(error, /2,883 legacy price rows/);
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
    assert.doesNotMatch(loadingMarkup, /No verified Yahoo price points are saved in this window/);

    const failedMarkup = renderToStaticMarkup(
      <SeriesChart {...base} priceError />,
    );
    assert.match(failedMarkup, /Price history unavailable/);
    assert.doesNotMatch(failedMarkup, /No verified Yahoo price points are saved in this window/);
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

  it("offers saved history without inventing a value for the empty selected window", () => {
    const now = Date.now();
    const latestScoreAt = now - 48 * 60 * 60_000;
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(now - 30 * 60_000, null, 0, null, null, null)]}
        hours={24}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={latestScoreAt}
        onViewHistory={() => undefined}
      />,
    );

    assert.match(html, /No saved scores in this window/);
    assert.match(html, /latest saved score 2d ago/);
    assert.match(html, /Show 7D history/);
    assert.match(html, /Show the last 7 days of saved Jev history/);
    assert.doesNotMatch(html, /decay/);
  });

  it("keeps the last scored timestamp as freshness metadata, not as a carried chart value", () => {
    const now = Date.now();
    const latestScoreAt = now - 48 * 60 * 60_000;
    const html = renderToStaticMarkup(
      <SeriesChart
        points={[scorePoint(now - 30 * 60_000, null, 0, null, null, null)]}
        hours={24}
        loading={false}
        mode="sentiment"
        currency={null}
        latestPriceAt={null}
        latestScoreAvailableAt={latestScoreAt}
        onViewHistory={() => undefined}
      />,
    );

    assert.match(html, /No saved scores in this window · latest saved score 2d ago/);
    assert.match(html, /Show 7D history/);
    assert.doesNotMatch(html, /modeled/);
  });
});
