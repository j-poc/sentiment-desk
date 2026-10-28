import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { secFilingArchiveCikPath, secIssuerDisplayName } from "../shared/sec-filings-inbox.js";
import { SavedFilingTasksRetry, SecFilingDetailPanel, SecFilingsInbox, SecFilingsRecoveryActions, deskFallbackMessage, isSecFilingsActivationCoolingDown, markSecFilingsRequestFailure, reloadSecFilingsInbox, retainLastAcceptedFilings, secFilingQuestionValue, secFreshnessLabel, secInboxEmptyMessage, secInboxStatusLabel, secIssuerRowAction, secListingDirectoryClockLabels, secListingVerificationSummary, shouldOfferSavedArchiveSearch, shouldOfferSecFilingsActivation, shouldShowDeskFallback, shouldStartSecFilingsPoll } from "../web/src/components/SecFilingsInbox.js";
import { SEC_FILINGS_FRESHNESS_BUDGET_MS, secFilingsFreshnessNextCheckMs, type SecFilingDetail, type SecFilingInboxRow, type SecFilingsInboxView, type SecFilingResearchTask } from "../shared/sec-filings-inbox.js";

const currentListing = { symbol: "ISSR", exchange: "Nasdaq", securityName: "Issuer One Inc.", directoryCreatedAt: "2026-10-08T11:00:00.000Z", directoryRetrievedAt: "2026-10-08T11:01:00.000Z",
  directories: [
    { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", createdAt: "2026-10-08T11:00:00.000Z", retrievedAt: "2026-10-08T11:01:00.000Z" },
    { source: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", createdAt: "2026-10-08T11:00:00.000Z", retrievedAt: "2026-10-08T11:01:00.000Z" },
  ] };

describe("first-run SEC filing browse surface", () => {
  it("offers the explicit directory check when rows are withheld for unverified listings", () => {
    const view: SecFilingsInboxView = {
      state: "listing_unverified", freshness: "current", rows: [], receiptId: "receipt-1",
      retrievedAt: "2026-10-08T23:32:05.737Z", feedUpdatedAt: "2026-10-08T23:32:05.000Z",
      jobStatus: "succeeded", canActivate: true, nextRefreshAt: "2026-10-08T23:47:06.184Z",
      message: null, withheldCount: 39,
      listingVerificationGap: "39 SEC filings were withheld pending current exchange-listing verification.",
    };
    expect(shouldOfferSecFilingsActivation(view)).toBe(true);
    expect(shouldOfferSecFilingsActivation({ ...view, canActivate: false })).toBe(false);
    expect(shouldOfferSecFilingsActivation({ ...view, state: "listing_unverified", canActivate: true })).toBe(true);
  });

  it("does not let the SEC feed refresh cooldown block a listing-only verification", () => {
    const now = Date.parse("2026-10-08T23:46:44.000Z");
    const view: SecFilingsInboxView = {
      state: "listing_unverified", freshness: "current", rows: [], receiptId: "receipt-1",
      retrievedAt: "2026-10-08T23:32:05.737Z", feedUpdatedAt: "2026-10-08T23:32:05.000Z",
      jobStatus: "succeeded", canActivate: true, nextRefreshAt: "2026-10-08T23:47:06.184Z",
      message: null, withheldCount: 39,
      listingVerificationGap: "39 SEC filings were withheld pending current exchange-listing verification.",
    };
    expect(isSecFilingsActivationCoolingDown(view, now)).toBe(false);
    expect(isSecFilingsActivationCoolingDown({ ...view, state: "ready" }, now)).toBe(true);
    expect(isSecFilingsActivationCoolingDown({ ...view, nextRefreshAt: null }, now)).toBe(false);
  });

  it("ages source freshness from the SEC update clock while the saved list remains visible", () => {
    const observedAt = Date.parse("2026-10-08T11:00:00.000Z");
    const current: SecFilingsInboxView = {
      state: "ready", freshness: "current", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: new Date(observedAt).toISOString(),
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
        listing: currentListing,
      }], receiptId: "receipt-1",
      retrievedAt: new Date(observedAt + 60_000).toISOString(), feedUpdatedAt: new Date(observedAt).toISOString(), listingDirectoryCreatedAt: currentListing.directoryCreatedAt, listingDirectories: currentListing.directories,
      jobStatus: "succeeded", canActivate: true, nextRefreshAt: null, message: null,
    };
    const pending: SecFilingsInboxView = {
      ...current, state: "pending", freshness: "unknown", rows: [], receiptId: null,
      retrievedAt: null, feedUpdatedAt: null, jobStatus: "running", message: "Refresh in progress.",
    };

    expect(secInboxStatusLabel(current, observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS - 1))
      .toContain("Source updated recently");
    expect(secInboxStatusLabel(current, observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS + 1))
      .toContain("Source may be out of date");
    expect(secInboxStatusLabel({ ...current, feedUpdatedAt: "not-a-clock" }, observedAt))
      .toContain("Source update time unavailable");
    expect(secFilingsFreshnessNextCheckMs(new Date(observedAt).toISOString(), observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS))
      .toBe(1);
    expect(secFilingsFreshnessNextCheckMs(new Date(observedAt).toISOString(), observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS + 1))
      .toBeNull();
    expect(secFilingsFreshnessNextCheckMs("not-a-clock", observedAt)).toBeNull();
    expect(retainLastAcceptedFilings(current, pending, observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS + 1))
      .toMatchObject({ state: "pending", rows: current.rows, receiptId: "receipt-1", freshness: "stale" });
    expect(shouldStartSecFilingsPoll(false)).toBe(true);
    expect(shouldStartSecFilingsPoll(true)).toBe(false);
    expect(markSecFilingsRequestFailure(current, "Activation failed.", observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS + 1))
      .toMatchObject({ state: "failed", rows: current.rows, receiptId: "receipt-1", freshness: "stale", message: "Activation failed." });
    const listingExpiredAt = Date.parse(currentListing.directoryCreatedAt) + 24 * 60 * 60 * 1000 + 1;
    expect(retainLastAcceptedFilings(current, pending, listingExpiredAt)).toMatchObject({ rows: [] });
    expect(markSecFilingsRequestFailure(current, "Activation failed.", listingExpiredAt)).toMatchObject({ rows: [], withheldCount: 1 });
    const emptyUnavailable: SecFilingsInboxView = { ...current, state: "unavailable", rows: [], withheldCount: 0,
      listingVerificationGap: "Current exchange-listing directories have not been verified in this app session." };
    expect(secListingVerificationSummary(emptyUnavailable)).toBeNull();
    expect(markSecFilingsRequestFailure(emptyUnavailable, "Hub status unavailable.", observedAt))
      .toMatchObject({ state: "unavailable", rows: [], withheldCount: 0, listingVerificationGap: null, message: "Hub status unavailable." });
  });

  it("removes only the SEC Atom machine suffix from issuer display names", () => {
    expect(secIssuerDisplayName("BIOFORCE NANOSCIENCES HOLDINGS, INC. (0001310488) (Filer)"))
      .toBe("BIOFORCE NANOSCIENCES HOLDINGS, INC.");
    expect(secIssuerDisplayName("Example Holdings (Class B)" )).toBe("Example Holdings (Class B)");
  });

  it("treats filings from the same issuer as separate research tasks", () => {
    const row: SecFilingInboxRow = { accession: "0000000320-25-000002", cik: "0000000320", issuer: "Issuer", form: "8-K",
      filedOn: "2025-01-02", acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: null,
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000002/0000000320-25-000002-index.htm" };
    const saved: SecFilingResearchTask = { cik: "0000000320", issuer: "Issuer", triggeringAccession: "0000000320-25-000001",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
      nextQuestion: "", feedReceiptId: "receipt", feedUpdatedAt: "2025-01-01T00:00:00.000Z", retrievedAt: "2025-01-01T00:01:00.000Z", savedAt: "2025-01-01T00:00:00.000Z" };
    expect(secIssuerRowAction(row, undefined)).toBe("save");
    expect(secIssuerRowAction(row, saved)).toBe("save");
    expect(secIssuerRowAction({ ...row, accession: saved.triggeringAccession }, saved)).toBe("remove");
  });

  it("preserves a saved research question when updating a task without editing its draft", () => {
    const saved = { cik: "0000000320", issuer: "Issuer", triggeringAccession: "0000000320-25-000001",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
      nextQuestion: "Check customer concentration", feedReceiptId: "receipt", feedUpdatedAt: null, retrievedAt: null, savedAt: "2025-01-01T00:00:00.000Z" };
    expect(secFilingQuestionValue(undefined, saved)).toBe("Check customer concentration");
    expect(secFilingQuestionValue("", saved)).toBe("");
    expect(secFilingQuestionValue("Check amended terms", saved)).toBe("Check amended terms");
  });

  it("recovers the exact SEC archive path CIK without confusing it with the accession filer CIK", () => {
    const accession = "0001193125-26-417064";
    const filingUrl = "https://www.sec.gov/Archives/edgar/data/1755672/000119312526417064/0001193125-26-417064-index.htm";
    expect(secFilingArchiveCikPath(filingUrl, accession)).toBe("1755672");
    expect(secFilingArchiveCikPath(filingUrl, "0001193125-26-417065")).toBeNull();
    expect(secFilingArchiveCikPath(filingUrl.replace("www.sec.gov", "attacker.example"), accession)).toBeNull();
  });

  it("renders an in-page retry for saved filing task load failures", () => {
    expect(renderToStaticMarkup(createElement(SavedFilingTasksRetry, { retrying: false, onRetry: () => {} })))
      .toContain("Retry saved tasks");
    expect(renderToStaticMarkup(createElement(SavedFilingTasksRetry, { retrying: true, onRetry: () => {} })))
      .toContain("Retrying…");
  });

  it("states the exact 8-K-only feed scope and does not imply a filter ran without a snapshot", () => {
    expect(secInboxEmptyMessage("", "empty", 0)).toContain("latest 40 SEC items");
    expect(secInboxEmptyMessage("", "empty", 0)).toContain("Form 8-K/A amendments are not included");
    expect(secInboxEmptyMessage("apple", "empty", 0)).toBe("No filing data is available to filter yet.");
    expect(secInboxEmptyMessage("apple", "ready", 2)).toBe("No filings in the saved list match your filter.");
    expect(secInboxEmptyMessage("", "not_configured", 0)).toBe("Current filing updates are unavailable. Try again later; saved filings remain available when present.");
  });

  it("shows withheld issuer count, exact current-listing gap, and both source-file clocks", () => {
    const view: SecFilingsInboxView = { state: "ready", freshness: "current", rows: [], receiptId: "receipt-1",
      retrievedAt: "2026-10-08T16:00:00.000Z", feedUpdatedAt: "2026-10-08T15:59:00.000Z", jobStatus: "succeeded",
      canActivate: true, nextRefreshAt: null, message: null, withheldCount: 2,
      listingVerificationGap: "2 SEC filings were withheld because the SEC issuer name had no unique exact match to an active, non-test, non-ETF Nasdaq Trader security name.",
      listingDirectoryCreatedAt: "2026-10-08T19:41:00.000Z", listingDirectoryRetrievedAt: "2026-10-08T20:00:00.000Z",
      listingDirectories: [
        { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", createdAt: "2026-10-08T19:41:00.000Z", retrievedAt: "2026-10-08T20:00:00.000Z" },
        { source: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", createdAt: "2026-10-08T19:41:00.000Z", retrievedAt: "2026-10-08T20:00:00.000Z" },
      ] };
    const summary = secListingVerificationSummary(view);
    expect(summary).toContain("2 SEC filings were held");
    expect(summary).toContain("Listing information updated");
    expect(summary).not.toContain("no unique exact match");
    expect(summary).not.toContain("nasdaqlisted.txt");
    expect(secListingDirectoryClockLabels(view)).toEqual([
      "nasdaqlisted.txt created 2026-10-08 19:41:00 UTC · checked 2026-10-08 20:00:00 UTC",
      "otherlisted.txt created 2026-10-08 19:41:00 UTC · checked 2026-10-08 20:00:00 UTC",
    ]);
  });

  it("explains the bounded, unranked coverage and does not invent any rows", () => {
    const html = renderToStaticMarkup(createElement(SecFilingsInbox));
    expect(html).toContain("Recent 8-K filings");
    expect(html).toContain("Up to 40 recent SEC Form 8-K filings");
    expect(html).toContain("8-K/A amendments are excluded");
    expect(html).toContain("not a complete issuer universe, a small-cap screen, or a ranked list");
    expect(html).toContain("No filing text is sent to Luna or saved here");
    expect(html).not.toContain("Saved filing tasks");
    expect(html).toContain("Reading the saved SEC feed");
    expect(html).not.toContain("Example Issuer");
    expect(html).not.toContain("Open SEC filing page");
  });

  it("offers archive search only when saved evidence exists, and gives an empty archive a setup action", () => {
    expect(shouldShowDeskFallback("not_configured", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("unsupported", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("failed", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("listing_unverified", 0, false)).toBe(true);
    expect(shouldShowDeskFallback("stale", 38, false)).toBe(false);
    expect(shouldShowDeskFallback("stale", 38, false, true)).toBe(true);
    expect(shouldShowDeskFallback("not_configured", 38, false, true)).toBe(true);
    expect(shouldShowDeskFallback("ready", 2, false)).toBe(false);
    expect(shouldShowDeskFallback("failed", 2, false)).toBe(false);
    expect(shouldShowDeskFallback("unavailable", 38, false)).toBe(true);
    expect(shouldShowDeskFallback(null, 0, true)).toBe(true);
    expect(shouldOfferSavedArchiveSearch("available", true)).toBe(true);
    expect(shouldOfferSavedArchiveSearch("empty", true)).toBe(false);
    expect(shouldOfferSavedArchiveSearch("unknown", true)).toBe(false);
    expect(shouldOfferSavedArchiveSearch("available", false)).toBe(false);
    expect(deskFallbackMessage("unavailable", false, null, "empty")).toContain("No saved SEC filings are available to search yet");
    expect(secInboxEmptyMessage("", "listing_unverified", 0)).toContain("current exchange listing can be confirmed");
    expect(deskFallbackMessage("listing_unverified", false, "2 SEC filings were withheld", "empty"))
      .toContain("2 SEC filings are withheld");
    expect(deskFallbackMessage("listing_unverified", false, "Listing check is paused; approve both sources", "empty"))
      .not.toContain("Activate Recent Filings");
  });

  it("renders the matching recovery action instead of an empty archive search", () => {
    const onBrowseSavedSources = () => {};
    const onOpenOperations = () => {};
    for (const archiveStatus of ["empty", "unknown"] as const) {
      const html = renderToStaticMarkup(createElement(SecFilingsRecoveryActions, {
        archiveStatus, onBrowseSavedSources, onOpenOperations,
      }));
      expect(html).not.toContain("Open Data connections");
      expect(html).not.toContain("Search saved archive");
    }
    const available = renderToStaticMarkup(createElement(SecFilingsRecoveryActions, {
      archiveStatus: "available", onBrowseSavedSources, onOpenOperations,
    }));
    expect(available).toContain("Search saved archive");
    expect(available).not.toContain("Open Data connections");
    const stale = renderToStaticMarkup(createElement(SecFilingsRecoveryActions, {
      archiveStatus: "available", onBrowseSavedSources, onOpenOperations, showOperations: true,
    }));
    expect(stale).toContain("Search saved archive");
    expect(stale).toContain("View update details");
    const retainedNotConfiguredFallback = shouldShowDeskFallback("not_configured", 38, false, true)
      ? renderToStaticMarkup(createElement(SecFilingsRecoveryActions, {
        archiveStatus: "available", onBrowseSavedSources, onOpenOperations, showOperations: true,
      })) : "";
    expect(retainedNotConfiguredFallback).toContain("View update details");
  });

  it("distinguishes an unsupported filing feed from unavailable SEC source status", () => {
    const unsupported = deskFallbackMessage("unsupported", false, "The saved Hub receipt does not permit this display.", "available");
    expect(unsupported).toContain("Recent SEC filings are unavailable in this view right now.");
    expect(unsupported).not.toContain("Hub receipt");
    expect(unsupported).not.toContain("Configure the SEC 8-K feed");
    expect(unsupported).toContain("Search saved filings for historical leads");
    expect(unsupported).toContain("not current coverage");
    expect(unsupported).not.toContain("cannot reach");
    expect(deskFallbackMessage("unsupported", false)).not.toMatch(/Hub|configuration/i);

    const blocked = deskFallbackMessage("unavailable", false, "The Hub needs its SEC contact User-Agent configured before collection can start.", "available");
    expect(blocked).not.toMatch(/User-Agent|configured|Hub/i);
    expect(blocked).not.toContain("cannot reach its registered local Public Data Hub");

    const paused = deskFallbackMessage("stale", false, null, "empty");
    expect(paused).toContain("saved SEC filing list is out of date");
    expect(paused).not.toMatch(/Refresh is paused|Data connections|source gate/i);

    const unavailable = deskFallbackMessage("unavailable", false, null, "available");
    expect(unavailable).toContain("filing status could not be read");
    expect(unavailable).toContain("Search saved filings for historical leads");
    expect(unavailable).toContain("not current coverage");
    expect(unavailable).not.toContain("source allowlists");
    expect(deskFallbackMessage("failed", true, null, "empty")).toContain("filing status could not be read");
  });

  it("keeps the exact last accepted filing receipt and clocks visible during transient refresh states", () => {
    const accepted: SecFilingsInboxView = {
      state: "ready", freshness: "stale", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedPublishedAt: "2026-10-04T15:19:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
        listing: currentListing,
      }],
      receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z", listingDirectoryCreatedAt: currentListing.directoryCreatedAt, listingDirectories: currentListing.directories,
      jobStatus: "succeeded", canActivate: true, nextRefreshAt: null, message: null,
    };
    const pending: SecFilingsInboxView = {
      state: "pending", freshness: "unknown", rows: [], receiptId: null, retrievedAt: null, feedUpdatedAt: null,
      jobStatus: "queued", canActivate: true, nextRefreshAt: null, message: "Refresh started.",
    };

    expect(retainLastAcceptedFilings(accepted, pending, Date.parse("2026-10-08T23:45:00.000Z"))).toMatchObject({
      state: "pending", rows: accepted.rows, receiptId: "receipt-1", retrievedAt: accepted.retrievedAt,
      feedUpdatedAt: accepted.feedUpdatedAt, freshness: "stale", message: "Refresh started.",
    });
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "rate_limited" }, Date.parse("2026-10-08T23:45:00.000Z")).rows).toEqual(accepted.rows);
    expect(retainLastAcceptedFilings(accepted, { ...pending, state: "failed" }, Date.parse("2026-10-08T23:45:00.000Z")).rows).toEqual(accepted.rows);
    for (const state of ["unsupported", "unavailable", "not_configured"] as const) {
      expect(retainLastAcceptedFilings(accepted, { ...pending, state, message: "Hub configuration needs attention." }, Date.parse("2026-10-08T23:45:00.000Z"))).toMatchObject({
        state, rows: accepted.rows, receiptId: "receipt-1", retrievedAt: accepted.retrievedAt,
        feedUpdatedAt: accepted.feedUpdatedAt, freshness: "stale", message: "Hub configuration needs attention.",
      });
    }
  });

  it("keeps the last accepted filing snapshot when ordinary polling loses the Hub", async () => {
    const accepted: SecFilingsInboxView = {
      state: "ready", freshness: "stale", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedPublishedAt: "2026-10-04T15:19:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
        listing: currentListing,
      }],
      receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z", listingDirectoryCreatedAt: currentListing.directoryCreatedAt, listingDirectories: currentListing.directories,
      jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null,
    };
    const unavailable: SecFilingsInboxView = {
      state: "unavailable", freshness: "unknown", rows: [], receiptId: null, retrievedAt: null, feedUpdatedAt: null,
      jobStatus: "unknown", canActivate: false, nextRefreshAt: null, message: "Hub unavailable.",
    };
    let view: SecFilingsInboxView | null = accepted;
    let loadFailed = false;
    let loading = true;

    await reloadSecFilingsInbox(
      async () => unavailable,
      (next) => { view = typeof next === "function" ? next(view) : next; },
      (failed) => { loadFailed = typeof failed === "function" ? failed(loadFailed) : failed; },
      (active) => { loading = typeof active === "function" ? active(loading) : active; },
      undefined, undefined, Date.parse("2026-10-08T23:45:00.000Z"),
    );

    expect(view).toMatchObject({
      state: "unavailable", rows: accepted.rows, receiptId: "receipt-1", retrievedAt: accepted.retrievedAt,
      feedUpdatedAt: accepted.feedUpdatedAt, freshness: "stale", message: "Hub unavailable.",
    });
    expect(loadFailed).toBe(false);
    expect(loading).toBe(false);

    view = { ...accepted, freshness: "current" };
    await reloadSecFilingsInbox(
      async () => unavailable,
      (next) => { view = typeof next === "function" ? next(view) : next; },
      (failed) => { loadFailed = typeof failed === "function" ? failed(loadFailed) : failed; },
      (active) => { loading = typeof active === "function" ? active(loading) : active; },
      undefined, undefined, Date.parse("2026-10-08T23:45:00.000Z"),
    );
    expect(view?.freshness).toBe("stale");
    expect(view && secInboxStatusLabel(view)).toContain("Source may be out of date");
  });

  it("downgrades unverified freshness and retains the last accepted receipt after a failed poll", async () => {
    const accepted: SecFilingsInboxView = {
      state: "ready", freshness: "current", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedPublishedAt: "2026-10-04T15:19:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
        listing: currentListing,
      }],
      receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z", listingDirectoryCreatedAt: currentListing.directoryCreatedAt, listingDirectories: currentListing.directories,
      jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null,
    };
    let view: SecFilingsInboxView | null = accepted;
    let loadFailed = false;
    let loading = true;

    await reloadSecFilingsInbox(
      async () => { throw new Error("Hub request failed"); },
      (next) => { view = typeof next === "function" ? next(view) : next; },
      (failed) => { loadFailed = typeof failed === "function" ? failed(loadFailed) : failed; },
      (active) => { loading = typeof active === "function" ? active(loading) : active; },
      undefined, undefined, Date.parse("2026-10-08T23:45:00.000Z"),
    );

    expect(view).toMatchObject({
      state: "failed", rows: accepted.rows, receiptId: "receipt-1", retrievedAt: accepted.retrievedAt,
      feedUpdatedAt: accepted.feedUpdatedAt, freshness: "stale",
    });
    expect(view && secInboxStatusLabel(view)).toContain("Source may be out of date");
    expect(loadFailed).toBe(true);
    expect(loading).toBe(false);
  });

  it("ignores a late older polling response after a newer receipt has arrived", async () => {
    const accepted: SecFilingsInboxView = {
      state: "ready", freshness: "stale", rows: [{
        accession: "0000000320-25-000001", cik: "0000000320", issuer: "Issuer One", form: "8-K",
        filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedPublishedAt: "2026-10-04T15:19:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z",
        filingUrl: "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm",
        listing: currentListing,
      }],
      receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z", listingDirectoryCreatedAt: currentListing.directoryCreatedAt, listingDirectories: currentListing.directories,
      jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null,
    };
    const older: SecFilingsInboxView = { ...accepted, receiptId: "receipt-older", retrievedAt: "2026-10-05T12:01:00.000Z" };
    const newer: SecFilingsInboxView = { ...accepted, receiptId: "receipt-newer", retrievedAt: "2026-10-05T12:02:00.000Z" };
    let resolveOlder!: (value: SecFilingsInboxView) => void;
    const olderResponse = new Promise<SecFilingsInboxView>((resolve) => { resolveOlder = resolve; });
    let requestSequence = 1;
    let view: SecFilingsInboxView | null = accepted;
    let loadFailed = false;
    let loading = true;
    const setView: (next: SecFilingsInboxView | null | ((current: SecFilingsInboxView | null) => SecFilingsInboxView | null)) => void =
      (next) => { view = typeof next === "function" ? next(view) : next; };
    const setBoolean = (key: "loadFailed" | "loading") => (next: boolean | ((current: boolean) => boolean)) => {
      if (key === "loadFailed") loadFailed = typeof next === "function" ? next(loadFailed) : next;
      else loading = typeof next === "function" ? next(loading) : next;
    };
    const oldRequest = reloadSecFilingsInbox(() => olderResponse, setView, setBoolean("loadFailed"), setBoolean("loading"), undefined,
      () => requestSequence === 1);

    requestSequence = 2;
    await reloadSecFilingsInbox(async () => newer, setView, setBoolean("loadFailed"), setBoolean("loading"), undefined,
      () => requestSequence === 2);
    resolveOlder(older);
    await oldRequest;

    expect(view?.receiptId).toBe("receipt-newer");
    expect(view?.retrievedAt).toBe("2026-10-05T12:02:00.000Z");
    expect(loadFailed).toBe(false);
    expect(loading).toBe(false);
  });

  it("labels source observation freshness separately from saved receipt delivery", () => {
    const observedAt = Date.parse("2026-10-08T11:00:00.000Z");
    expect(secFreshnessLabel("current")).toBe("Source updated recently");
    expect(secFreshnessLabel("stale")).toBe("Source may be out of date");
    expect(secFreshnessLabel("unknown")).toBe("Source update time unavailable");
    const delivered: SecFilingsInboxView = {
      state: "ready", freshness: "unknown", rows: [], receiptId: "receipt-1",
      retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: new Date(observedAt).toISOString(), jobStatus: "succeeded",
      canActivate: true, nextRefreshAt: null, message: null,
    };
    expect(secInboxStatusLabel({ ...delivered, feedUpdatedAt: null }, observedAt)).toBe("Filing updates available · Source update time unavailable");
    expect(secInboxStatusLabel(delivered, observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS + 1)).toBe("Filing updates available · Source may be out of date");
    expect(secInboxStatusLabel(delivered, observedAt + 1)).toBe("Filing updates available · Source updated recently");
  });

  it("renders exact filing clocks, item labels, excerpt provenance, and partial state without an AI summary", () => {
    const detail: SecFilingDetail = {
      state: "partial", cik: "0001310488", accession: "0001091818-26-000108",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/1310488/000109181826000108/0001091818-26-000108-index.htm",
      filingDate: "2026-08-18", reportDate: "2026-06-30", acceptedAt: "2026-08-18T12:30:00.000Z",
      metadataRetrievedAt: "2026-10-07T10:00:00.000Z", items: [{ code: "2.02", label: "Results of Operations" }],
      selectionReason: "ambiguous_exhibit", selectedRole: null,
      documents: [{ role: "8k_primary", url: "https://www.sec.gov/Archives/edgar/data/1310488/000109181826000108/form8-k.htm",
        outcome: "success", retrievedAt: "2026-10-07T10:00:02.000Z", bodySha256: "a".repeat(64),
        excerpt: "Item 2.02. A copy of the report is referenced.", errorCode: null }],
      message: "SEC metadata matched, but the filing text is incomplete or could not be verified. Use the source link or retry.",
    };
    const html = renderToStaticMarkup(createElement(SecFilingDetailPanel, { detail, onRetry: () => {} }));
    expect(html).toContain("Period of report · not an event date");
    expect(html).toContain("2026-06-30");
    expect(html).toContain("Accepted by EDGAR");
    expect(html).toContain("EDGAR metadata retrieved");
    expect(html).toContain("Item 2.02");
    expect(html).toContain("SHA-256");
    expect(html).toContain("Partial source text");
    expect(html).toContain("Retry SEC evidence");
    expect(html).not.toContain("AI summary");
  });
});
