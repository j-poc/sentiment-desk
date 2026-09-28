import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../web/src/App.js";

describe("Desk source coverage disclosure", () => {
  it("makes the partial configured-feed scope explicit in rendered markup", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('role="note"');
    expect(html).toContain("Configured feeds only.");
    expect(html).toContain("does not cover the entire public web or all investor activity");
  });
});
