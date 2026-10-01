import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunEvidenceBrief, FirstRunNoLocalData } from "../web/src/components/FirstRunEvidenceBrief.js";

const archivedRun = {
  label: "Archived real-source SEC-to-Jev run", company: "Tesla, Inc.", ticker: "TSLA",
  sourceTitle: "SEC 8-K filing", sourceUrl: "https://www.sec.gov/filing", sourcePublishedAt: 1_790_714_330_000,
  filedAt: 1_790_640_000_000,
  collectedAt: 1_790_847_689_506, scoredAt: 1_790_847_689_800, receiptId: "receipt", receiptDigest: "digest",
  sourceAdapter: "sec-primary-document/1", sentiment: "neutral" as const, eventType: "corporate_action",
  model: "jev-1.13.0", confidence: 0.54, requestDigest: "request", rubricDigest: "rubric",
};

describe("FirstRunEvidenceBrief", () => {
  it("distinguishes unknown from empty and exposes provenance through keyboard-native disclosure", () => {
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="error" />)).toContain("cannot determine whether this is a first run");
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="error" localObservationArrived />)).toBe("");
    expect(renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={1} secCollectorEnabled={false} jevSecScoringEnabled={false} archivedRun={null} />)).toBe("");
    const markup = renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={0} secCollectorEnabled={false} jevSecScoringEnabled={false} archivedRun={archivedRun} />);
    expect(markup).toContain("<details");
    expect(markup).toContain("Archived SEC-to-Jev run");
    expect(markup).not.toContain("Archived SEC-to-Jev verification");
    expect(markup).toContain("<summary>Recorded run references · not locally verifiable</summary>");
    expect(markup).toContain("recorded references rather than locally resolvable evidence");
    expect(markup).toContain("excluded from Desk statistics");
    expect(markup).toContain("No eligible saved observations");
    expect(markup).toContain("filed");
    expect(markup).toContain("Jev reported:");
    expect(markup).toContain("confidence 54% (not calibrated)");
    expect(markup).toContain("calibration not assessed");
    expect(markup).toContain("Recorded source receipt");
    expect(markup).toContain("Recorded request digest");
    expect(markup).toContain("Recorded rubric digest");
    expect(markup).toContain("target=\"_blank\" rel=\"noreferrer\"");
    expect(markup).not.toContain("button");
  });

  it("hides the archive as soon as an eligible local observation arrives", () => {
    const markup = renderToStaticMarkup(<FirstRunEvidenceBrief state="ready" eligibleObservationCount={0} secCollectorEnabled={false} jevSecScoringEnabled={false} archivedRun={archivedRun} localObservationArrived />);
    expect(markup).toBe("");
  });

  it("explains why a selected company has no chart without borrowing archive data", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" secCollectorEnabled={false} jevSecScoringEnabled={false} />);
    expect(markup).toContain("Apple · AAPL");
    expect(markup).toContain("no company trend to chart");
    expect(markup).toContain("eligible source-attributed observations");
    expect(markup).toContain("does not supply this company’s data");
    expect(markup).toContain("Next step:");
    expect(markup).not.toContain("Next step: Next:");
    expect(markup).toContain("approve SEC collection");
    expect(markup).toContain("<details");
  });

  it("keeps the empty chart hidden when the saved-history check is unresolved", () => {
    const checking = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="checking" secCollectorEnabled={false} jevSecScoringEnabled={false} />);
    expect(checking).toContain("checking local history");
    expect(checking).not.toContain("No eligible source-attributed observations");
    const unavailable = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="unavailable" secCollectorEnabled={false} jevSecScoringEnabled={false} />);
    expect(unavailable).toContain("Chart availability is unknown");
    expect(unavailable).toContain("retry automatically");
    expect(unavailable).not.toContain("No eligible source-attributed observations");
  });

  it("does not confuse another Jev allowlist with SEC scoring readiness", () => {
    const markup = renderToStaticMarkup(<FirstRunNoLocalData company="Apple" ticker="AAPL" state="empty" secCollectorEnabled={true} jevSecScoringEnabled={false} />);
    expect(markup).toContain("enable Jev for SEC filings");
    expect(markup).toContain("SEC collection is enabled");
    expect(markup).toContain("SEC source allowlist");
  });
});
