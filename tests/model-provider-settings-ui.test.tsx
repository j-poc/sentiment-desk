import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelProviderSettings } from "../web/src/components/ModelProviderSettings.js";

describe("local provider key setup", () => {
  it("distinguishes Gemini free-quota uncertainty, metered OpenAI API, and separate Jev controls", () => {
    const html = renderToStaticMarkup(createElement(ModelProviderSettings));
    expect(html).toContain("Add your own API key");
    expect(html).toContain("Google Gemini API · free only where permitted");
    expect(html).toContain("GPT-6 Luna");
    expect(html).toContain("TypeSafe Jev");
    expect(html).toContain("Google lists free input and output quota for eligible models and projects in regions where free-tier use is allowed");
    expect(html).toContain("professional or business purposes, not consumer use");
    expect(html).toContain("cannot determine whether your personal or retail-investing use meets that requirement");
    expect(html).toContain("to use Paid Services through a Cloud project with active billing");
    expect(html).toContain("a free-tier-only project is not eligible there");
    expect(html).toContain("Gemini 3.8 Flash paid-tier usage is metered");
    expect(html).toContain("If you require strictly $0 use in those regions, do not send Gemini requests");
    expect(html).not.toContain("eligible quota may still be free");
    expect(html).toContain("active billing");
    expect(html).toContain("For API clients made available in the EEA, Switzerland, and UK, Google requires Paid Services through a project with active billing");
    expect(html).toContain("private notes are never sent through Gemini");
    expect(html).toContain("Get a Gemini API key");
    expect(html).toContain('href="https://aistudio.google.com/apikey"');
    expect(html).toContain("API billing is separate from ChatGPT plans");
    expect(html).toContain("Local usage caps are not a provider billing limit or balance");
    expect(html).toContain("Jev uses its own rubric and a separate source history");
    expect(html).toContain("Save key");
    expect(html).toContain("Verify model access");
    expect(html).not.toContain("Supabase project URL");
    expect(html).not.toContain("Environment variables");
    expect(html).toContain('class="mt-3 grid gap-3 md:grid-cols-2"');
    expect(html).not.toContain("xl:grid-cols-3");
  });

  it("puts Gemini first and labels free access as region and project dependent", () => {
    const html = renderToStaticMarkup(createElement(ModelProviderSettings));
    expect(html.indexOf("Google Gemini API · free only where permitted")).toBeLessThan(html.indexOf("OpenAI API · GPT-6 Luna"));
    expect(html.indexOf("OpenAI API · GPT-6 Luna")).toBeLessThan(html.indexOf("TypeSafe Jev"));
  });
});
