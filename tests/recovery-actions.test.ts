import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutcomeCheckLoadState, OutcomeCheckRefreshNotice } from "../web/src/components/OutcomeCheck.js";
import { CompanyInventoryState } from "../web/src/components/CompanyInventoryState.js";

describe("initial-load recovery controls", () => {
  it("offers a retry when the outcome summary fails before any data is available", () => {
    const markup = renderToStaticMarkup(createElement(OutcomeCheckLoadState, {
      ticker: "ACME",
      failed: true,
      onRetry: () => undefined,
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Retry loading outcome data"');
  });

  it("offers a retry when refresh fails after outcome data was already displayed", () => {
    const markup = renderToStaticMarkup(createElement(OutcomeCheckRefreshNotice, {
      onRetry: () => undefined,
    }));

    expect(markup).toContain("refresh failed · showing prior data");
    expect(markup).toContain('aria-label="Retry refreshing outcome data"');
  });

  it("offers a retry when the company inventory cannot load before the main pane can render a selection", () => {
    const markup = renderToStaticMarkup(createElement(CompanyInventoryState, {
      state: "failed",
      onRetry: () => undefined,
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Retry loading company inventory"');
  });
});
