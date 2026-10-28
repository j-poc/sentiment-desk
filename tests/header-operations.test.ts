import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Header } from "../web/src/components/Header.js";

describe("user-facing header", () => {
  it("does not expose provider setup, request accounting, or diagnostics", () => {
    const html = renderToStaticMarkup(createElement(Header, {
      totalMentions: 57, clock: 1_790_000_000_000,
    }));

    expect(html).toContain("57 source records retrieved in 24h");
    expect(html).not.toMatch(/SAVED ONLY|LUNA PAUSED|ChatGPT|local requests|APP CONNECTED|operations/i);
  });
});
