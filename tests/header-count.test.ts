import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Header } from "../web/src/components/Header.js";
import { StatusBar } from "../web/src/components/StatusBar.js";

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

  it("shows the stream as connecting until the first successful connection", () => {
    const html = renderToStaticMarkup(createElement(Header, {
      connected: null,
      health: null,
      totalMentions: 0,
      clock: Date.now(),
    }));

    expect(html).toContain("APP CONNECTING");
    expect(html).not.toContain("APP DISCONNECTED");
    expect(html).toContain('role="status" aria-label="App connecting"');
    expect(html).toContain('class="header-connectivity-label"');

    const footer = renderToStaticMarkup(createElement(StatusBar, {
      health: null,
      session: { state: "closed", label: "MARKET CLOSED", etClock: "18:00:00 ET" },
      connected: null,
      tape: [],
    }));
    expect(footer).toContain("app connecting");
    expect(footer).not.toContain("app disconnected");
  });

  it("distinguishes an opened stream from a failed stream in both status indicators", () => {
    for (const [connected, label] of [[true, "connected"], [false, "disconnected"]] as const) {
      const header = renderToStaticMarkup(createElement(Header, {
        connected,
        health: null,
        totalMentions: 0,
        clock: Date.now(),
      }));
      const footer = renderToStaticMarkup(createElement(StatusBar, {
        health: null,
        session: { state: "closed", label: "MARKET CLOSED", etClock: "18:00:00 ET" },
        connected,
        tape: [],
      }));
      expect(header).toContain(`APP ${label.toUpperCase()}`);
      expect(header).toContain(`aria-label="App ${label}"`);
      expect(footer).toContain(`app ${label}`);
    }
  });
});
