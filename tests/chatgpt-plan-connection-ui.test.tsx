import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chatGPTPlanHeading, ChatGPTPlanConnection } from "../web/src/components/ChatGPTPlanConnection.js";

describe("ChatGPT plan connection disclosure", () => {
  it("explains what account connection shares without exposing operator controls", () => {
    const html = renderToStaticMarkup(createElement(ChatGPTPlanConnection));

    expect(html).toContain("name, email, and profile picture");
    expect(html).toContain("Allowing plan usage is a separate choice");
    expect(html).toContain("The Desk cannot see your remaining plan allowance");
    expect(html).toContain("Only public source text is eligible for this chart");
    expect(html).toContain("Check ChatGPT plan usage");
    expect(html).toMatch(/private notes.*separate item-specific confirmation/i);
    expect(html).not.toMatch(/request scope|source-use approval|external requests are disabled|localhost|loopback/i);
  });
});

describe("ChatGPT plan status wording", () => {
  it("distinguishes available access, verified model access, and paused processing", () => {
    expect(chatGPTPlanHeading(null, true)).toBe("Checking account connection…");
    expect(chatGPTPlanHeading(null, false)).toBe("Luna access status unavailable");
    expect(chatGPTPlanHeading({ configured: true, connected: false, modelAvailable: false, ready: false }, false))
      .toBe("Connect your ChatGPT plan");
    expect(chatGPTPlanHeading({ configured: false, connected: false, modelAvailable: false, ready: false }))
      .toBe("Luna access is unavailable right now");
    expect(chatGPTPlanHeading({ configured: true, connected: true, modelAvailable: false, ready: false }))
      .toBe("GPT-6 Luna is unavailable on this ChatGPT plan");
    expect(chatGPTPlanHeading({ configured: true, connected: true, modelAvailable: null, ready: false }))
      .toBe("Checking GPT-6 Luna access");
    expect(chatGPTPlanHeading({ configured: true, connected: true, modelAvailable: true, ready: false }))
      .toBe("GPT-6 Luna is paused");
    expect(chatGPTPlanHeading({ configured: true, connected: true, modelAvailable: true, ready: true }))
      .toBe("GPT-6 Luna is ready");
  });
});
