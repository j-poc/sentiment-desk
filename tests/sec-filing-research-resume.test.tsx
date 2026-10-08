import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SecFilingResearchTask, SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { SavedSecResearchTaskCard, SavedSecTaskResumeAction } from "../web/src/components/AnalystResearchQueue.js";
import { SavedSecFilingResumeCard, SecFilingInFeedResumeContext, secFilingResumeState } from "../web/src/components/SecFilingsInbox.js";
import { secFilingResumeActionId, secFilingResumeTargetFromTask, type SecFilingResumeTarget } from "../web/src/lib/sec-filing-resume.js";

const task: SecFilingResearchTask = {
  cik: "0000320193",
  issuer: "Apple Inc.",
  triggeringAccession: "0000320193-24-000081",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/0000320193-24-000081-index.htm",
  nextQuestion: "Check the reported supply constraint against the filing.",
  feedReceiptId: "sec-feed-receipt-2024-11-01T12:00:00Z",
  feedUpdatedAt: "2024-11-01T12:00:00.000Z",
  retrievedAt: "2024-11-01T12:00:08.000Z",
  savedAt: "2024-11-01T12:01:00.000Z",
};

const target: SecFilingResumeTarget = {
  requestId: 1,
  cik: task.cik,
  accession: task.triggeringAccession,
  issuer: task.issuer,
  filingUrl: task.filingUrl,
  nextQuestion: task.nextQuestion,
  feedReceiptId: task.feedReceiptId,
  feedUpdatedAt: task.feedUpdatedAt,
  retrievedAt: task.retrievedAt,
};

function feed(overrides: Partial<SecFilingsInboxView> = {}): SecFilingsInboxView {
  return {
    state: "ready",
    freshness: "current",
    rows: [{
      cik: task.cik, accession: task.triggeringAccession, issuer: task.issuer, form: "8-K",
      filedOn: "2024-11-01", acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: "2024-11-01T12:00:00.000Z",
      filingUrl: task.filingUrl,
    }],
    receiptId: task.feedReceiptId,
    retrievedAt: "2024-11-01T12:00:08.000Z",
    feedUpdatedAt: "2024-11-01T12:00:00.000Z",
    jobStatus: "succeeded",
    canActivate: true,
    nextRefreshAt: null,
    message: null,
    ...overrides,
  };
}

describe("resume saved SEC filing tasks in Desk", () => {
  it("opens only an exact CIK and accession match in a current ready feed", () => {
    expect(secFilingResumeState(target, feed(), false, false, Date.parse("2024-11-01T12:01:00Z"))).toBe("open");
    expect(secFilingResumeState(target, feed({ rows: [{ ...feed().rows[0]!, cik: "0000789019" }] }), false, false, Date.parse("2024-11-01T12:01:00Z"))).toBe("rolled_out");
    expect(secFilingResumeState(target, feed({ rows: [{ ...feed().rows[0]!, accession: "0000320193-24-000082" }] }), false, false, Date.parse("2024-11-01T12:01:00Z"))).toBe("rolled_out");
  });

  it("does not treat stale, not-ready, or unavailable feed state as a confirmed resume", () => {
    expect(secFilingResumeState(target, feed({ freshness: "stale" }), false, false, Date.parse("2024-11-01T12:01:00Z"))).toBe("stale");
    expect(secFilingResumeState(target, feed({ state: "pending" }), false, false, Date.parse("2024-11-01T12:01:00Z"))).toBe("stale");
    expect(secFilingResumeState(target, feed({ state: "unavailable" }), false, false, Date.parse("2024-11-01T12:01:00Z"))).toBe("unavailable");
    expect(secFilingResumeState(target, null, true, false)).toBe("wait");
    expect(secFilingResumeState(target, null, false, true)).toBe("unavailable");
  });

  it("exposes an accessible exact-identity resume action without changing task lineage", () => {
    const onResume = vi.fn();
    const html = renderToStaticMarkup(createElement(SavedSecTaskResumeAction, { task, onResume }));
    expect(html).toContain("Resume in Desk");
    expect(html).toContain("CIK 0000320193, accession 0000320193-24-000081");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("keeps the saved question and source clocks visible beside the resume action", () => {
    const onResume = vi.fn();
    const html = renderToStaticMarkup(createElement(SavedSecResearchTaskCard, {
      item: task, value: task.nextQuestion, busy: false, onChange: vi.fn(), onResume,
      onSave: vi.fn(), onRemove: vi.fn(),
    }));
    expect(html).toContain("Check the reported supply constraint against the filing.");
    expect(html).toContain(`Feed receipt ${task.feedReceiptId}`);
    expect(html).toContain("observed 2024-11-01T12:00:00.000Z");
    expect(html).toContain("retrieved 2024-11-01T12:00:08.000Z");
    expect(html).toContain("Resume in Desk");
    expect(onResume).not.toHaveBeenCalled();
    expect(task).toMatchObject({
      nextQuestion: "Check the reported supply constraint against the filing.",
      feedReceiptId: "sec-feed-receipt-2024-11-01T12:00:00Z",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/0000320193-24-000081-index.htm",
    });
  });

  it("hands the exact saved task from the card action into the Desk resume target", () => {
    const onResume = vi.fn();
    const card = SavedSecResearchTaskCard({ item: task, value: task.nextQuestion, busy: false,
      onChange: vi.fn(), onResume, onSave: vi.fn(), onRemove: vi.fn() });
    const actionGroup = Children.toArray(card.props.children)[3];
    if (!isValidElement<{ children: unknown }>(actionGroup)) throw new Error("saved task actions are missing");
    const action = Children.toArray(actionGroup.props.children as ReactNode)[0];
    if (!isValidElement<{ task: SecFilingResearchTask; onResume: (item: SecFilingResearchTask) => void }>(action)
      || action.type !== SavedSecTaskResumeAction) throw new Error("saved task resume action is missing");
    const button = SavedSecTaskResumeAction(action.props);
    const click = button.props.onClick as ((event: never) => void) | undefined;
    if (!click) throw new Error("saved task resume action is not interactive");
    click({} as never);

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(task);
    expect(secFilingResumeTargetFromTask(task, 42)).toEqual({
      requestId: 42, cik: task.cik, accession: task.triggeringAccession, issuer: task.issuer,
      filingUrl: task.filingUrl, nextQuestion: task.nextQuestion, feedReceiptId: task.feedReceiptId,
      feedUpdatedAt: task.feedUpdatedAt, retrievedAt: task.retrievedAt,
    });
  });

  it("offers a deliberate in-Desk inspection after the saved filing leaves the feed", () => {
    const onInspect = vi.fn();
    const html = renderToStaticMarkup(createElement(SavedSecFilingResumeCard, {
      target, detail: null, loading: false, failed: false, onInspect,
    }));
    expect(html).toContain("Inspect saved filing in Desk");
    expect(html).toContain(`id="${secFilingResumeActionId(target, "rolled_out")}"`);
    expect(html).toContain("CIK 0000320193");
    expect(html).toContain("accession 0000320193-24-000081");
    expect(html).toContain("aria-controls=\"saved-sec-resume-evidence\"");
    expect(html).not.toContain("Source text available");
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("keeps the saved question beside the in-feed filing and exposes its focusable inspection action", () => {
    const onInspect = vi.fn();
    const html = renderToStaticMarkup(createElement(SecFilingInFeedResumeContext, { target, onInspect }));
    expect(html).toContain("Exact filing selected from My Research");
    expect(html).toContain("Saved research question:");
    expect(html).toContain(task.nextQuestion);
    expect(html).toContain(`id="${secFilingResumeActionId(target, "open")}"`);
    expect(html).toContain("Inspect in Desk");
    expect(html).not.toContain("SEC document text has not been requested; inspect it when ready");
    expect(onInspect).not.toHaveBeenCalled();
  });
});
