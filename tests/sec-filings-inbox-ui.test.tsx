import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecFilingsInbox, deskFallbackMessage, retainLastAcceptedFilings, secFreshnessLabel, secInboxStatusLabel, shouldShowDeskFallback } from "../web/src/components/SecFilingsInbox.js";
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

  it("distinguishes an unsupported filing feed from an unavailable Hub", () => {
    const unsupported = deskFallbackMessage("unsupported", false, "The saved Hub receipt does not permit this display.");
    expect(unsupported).toContain("The saved Hub receipt does not permit this display.");
    expect(unsupported).toContain("Configure the SEC 8-K feed in the Hub, then check again.");
    expect(unsupported).toContain("search saved headlines and excerpts");
    expect(unsupported).toContain("historical leads, not current coverage");
    expect(unsupported).not.toContain("cannot reach");
    expect(deskFallbackMessage("unsupported", false)).toContain("not supported by the current Hub configuration");

    const unavailable = deskFallbackMessage("unavailable", false);
    expect(unavailable).toContain("cannot reach its registered local Public Data Hub");
    expect(unavailable).toContain("Start that Hub service, then choose Check Hub again");
    expect(unavailable).toContain("search saved headlines and excerpts");
    expect(unavailable).toContain("historical evidence, not current market coverage");
    expect(unavailable).not.toContain("source allowlists");
  });

  it("keeps the exact last accepted filing receipt and clocks visible during transient refresh states", () => {
    const accepted: SecFilingsInboxView = {
      state: "ready", freshness: "stale", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
      }],
      receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
      jobStatus: "succeeded", canActivate: true, nextRefreshAt: null, message: null,
    };
    const pending: SecFilingsInboxView = {
      state: "pending", freshness: "unknown", rows: [], receiptId: null, retrievedAt: null, feedUpdatedAt: null,
      jobStatus: "queued", canActivate: true, nextRefreshAt: null, message: "Refresh started.",
    };

    expect(retainLastAcceptedFilings(accepted, pending)).toMatchObject({
      state: "pending", rows: accepted.rows, receiptId: "receipt-1", retrievedAt: accepted.retrievedAt,
      feedUpdatedAt: accepted.feedUpdatedAt, freshness: "stale", message: "Refresh started.",
    });
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "rate_limited" }).rows).toEqual(accepted.rows);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "failed" }).rows).toEqual(accepted.rows);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "unsupported" }).rows).toEqual([]);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "unavailable" }).rows).toEqual([]);
  });

  it("labels source observation freshness separately from saved receipt delivery", () => {
    expect(secFreshnessLabel("current")).toBe("Source freshness current");
    expect(secFreshnessLabel("stale")).toBe("Source update is stale");
    expect(secFreshnessLabel("unknown")).toBe("Source freshness unknown");
    const delivered: SecFilingsInboxView = {
      state: "ready", freshness: "unknown", rows: [], receiptId: "receipt-1",
      retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: null, jobStatus: "succeeded",
      canActivate: true, nextRefreshAt: null, message: null,
    };
    expect(secInboxStatusLabel(delivered)).toBe("Saved feed available · Source freshness unknown");
    expect(secInboxStatusLabel({ ...delivered, freshness: "stale" })).toBe("Saved feed available · Source update is stale");
    expect(secInboxStatusLabel({ ...delivered, freshness: "current" })).toBe("Saved feed available · Source freshness current");
  });
});
