import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecFilingInboxRow, SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";

const row: SecFilingInboxRow = {
  cik: "0000320193",
  accession: "0000320193-24-000081",
  issuer: "Apple Inc.",
  form: "8-K",
  filedOn: "2024-11-01",
  acceptedAt: null,
  feedPublishedAt: null,
  feedUpdatedAt: "2024-11-01T12:00:00.000Z",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/0000320193-24-000081-index.htm",
};

function feed(rows: SecFilingInboxRow[]): SecFilingsInboxView {
  return { state: "ready", freshness: "current", rows, receiptId: "sec-receipt-2024-11-01",
    retrievedAt: "2024-11-01T12:00:08.000Z", feedUpdatedAt: "2024-11-01T12:00:00.000Z",
    jobStatus: "succeeded", canActivate: true, nextRefreshAt: null, message: null };
}

const directories: string[] = [];
let desk: Desk | null = null;
let hub: Hub | null = null;
afterEach(() => {
  desk?.close(); desk = null;
  hub?.closeAll(); hub = null;
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("saved SEC filing research resume route", () => {
  it("inspects an exact persisted task after feed rollover using only its server-stored URL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-filing-research-resume-api-")); directories.push(directory);
    desk = new Desk(join(directory, "desk.sqlite"));
    hub = new Hub();
    let currentFeed = feed([row]);
    const inspect = vi.fn(async (filing: SecFilingInboxRow) => ({ state: "ready", cik: filing.cik, accession: filing.accession, filingUrl: filing.filingUrl }));
    const app = createApp({ db: desk, dbPath: join(directory, "desk.sqlite"), pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub,
      health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
      secFilingsInbox: { read: async () => currentFeed } as AppDeps["secFilingsInbox"],
      secFilingDetail: { inspect } as unknown as AppDeps["secFilingDetail"],
    });
    const headers = { "content-type": "application/json" };
    const saved = await app.request("/api/sec-filing-research-tasks", { method: "POST", headers, body: JSON.stringify({ cik: row.cik, accession: row.accession, nextQuestion: "Verify the announced supply constraint." }) });
    expect(saved.status).toBe(201);
    currentFeed = feed([]);

    const response = await app.request("/api/sec-filings-inbox/evidence", { method: "POST", headers,
      body: JSON.stringify({ cik: row.cik, accession: row.accession, confirmUse: true }) });
    expect(response.status).toBe(200);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cik: row.cik, accession: row.accession, accessionCik: "0000320193", filingCikPath: "320193",
      issuer: row.issuer, form: "8-K", filingUrl: row.filingUrl,
    }));
    expect(await response.json()).toMatchObject({ filingUrl: row.filingUrl });

    const clientUrl = await app.request("/api/sec-filings-inbox/evidence", { method: "POST", headers,
      body: JSON.stringify({ cik: row.cik, accession: row.accession, confirmUse: true, filingUrl: "https://attacker.example/document" }) });
    expect(clientUrl.status).toBe(400);
    expect(inspect).toHaveBeenCalledTimes(1);

    const unsaved = await app.request("/api/sec-filings-inbox/evidence", { method: "POST", headers,
      body: JSON.stringify({ cik: "0000789019", accession: "0000789019-24-000001", confirmUse: true }) });
    expect(unsaved.status).toBe(404);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
