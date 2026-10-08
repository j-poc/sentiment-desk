import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";
import { DeskWriterLock } from "../server/writer-lock.js";

const accession = "0000000320-25-000001";
const filingUrl = "https://www.sec.gov/Archives/edgar/data/320/000000032025000001/0000000320-25-000001-index.htm";
const nextAccession = "0000000320-25-000002";
const nextFilingUrl = "https://www.sec.gov/Archives/edgar/data/320/000000032025000002/0000000320-25-000002-index.htm";
let inbox: SecFilingsInboxView = {
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

describe("saved SEC filing research tasks", () => {
  it("keeps an older v16 database readable in writer-lock read-only mode and reports task storage unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-filing-task-readonly-")); directories.push(directory);
    const dbPath = join(directory, "desk.sqlite");
    const initialized = new Desk(dbPath);
    initialized.close();
    const oldSchema = new DatabaseSync(dbPath);
    oldSchema.exec("DROP TABLE sec_filing_research_tasks");
    oldSchema.close();

    const lock = DeskWriterLock.acquire(dbPath);
    expect(lock).not.toBeNull();
    try {
      const app = appAt(dbPath);
      const response = await app.request("/api/sec-filing-research-tasks");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "sec_filing_research_tasks_unavailable" });
    } finally {
      desk?.close(); desk = null;
      lock?.release();
    }
  });

  it("keys tasks by issuer and accession, preserves multiple filings, survives reopen, and removes one filing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-issuer-followup-")); directories.push(directory);
    const dbPath = join(directory, "desk.sqlite");
    let app = appAt(dbPath);

    expect((await app.request("/api/sec-filing-research-tasks")).status).toBe(200);
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accession }) })).status).toBe(400);
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession, nextQuestion: "Check customer concentration" }) })).status).toBe(201);
    const savedResponse = await app.request("/api/sec-filing-research-tasks");
    const firstSaved = await savedResponse.json() as { items: Array<{ savedAt: string; cik: string; issuer: string; triggeringAccession: string; filingUrl: string; nextQuestion: string; feedReceiptId: string; feedUpdatedAt: string; retrievedAt: string }> };
    expect(firstSaved).toMatchObject({ items: [{ cik: "0000000320", issuer: "Apple Inc.", triggeringAccession: accession, filingUrl,
      nextQuestion: "Check customer concentration", feedReceiptId: "receipt", feedUpdatedAt: "2025-01-01T00:00:00.000Z", retrievedAt: "2025-01-01T00:01:00.000Z" }] });

    await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession }) });
    const repeatedSave = await (await app.request("/api/sec-filing-research-tasks")).json() as { items: Array<{ savedAt: string; triggeringAccession: string; filingUrl: string }> };
    expect(repeatedSave.items).toHaveLength(1);
    expect(repeatedSave.items[0]).toMatchObject({ savedAt: firstSaved.items[0]?.savedAt, triggeringAccession: accession, filingUrl });
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession: "0000000320-25-000003" }) })).status).toBe(404);

    await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession: nextAccession, nextQuestion: "Read the guidance update" }) });
    const changedLead = await (await app.request("/api/sec-filing-research-tasks")).json() as { items: Array<{ cik: string; savedAt: string; triggeringAccession: string; filingUrl: string; nextQuestion: string }> };
    expect(changedLead.items).toHaveLength(2);
    expect(changedLead.items).toContainEqual(expect.objectContaining({ cik: "0000000320", triggeringAccession: accession, filingUrl, nextQuestion: "Check customer concentration" }));
    expect(changedLead.items).toContainEqual(expect.objectContaining({ cik: "0000000320", triggeringAccession: nextAccession, filingUrl: nextFilingUrl, nextQuestion: "Read the guidance update" }));

    inbox = { ...inbox, rows: inbox.rows.filter((row) => row.accession === nextAccession), state: "stale", freshness: "stale" };
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession: "0000000320-25-000003", nextQuestion: "Must not change a stale snapshot" }) })).status).toBe(409);
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession, nextQuestion: "Resume after feed rollover" }) })).status).toBe(200);
    expect((await (await app.request("/api/sec-filing-research-tasks")).json() as { items: unknown[] }).items).toHaveLength(2);
    inbox = { ...inbox, state: "ready", freshness: "current" };
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession: "0000000320-25-000003", nextQuestion: "Must not save" }) })).status).toBe(404);
    expect((await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cik: "0000000320", accession, nextQuestion: "q".repeat(501) }) })).status).toBe(400);

    const originalSave = desk!.saveSecFilingResearchTask.bind(desk);
    desk!.saveSecFilingResearchTask = () => { throw new Error("simulated local storage write failure"); };
    const failedWrite = await app.request("/api/sec-filing-research-tasks", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cik: "0000000320", accession, nextQuestion: "Uncommitted draft" }) });
    expect(failedWrite.status).toBe(503);
    expect(await failedWrite.json()).toEqual({ error: "sec_filing_research_task_storage_failed" });
    desk!.saveSecFilingResearchTask = originalSave;
    const afterWriteFailure = await (await app.request("/api/sec-filing-research-tasks")).json() as { items: Array<{ triggeringAccession: string; nextQuestion: string }> };
    expect(afterWriteFailure.items.find((item) => item.triggeringAccession === accession)?.nextQuestion).toBe("Resume after feed rollover");

    desk!.close(); desk = null;
    app = appAt(dbPath);
    expect(await (await app.request("/api/sec-filing-research-tasks")).json()).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ cik: "0000000320", triggeringAccession: accession, nextQuestion: "Resume after feed rollover", filingUrl }),
      expect.objectContaining({ cik: "0000000320", triggeringAccession: nextAccession, filingUrl: nextFilingUrl }),
    ]) });
    expect((await app.request(`/api/sec-filing-research-tasks/0000000320/${accession}`, { method: "DELETE" })).status).toBe(200);
    expect(await (await app.request("/api/sec-filing-research-tasks")).json()).toMatchObject({ items: [{ triggeringAccession: nextAccession }] });
  });
});
