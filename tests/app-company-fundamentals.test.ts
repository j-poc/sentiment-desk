import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { CompanyFundamentals } from "../server/company-fundamentals.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { loadCompanies } from "../server/config.js";

const company = loadCompanies().find((candidate) => candidate.ticker === "AAPL")!;
const openDesks: Desk[] = [];
const directories: string[] = [];

afterEach(() => {
  while (openDesks.length) openDesks.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function makeApp(fetcher: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-fundamentals-api-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.sqlite");
  const db = new Desk(dbPath);
  db.seedCompanies([company]);
  openDesks.push(db);
  const companyFundamentals = new CompanyFundamentals({
    db, externalRequestsEnabled: false, secSourceEnabled: false, userAgent: "", fetcher,
  });
  const app = createApp({
    db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [], companyFundamentals,
  });
  return { app, db };
}

describe("selected-company SEC fundamentals routes", () => {
  it("returns the saved blocked first run and never calls SEC when external acquisition is disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app, db } = makeApp(fetcher);

    const read = await app.request(`/api/companies/${encodeURIComponent(company.id)}/fundamentals`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      companyId: company.id, state: "blocked", facts: [], comparisons: [], points: [],
      refreshAllowed: false, refreshBlockedReason: "External requests are disabled; saved SEC facts remain available.",
    });

    const refresh = await app.request(`/api/companies/${encodeURIComponent(company.id)}/fundamentals/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: randomUUID() }),
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ refresh: "blocked", facts: [], points: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.latestFundamentalAttempt(company.id)).toBeNull();
  });

  it("rejects arbitrary CIK/URL fields and malformed request keys", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app, db } = makeApp(fetcher);
    const invalid = await app.request(`/api/companies/${encodeURIComponent(company.id)}/fundamentals/refresh`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "invalid", cik: "0000000001", url: "https://example.com/" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_company_fundamentals_refresh" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.latestFundamentalAttempt(company.id)).toBeNull();
  });
});
