import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Desk } from "../server/db.js";
import { SecFilingsInbox, type ListingSnapshotStore } from "../server/sec-filings-inbox.js";
import { isCurrentSecFilingsReceiptEvidence } from "../scripts/verify-sec-filings-hub.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const base = "http://127.0.0.1:18765";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm";
const longNasdaqListedSecurityName = "Synthetic Fixed-Income Securities, Inc. on behalf of STRATS (SM) Trust for Dominion Resources, Inc. Securities, Series 2005-6, Floating Rate Structured Repackaged Asset-Backed Trust Securities (STRATS) Certificates";
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
    published_source_timestamp?: string;
    feed_updated_at?: string | null;
  };
};
const validRow: HubFilingRecord = {
  kind: "document", entity: "0000000320", source_address: filingUrl,
  attributes: {
    issuer_label: "Example Issuer", form: "8-K", accession: "0000000320-25-000001",
    accession_cik: "0000000320", filing_cik_path: "320",
    filing_url: filingUrl, filed_at: "2026-10-04", accepted_at: "2026-10-04T15:20:00Z",
    published_source_timestamp: "2026-10-04T15:19:00-04:00",
    feed_updated_at: "2026-10-04T15:21:00Z",
  },
};
const currentProfile = {
  id: "feed-1", revision: 1, dataset: "sec.latest_filings_8k", params: { form: "8-K" },
  consumer: "sentiment-desk", cadence_seconds: 900, enabled: true,
};

function responseFor({ records = [validRow], job = "succeeded", updatedAt = "2026-10-05T12:00:00Z", rights = {}, configured = true } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt") return new Response(listingFile("nasdaq"), { status: 200 });
    if (url === "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt") return new Response(listingFile("other"), { status: 200 });
    if (url.endsWith("/api/v1/sources")) return Response.json({ implemented: [{ id: "sec.latest_filings_8k", configured }] });
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

function listingFile(kind: "nasdaq" | "other"): string {
  if (kind === "nasdaq") return [
    "File Creation Time: 10052026 08:00",
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF",
    "EXMP|Example Issuer Inc.|Q|N|N|100|N",
    "BIOF|BIOFORCE NANOSCIENCES HOLDINGS, INC.|Q|N|N|100|N",
    "VICR|VICOR CORP|Q|N|N|100|N",
    "COR|Corteva, Inc.|Q|N|N|100|N",
    "EID|EIDP, Inc.|Q|N|N|100|N",
    "TEST|Example Issuer Inc.|Q|Y|N|100|N",
    "FUND|Example Issuer Inc.|Q|N|N|100|Y",
    "File Creation Time: 10052026 08:00", "",
  ].join("\n");
  return [
    "File Creation Time: 10052026 08:00",
    "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
    // Exact 214-character security name observed in the 2026-10-08 Nasdaq Trader directory.
    `GJP|${longNasdaqListedSecurityName}|N|GJP|N|100|N|GJP`,
    "OTCX|Unknown Issuer Inc.|N|OTCX|N|100|N|OTCX",
    "File Creation Time: 10052026 08:00", "",
  ].join("\n");
}

function makeInbox(fetcher: typeof fetch, now = Date.parse("2026-10-05T12:05:00Z"), acquisitionEnabled = true, listingSnapshotStore?: ListingSnapshotStore) {
  return new SecFilingsInbox({
    acquisitionEnabled, fetcher, now: () => now,
    listingSnapshotStore,
    connectionProvider: () => ({ baseUrl: new URL(base), token: "test-token" }),
  });
}

async function readAfterListing(fetcher: ReturnType<typeof responseFor>, now = Date.parse("2026-10-05T12:05:00Z")) {
  const inbox = makeInbox(fetcher, now);
  await inbox.activate(); // Listing acquisition is explicit; read() itself remains saved/local-only.
  return { result: await inbox.read(), inbox };
}

describe("real SEC filings inbox Hub boundary", () => {
  it("reads a private-display-only Hub receipt and preserves source clocks", async () => {
    const fetcher = responseFor();
    const { result } = await readAfterListing(fetcher);
    expect(result).toMatchObject({ state: "ready", freshness: "stale", receiptId: "receipt-1", retrievedAt: "2026-10-05T12:00:00.000Z" });
    expect(result.rows).toEqual([{
      accession: "0000000320-25-000001", cik: "0000000320", accessionCik: "0000000320", filingCikPath: "320",
      issuer: "Example Issuer", form: "8-K",
      filedOn: "2026-10-04", acceptedAt: "2026-10-04T15:20:00.000Z", feedPublishedAt: "2026-10-04T19:19:00.000Z",
      feedUpdatedAt: "2026-10-04T15:21:00.000Z", filingUrl,
      listing: { symbol: "EXMP", exchange: "Nasdaq", securityName: "Example Issuer Inc.", directoryCreatedAt: "2026-10-05T12:00:00.000Z", directoryRetrievedAt: "2026-10-05T12:05:00.000Z",
        directories: [
          { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", createdAt: "2026-10-05T12:00:00.000Z", retrievedAt: "2026-10-05T12:05:00.000Z" },
          { source: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", createdAt: "2026-10-05T12:00:00.000Z", retrievedAt: "2026-10-05T12:05:00.000Z" },
        ] },
    }]);
    expect(result).toMatchObject({ withheldCount: 0, listingVerificationGap: null });
    const receiptRequest = fetcher.mock.calls.find(([input]) => String(input).includes("/api/v1/receipts/"));
    expect(String(receiptRequest?.[0])).toBe(`${base}/api/v1/receipts/receipt-1?purpose=private_display`);
  });

  it("normalizes the exact machine suffix used in live SEC Atom issuer titles", async () => {
    const liveTitle = structuredClone(validRow);
    liveTitle.attributes.issuer_label = "BIOFORCE NANOSCIENCES HOLDINGS, INC. (0001310488) (Filer)";
    const { result } = await readAfterListing(responseFor({ records: [liveTitle] }));
    expect(result.rows[0]?.issuer).toBe("BIOFORCE NANOSCIENCES HOLDINGS, INC.");
  });

  it("parses Nasdaq's documented compact file-creation clock with trailing empty directory fields", async () => {
    const compactTimestamp = (value: string) => value.replaceAll("File Creation Time: 10052026 08:00", "File Creation Time: 1005202608:00|||||||");
    const fallback = responseFor();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt") return new Response(compactTimestamp(listingFile("nasdaq")), { status: 200 });
      if (url === "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt") return new Response(compactTimestamp(listingFile("other")), { status: 200 });
      return fallback(input, init);
    });
    const { result } = await readAfterListing(fetcher);
    expect(result).toMatchObject({ state: "ready", rows: [{ listing: { symbol: "EXMP" } }], listingVerificationGap: null });
  });

  it("keeps fresh retrieval separate from an old SEC source observation", async () => {
    const { result } = await readAfterListing(responseFor(), Date.parse("2026-10-05T12:05:00Z"));
    expect(result).toMatchObject({
      state: "ready", freshness: "stale", retrievedAt: "2026-10-05T12:00:00.000Z",
      feedUpdatedAt: "2026-10-04T15:21:00.000Z",
    });
    expect(result.rows).toHaveLength(1);
  });

  it("reports source freshness unknown when the recent saved receipt has no feed update clock", async () => {
    const noClock = structuredClone(validRow);
    delete noClock.attributes.feed_updated_at;
    const { result } = await readAfterListing(responseFor({ records: [noClock] }));
    expect(result).toMatchObject({ state: "ready", freshness: "unknown", retrievedAt: "2026-10-05T12:00:00.000Z", feedUpdatedAt: null });
    expect(result.rows).toHaveLength(1);
  });

  it("marks the source current only when its own update clock is inside the freshness budget", async () => {
    const observed = structuredClone(validRow);
    observed.attributes.feed_updated_at = "2026-10-05T12:04:00Z";
    const { result } = await readAfterListing(responseFor({ records: [observed] }), Date.parse("2026-10-05T12:05:00Z"));
    expect(result).toMatchObject({ state: "ready", freshness: "current", feedUpdatedAt: "2026-10-05T12:04:00.000Z" });
  });

  it("withholds SEC filers that lack a unique active-listed security match", async () => {
    const privateIssuer = structuredClone(validRow);
    privateIssuer.attributes.issuer_label = "Ford Credit Floorplan LLC";
    const fetcher = responseFor({ records: [privateIssuer] });
    const { result } = await readAfterListing(fetcher);
    expect(result).toMatchObject({ rows: [], withheldCount: 1, listingDirectoryCreatedAt: "2026-10-05T12:00:00.000Z" });
    expect(result.listingVerificationGap).toContain("no unique exact match");
  });

  it("withholds same-name multi-symbol ambiguity rather than choosing a listing", async () => {
    const fallback = responseFor();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt") {
        const duplicate = listingFile("nasdaq").replace("TEST|Example Issuer Inc.|Q|Y|N|100|N", "EXM2|Example Issuer Inc.|Q|N|N|100|N");
        return new Response(duplicate, { status: 200 });
      }
      return fallback(input, init);
    });
    const { result } = await readAfterListing(fetcher);
    expect(result).toMatchObject({ rows: [], withheldCount: 1 });
    expect(result.listingVerificationGap).toContain("no unique exact match");
  });

  it("withholds all issuers when either official directory is malformed", async () => {
    const fallback = responseFor();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt") return new Response("File Creation Time: yesterday\nmalformed", { status: 200 });
      return fallback(input, init);
    });
    const { result } = await readAfterListing(fetcher);
    expect(result).toMatchObject({ state: "listing_unverified", rows: [], withheldCount: 1, listingDirectoryCreatedAt: null });
    expect(result.listingVerificationGap).toContain("could not be verified");
  });

  it("keeps read local-only and withholds every row until explicit current-listing activation", async () => {
    const fetcher = responseFor();
    const result = await makeInbox(fetcher).read();
    expect(result).toMatchObject({ state: "listing_unverified", rows: [], withheldCount: 1, listingDirectoryCreatedAt: null });
    expect(result.listingVerificationGap).toContain("local app session has no directory snapshot");
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("nasdaqtrader.com"))).toBe(false);
  });

  it("reuses the verified real-source directory after app restart without another provider request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-sec-listing-cache-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "desk.sqlite");
    const firstDb = new Desk(databasePath);
    const firstStore: ListingSnapshotStore = {
      read: () => firstDb.readSecListingSnapshot(),
      write: (snapshot) => firstDb.saveSecListingSnapshot(snapshot),
    };
    const fetcher = responseFor();
    const firstInbox = makeInbox(fetcher, Date.parse("2026-10-05T12:05:00Z"), true, firstStore);
    expect((await firstInbox.activate()).state).toBe("rate_limited");
    expect((await firstInbox.read())).toMatchObject({ state: "ready", rows: [{ listing: { symbol: "EXMP" } }], withheldCount: 0 });
    expect(firstDb.readSecListingSnapshot()).toMatchObject({
      directories: [
        { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", bodyBytes: expect.any(Number), bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { source: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", bodyBytes: expect.any(Number), bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    });
    firstDb.close();

    const secondDb = new Desk(databasePath);
    try {
      const secondStore: ListingSnapshotStore = {
        read: () => secondDb.readSecListingSnapshot(),
        write: (snapshot) => secondDb.saveSecListingSnapshot(snapshot),
      };
      const restartedFetcher = responseFor();
      const restarted = makeInbox(restartedFetcher, Date.parse("2026-10-05T12:10:00Z"), false, secondStore);
      expect(await restarted.read()).toMatchObject({ state: "ready", rows: [{ listing: { symbol: "EXMP" } }], withheldCount: 0 });
      expect((secondDb.readSecListingSnapshot() as { securities: Array<{ symbol: string; securityName: string }> }).securities)
        .toContainEqual(expect.objectContaining({ symbol: "GJP", securityName: longNasdaqListedSecurityName }));
      expect(restartedFetcher.mock.calls.some(([input]) => String(input).includes("nasdaqtrader.com"))).toBe(false);

      const expiredFetcher = responseFor();
      const expired = makeInbox(expiredFetcher, Date.parse("2026-10-06T12:10:01Z"), false, secondStore);
      expect(await expired.read()).toMatchObject({ state: "listing_unverified", rows: [], withheldCount: 1 });
      expect((await expired.read()).listingVerificationGap).toContain("stale or have an invalid clock");
      expect(expiredFetcher.mock.calls.some(([input]) => String(input).includes("nasdaqtrader.com"))).toBe(false);

      const rawDb = (secondDb as unknown as { db: DatabaseSync }).db;
      rawDb.prepare("UPDATE sec_listing_verification_cache SET snapshot_sha256=? WHERE singleton=1").run("0".repeat(64));
      expect(secondDb.readSecListingSnapshot()).toBeNull();
      const corrupted = makeInbox(responseFor(), Date.parse("2026-10-05T12:10:00Z"), false, secondStore);
      expect(await corrupted.read()).toMatchObject({ state: "listing_unverified", rows: [], withheldCount: 1 });
    } finally {
      secondDb.close();
    }
  });

  it("withholds listings whose exchange-directory creation clock exceeds the freshness budget", async () => {
    const fetcher = responseFor();
    const { result } = await readAfterListing(fetcher, Date.parse("2026-10-06T13:00:00Z"));
    expect(result).toMatchObject({ state: "listing_unverified", rows: [], withheldCount: 1, listingDirectoryCreatedAt: "2026-10-05T12:00:00.000Z" });
    expect(result.listingVerificationGap).toContain("stale or have an invalid clock");
  });

  it("does not treat a future Atom update clock as current source data", async () => {
    const future = structuredClone(validRow);
    future.attributes.feed_updated_at = "2026-10-05T12:06:00Z";
    const { result } = await readAfterListing(responseFor({ records: [future] }), Date.parse("2026-10-05T12:05:00Z"));
    expect(result).toMatchObject({ state: "ready", freshness: "stale", feedUpdatedAt: "2026-10-05T12:06:00.000Z" });
  });

  it("verifies the current private-display receipt without bypassing the UI listing gate", async () => {
    const now = Date.parse("2026-10-05T12:05:00Z");
    const staleInbox = makeInbox(responseFor(), now, false);
    const staleEvidence = await staleInbox.readReceiptEvidence();
    expect(staleEvidence).toMatchObject({ state: "ready", freshness: "stale", rowCount: 1, retrievedAt: "2026-10-05T12:00:00.000Z" });
    expect(isCurrentSecFilingsReceiptEvidence(staleEvidence)).toBe(false);

    const current = structuredClone(validRow);
    current.attributes.feed_updated_at = "2026-10-05T12:04:00Z";
    const fetcher = responseFor({ records: [current] });
    const inbox = makeInbox(fetcher, now, false);
    const evidence = await inbox.readReceiptEvidence();
    expect(evidence).toMatchObject({ state: "ready", freshness: "current", rowCount: 1, receiptId: "receipt-1", feedUpdatedAt: "2026-10-05T12:04:00.000Z" });
    expect(isCurrentSecFilingsReceiptEvidence(evidence)).toBe(true);

    const display = await inbox.read();
    expect(display).toMatchObject({ state: "listing_unverified", rows: [], withheldCount: 1 });
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("nasdaqtrader.com"))).toBe(false);
  });

  it("returns a current accepted receipt after explicit listing verification without enqueueing another SEC refresh", async () => {
    const current = structuredClone(validRow);
    current.attributes.feed_updated_at = "2026-10-05T12:04:00Z";
    const fetcher = responseFor({ records: [current] });
    const activated = await makeInbox(fetcher).activate();

    expect(activated).toMatchObject({ state: "ready", freshness: "current", receiptId: "receipt-1" });
    expect(activated.rows).toHaveLength(1);
    expect(activated.rows[0]).toMatchObject({ accession: "0000000320-25-000001", listing: { symbol: "EXMP", exchange: "Nasdaq" } });
    expect(activated.listingVerificationGap).toBeNull();
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("/refresh") || init?.method === "POST")).toBe(false);
  });

  it("reuses a current private-display receipt when Hub acquisition is unconfigured", async () => {
    const current = structuredClone(validRow);
    current.attributes.feed_updated_at = "2026-10-05T12:04:00Z";
    const fetcher = responseFor({ records: [current], configured: false });
    const activated = await makeInbox(fetcher).activate();

    expect(activated).toMatchObject({ state: "ready", freshness: "current", receiptId: "receipt-1" });
    expect(activated.rows).toHaveLength(1);
    expect(activated.listingVerificationGap).toBeNull();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
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
    agentFiled.attributes.published_source_timestamp = "";
    agentFiled.attributes.feed_updated_at = null;

    const { result } = await readAfterListing(responseFor({ records: [agentFiled] }));
    expect(result).toMatchObject({ state: "ready" });
    expect(result.rows).toEqual([{
      accession: "0001193125-26-370420", cik: "0000751978", accessionCik: "0001193125", filingCikPath: "1193125",
      issuer: "VICOR CORP", form: "8-K", filedOn: "2026-08-27", acceptedAt: null,
      feedPublishedAt: null, feedUpdatedAt: null, filingUrl,
      listing: { symbol: "VICR", exchange: "Nasdaq", securityName: "VICOR CORP", directoryCreatedAt: "2026-10-05T12:00:00.000Z", directoryRetrievedAt: "2026-10-05T12:05:00.000Z",
        directories: [
          { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", createdAt: "2026-10-05T12:00:00.000Z", retrievedAt: "2026-10-05T12:05:00.000Z" },
          { source: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", createdAt: "2026-10-05T12:00:00.000Z", retrievedAt: "2026-10-05T12:05:00.000Z" },
        ] },
    }]);
  });

  it("preserves distinct issuers sharing a real joint-filing accession and rejects a duplicate issuer/accession pair", async () => {
    // SEC Atom can publish one joint filing under multiple issuer CIKs. This accession
    // was observed twice in the live 40-entry feed, for Corteva and EIDP.
    const jointAccession = "0001193125-26-417064";
    const first = structuredClone(validRow);
    const second = structuredClone(validRow);
    for (const [record, cik, issuer] of [
      [first, "0001755672", "Corteva, Inc."],
      [second, "0000030554", "EIDP, Inc."],
    ] as const) {
      record.entity = cik;
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/000119312526417064/${jointAccession}-index.htm`;
      record.source_address = url;
      record.attributes.accession = jointAccession;
      record.attributes.accession_cik = "0001193125";
      record.attributes.filing_cik_path = String(Number(cik));
      record.attributes.filing_url = url;
      record.attributes.issuer_label = issuer;
      delete record.attributes.filed_at;
      delete record.attributes.accepted_at;
      delete record.attributes.published_source_timestamp;
      delete record.attributes.feed_updated_at;
    }
    const { result } = await readAfterListing(responseFor({ records: [first, second] }));
    expect(result.state).toBe("ready");
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(({ cik, accession }) => [cik, accession])).toEqual([
      ["0001755672", jointAccession], ["0000030554", jointAccession],
    ]);

    const { result: duplicate } = await readAfterListing(responseFor({ records: [first, structuredClone(first)] }));
    expect(duplicate.state).toBe("unsupported");
    expect(duplicate.rows).toEqual([]);
  });

  it("rejects forms outside the exact 8-K Hub profile and keeps Atom publication separate from filing time", async () => {
    const amendment = structuredClone(validRow);
    amendment.attributes.form = "8-K/A";
    const { result } = await readAfterListing(responseFor({ records: [amendment] }));
    expect(result.state).toBe("unsupported");
    expect(result.rows).toEqual([]);

    const noFilingClocks = structuredClone(validRow);
    delete noFilingClocks.attributes.filed_at;
    delete noFilingClocks.attributes.accepted_at;
    const { result: clockResult } = await readAfterListing(responseFor({ records: [noFilingClocks] }));
    expect(clockResult.rows[0]).toMatchObject({ filedOn: null, acceptedAt: null, feedPublishedAt: "2026-10-04T19:19:00.000Z" });
  });

  it("fails closed on inconsistent accession or archive identities and on any export permission", async () => {
    const badAccessionCik = structuredClone(validRow);
    badAccessionCik.attributes.accession_cik = "0000000321";
    const { result: invalidAccession } = await readAfterListing(responseFor({ records: [badAccessionCik] }));
    expect(invalidAccession.state).toBe("unsupported");
    expect(invalidAccession.rows).toEqual([]);

    const badArchiveCik = structuredClone(validRow);
    badArchiveCik.attributes.filing_cik_path = "321";
    const { result: invalidArchive } = await readAfterListing(responseFor({ records: [badArchiveCik] }));
    expect(invalidArchive.state).toBe("unsupported");
    expect(invalidArchive.rows).toEqual([]);

    const mismatch = structuredClone(validRow);
    mismatch.source_address = "https://www.sec.gov/Archives/edgar/data/321/000000032025000001/0000000320-25-000001-index.htm";
    mismatch.attributes.filing_url = mismatch.source_address;
    const { result: invalidLink } = await readAfterListing(responseFor({ records: [mismatch] }));
    expect(invalidLink.state).toBe("unsupported");
    expect(invalidLink.rows).toEqual([]);

    const { result: exportAllowed } = await readAfterListing(responseFor({ rights: { export: true } }));
    expect(exportAllowed.state).toBe("unsupported");
    expect(exportAllowed.rows).toEqual([]);
  });

  it("distinguishes stale receipts and failed refreshes while retaining the last accepted rows", async () => {
    const { result: stale } = await readAfterListing(responseFor(), Date.parse("2026-10-06T00:00:00Z"));
    expect(stale.state).toBe("stale");
    const { result: failed } = await readAfterListing(responseFor({ job: "failed", updatedAt: "2026-10-05T12:04:00Z" }));
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

    const staleFetcher = responseFor({ updatedAt: "2026-10-05T11:55:00Z" });
    const stale = await makeInbox(staleFetcher, Date.parse("2026-10-06T00:00:00Z")).activate();
    expect(stale.state).toBe("pending");
    expect(staleFetcher.mock.calls.some(([input, init]) => String(input).includes("/refresh") && init?.method === "POST")).toBe(true);
  });

  it("does not contact the Hub when the global and source gates are closed", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const inbox = makeInbox(fetcher, undefined, false);
    expect((await inbox.activate()).canActivate).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
