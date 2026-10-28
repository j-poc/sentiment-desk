import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudCoreApp } from "../web/src/components/CloudCoreApp.js";

describe("cloud unavailable state", () => {
  it("does not expose deployment or database setup to the user", () => {
    const html = renderToStaticMarkup(createElement(CloudCoreApp));

    expect(html).toContain("SENTIMENT DESK");
    expect(html).toContain("We can’t open your research desk right now");
    expect(html).not.toMatch(/CLOUD CORE|CLOUD SETUP REQUIRED|Supabase|Vercel|database|backend/i);
  });
});
