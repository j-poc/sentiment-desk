import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecFilingDetail, SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";

const accession = "0001091818-26-000108";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/1310488/000109181826000108/0001091818-26-000108-index.htm";
const inbox: SecFilingsInboxView = {
  state: "ready", freshness: "current", rows: [{ accession, cik: "0001310488", accessionCik: "0001091818",
    filingCikPath: "0001310488", issuer: "BIOFORCE NANOSCIENCES HOLDINGS, INC.", form: "8-K", filedOn: "2026-08-18",
    acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: null, filingUrl }],
  receiptId: "receipt", retrievedAt: "2026-10-07T10:00:00.000Z", feedUpdatedAt: null,
  jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null,
};
const detail: SecFilingDetail = {
  state: "ready", cik: "0001310488", accession, filingUrl, filingDate: "2026-08-18", reportDate: "2026-06-30",
  acceptedAt: "2026-08-18T12:30:00.000Z", metadataRetrievedAt: "2026-10-07T10:01:00.000Z",
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
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession, confirmUse: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(inbox.rows[0]);
    const invalid = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession }),
    });
    expect(invalid.status).toBe(400);
    const missing = await app.request("/api/sec-filings-inbox/evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession: "0001091818-26-000109", confirmUse: true }),
    });
    expect(missing.status).toBe(404);
    expect(inspect).toHaveBeenCalledTimes(1);
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
});
