import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunEvidenceBrief, FirstRunNoLocalData } from "../web/src/components/FirstRunEvidenceBrief.js";

describe("first-run evidence states", () => {
  it("shows the real empty state without substituting an archived result", () => {
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="error" />)).toContain("cannot determine whether this is a first run");
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="error" localObservationArrived />)).toBe("");
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={1} secCollectorEnabled={false} jevSecScoringEnabled={false} />)).toBe("");
    const markup = renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={0} secCollectorEnabled={false} jevSecScoringEnabled={false} onOpenOperations={() => undefined} onOpenDisclosures={() => undefined} />);
    expect(markup).toContain("No eligible saved observations");
    expect(markup).toContain("Start with real saved evidence");
    expect(markup).toContain("no archived samples or demonstration results");
    expect(markup).toContain("External requests remain under explicit operator controls");
    expect(markup).toContain("Open Sources &amp; operations");
    expect(markup).toContain("Browse recent SEC filings");
    expect(markup).not.toMatch(/Tesla|TSLA|Archived SEC|jev-1\.13/);
    expect(markup).not.toContain("example");
  });

  it("explains why a selected company has no chart and keeps the state truthful", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" secCollectorEnabled={false} classifierSecClassificationEnabled={false} />);
    expect(markup).toContain("Apple · AAPL");
    expect(markup).toContain("no company trend to chart");
    expect(markup).toContain("eligible saved source observations");
    expect(markup).toContain("does not substitute archived samples or demonstration data");
    expect(markup).toContain("Next step:");
    expect(markup).not.toContain("Next step: Next:");
    expect(markup).toContain("approve SEC collection");
    expect(markup).toContain("<details");
  });

  it("keeps the empty chart hidden when the saved-history check is unresolved", () => {
    const checking = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="checking" secCollectorEnabled={false} />);
    expect(checking).toContain("checking local history");
    expect(checking).not.toContain("No eligible saved source observations");
    const unavailable = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="unavailable" secCollectorEnabled={false} />);
    expect(unavailable).toContain("Chart availability is unknown");
    expect(unavailable).toContain("retry automatically");
    expect(unavailable).not.toContain("No eligible saved source observations");
  });

  it("does not confuse another collector allowlist with SEC Luna readiness", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" secCollectorEnabled={true} classifierSecClassificationEnabled={false} />);
    expect(markup).toContain("enable Luna for SEC filings");
    expect(markup).toContain("SEC collection is enabled");
    expect(markup).toContain("SEC source allowlist");
  });

  it("directs new Luna installations to the selected provider while preserving historical Jev semantics", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" secCollectorEnabled={true} classifierSecClassificationEnabled={false} classifierBlockedReason="OpenAI API key missing" />);
    expect(markup).toContain("enable Luna for SEC filings");
    expect(markup).toContain("dollar limits");
    expect(markup).toContain("OpenAI API key missing");
    expect(markup).not.toContain("enable Jev for SEC");
    expect(markup).toContain("separate from historical Jev probabilities");
  });
});
