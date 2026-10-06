import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyFundamentals, normalizeExactDecimal } from "../server/company-fundamentals.js";
import { TestDesk as Desk } from "./test-desk.js";
import { loadCompanies } from "../server/config.js";

const apple = loadCompanies().find((company) => company.ticker === "AAPL")!;
const openDesks: Desk[] = [];
const tempDirs: string[] = [];

function memoryDesk(company = apple): Desk {
  const db = new Desk(":memory:");
  db.seedCompanies([company]);
  openDesks.push(db);
  return db;
}

function secResponseFetcher(includeDecimals: boolean, currentRevenue = 101_000_000): typeof fetch {
  // Fictional source-shaped payloads are isolated technical fixtures only.
  const accession = "0000000001-25-000001";
  const fact = (start: string, end: string, value: number) => ({
    start, end, val: value, accn: accession, fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-01",
    ...(includeDecimals ? { decimals: -6 } : {}),
  });
  const bodies = new Map<string, unknown>([
    ["https://www.sec.gov/files/company_tickers.json", { "0": { cik_str: 1, ticker: "TEST", title: "Isolated test issuer" } }],
    ["https://data.sec.gov/submissions/CIK0000000001.json", {
      cik: 1,
      filings: { recent: {
        form: ["10-K"], filingDate: ["2025-02-01"], reportDate: ["2024-12-31"],
        acceptanceDateTime: ["2025-02-01T09:00:00.000Z"], accessionNumber: [accession], primaryDocument: ["aapl-20241231.htm"],
      } },
    }],
    ["https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json", {
      cik: 1, entityName: "Isolated test issuer", facts: { "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
          fact("2023-01-01", "2023-12-31", 100_000_000),
          fact("2024-01-01", "2024-12-31", currentRevenue),
        ] } },
      } },
    }],
  ]);
  return vi.fn<typeof fetch>(async (input) => {
    const body = bodies.get(String(input));
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  while (openDesks.length) openDesks.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("selected-company SEC fundamentals service", () => {
  it("keeps missing process identity blocked and sends no external request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const db = memoryDesk();
    const service = new CompanyFundamentals({ db, externalRequestsEnabled: true, secCompanyFactsEnabled: true, userAgent: "", fetcher });

    const saved = service.read(apple.id);
    expect(saved.state).toBe("blocked");
    expect(saved.facts).toEqual([]);
    expect(saved.points).toEqual([]);
    expect(saved.refreshAllowed).toBe(false);
    expect(saved.refreshBlockedReason).toContain("identity is not configured");

    const result = await service.refresh(apple.id, randomUUID());
    expect(result.refresh).toBe("blocked");
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.latestFundamentalAttempt(apple.id)).toBeNull();
  });

  it("requires the separate CompanyFacts scope before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const db = memoryDesk();
    const service = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: false,
      userAgent: "Sentiment Desk test contact security@example.org", fetcher,
    });

    const result = await service.refresh(apple.id, randomUUID());
    expect(result.refresh).toBe("blocked");
    expect(result.refreshBlockedReason).toContain("separate sec_company_facts request scope");
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.latestFundamentalAttempt(apple.id)).toBeNull();
  });

  it("serializes selected-company SEC refreshes across issuers", async () => {
    const other = { ...apple, id: "other-company", ticker: "OTHER", name: "Other Company" };
    const db = memoryDesk(apple);
    db.seedCompanies([other]);
    let releaseFirstRequest!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { releaseFirstRequest = resolve; });
    const fetcher = vi.fn<typeof fetch>(() => firstResponse);
    const service = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk isolated fixture contact security@example.org", fetcher,
    });

    const first = service.refresh(apple.id, randomUUID());
    const second = await service.refresh(other.id, randomUUID());
    expect(second.refresh).toBe("blocked");
    expect(second.refreshBlockedReason).toContain("Another company's SEC refresh is running");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.latestFundamentalAttempt(other.id)).toBeNull();

    releaseFirstRequest(new Response("unavailable", { status: 503 }));
    await first;
  });

  it("recovers a request claim as interrupted after process restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-fundamentals-"));
    tempDirs.push(directory);
    const path = join(directory, "desk.sqlite");
    let db = new Desk(path);
    db.seedCompanies([apple]);
    const key = randomUUID();
    const claim = db.claimFundamentalAttempt({ companyId: apple.id, requestKey: key });
    expect(claim.kind).toBe("claimed");
    db.close();

    db = new Desk(path);
    openDesks.push(db);
    expect(db.fundamentalAttemptByKey(apple.id, key)).toMatchObject({ status: "interrupted", snapshotId: null });
    expect(db.latestCompanyFundamentals(apple.id)).toBeNull();
  });

  it("keeps response bytes in an immutable content-addressed store separate from request receipts", () => {
    const db = memoryDesk();
    const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const blobs = new Set((raw.prepare("PRAGMA table_info(sec_fundamental_payload_blobs)").all() as Array<{ name: string }>).map((row) => row.name));
    const receipts = new Set((raw.prepare("PRAGMA table_info(sec_fundamental_payloads)").all() as Array<{ name: string }>).map((row) => row.name));
    expect(blobs).toEqual(new Set(["sha256", "body_bytes", "body"]));
    expect(receipts).toEqual(new Set(["delivery_id", "endpoint", "url", "retrieved_at", "body_bytes", "sha256"]));
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sec_fundamental_payload_blobs").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sec_fundamental_payloads").get()).toEqual({ count: 0 });
  });

  it("persists a partial zero-fact SEC response and shares identical non-financial payload bytes", () => {
    const db = memoryDesk();
    const requestKey = randomUUID();
    const claim = db.claimFundamentalAttempt({ companyId: apple.id, requestKey });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("Expected isolated SEC attempt claim.");
    const body = "{}";
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    const startedAt = claim.attempt.startedAt;
    const retrievedAt = startedAt + 1;
    const endpoints = [
      ["ticker_directory", "https://www.sec.gov/files/company_tickers.json"],
      ["submissions", "https://data.sec.gov/submissions/CIK0000320193.json"],
      ["companyfacts", "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json"],
    ] as const;

    db.saveCompanyFundamentals({
      attemptId: claim.attempt.id,
      companyId: apple.id,
      cik: "0000320193",
      completedAt: retrievedAt,
      state: "partial",
      coverage: ["No supported fact has a matching filing acceptance record."],
      facts: [],
      payloads: endpoints.map(([endpoint, url]) => ({ endpoint, url, startedAt, retrievedAt, body,
        bodyBytes: Buffer.byteLength(body), sha256: digest, itemCount: 0 })),
    });

    expect(db.latestCompanyFundamentals(apple.id)).toMatchObject({
      state: "partial",
      facts: [],
      coverage: ["No supported fact has a matching filing acceptance record."],
    });
    expect(db.latestFundamentalAttempt(apple.id)).toMatchObject({ status: "partial" });
    const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sec_fundamental_payloads").get()).toEqual({ count: 3 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sec_fundamental_payload_blobs").get()).toEqual({ count: 1 });
  });

  it("rejects unsupported numeric tokens instead of coercing them into saved facts", () => {
    expect(normalizeExactDecimal("NaN")).toBeNull();
    expect(normalizeExactDecimal("Infinity")).toBeNull();
    expect(normalizeExactDecimal(1)).toBeNull();
  });

  it("retains SEC decimals through acquisition, persistence, and comparison", async () => {
    const issuer = { ...apple, id: "isolated-sec-test-issuer", name: "Isolated test issuer", ticker: "TEST" };
    const db = memoryDesk(issuer);
    let clock = Date.UTC(2026, 9, 4);
    const fetcher = secResponseFetcher(true);
    const service = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk isolated fixture contact security@example.org",
      fetcher, now: () => ++clock,
    });

    const result = await service.refresh(issuer.id, randomUUID());
    const currentFact = result.facts.find((fact) => fact.endDate === "2024-12-31");
    expect(fetcher).toHaveBeenCalledTimes(3);
    const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(raw.prepare("SELECT DISTINCT collector FROM source_deliveries").all()).toEqual([{ collector: "sec_company_facts" }]);
    expect(result.state).toBe("stale");
    expect(result.staleReason).toContain("accepted more than 365 days ago");
    expect(currentFact).toMatchObject({ value: "101000000", reportedDecimals: "-6", reportedPrecisionStatus: "declared" });
    expect(result.points.map((point) => [point.value, point.reportedDecimals, point.reportedPrecisionStatus])).toEqual([
      ["100000000", "-6", "declared"], ["101000000", "-6", "declared"],
    ]);
    expect(result.comparisons.find((comparison) => comparison.currentFactId === currentFact?.id)).toMatchObject({
      state: "comparable", delta: "1000000", percentChange: null, changeInterpretation: "within_reported_precision",
    });
    expect(result.coverage).toHaveLength(3);
    expect(result.coverage.every((item) => !item.startsWith("revenue:"))).toBe(true);
  });

  it("keeps each completed SEC response receipt when a later endpoint fails and preserves the prior snapshot", async () => {
    const issuer = { ...apple, id: "isolated-sec-test-issuer", name: "Isolated test issuer", ticker: "TEST" };
    const db = memoryDesk(issuer);
    let clock = Date.UTC(2025, 2, 1);
    const good = secResponseFetcher(true);
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      calls += 1;
      if (calls === 5) return new Response("temporarily unavailable", { status: 503 });
      return good(input, init);
    });
    const service = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk isolated fixture contact security@example.org",
      fetcher, now: () => ++clock,
    });

    const first = await service.refresh(issuer.id, randomUUID());
    // This isolated issuer exposes revenue only. Keep the coverage gap visible
    // instead of calling a partial fundamental snapshot complete.
    expect(first.state).toBe("partial");
    const previousSnapshotId = db.latestCompanyFundamentals(issuer.id)?.snapshotId;
    const previousFactIds = db.latestCompanyFundamentals(issuer.id)?.facts.map((fact) => fact.id);
    expect(previousSnapshotId).toBeTruthy();

    const failed = await service.refresh(issuer.id, randomUUID());
    expect(failed.refresh).toBe("completed");
    expect(failed.state).toBe("partial");
    expect(db.latestFundamentalAttempt(issuer.id)).toMatchObject({ status: "failed" });
    expect(db.latestCompanyFundamentals(issuer.id)?.snapshotId).toBe(previousSnapshotId);
    expect(db.latestCompanyFundamentals(issuer.id)?.facts.map((fact) => fact.id)).toEqual(previousFactIds);
    const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(raw.prepare("SELECT COUNT(*) AS count FROM source_deliveries WHERE collector='sec_company_facts'").get()).toEqual({ count: 4 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sec_fundamental_payloads").get()).toEqual({ count: 4 });
  });

  it("withholds percentage changes even when a finite-precision difference exceeds its bound", async () => {
    const issuer = { ...apple, id: "isolated-sec-test-issuer", name: "Isolated test issuer", ticker: "TEST" };
    const db = memoryDesk(issuer);
    let clock = Date.UTC(2026, 9, 4);
    const service = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk isolated fixture contact security@example.org",
      fetcher: secResponseFetcher(true, 104_000_000), now: () => ++clock,
    });

    const result = await service.refresh(issuer.id, randomUUID());
    const currentFact = result.facts.find((fact) => fact.endDate === "2024-12-31");
    const comparison = result.comparisons.find((item) => item.currentFactId === currentFact?.id);
    expect(comparison).toMatchObject({
      state: "comparable", delta: "4000000", percentChange: null, changeInterpretation: "change_exceeds_precision",
    });
    expect(comparison?.reason).toContain("Percentage change is withheld because one or both SEC amounts have finite reported precision.");
  });

  it("labels absent SEC decimals as unknown and withholds unqualified percentage changes", async () => {
    const issuer = { ...apple, id: "isolated-sec-test-issuer", name: "Isolated test issuer", ticker: "TEST" };
    const db = memoryDesk(issuer);
    let clock = Date.UTC(2026, 9, 4);
    const fetcher = secResponseFetcher(false);
    const service = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk isolated fixture contact security@example.org",
      fetcher, now: () => ++clock,
    });

    const result = await service.refresh(issuer.id, randomUUID());
    const currentFact = result.facts.find((fact) => fact.endDate === "2024-12-31");
    expect(currentFact).toMatchObject({ reportedDecimals: null, reportedPrecisionStatus: "missing" });
    expect(result.comparisons.find((comparison) => comparison.currentFactId === currentFact?.id)).toMatchObject({
      state: "comparable", delta: "1000000", percentChange: null, changeInterpretation: "reported_values_only",
    });
    expect(result.comparisons.find((comparison) => comparison.currentFactId === currentFact?.id)?.reason)
      .toContain("Percentage change is withheld because the SEC source precision metadata is unavailable.");
    expect(result.coverage.join(" ")).toContain("no SEC decimals precision field");
  });
});
