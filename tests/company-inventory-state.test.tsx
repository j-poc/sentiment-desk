import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyInventoryState } from "../web/src/components/CompanyInventoryState.js";

describe("company inventory empty state", () => {
  it("describes inventory loading instead of implying the app is connecting", () => {
    const html = renderToStaticMarkup(createElement(CompanyInventoryState, {
      state: "loading",
      onRetry: vi.fn(),
    }));

    expect(html).toContain("Loading the company inventory…");
    expect(html).not.toContain("Connecting");
    expect(html).not.toContain("the desk");
    expect(html).toContain('role="status"');
  });

  it("names the inventory in failure and ready-empty states and exposes an accurate retry label", () => {
    const failedHtml = renderToStaticMarkup(createElement(CompanyInventoryState, {
      state: "failed",
      onRetry: vi.fn(),
    }));
    const readyHtml = renderToStaticMarkup(createElement(CompanyInventoryState, {
      state: "ready",
      onRetry: vi.fn(),
    }));

    expect(failedHtml).toContain("Could not load the company inventory.");
    expect(failedHtml).toContain('role="alert"');
    expect(failedHtml).toContain('aria-label="Retry loading company inventory"');
    expect(readyHtml).toContain("The company inventory is empty.");
    expect(readyHtml).toContain('aria-label="Retry loading company inventory"');
  });
});
