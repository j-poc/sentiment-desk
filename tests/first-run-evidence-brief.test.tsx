import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunEvidenceBrief, FirstRunNoLocalData } from "../web/src/components/FirstRunEvidenceBrief.js";

describe("first-run evidence states", () => {
  it("shows the real empty state without substituting an archived result", () => {
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="error" />)).toContain("cannot determine whether this is a first run");
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="error" localObservationArrived />)).toBe("");
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={1} secCollectorEnabled={false} jevSecScoringEnabled={false} />)).toBe("");
    const markup = renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={0} secCollectorEnabled={false} jevSecScoringEnabled={false} onOpenDisclosures={() => undefined} onOpenOperations={() => undefined} />);
    expect(markup).toContain("No eligible saved observations");
    expect(markup).toContain("No saved evidence to start from");
    expect(markup).toContain("empty result is not neutral sentiment");
    expect(markup).toContain("fixed company list; tickerless small-cap discovery is not available yet");
    expect(markup).toContain("Recent SEC filings are for browsing, not research leads or evidence of investment merit");
    expect(markup).toContain("no demo records fill the gap");
    expect(markup).not.toMatch(/Data connections|operator controls|external requests/);
    expect(markup).toContain("Browse recent SEC filings");
    expect(markup).toContain("Review update availability");
    expect(markup).toContain("Start by browsing filings or checking which source updates are available");
    expect(markup).not.toMatch(/Tesla|TSLA|Archived SEC|jev-1\.13/);
    expect(markup).not.toMatch(/companies? (?:worth|to) (?:investigating|buying)|promising issuers|opportunities/);
    expect(markup).not.toContain("example");
  });

  it("explains why a selected company has no chart and keeps the state truthful", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" />);
    expect(markup).toContain("Apple · AAPL");
    expect(markup).toContain("no company trend to chart");
    expect(markup).toContain("eligible saved source observations");
    expect(markup).toContain("does not substitute archived samples or demonstration data");
    expect(markup).toContain("source links, publication times and collection times");
    expect(markup).not.toMatch(/request scope|source-use approval|operator controls|API key|ChatGPT plan/);
  });

  it("keeps the empty chart hidden when the saved-history check is unresolved", () => {
    const checking = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="checking" />);
    expect(checking).toContain("checking this company’s recent source history");
    expect(checking).not.toContain("No eligible saved source observations");
    const unavailable = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="unavailable" />);
    expect(unavailable).toContain("Chart temporarily unavailable");
    expect(unavailable).toContain("retry automatically");
    expect(unavailable).not.toContain("No eligible saved source observations");
  });

  it("keeps provider and collector setup out of the selected-company empty state", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" />);
    expect(markup).toContain("No chart data yet");
    expect(markup).toContain("Apple · AAPL");
    expect(markup).not.toMatch(/ChatGPT|API key|request scope|source-use approval|collector allowlist|external requests/);
  });
});
