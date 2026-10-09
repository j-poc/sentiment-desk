import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { loadCompanies } from "../server/config.js";
import { CompanyFundamentals } from "../server/company-fundamentals.js";
import { TestDesk as Desk } from "./test-desk.js";
import { DeskWriterLock } from "../server/writer-lock.js";

const dirs: string[] = [];
const desks: Desk[] = [];
afterEach(() => { while (desks.length) desks.pop()!.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function inbox(overrides: Partial<SecFilingsInboxView> = {}): SecFilingsInboxView {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = { cik: "0001786108", accession: "0001786108-26-000001", form: "8-K" as const,
    issuer: "Trinity Capital Inc.", filingUrl: "https://www.sec.gov/Archives/edgar/data/1786108/000178610826000001/0001786108-26-000001-index.htm",
    filedOn: iso(now), acceptedAt: iso(now), feedPublishedAt: null, feedUpdatedAt: iso(now),
    listing: { symbol: "TRIN", exchange: "Nasdaq", securityName: "Trinity Capital Inc. - Common Stock",
      directoryCreatedAt: iso(now - 60_000), directoryRetrievedAt: iso(now - 30_000), directories: [
        { source: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", createdAt: iso(now - 60_000), retrievedAt: iso(now - 30_000) },
      ] } };
  return { state: "ready", freshness: "current", rows: [row], receiptId: "sec-feed-receipt", retrievedAt: iso(now),
    feedUpdatedAt: iso(now), jobStatus: "succeeded", canActivate: false, nextRefreshAt: null, message: null, ...overrides };
}

function setup(current: SecFilingsInboxView, fetcher?: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), "sec-filing-research-case-")); dirs.push(directory);
  const path = join(directory, "desk.sqlite"); const db = new Desk(path); desks.push(db);
  const roster = loadCompanies().filter((company) => company.ticker === "AAPL"); db.seedCompanies(roster);
  const companyFundamentals = new CompanyFundamentals({ db, externalRequestsEnabled: fetcher != null,
    secCompanyFactsEnabled: fetcher != null, userAgent: "SentimentDesk contact research@example.com", fetcher });
  const app = createApp({ db, dbPath: path, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
    companyFundamentals,
    secFilingsInbox: { read: async () => current } as AppDeps["secFilingsInbox"],
  });
  return { app, db, roster, path };
}

const body = { cik: "0001786108", accession: "0001786108-26-000001" };
const officialExchangeDirectory = (...entries: Array<{ cik: number; name: string; ticker: string; exchange: string | null }>) => ({
  fields: ["cik", "name", "ticker", "exchange"],
  data: entries.map(({ cik, name, ticker, exchange }) => [cik, name, ticker, exchange]),
});
const post = (app: ReturnType<typeof setup>["app"], data: unknown) => app.request("/api/sec-filing-research-cases", {
  method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(data),
});

describe("research-only SEC filing case enrollment", () => {
  it("enrolls by exact current filing identity, is idempotent, and never touches configured companies", async () => {
    const { app, db, roster } = setup(inbox());
    const first = await post(app, body); expect(first.status).toBe(201);
    const value = await first.json() as { case: { kind: string; id: string; cik: string; triggeringAccession: string; filingSymbol: string; identity: { status: string } }; created: boolean };
    expect(value).toMatchObject({ created: true, case: { kind: "sec_filing_case", cik: body.cik,
      triggeringAccession: body.accession, filingSymbol: "TRIN", identity: { status: "unverified" } } });
    const repeated = await post(app, body); expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ created: false, case: { id: value.case.id } });
    expect(db.companies()).toHaveLength(roster.length);
    expect(db.companies().map(({ id, ticker }) => ({ id, ticker }))).toEqual(roster.map(({ id, ticker }) => ({ id, ticker })));
    const cases = await app.request("/api/sec-filing-research-cases"); expect(cases.status).toBe(200);
    expect(await cases.json()).toMatchObject({ items: [{ id: value.case.id, kind: "sec_filing_case" }] });
    expect((await app.request(`/api/sec-filing-research-cases/${value.case.id}`)).status).toBe(200);
  });

  it("rejects stale feeds, missing filings, CIK mismatches, and client-supplied issuer claims", async () => {
    const stale = setup(inbox({ freshness: "stale" })); expect((await post(stale.app, body)).status).toBe(409);
    const absent = setup(inbox({ rows: [] })); expect((await post(absent.app, body)).status).toBe(404);
    const mismatch = setup(inbox()); expect((await post(mismatch.app, { ...body, cik: "0000000001" })).status).toBe(404);
    const claims = setup(inbox()); expect((await post(claims.app, { ...body, ticker: "TRIN", name: "Trinity Capital" })).status).toBe(400);
    expect(claims.db.secFilingResearchCases()).toEqual([]);
  });

  it("rejects missing or stale listing proof even when the filing row is current", async () => {
    const missingProof = setup(inbox({ rows: [{ ...inbox().rows[0]!, listing: undefined }] }));
    expect((await post(missingProof.app, body)).status).toBe(404);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const staleProof = setup(inbox({ rows: [{ ...inbox().rows[0]!, listing: { ...inbox().rows[0]!.listing!, directoryRetrievedAt: old,
      directories: [{ ...inbox().rows[0]!.listing!.directories[0]!, retrievedAt: old }] } }] }));
    expect((await post(staleProof.app, body)).status).toBe(409);
  });

  it("verifies SEC ticker identity only from the official response and persists its exact receipt", async () => {
    const fetcher: typeof fetch = async (input) => String(input) === "https://www.sec.gov/files/company_tickers_exchange.json"
      ? new Response(JSON.stringify(officialExchangeDirectory(
        { cik: 1786108, name: "Trinity Capital Inc.", ticker: "TRIN", exchange: "NYSE" },
        { cik: 1362988, name: "Aircastle LTD", ticker: "AYR", exchange: null },
      )),
        { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
    const { app, db } = setup(inbox(), fetcher);
    const enrolled = await post(app, body); const value = await enrolled.json() as { case: { id: string } };
    const response = await app.request(`/api/sec-filing-research-cases/${value.case.id}/verify-identity`, {
      method: "POST", headers: { origin: "http://localhost" },
    });
    expect(response.status).toBe(200);
    const verified = await response.json() as { case: { identity: { status: string; ticker: string; issuerName: string; receipt: { url: string; sha256: string } } } };
    expect(verified).toMatchObject({ case: { identity: { status: "verified", ticker: "TRIN", issuerName: "Trinity Capital Inc.",
      receipt: { url: "https://www.sec.gov/files/company_tickers_exchange.json" } } } });
    const actualBody = JSON.stringify(officialExchangeDirectory(
      { cik: 1786108, name: "Trinity Capital Inc.", ticker: "TRIN", exchange: "NYSE" },
      { cik: 1362988, name: "Aircastle LTD", ticker: "AYR", exchange: null },
    ));
    expect(verified.case.identity.receipt.sha256).toBe(createHash("sha256").update(actualBody).digest("hex"));
  });

  it("recovers a mismatch only after a fresh SEC recheck and preserves both identity receipts", async () => {
    const directoryBodies = [
      officialExchangeDirectory({ cik: 320193, name: "Apple Inc.", ticker: "TRIN", exchange: "Nasdaq" }),
      officialExchangeDirectory({ cik: 1786108, name: "Trinity Capital Inc.", ticker: "TRIN", exchange: "NYSE" }),
    ];
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(directoryBodies.shift()),
      { status: 200, headers: { "content-type": "application/json" } });
    const { app, db } = setup(inbox(), fetcher);
    const enrolled = await post(app, body); const value = await enrolled.json() as { case: { id: string } };
    const verify = (origin = "http://localhost") => app.request(`/api/sec-filing-research-cases/${value.case.id}/verify-identity`, {
      method: "POST", headers: { origin },
    });
    const mismatch = await verify();
    expect(mismatch.status).toBe(200);
    expect(await mismatch.json()).toMatchObject({ case: { identity: { status: "mismatch", ticker: null, issuerName: null } } });
    const recovered = await verify();
    expect(recovered.status).toBe(200);
    const recoveredValue = await recovered.json() as { case: { identity: { status: string; ticker: string; issuerName: string; receipt: { sha256: string } } } };
    expect(recoveredValue).toMatchObject({ case: { identity: { status: "verified", ticker: "TRIN", issuerName: "Trinity Capital Inc." } } });
    const rawDb = (db as unknown as { db: DatabaseSync }).db;
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM public_sec_research_identity_receipts WHERE case_id=?").get(value.case.id) as { count: number }).count).toBe(2);
    expect(db.secFilingResearchIdentityReceipt(value.case.id)?.sha256).toBe(recoveredValue.case.identity.receipt.sha256);
  });

  it("rejects a cross-origin mismatch recheck before requesting SEC", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return new Response(JSON.stringify(officialExchangeDirectory({ cik: 320193, name: "Apple Inc.", ticker: "TRIN", exchange: "Nasdaq" })),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    const { app } = setup(inbox(), fetcher);
    const enrolled = await post(app, body); const value = await enrolled.json() as { case: { id: string } };
    const first = await app.request(`/api/sec-filing-research-cases/${value.case.id}/verify-identity`, {
      method: "POST", headers: { origin: "http://localhost" },
    });
    expect(first.status).toBe(200);
    expect(requests).toBe(1);
    const crossOrigin = await app.request(`/api/sec-filing-research-cases/${value.case.id}/verify-identity`, {
      method: "POST", headers: { origin: "https://example.com" },
    });
    expect(crossOrigin.status).toBe(403);
    expect(requests).toBe(1);
  });

  it("keeps unverified and mismatched identities from exposing facts or allowing a fundamentals request", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(officialExchangeDirectory({ cik: 320193, name: "Apple Inc.", ticker: "TRIN", exchange: "Nasdaq" })),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    const { app } = setup(inbox(), fetcher);
    const enrolled = await post(app, body); const value = await enrolled.json() as { case: { id: string } };
    const unverified = await app.request(`/api/sec-filing-research-cases/${value.case.id}`);
    expect(await unverified.json()).toMatchObject({ case: { identity: { status: "unverified" } }, fundamentals: { facts: [], state: "blocked" }, brief: null });
    const verified = await app.request(`/api/sec-filing-research-cases/${value.case.id}/verify-identity`, { method: "POST", headers: { origin: "http://localhost" } });
    expect(verified.status).toBe(200);
    const before = requests.length;
    const refresh = await app.request(`/api/sec-filing-research-cases/${value.case.id}/fundamentals/refresh`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ requestKey: randomUUID() }),
    });
    expect(refresh.status).toBe(409);
    expect(await refresh.json()).toEqual({ error: "sec_filing_case_identity_mismatch" });
    expect(requests).toHaveLength(before);
  });

  it("allows reads but rejects enrollment writes while the initialized case store is read-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sec-case-readonly-")); dirs.push(directory);
    const path = join(directory, "desk.sqlite"); const initialized = new Desk(path); initialized.close();
    const lock = DeskWriterLock.acquire(path); expect(lock).not.toBeNull();
    try {
      const db = new Desk(path); desks.push(db);
      const app = createApp({ db, dbPath: path, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
        health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
        secFilingsInbox: { read: async () => inbox() } as AppDeps["secFilingsInbox"],
      });
      expect((await app.request("/api/sec-filing-research-cases")).status).toBe(200);
      const response = await post(app, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "sec_filing_research_case_storage_paused" });
    } finally { lock?.release(); }
  });

  it("marks an interrupted case refresh recoverable on restart", async () => {
    const { app, db, path } = setup(inbox());
    const enrolled = await post(app, body); const value = await enrolled.json() as { case: { id: string } };
    db.claimSecFilingCaseFundamentalAttempt({ caseId: value.case.id, requestKey: randomUUID() });
    desks.splice(desks.indexOf(db),1); db.close();
    const recovered = new Desk(path); desks.push(recovered);
    expect(recovered.latestSecFilingCaseFundamentalAttempt(value.case.id)).toMatchObject({ status: "interrupted",
      error: "The application stopped before this SEC research-case refresh completed." });
  });

  it("refreshes only a verified case, returns case-typed facts, and saves an immutable case decision to its queue", async () => {
    const accession = "0001786108-25-000007";
    const repeatedAccession = "0001193125-26-068600";
    const currentAccession = "0001193125-26-333907";
    const docs = new Map<string, unknown>([
      ["https://www.sec.gov/files/company_tickers_exchange.json", officialExchangeDirectory({ cik: 1786108, name: "Trinity Capital Inc.", ticker: "TRIN", exchange: "NYSE" })],
      ["https://data.sec.gov/submissions/CIK0001786108.json", { cik: 1786108, filings: { recent: {
        form: ["10-K", "10-K", "10-Q"], filingDate: ["2025-02-20", "2026-02-20", "2026-08-05"],
        reportDate: ["2024-12-31", "2024-12-31", "2026-06-30"],
        acceptanceDateTime: ["2025-02-20T13:00:00.000Z", "2026-02-20T13:00:00.000Z", "2026-08-05T13:00:00.000Z"],
        accessionNumber: [accession, repeatedAccession, currentAccession], primaryDocument: ["annual.htm", "annual-amended.htm", "quarterly.htm"],
      } } }],
      ["https://data.sec.gov/api/xbrl/companyfacts/CIK0001786108.json", { cik: 1786108, entityName: "Trinity Capital Inc.", facts: { "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
          { start: "2023-01-01", end: "2023-12-31", val: 100, accn: accession, fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-20", decimals: "INF" },
          { start: "2024-01-01", end: "2024-12-31", val: 120, accn: accession, fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-20", decimals: "INF" },
          { start: "2024-01-01", end: "2024-12-31", val: 120, accn: repeatedAccession, fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-20", decimals: "INF" },
          { start: "2026-01-01", end: "2026-06-30", val: 220, accn: currentAccession, fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-08-05", decimals: "INF" },
        ] } },
      } } }],
    ]);
    const fetcher: typeof fetch = async (input) => {
      const data = docs.get(String(input));
      return data ? new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 });
    };
    const { app } = setup(inbox(), fetcher);
    const enrolled = await post(app, body); const saved = await enrolled.json() as { case: { id: string } };
    const verify = await app.request(`/api/sec-filing-research-cases/${saved.case.id}/verify-identity`, { method: "POST", headers: { origin: "http://localhost" } });
    expect(verify.status).toBe(200);
    const refresh = await app.request(`/api/sec-filing-research-cases/${saved.case.id}/fundamentals/refresh`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ requestKey: randomUUID() }),
    });
    expect(refresh.status).toBe(200);
    const detail = await refresh.json() as { fundamentals: { kind: string; caseId: string; state: string; staleReason: string | null; facts: Array<Record<string, unknown>> }; brief: { brief: { subject: Record<string, unknown>; facts: Array<Record<string, unknown>> }; snapshotKey: string } };
    expect(detail.fundamentals).toMatchObject({ kind: "sec_filing_case_fundamentals", caseId: saved.case.id });
    expect(detail.fundamentals.facts).toHaveLength(4);
    expect(detail.brief.brief.facts).toHaveLength(3);
    expect(detail.fundamentals.facts[0]).toHaveProperty("caseId", saved.case.id);
    expect(detail.fundamentals.facts[0]).not.toHaveProperty("companyId");
    expect(detail.fundamentals.state).toBe("partial");
    expect(detail.fundamentals.staleReason).toBeNull();
    expect(detail.brief.brief.subject).toMatchObject({ kind: "sec_filing_case", caseId: saved.case.id, ticker: "TRIN" });
    const decision = await app.request(`/api/sec-filing-research-cases/${saved.case.id}/research-brief/decisions`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({
        requestKey: randomUUID(), asOfMs: Date.now() + 1, snapshotKey: detail.brief.snapshotKey,
        factIds: detail.brief.brief.facts.map((fact) => String(fact.id)), decision: "investigate_further", rationale: "Review filing-linked revenue change.", nextCheckDate: null,
      }),
    });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({ decision: { caseId: saved.case.id } });
    const queue = await app.request("/api/research-queue/sec-filing-cases");
    expect(await queue.json()).toMatchObject({ items: [{ target: { kind: "sec_filing_case", caseId: saved.case.id }, factCount: 3 }] });
  });
});
