import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecIssuerDirectory } from "../web/src/components/SecIssuerDirectory.js";

describe("company search user surface", () => {
  it("keeps source permissions, storage details, and receipt hashes out of the user view", () => {
    const html = renderToStaticMarkup(createElement(SecIssuerDirectory));

    expect(html).toContain("Find a company to research");
    expect(html).toContain("SEC company ticker list");
    expect(html).toContain("company search is temporarily unavailable");
    expect(html).not.toMatch(/request scope|source-use approval|SHA-256|CIK-scoped|Load SEC issuer directory|Vercel|Supabase/i);
  });
});
