import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalLunaSettings } from "../web/src/components/LocalLunaSettings.js";

describe("local Luna settings", () => {
  it("puts ChatGPT-plan access ahead of optional API-key providers", () => {
    const html = renderToStaticMarkup(createElement(LocalLunaSettings));
    expect(html).toContain("Checking account connection");
    expect(html).toContain("Continue with ChatGPT");
    expect(html).toContain("MODEL PROVIDERS");
    expect(html.indexOf("CHATGPT PLAN")).toBeLessThan(html.indexOf("MODEL PROVIDERS"));
    expect(html).toContain("Only public source text is eligible for this chart");
  });
});
