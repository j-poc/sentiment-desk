import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../web/src/App.js";
import { SourceCoverageDisclosure } from "../web/src/components/SourceCoverageDisclosure.js";

describe("Desk source coverage disclosure", () => {
  it("makes the partial configured-feed scope explicit in rendered markup", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('role="note"');
    expect(html).toContain("Configured feeds only.");
    expect(html).toContain("does not cover the entire public web or all investor activity");
    expect(html).toContain("Collection scope and gaps");
    expect(html).toContain("RSS reads one response per company with no pagination or provider completeness signal, so its coverage is unknown and may be incomplete");
    expect(html).toContain("flags its 250-row cap as partial");
    expect(html).toContain("Finnhub company news uses a three-day window");
    expect(html).toContain("X recent search is bounded to seven days");
    expect(html).toContain("Not directly collected:");
    expect(html).toContain("app-store reviews, search trends, YouTube or podcast transcripts");
    expect(html).toContain("Reddit and X are the only direct social collectors");
    expect(html).toContain("Feed access does not by itself establish rights");
    expect(html).toContain("SOURCE_RIGHTS_APPROVED_COLLECTORS");
    expect(html).toContain("OPENAI_ACCOUNT_USE_APPROVED=true");
    expect(html).toContain("finite daily request, byte and dollar limits");
    expect(html).toContain("operator attestations");
    expect(html).toContain("Checking source, classifier, and webhook status");
    expect(html).not.toContain("External requests are paused.");
  });

  it("keeps paused external requests and saved-data mode visible", () => {
    const html = renderToStaticMarkup(createElement(SourceCoverageDisclosure, { externalRequestsEnabled: false }));

    expect(html).toContain("External requests are paused.");
    expect(html).toContain("uses only data and price history already saved locally.");
  });

  it("does not infer an external request switch from unknown health", () => {
    const html = renderToStaticMarkup(createElement(SourceCoverageDisclosure, { externalRequestsEnabled: null }));

    expect(html).not.toContain("External requests are paused.");
    expect(html).toContain("Collection scope and gaps");
  });
});
