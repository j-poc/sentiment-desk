import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Header } from "../web/src/components/Header.js";
import { StatusBar } from "../web/src/components/StatusBar.js";

describe("header source retrieval count", () => {
  it("uses a singular retrieval label for one recent source record", () => {
    const html = renderToStaticMarkup(createElement(Header, {
      totalMentions: 1,
      clock: Date.now(),
    }));

    expect(html).toContain("1 source record retrieved in 24h");
  });

  it("keeps application connection state out of the user header", () => {
    const html = renderToStaticMarkup(createElement(Header, {
      totalMentions: 0,
      clock: Date.now(),
    }));

    expect(html).not.toMatch(/APP CONNECTING|APP CONNECTED|APP DISCONNECTED|local requests today|est\./i);

    const footer = renderToStaticMarkup(createElement(StatusBar, {
      health: null,
      session: { state: "closed", label: "MARKET CLOSED", etClock: "18:00:00 ET" },
      connected: null,
      tape: [],
    }));
    expect(footer).toContain("app connecting");
    expect(footer).not.toContain("app disconnected");
  });

  it("keeps source retrieval context while omitting internal usage and transport counters", () => {
      const header = renderToStaticMarkup(createElement(Header, {
        totalMentions: 57,
        clock: Date.now(),
      }));
      const footer = renderToStaticMarkup(createElement(StatusBar, {
        health: null,
        session: { state: "closed", label: "MARKET CLOSED", etClock: "18:00:00 ET" },
        connected: true,
        tape: [],
      }));
      expect(header).toContain("57 source records retrieved in 24h");
      expect(header).not.toContain("APP CONNECTED");
      expect(footer).toContain("app connected");
  });
});
