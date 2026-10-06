import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecFilingsInbox, retainLastAcceptedFilings, shouldShowDeskFallback } from "../web/src/components/SecFilingsInbox.js";
import type { SecFilingsInboxView } from "../shared/sec-filings-inbox.js";

describe("first-run SEC filing browse surface", () => {
  it("explains the bounded, unranked coverage and does not invent any rows", () => {
    const html = renderToStaticMarkup(createElement(SecFilingsInbox));
    expect(html).toContain("Recent 8-K filings");
    expect(html).toContain("at most 40 recent filings");
    expect(html).toContain("not a complete universe, small-cap screen, or ranked opportunity list");
    expect(html).toContain("Reading the saved SEC feed");
    expect(html).not.toContain("Example Issuer");
    expect(html).not.toContain("Open original SEC filing");
  });

  it("offers saved company research when a feed error leaves no filing rows", () => {
    expect(shouldShowDeskFallback("not_configured", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("unsupported", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("failed", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("ready", 2, false)).toBe(false);
    expect(shouldShowDeskFallback("failed", 2, false)).toBe(false);
    expect(shouldShowDeskFallback(null, 0, true)).toBe(true);
  });

  it("keeps the exact last accepted filing receipt and clocks visible during transient refresh states", () => {
    const accepted: SecFilingsInboxView = {
      state: "ready", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
      }],
      receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
      jobStatus: "succeeded", canActivate: true, nextRefreshAt: null, message: null,
    };
    const pending: SecFilingsInboxView = {
      state: "pending", rows: [], receiptId: null, retrievedAt: null, feedUpdatedAt: null,
      jobStatus: "queued", canActivate: true, nextRefreshAt: null, message: "Refresh started.",
    };

    expect(retainLastAcceptedFilings(accepted, pending)).toMatchObject({
      state: "pending", rows: accepted.rows, receiptId: "receipt-1", retrievedAt: accepted.retrievedAt,
      feedUpdatedAt: accepted.feedUpdatedAt, message: "Refresh started.",
    });
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "rate_limited" }).rows).toEqual(accepted.rows);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "failed" }).rows).toEqual(accepted.rows);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "unsupported" }).rows).toEqual([]);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "unavailable" }).rows).toEqual([]);
  });
});
