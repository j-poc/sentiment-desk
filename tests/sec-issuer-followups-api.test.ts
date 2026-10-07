import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";

const accession = "0000000320-25-000001";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm";
const nextAccession = "0000000320-25-000002";
const nextFilingUrl = "https://www.sec.gov/Archives/edgar/data/320/000000032025000002/0000000320-25-000002-index.htm";
const inbox: SecFilingsInboxView = {
  state: "ready", freshness: "current", rows: [
    { accession, cik: "0000000320", accessionCik: "0000000320", filingCikPath: "320",
      issuer: "Apple Inc.", form: "8-K", filedOn: "2025-01-01", acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: "2025-01-01T00:00:00.000Z", filingUrl },
    { accession: nextAccession, cik: "0000000320", accessionCik: "0000000320", filingCikPath: "320",
      issuer: "Apple Inc.", form: "8-K", filedOn: "2025-01-02", acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: "2025-01-02T00:00:00.000Z", filingUrl: nextFilingUrl },
  ],
  receiptId: "receipt", retrievedAt: "2025-01-01T00:01:00.000Z", feedUpdatedAt: "2025-01-01T00:00:00.000Z",
  jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null,
};

const directories: string[] = [];
let desk: Desk | null = null;
let hub: Hub | null = null;
afterEach(() => {
  desk?.close(); desk = null;
  hub?.closeAll(); hub = null;
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function appAt(path: string) {
  desk = new Desk(path);
  hub = new Hub();
  const db = desk;
  return createApp({ db, dbPath: path, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub,
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
    secFilingsInbox: { read: async () => inbox } as AppDeps["secFilingsInbox"],
  });
}

describe("saved SEC issuer research leads", () => {
  it("is idempotent for one accession, refreshes the lead for a different current filing, survives reopen, and removes durably", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-issuer-followup-")); directories.push(directory);
    const dbPath = join(directory, "desk.sqlite");
    let app = appAt(dbPath);

    expect((await app.request("/api/sec-issuer-followups")).status).toBe(200);
    expect((await app.request("/api/sec-issuer-followups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession }) })).status).toBe(201);
    const savedResponse = await app.request("/api/sec-issuer-followups");
    const firstSaved = await savedResponse.json() as { items: Array<{ savedAt: string; cik: string; issuer: string; triggeringAccession: string; filingUrl: string }> };
    expect(firstSaved).toMatchObject({ items: [{ cik: "0000000320", issuer: "Apple Inc.", triggeringAccession: accession, filingUrl }] });

    await app.request("/api/sec-issuer-followups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession }) });
    const repeatedSave = await (await app.request("/api/sec-issuer-followups")).json() as { items: Array<{ savedAt: string; triggeringAccession: string; filingUrl: string }> };
    expect(repeatedSave.items).toHaveLength(1);
    expect(repeatedSave.items[0]).toMatchObject({ savedAt: firstSaved.items[0]?.savedAt, triggeringAccession: accession, filingUrl });
    expect((await app.request("/api/sec-issuer-followups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession: "0000000320-25-000003" }) })).status).toBe(404);

    await app.request("/api/sec-issuer-followups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession: nextAccession }) });
    const changedLead = await (await app.request("/api/sec-issuer-followups")).json() as { items: Array<{ cik: string; savedAt: string; triggeringAccession: string; filingUrl: string }> };
    expect(changedLead.items).toHaveLength(1);
    expect(changedLead.items[0]).toMatchObject({ cik: "0000000320", triggeringAccession: nextAccession, filingUrl: nextFilingUrl });
    expect(Date.parse(changedLead.items[0]!.savedAt)).toBeGreaterThan(Date.parse(repeatedSave.items[0]!.savedAt));

    desk!.close(); desk = null;
    app = appAt(dbPath);
    expect(await (await app.request("/api/sec-issuer-followups")).json()).toMatchObject({ items: [{ cik: "0000000320", triggeringAccession: nextAccession, filingUrl: nextFilingUrl }] });
    expect((await app.request("/api/sec-issuer-followups/0000000320", { method: "DELETE" })).status).toBe(200);
    expect(await (await app.request("/api/sec-issuer-followups")).json()).toEqual({ items: [] });
  });
});
