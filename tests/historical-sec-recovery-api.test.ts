import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, type AppDeps } from "../server/app.js";
import { loadCompanies } from "../server/config.js";
import { CompanyFundamentals } from "../server/company-fundamentals.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { TestDesk } from "./test-desk.js";

const company = loadCompanies().find(({ ticker }) => ticker === "AAPL")!;
const tempPaths: string[] = [];
const openDesks: TestDesk[] = [];
const fundamentalsResponseSchema = z.object({
  state: z.enum(["idle", "ready", "partial", "empty", "stale", "blocked", "failed"]),
  snapshotId: z.string().nullable(),
  facts: z.array(z.object({ metric: z.string(), acceptedAt: z.number().nullable() })),
  retrievedAt: z.number().nullable(),
  latestAttemptAt: z.number().nullable(),
  staleReason: z.string().nullable(),
  lastRefreshError: z.string().nullable(),
});

afterEach(() => {
  while (openDesks.length) openDesks.pop()!.close();
  while (tempPaths.length) rmSync(tempPaths.pop()!, { recursive: true, force: true });
});

function revenueOnlySecFetcher(): typeof fetch {
  // Deterministic historical test evidence only; this fixture is never sent to SEC.
  const accession = "0000320193-25-000001";
  const bodies = new Map<string, unknown>([
    ["https://www.sec.gov/files/company_tickers.json", {
      "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    }],
    ["https://data.sec.gov/submissions/CIK0000320193.json", {
      cik: 320193,
      filings: { recent: {
        form: ["10-K"], filingDate: ["2025-02-05"], reportDate: ["2024-12-31"],
        acceptanceDateTime: ["2025-02-05T17:00:00.000Z"], accessionNumber: [accession], primaryDocument: ["annual-report.htm"],
      } },
    }],
    ["https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", {
      cik: 320193,
      entityName: "Apple Inc.",
      facts: { "us-gaap": { RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
        { start: "2023-01-01", end: "2023-12-31", val: 100_000_000, accn: accession, fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-05", decimals: -6 },
        { start: "2024-01-01", end: "2024-12-31", val: 101_000_000, accn: accession, fy: 2024, fp: "FY", form: "10-K", filed: "2025-02-05", decimals: -6 },
      ] } } } },
    }],
  ]);
  return async (input) => {
    const body = bodies.get(String(input));
    return body
      ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("unmapped deterministic fixture request", { status: 502 });
  };
}

describe("SEC historical snapshot recovery through the HTTP API", () => {
  it("keeps a partial last-good snapshot after a failed refresh and preserves source observation freshness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-historical-sec-api-"));
    tempPaths.push(directory);
    const dbPath = join(directory, "desk.sqlite");
    let db = new TestDesk(dbPath);
    openDesks.push(db);
    db.seedCompanies([company]);

    const successfulFixtureFetch = revenueOnlySecFetcher();
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 5) return new Response("deterministic refresh failure", { status: 503 });
      return successfulFixtureFetch(input, init);
    };
    let clock = Date.UTC(2026, 9, 7, 12);
    const fundamentals = new CompanyFundamentals({
      db,
      externalRequestsEnabled: true,
      secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk deterministic test fixture contact security@example.org",
      fetcher,
      now: () => ++clock,
    });
    const app = createApp({
      db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
      health: new HealthTracker(false, false, "deterministic-test"), version: "deterministic-test",
      deliverySources: [], companyFundamentals: fundamentals,
    });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    let acceptedSnapshotId: string | null = null;
    let acceptedRetrievedAt: number | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (address == null || typeof address === "string") throw new Error("isolated API server did not bind a TCP port");
      const origin = `http://127.0.0.1:${address.port}`;
      const route = `/api/companies/${encodeURIComponent(company.id)}/fundamentals`;
      const refresh = async () => fetch(`${origin}${route}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ requestKey: randomUUID() }),
      });

      const firstRefresh = await refresh();
      expect(firstRefresh.status).toBe(200);
      const first = fundamentalsResponseSchema.parse(await firstRefresh.json());
      expect(first.state).toBe("stale");
      expect(first.snapshotId).toBeTruthy();
      acceptedSnapshotId = first.snapshotId;
      acceptedRetrievedAt = first.retrievedAt;
      expect(first.facts).toHaveLength(2);
      expect(first.facts.every(({ metric }) => metric === "revenue")).toBe(true);
      expect(first.staleReason).toContain("accepted more than 365 days ago");
      expect(first.lastRefreshError).toBeNull();
      expect(first.retrievedAt).toBeGreaterThan(Date.UTC(2026, 9, 7, 11));

      const afterSuccess = await fetch(`${origin}${route}`);
      expect(afterSuccess.status).toBe(200);
      const saved = fundamentalsResponseSchema.parse(await afterSuccess.json());
      expect(saved).toMatchObject({ snapshotId: first.snapshotId, retrievedAt: first.retrievedAt, state: "stale" });
      expect(saved.staleReason).toContain("accepted more than 365 days ago");

      const failedRefresh = await refresh();
      expect(failedRefresh.status).toBe(200);
      const afterFailure = fundamentalsResponseSchema.parse(await failedRefresh.json());
      expect(afterFailure).toMatchObject({ snapshotId: first.snapshotId, retrievedAt: first.retrievedAt, state: "stale" });
      expect(afterFailure.facts).toEqual(first.facts);
      expect(afterFailure.lastRefreshError).toContain("HTTP 503");
      expect(afterFailure.latestAttemptAt).toBeGreaterThan(afterFailure.retrievedAt ?? 0);
      expect(afterFailure.staleReason).toContain("accepted more than 365 days ago");
      expect(calls).toBe(5);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    db.close();
    openDesks.splice(openDesks.indexOf(db), 1);
    db = new TestDesk(dbPath);
    openDesks.push(db);
    const persisted = db.latestCompanyFundamentals(company.id);
    const attempt = db.latestFundamentalAttempt(company.id);
    expect(persisted).toMatchObject({ snapshotId: acceptedSnapshotId, state: "partial", createdAt: acceptedRetrievedAt });
    expect(persisted?.facts).toHaveLength(2);
    expect(attempt).toMatchObject({ status: "failed", error: expect.stringContaining("HTTP 503") });
  });
});
