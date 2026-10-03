import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { Sparkline } from "../web/src/components/Watchlist.js";
import type { SeriesPoint } from "../web/src/lib/api.js";

function point(at: number, value: number | null, count: number, min: number | null, max: number | null): SeriesPoint {
  return {
    bucketStartAtMs: at - 15 * 60_000,
    bucketEndAtMs: at,
    bucketSnapshotKey: count > 0 ? "b".repeat(64) : null,
    weightedMeanImpact: value,
    scoredRecordCount: count,
    recordImpactMin: min,
    recordImpactMax: max,
    latestRecordScoredAtMs: count ? at : null,
    t: at, v: value, n: count, itemImpactMin: min, itemImpactMax: max, lastScoredAt: count ? at : null,
  };
}

describe("watchlist score sparkline", () => {
  it("uses timestamp-positioned unconnected impact marks and record-spread whiskers", () => {
    const html = renderToStaticMarkup(
      <Sparkline points={[
        point(0, -20, 2, -40, 10),
        point(15 * 60_000, null, 0, null, null),
        point(60 * 60_000, 30, 1, 30, 30),
      ]} width={60} height={20} />,
    );

    assert.match(html, /Discrete weighted mean Jev impact marks/);
    assert.match(html, /gaps/);
    assert.match(html, /whiskers show individual record spread/);
    assert.doesNotMatch(html, /<path/);
    assert.match(html, /cx="0"/);
    assert.match(html, /cx="60"/);
    assert.match(html, /record spread -40 to 10 impact points/);
  });

  it("omits the sparkline when the loaded window has no scored records", () => {
    assert.equal(renderToStaticMarkup(<Sparkline points={[point(1, null, 0, null, null)]} />), "");
  });
});
