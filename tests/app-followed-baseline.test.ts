import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import type { Company } from "../server/types.js";

const directories: string[] = [];
const company: Company = { id: "acme", name: "Acme", ticker: "ACME", sector: "Technology", aliases: [], color: "#123456" };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeApp() {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-followed-baseline-api-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.db");
  const db = new Desk(dbPath);
  db.seedCompanies([company]);
  const app = createApp({
    db,
    dbPath,
    pipeline: {} as AppDeps["pipeline"],
    market: {} as AppDeps["market"],
    hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured", false, false, false, false),
    version: "test",
    webRoot: join(directory, "missing-web-root"),
    deliverySources: [],
  });
  return { db, app };
}

describe("followed evidence baseline API", () => {
  it("keeps no-baseline and no-evidence states distinct and makes capture idempotent", async () => {
    const { db, app } = makeApp();
    try {
      const initialResponse = await app.request("/api/companies/acme/followed-evidence");
      expect(initialResponse.status).toBe(200);
      await expect(initialResponse.json()).resolves.toMatchObject({
        companyId: "acme", baseline: null, eligibleObservationsNow: 0, withheldFromBaseline: 0,
        newEvidenceCount: 0, items: [], nextCursor: null,
      });

      const captureKey = randomUUID();
      const request = () => app.request("/api/companies/acme/followed-evidence/baseline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captureKey, expectedBaselineId: null }),
      });
      const first = await request();
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { baseline: { id: string; version: number; eligibleObservationCount: number }; reused: boolean };
      expect(firstBody).toMatchObject({ reused: false, baseline: { version: 1, eligibleObservationCount: 0 } });
      const retry = await request();
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({ reused: true, baseline: { id: firstBody.baseline.id } });

      const changedPayload = await app.request("/api/companies/acme/followed-evidence/baseline", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ captureKey, expectedBaselineId: firstBody.baseline.id }),
      });
      expect(changedPayload.status).toBe(409);
      await expect(changedPayload.json()).resolves.toMatchObject({ error: "baseline_changed" });

      const current = await app.request("/api/companies/acme/followed-evidence");
      await expect(current.json()).resolves.toMatchObject({ baseline: { id: firstBody.baseline.id, version: 1 }, newEvidenceCount: 0 });
      expect((await app.request("/api/companies/unknown/followed-evidence")).status).toBe(404);
      expect((await app.request("/api/companies/acme/followed-evidence?cursor=not-json")).status).toBe(400);

      const stale = await app.request("/api/companies/acme/followed-evidence/baseline", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ captureKey: randomUUID(), expectedBaselineId: null }),
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ error: "baseline_changed", currentBaseline: { id: firstBody.baseline.id } });

      const secondKey = randomUUID();
      const second = await app.request("/api/companies/acme/followed-evidence/baseline", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ captureKey: secondKey, expectedBaselineId: firstBody.baseline.id }),
      });
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({ reused: false, baseline: { version: 2 } });

      const staleCursor = encodeURIComponent(JSON.stringify({
        companyId: "acme", baselineId: firstBody.baseline.id, snapshotAt: Date.now(),
        snapshotMaxRowId: 0, ingestedAt: Date.now(), id: "old-item",
      }));
      const oldPage = await app.request(`/api/companies/acme/followed-evidence?cursor=${staleCursor}`);
      expect(oldPage.status).toBe(409);
      expect((await app.request("/api/companies/acme/followed-evidence/baseline", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })).status).toBe(400);
    } finally {
      db.close();
    }
  });
});
