import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Header } from "../web/src/components/Header.js";

describe("header source retrieval count", () => {
  it("uses a singular retrieval label for one recent source record", () => {
    const html = renderToStaticMarkup(createElement(Header, {
      connected: true,
      health: null,
      totalMentions: 1,
      clock: Date.now(),
    }));

    expect(html).toContain("1 source record retrieved in 24h");
  });
});
