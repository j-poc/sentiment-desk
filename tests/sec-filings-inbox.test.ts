import { describe, expect, it, vi } from "vitest";
import { SecFilingsInbox } from "../server/sec-filings-inbox.js";

const base = "http://127.0.0.1:18765";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm";
type HubFilingRecord = {
  kind: string;
  entity: string;
  source_address: string;
  attributes: {
    issuer_label: string;
    form: string;
    accession: string;
    accession_cik: string;
    filing_cik_path: string;
    filing_url: string;
    filed_at?: string;
    accepted_at?: string | null;
    feed_updated_at?: string | null;
  };
};
const validRow: HubFilingRecord = {
  kind: "document", entity: "0000000320", source_address: filingUrl,
  attributes: {
    issuer_label: "Example Issuer", form: "8-K", accession: "0000000320-25-000001",
    accession_cik: "0000000320", filing_cik_path: "320",
    filing_url: filingUrl, filed_at: "2026-10-04", accepted_at: "2026-10-04T15:20:00Z",
    feed_updated_at: "2026-10-04T15:21:00Z",
  },
};
const currentProfile = {
  id: "feed-1", revision: 1, dataset: "sec.latest_filings_8k", params: { form: "8-K" },
  consumer: "sentiment-desk", cadence_seconds: 900, enabled: true,
};

function responseFor({ records = [validRow], job = "succeeded", updatedAt = "2026-10-05T12:00:00Z", rights = {} } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/sources")) return Response.json({ implemented: [{ id: "sec.latest_filings_8k", configured: true }] });
    if (url.endsWith("/api/v1/state?include_results=false")) return Response.json({ profiles: [{
      profile: currentProfile, latest_job: { status: job, updated_at: updatedAt },
      last_accepted_job: { receipt_id: "receipt-1", revision: 1 }, result_matches_current_revision: true,
    }] });
    if (url.includes("/api/v1/receipts/receipt-1?purpose=private_display")) return Response.json({
      dataset: "sec.latest_filings_8k", params: { form: "8-K" }, receipt_id: "receipt-1",
      records, retrieved_at: "2026-10-05T12:00:00Z",
      rights: { private_display: true, export: false, redistribution: false, ...rights },
    });
    if (url.includes("/api/v1/profiles/feed-1/refresh")) return Response.json({ job: { status: "queued" } });
    return Response.json({});
  });
}

function makeInbox(fetcher: typeof fetch, now = Date.parse("2026-10-05T12:05:00Z"), acquisitionEnabled = true) {
  return new SecFilingsInbox({
    acquisitionEnabled, fetcher, now: () => now,
    connectionProvider: () => ({ baseUrl: new URL(base), token: "test-token" }),
  });
}

describe("real SEC filings inbox Hub boundary", () => {
  it("reads a private-display-only Hub receipt and preserves source clocks", async () => {
    const fetcher = responseFor();
    const result = await makeInbox(fetcher).read();
    expect(result).toMatchObject({ state: "ready", freshness: "stale", receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z" });
    expect(result.rows).toEqual([{
      accession: "0000000320-25-000001", cik: "0000000320", accessionCik: "0000000320", filingCikPath: "320",
      issuer: "Example Issuer", form: "8-K",
      filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedUpdatedAt: "2026-10-04T15:21:00.000Z", filingUrl,
    }]);
    const receiptRequest = fetcher.mock.calls.find(([input]) => String(input).includes("/api/v1/receipts/"));
    expect(String(receiptRequest?.[0])).toBe(`${base}/api/v1/receipts/receipt-1?purpose=private_display`);
  });

  it("keeps fresh retrieval separate from an old SEC source observation", async () => {
    const result = await makeInbox(responseFor(), Date.parse("2026-10-05T12:05:00Z")).read();
    expect(result).toMatchObject({
      state: "ready", freshness: "stale", retrievedAt: "2026-10-05T12:00:00.000Z",
      feedUpdatedAt: "2026-10-04T15:21:00.000Z",
    });
    expect(result.rows).toHaveLength(1);
  });

  it("reports source freshness unknown when the recent saved receipt has no feed update clock", async () => {
    const noClock = structuredClone(validRow);
    delete noClock.attributes.feed_updated_at;
    const result = await makeInbox(responseFor({ records: [noClock] })).read();
    expect(result).toMatchObject({ state: "ready", freshness: "unknown", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: null });
    expect(result.rows).toHaveLength(1);
  });

  it("marks the source current only when its own update clock is inside the freshness budget", async () => {
    const observed = structuredClone(validRow);
    observed.attributes.feed_updated_at = "2026-10-05T12:04:00Z";
    const result = await makeInbox(responseFor({ records: [observed] }), Date.parse("2026-10-05T12:05:00Z")).read();
    expect(result).toMatchObject({ state: "ready", freshness: "current", feedUpdatedAt: "2026-10-05T12:04:00.000Z" });
  });

  it("keeps the issuer, EDGAR login CIK, and archive-path CIK distinct", async () => {
    // Real SEC Form 8-K example: VICOR Corp is issuer CIK 0000751978, while
    // accession 0001193125-26-370420 was filed under login CIK 0001193125.
    const agentFiled = structuredClone(validRow);
    const filingUrl = "https://www.sec.gov/Archives/edgar/data/1193125/000119312526370420/0001193125-26-370420-index.htm";
    agentFiled.entity = "0000751978";
    agentFiled.source_address = filingUrl;
    agentFiled.attributes.accession = "0001193125-26-370420";
    agentFiled.attributes.accession_cik = "0001193125";
    agentFiled.attributes.filing_cik_path = "1193125";
    agentFiled.attributes.filing_url = filingUrl;
    agentFiled.attributes.issuer_label = "VICOR CORP";
    agentFiled.attributes.filed_at = "2026-08-27";
    agentFiled.attributes.accepted_at = null;
    agentFiled.attributes.feed_updated_at = null;

    const result = await makeInbox(responseFor({ records: [agentFiled] })).read();
    expect(result).toMatchObject({ state: "ready" });
    expect(result.rows).toEqual([{
      accession: "0001193125-26-370420", cik: "0000751978", accessionCik: "0001193125", filingCikPath: "1193125",
      issuer: "VICOR CORP", form: "8-K", filedOn: "2026-08-27", acceptedAt: null,
      feedUpdatedAt: null, filingUrl,
    }]);
  });

  it("fails closed on inconsistent accession or archive identities and on any export permission", async () => {
    const badAccessionCik = structuredClone(validRow);
    badAccessionCik.attributes.accession_cik = "0000000321";
    const invalidAccession = await makeInbox(responseFor({ records: [badAccessionCik] })).read();
    expect(invalidAccession.state).toBe("unsupported");
    expect(invalidAccession.rows).toEqual([]);

    const badArchiveCik = structuredClone(validRow);
    badArchiveCik.attributes.filing_cik_path = "321";
    const invalidArchive = await makeInbox(responseFor({ records: [badArchiveCik] })).read();
    expect(invalidArchive.state).toBe("unsupported");
    expect(invalidArchive.rows).toEqual([]);

    const mismatch = structuredClone(validRow);
    mismatch.source_address = "https://www.sec.gov/Archives/edgar/data/321/000000032025000001/0000000320-25-000001-index.htm";
    mismatch.attributes.filing_url = mismatch.source_address;
    const invalidLink = await makeInbox(responseFor({ records: [mismatch] })).read();
    expect(invalidLink.state).toBe("unsupported");
    expect(invalidLink.rows).toEqual([]);

    const exportAllowed = await makeInbox(responseFor({ rights: { export: true } })).read();
    expect(exportAllowed.state).toBe("unsupported");
    expect(exportAllowed.rows).toEqual([]);
  });

  it("distinguishes stale receipts and failed refreshes while retaining the last accepted rows", async () => {
    const stale = await makeInbox(responseFor(), Date.parse("2026-10-06T00:00:00Z")).read();
    expect(stale.state).toBe("stale");
    const failed = await makeInbox(responseFor({ job: "failed", updatedAt: "2026-10-05T12:04:00Z" })).read();
    expect(failed.state).toBe("failed");
    expect(failed.rows).toHaveLength(1);
    expect(failed.message).toMatch(/last accepted snapshot is retained/);
  });

  it("does not refresh during an active job or before the 15-minute request floor", async () => {
    const activeFetcher = responseFor({ job: "running", updatedAt: "2026-10-05T12:04:00Z" });
    const active = await makeInbox(activeFetcher).activate();
    expect(active.state).toBe("pending");
    expect(activeFetcher.mock.calls.some(([input, init]) => String(input).includes("/refresh") || init?.method === "POST")).toBe(false);

    const recentFetcher = responseFor({ job: "failed", updatedAt: "2026-10-05T11:55:00Z" });
    const recent = await makeInbox(recentFetcher).activate();
    expect(recent.state).toBe("rate_limited");
    expect(recent.nextRefreshAt).toBe("2026-10-05T12:10:00.000Z");
    expect(recentFetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not contact the Hub when the global and source gates are closed", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const inbox = makeInbox(fetcher, undefined, false);
    expect((await inbox.activate()).canActivate).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
