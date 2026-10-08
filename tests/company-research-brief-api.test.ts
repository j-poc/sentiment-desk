import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { loadCompanies } from "../server/config.js";
import { TestDesk as Desk } from "./test-desk.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-research-brief-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.sqlite");
  const companies = loadCompanies();
  const db = new Desk(dbPath);
  db.seedCompanies(companies);
  const publicIds = new Set(companies.filter((company) => company.listingStatus === "publicly_listed").map((company) => company.id));
  const makeApp = (current: Desk) => createApp({
    db: current, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
    configuredPublicCompanyIds: publicIds,
  });
  return { db, dbPath, companies, makeApp };
}

function saveReceiptVerifiedObservation(db: Desk, input: {
  companyId: string; id: string; title: string; retrievedAt: number; publishedAt: number | null;
}) {
  const startedAt = input.retrievedAt - 20;
  const deliveryId = db.recordDelivery({
    collector: "google_news_rss", companyId: input.companyId, requestKey: `brief-${input.id}`,
    startedAt, completedAt: input.retrievedAt - 10, result: "success", parsedItemCount: 1,
    adapterVersion: "google-news-rss/test", processingRequired: true,
  });
  db.startDeliveryIngestion(deliveryId, 1, input.retrievedAt - 9);
  const observation = db.insertObservation({
    companyId: input.companyId, kind: "rss", sourceName: "Google News RSS",
    sourceUrl: `https://news.google.com/rss/articles/${input.id}`, tier: "major", title: input.title,
    snippet: "Saved public excerpt for analyst review.", publishedAt: input.publishedAt,
    retrievedAt: input.retrievedAt, collector: "google_news_rss", publisherName: "Example Publisher",
    publisherDomain: "example.com", sourceItemId: input.id, adapterVersion: "google-news-rss/test", deliveryId,
  });
  db.finishDeliveryIngestion(deliveryId, {
    status: "success", processedCount: 1, insertedCount: 1, completedAt: input.retrievedAt - 1,
  });
  return observation.observationId;
}

describe("selected-company public research brief API", () => {
  it("includes only cutoff-bound strong-identity rows with terminal matching receipts", async () => {
    const { db, companies, makeApp } = setup();
    const apple = companies.find((company) => company.ticker === "AAPL")!;
    const adobe = companies.find((company) => company.ticker === "ADBE")!;
    const now = Date.now();
    const eligible = saveReceiptVerifiedObservation(db, {
      companyId: apple.id, id: "eligible-aapl", title: "AAPL quarterly results and iPhone revenue", retrievedAt: now - 100, publishedAt: now - 200,
    });
    const weak = saveReceiptVerifiedObservation(db, {
      companyId: apple.id, id: "weak-apple", title: "Apple pie festival returns to town", retrievedAt: now - 80, publishedAt: now - 180,
    });
    db.insertObservation({
      companyId: apple.id, kind: "rss", sourceName: "Unlinked", sourceUrl: "https://example.com/unlinked",
      tier: "major", title: "AAPL unlinked historical lead", snippet: "No receipt.", publishedAt: now - 50,
      retrievedAt: now - 40, collector: "google_news_rss", publisherName: "Example Publisher", publisherDomain: "example.com",
    });
    saveReceiptVerifiedObservation(db, {
      companyId: adobe.id, id: "other-issuer", title: "ADBE quarterly results", retrievedAt: now - 60, publishedAt: now - 160,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await makeApp(db).request(`/api/companies/${apple.id}/research-brief`);
      expect(response.status).toBe(200);
      const result = await response.json() as {
        brief: { observations: Array<{ id: string; deliveryId: string; deliveryCompletedAt: number; ingestionCompletedAt: number; timeBasis: string }>; coverage: { publicObservations: string; reasons: string[] } };
      };
      expect(result.brief.observations.map((item) => item.id)).toEqual([eligible]);
      expect(result.brief.observations[0]).toMatchObject({
        deliveryId: expect.any(String), deliveryCompletedAt: expect.any(Number), ingestionCompletedAt: expect.any(Number),
      });
      expect(result.brief.coverage.publicObservations).toBe("partial");
      expect(result.brief.coverage.reasons.join(" ")).toMatch(/withheld/);
      expect(result.brief.observations.map((item) => item.id)).not.toContain(weak);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("persists an explicit analyst decision bound to the exact cutoff and manifest across restart", async () => {
    const { db, dbPath, companies, makeApp } = setup();
    const apple = companies.find((company) => company.ticker === "AAPL")!;
    try {
      const originalNow = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(originalNow);
      const app = makeApp(db);
      const initial = await app.request(`/api/companies/${apple.id}/research-brief`);
      expect(initial.status).toBe(200);
      const body = await initial.json() as { snapshotKey: string; brief: { asOfMs: number; observations: unknown[] } };
      const requestKey = randomUUID();
      const save = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ requestKey, asOfMs: body.brief.asOfMs, snapshotKey: body.snapshotKey,
          decision: "insufficient_evidence", rationale: "No comparable saved filing evidence.", evidenceRoles: [], nextCheckDate: null }),
      }));
      expect(save.status).toBe(200);
      expect(await save.json()).toMatchObject({ decision: { requestKey, decision: "insufficient_evidence", factIds: [], observationIds: [], evidenceRoles: [] } });
      const firstReadback = await makeApp(db).request(`/api/companies/${apple.id}/research-brief`);
      const firstReadbackBody = await firstReadback.json() as { snapshotKey: string; brief: { asOfMs: number }; decision: { asOfMs: number; snapshotKey: string; rationale: string } };
      clock.mockReturnValue(originalNow + 60_000);
      const laterReadback = await makeApp(db).request(`/api/companies/${apple.id}/research-brief`);
      const laterReadbackBody = await laterReadback.json() as { snapshotKey: string; brief: { asOfMs: number }; decision: { asOfMs: number; snapshotKey: string; rationale: string } };
      expect(firstReadbackBody.snapshotKey).toBe(body.snapshotKey);
      expect(laterReadbackBody.snapshotKey).toBe(body.snapshotKey);
      expect(laterReadbackBody.brief.asOfMs).toBeGreaterThan(firstReadbackBody.brief.asOfMs);
      expect(laterReadbackBody.decision).toMatchObject({ asOfMs: body.brief.asOfMs, snapshotKey: body.snapshotKey,
        rationale: "No comparable saved filing evidence." });
      db.close();

      const reopened = new Desk(dbPath);
      try {
        const afterRestart = await makeApp(reopened).request(`/api/companies/${apple.id}/research-brief`);
        expect(afterRestart.status).toBe(200);
        expect(await afterRestart.json()).toMatchObject({
          decision: { requestKey, companyId: apple.id, decision: "insufficient_evidence", rationale: "No comparable saved filing evidence." },
          decisionStorageAvailable: true,
        });
      } finally { reopened.close(); }
    } finally {
      try { db.close(); } catch { /* closed before restart */ }
    }
  });

  it("reports write-capacity pauses and preserves existing decisions while refusing new saves", async () => {
    const { db, companies, makeApp } = setup();
    const apple = companies.find((company) => company.ticker === "AAPL")!;
    const app = makeApp(db);
    try {
      const initial = await app.request(`/api/companies/${apple.id}/research-brief`);
      expect(initial.status).toBe(200);
      const snapshot = await initial.json() as { snapshotKey: string; brief: { asOfMs: number } };
      const saveInput = {
        requestKey: randomUUID(), asOfMs: snapshot.brief.asOfMs, snapshotKey: snapshot.snapshotKey,
        decision: "investigate_further", rationale: "Check the saved evidence again.", evidenceRoles: [], nextCheckDate: null,
      };
      const saved = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" }, body: JSON.stringify(saveInput),
      }));
      expect(saved.status).toBe(200);

      const capacity = db.storageCapacity();
      vi.spyOn(db, "storageCapacity").mockReturnValue({
        ...capacity, state: "disk_pressure", writesAllowed: false,
        reason: "Free at least 1 GiB on the data volume before collection resume.",
      });
      const pausedRead = await app.request(`/api/companies/${apple.id}/research-brief`);
      expect(pausedRead.status).toBe(200);
      expect(await pausedRead.json()).toMatchObject({
        decision: { requestKey: saveInput.requestKey, rationale: "Check the saved evidence again." },
        decisionStorageAvailable: false,
        decisionStorageUnavailableReason: "Free at least 1 GiB on the data volume before collection resume.",
      });

      const rejected = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ ...saveInput, requestKey: randomUUID(), decision: "set_aside" }),
      }));
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toMatchObject({ error: "company_research_decision_storage_paused" });
      expect(db.latestCompanyResearchDecision(apple.id)).toMatchObject({
        requestKey: saveInput.requestKey, decision: "investigate_further",
      });
    } finally { db.close(); }
  });

  it("reconstructs a saved cutoff after later receipt-verified evidence arrives without a provider request", async () => {
    const { db, companies, makeApp } = setup();
    const apple = companies.find((company) => company.ticker === "AAPL")!;
    const originalNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(originalNow);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const app = makeApp(db);
      const initial = await app.request(`/api/companies/${apple.id}/research-brief`);
      expect(initial.status).toBe(200);
      const saved = await initial.json() as { snapshotKey: string; brief: { asOfMs: number; observations: Array<{ id: string }> } };
      const save = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ requestKey: randomUUID(), asOfMs: saved.brief.asOfMs, snapshotKey: saved.snapshotKey,
          decision: "investigate_further", rationale: "Recheck this exact evidence set.", evidenceRoles: [], nextCheckDate: null }),
      }));
      expect(save.status).toBe(200);

      const laterObservationId = saveReceiptVerifiedObservation(db, {
        companyId: apple.id, id: "later-receipt-verified", title: "AAPL reports a later quarterly update",
        retrievedAt: originalNow + 10_000, publishedAt: originalNow + 9_000,
      });
      const resumed = await app.request(`/api/companies/${apple.id}/research-brief?asOfMs=${saved.brief.asOfMs}`);
      expect(resumed.status).toBe(200);
      const restored = await resumed.json() as { snapshotKey: string; brief: { asOfMs: number; observations: Array<{ id: string }> } };
      expect(restored.snapshotKey).toBe(saved.snapshotKey);
      expect(restored.brief.asOfMs).toBe(saved.brief.asOfMs);
      expect(restored.brief.observations.map((item) => item.id)).toEqual(saved.brief.observations.map((item) => item.id));
      expect(restored.brief.observations.map((item) => item.id)).not.toContain(laterObservationId);

      const later = await app.request(`/api/companies/${apple.id}/research-brief?asOfMs=${originalNow + 20_000}`);
      expect(later.status).toBe(200);
      const laterBody = await later.json() as { snapshotKey: string; brief: { observations: Array<{ id: string }> } };
      expect(laterBody.snapshotKey).not.toBe(saved.snapshotKey);
      expect(laterBody.brief.observations.map((item) => item.id)).toContain(laterObservationId);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("rejects malformed or ambiguous historical cutoffs", async () => {
    const { db, companies, makeApp } = setup();
    const apple = companies.find((company) => company.ticker === "AAPL")!;
    try {
      const app = makeApp(db);
      for (const query of ["asOfMs=-1", "asOfMs=1.5", "asOfMs=1e3", "asOfMs=9007199254740992", "asOfMs=1&asOfMs=2"]) {
        const response = await app.request(`/api/companies/${apple.id}/research-brief?${query}`);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_research_brief_cutoff" });
      }
    } finally { db.close(); }
  });

  it("rejects a non-public company, a mismatched snapshot key, and cross-origin writes", async () => {
    const { db, companies, makeApp } = setup();
    const apple = companies.find((company) => company.ticker === "AAPL")!;
    const adobe = companies.find((company) => company.ticker === "ADBE")!;
    const privateLike = { ...apple, id: "unlisted-private", ticker: "PRIVATE", name: "Private Company" };
    db.seedCompanies([privateLike]);
    try {
      const originalNow = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(originalNow);
      const app = makeApp(db);
      expect((await app.request(`/api/companies/${privateLike.id}/research-brief`)).status).toBe(404);
      const initial = await app.request(`/api/companies/${apple.id}/research-brief`);
      const body = await initial.json() as { snapshotKey: string; brief: { asOfMs: number } };
      clock.mockReturnValue(originalNow + 10_000);
      const newObservationId = saveReceiptVerifiedObservation(db, {
        companyId: apple.id, id: "arrived-after-cutoff", title: "AAPL new results update", retrievedAt: Date.now(), publishedAt: Date.now(),
      });
      const stale = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ requestKey: randomUUID(), asOfMs: body.brief.asOfMs, snapshotKey: body.snapshotKey,
          decision: "set_aside", rationale: "Changed", evidenceRoles: [], nextCheckDate: null }),
      }));
      expect(stale.status).toBe(200);
      expect(await stale.json()).toMatchObject({ decision: { asOfMs: body.brief.asOfMs, snapshotKey: body.snapshotKey } });
      const mismatched = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ requestKey: randomUUID(), asOfMs: body.brief.asOfMs, snapshotKey: "0".repeat(64),
          decision: "set_aside", rationale: "Changed", evidenceRoles: [], nextCheckDate: null }),
      }));
      expect(mismatched.status).toBe(409);
      const wrongIssuer = await app.request(new Request(`http://127.0.0.1/api/companies/${apple.id}/research-brief/decisions`, {
        method: "POST", headers: { "content-type": "application/json", origin: `https://attacker.invalid` },
        body: JSON.stringify({ requestKey: randomUUID(), asOfMs: body.brief.asOfMs, snapshotKey: body.snapshotKey,
          decision: "set_aside", rationale: "Changed", evidenceRoles: [], nextCheckDate: null }),
      }));
      expect(wrongIssuer.status).toBe(403);
      expect((await app.request(`/api/companies/${adobe.id}/research-brief`)).status).toBe(200);

      clock.mockReturnValue(originalNow + 60_000);
      const refreshed = await app.request(`/api/companies/${apple.id}/research-brief`);
      const refreshedBody = await refreshed.json() as { snapshotKey: string; brief: { asOfMs: number; observations: Array<{ id: string }> }; decision: { snapshotKey: string } };
      expect(refreshedBody.snapshotKey).not.toBe(body.snapshotKey);
      expect(refreshedBody.brief.observations.map((item) => item.id)).toContain(newObservationId);
      expect(refreshedBody.decision.snapshotKey).toBe(body.snapshotKey);
    } finally { db.close(); }
  });
});
