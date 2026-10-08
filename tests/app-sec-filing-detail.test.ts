import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecFilingDetail, SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";

const accession = "0001193125-26-417064";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/1755672/000119312526417064/0001193125-26-417064-index.htm";
const firstRow = { accession, cik: "0001755672", accessionCik: "0001193125",
    filingCikPath: "1755672", issuer: "Corteva, Inc.", form: "8-K", filedOn: null,
    acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: null, filingUrl } as const;
const secondRow = { ...firstRow, cik: "0000030554", filingCikPath: "30554", issuer: "EIDP, Inc.",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/30554/000119312526417064/0001193125-26-417064-index.htm" } as const;
const inbox: SecFilingsInboxView = {
  state: "ready", freshness: "current", rows: [firstRow, secondRow],
  receiptId: "receipt", retrievedAt: "2026-10-07T10:00:00.000Z", feedUpdatedAt: null,
  jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null,
};
const detail: SecFilingDetail = {
  state: "ready", cik: "0001755672", accession, filingUrl, filingDate: null, reportDate: null,
  acceptedAt: null, metadataRetrievedAt: "2026-10-07T10:01:00.000Z",
  items: [{ code: "2.02", label: "Results of Operations" }], selectionReason: "unique_exhibit_selected",
  selectedRole: "earnings_exhibit_99_1", documents: [], message: null,
};

const directories: string[] = [];
let desk: Desk | null = null;
let hub: Hub | null = null;
afterEach(() => {
  desk?.close(); desk = null;
  hub?.closeAll(); hub = null;
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function appAt(path: string, inspect = vi.fn(async () => detail)) {
  desk = new Desk(path);
  hub = new Hub();
  const db = desk;
  return { app: createApp({ db, dbPath: path, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub,
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
    secFilingsInbox: { read: async () => inbox } as AppDeps["secFilingsInbox"],
    secFilingDetail: { inspect } as unknown as AppDeps["secFilingDetail"],
  }), inspect };
}

describe("SEC filing detail route", () => {
  it("only reads a filing present in the current inbox and requires an explicit confirmation body", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-filing-detail-api-")); directories.push(directory);
    const { app, inspect } = appAt(join(directory, "desk.sqlite"));
    const response = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: firstRow.cik, accession, confirmUse: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(firstRow);
    const invalid = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: firstRow.cik, accession }),
    });
    expect(invalid.status).toBe(400);
    const missing = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: firstRow.cik, accession: "0001193125-26-417065", confirmUse: true }),
    });
    expect(missing.status).toBe(404);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("requires the issuer CIK when an accession is attached to more than one issuer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-joint-filing-api-")); directories.push(directory);
    const { app, inspect } = appAt(join(directory, "desk.sqlite"));
    const ambiguous = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession, confirmUse: true }),
    });
    expect(ambiguous.status).toBe(400);
    const exact = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: secondRow.cik, accession, confirmUse: true }),
    });
    expect(exact.status).toBe(200);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(secondRow);

    const wrongIssuer = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000001", accession, confirmUse: true }),
    });
    expect(wrongIssuer.status).toBe(404);
  });

  it("rejects cross-origin requests before calling SEC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-filing-detail-origin-")); directories.push(directory);
    const { app, inspect } = appAt(join(directory, "desk.sqlite"));
    const response = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://outside.example" },
      body: JSON.stringify({ accession, confirmUse: true }),
    });
    expect(response.status).toBe(403);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("routes a joint-filing issuer follow-up by exact issuer and accession", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-joint-followup-api-")); directories.push(directory);
    const { app } = appAt(join(directory, "desk.sqlite"));
    const response = await app.request("/api/sec-filing-research-tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cik: secondRow.cik, accession }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ cik: secondRow.cik, issuer: secondRow.issuer, triggeringAccession: accession,
      filingUrl: secondRow.filingUrl, feedReceiptId: "receipt", feedUpdatedAt: null, retrievedAt: inbox.retrievedAt });
  });
});
