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

function makeApp(fetcher: typeof fetch, options: { externalRequestsEnabled?: boolean; secCompanyFactsEnabled?: boolean; userAgent?: string; now?: () => number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-fundamentals-api-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.sqlite");
  const db = new Desk(dbPath);
  db.seedCompanies([company]);
  openDesks.push(db);
  const companyFundamentals = new CompanyFundamentals({
    db, externalRequestsEnabled: options.externalRequestsEnabled ?? false,
    secCompanyFactsEnabled: options.secCompanyFactsEnabled ?? false,
    userAgent: options.userAgent ?? "", fetcher, now: options.now,
  });
  const app = createApp({
    db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [], companyFundamentals,
  });
  return { app, db };
}

function routedSecFetcher(): typeof fetch {
  const accession = "0000320193-25-000001";
  const fact = (end: string, value: number) => ({
    start: `${end.slice(0, 4)}-01-01`, end, val: value, accn: accession,
    fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-01", decimals: -6,
  });
  const bodies = new Map<string, unknown>([
    ["https://www.sec.gov/files/company_tickers.json", { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }],
    ["https://data.sec.gov/submissions/CIK0000320193.json", { cik: 320193, filings: { recent: {
      form: ["10-K"], filingDate: ["2025-02-01"], reportDate: ["2024-12-31"],
      acceptanceDateTime: ["2025-02-01T09:00:00.000Z"], accessionNumber: [accession], primaryDocument: ["annual-report.htm"],
    } } }],
    ["https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", { cik: 320193, entityName: "Apple Inc.", facts: { "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
        fact("2023-12-31", 100_000_000), fact("2024-12-31", 101_000_000),
      ] } },
    } } }],
  ]);
  return vi.fn<typeof fetch>(async (input) => {
    const body = bodies.get(String(input));
    return body
      ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  });
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

  it("rejects a cross-origin or non-JSON refresh before any SEC request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app, db } = makeApp(fetcher);
    const route = `/api/companies/${encodeURIComponent(company.id)}/fundamentals/refresh`;
    const crossOrigin = await app.request(route, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ requestKey: randomUUID() }),
    });
    expect(crossOrigin.status).toBe(403);

    const nonJson = await app.request(route, {
      method: "POST", headers: { "content-type": "text/plain" },
      body: JSON.stringify({ requestKey: randomUUID() }),
    });
    expect(nonJson.status).toBe(415);
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.latestFundamentalAttempt(company.id)).toBeNull();
  });

  it("rejects non-loopback hosts, a mismatched Host, and cross-site fetches", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app, db } = makeApp(fetcher);
    const route = `/api/companies/${encodeURIComponent(company.id)}/fundamentals/refresh`;
    const request = (url: string, headers: Record<string, string>) => app.request(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ requestKey: randomUUID() }),
    });
    const nonLoopback = await request(`https://desk.example${route}`, {});
    const wrongHost = await request(route, { host: "attacker.example" });
    const crossSite = await request(route, { origin: "http://localhost", "sec-fetch-site": "cross-site" });
    expect([nonLoopback.status, wrongHost.status, crossSite.status]).toEqual([403, 403, 403]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.latestFundamentalAttempt(company.id)).toBeNull();
  });

  it("completes the same-origin selected-company flow and reads back filing-linked facts", async () => {
    const fetcher = routedSecFetcher();
    const { app, db } = makeApp(fetcher, {
      externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk isolated route test contact security@example.org",
      now: () => Date.UTC(2025, 2, 1),
    });
    const route = `/api/companies/${encodeURIComponent(company.id)}/fundamentals/refresh`;
    const refresh = await app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ requestKey: randomUUID() }),
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ refresh: "completed", state: "partial", companyId: company.id });
    expect(fetcher).toHaveBeenCalledTimes(3);

    const saved = await app.request(`/api/companies/${encodeURIComponent(company.id)}/fundamentals`);
    const savedBody = await saved.json() as { state: string; facts: Array<Record<string, unknown>> };
    expect(savedBody.state).toBe("partial");
    expect(savedBody.facts).toHaveLength(2);
    expect(savedBody.facts).toEqual(expect.arrayContaining([expect.objectContaining({ metric: "revenue", form: "10-K" })]));
    const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(raw.prepare("SELECT DISTINCT collector FROM source_deliveries").all()).toEqual([{ collector: "sec_company_facts" }]);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sec_fundamental_payloads").get()).toEqual({ count: 3 });
    const factsReceiptIds = [...new Set(savedBody.facts.map((fact) => fact.companyFactsDeliveryId))];
    expect(factsReceiptIds).toHaveLength(1);
    const factsReceiptId = factsReceiptIds[0];
    if (typeof factsReceiptId !== "string") throw new Error("Persisted facts omitted their CompanyFacts delivery receipt ID.");
    expect(raw.prepare(`SELECT p.endpoint, d.collector FROM sec_fundamental_payloads p
      JOIN source_deliveries d ON d.id=p.delivery_id WHERE p.delivery_id=?`).get(factsReceiptId)).toEqual({
      endpoint: "companyfacts", collector: "sec_company_facts",
    });
  });
});
