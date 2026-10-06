import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { HistoricalJevCaveat } from "../web/src/components/HistoricalJevCaveat.js";

describe("historical Jev chart interpretation", () => {
  it("puts per-bucket lineage and time-basis limits in an accessible note", () => {
    const html = renderToStaticMarkup(<HistoricalJevCaveat />);
    assert.match(html, /role="note"/);
    assert.match(html, /Check bucket lineage before interpreting a score/);
    assert.match(html, /Hover a bar or inspect the keyboard table for its receipt links and exact-title repeat cues/);
    assert.match(html, /A title match does not prove duplicate stories or independent sources/);
    assert.match(html, /not current Luna analysis or validated investor sentiment/);
  });
});
