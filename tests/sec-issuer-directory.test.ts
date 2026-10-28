import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { CompanyFundamentals } from "../server/company-fundamentals.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { SEC_ISSUER_DIRECTORY_URL } from "../shared/sec-issuer-directory.js";
import { TestDesk as Desk } from "./test-desk.js";

const openDesks: Desk[] = [];
const directories: string[] = [];
const sourceBody = JSON.stringify({
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    ["1", "Acme Industrial Holdings Inc.", "ACME", "NYSE"],
    ["2", "Another Acme Corporation", "ACM", "Nasdaq"],
  ],
});
const sourceSha256 = createHash("sha256").update(sourceBody, "utf8").digest("hex");

afterEach(() => {
  while (openDesks.length) openDesks.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function setup(fetcher: typeof fetch, options: { enabled?: boolean; approved?: boolean; userAgent?: string; path?: string; snapshot?: () => unknown } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-sec-issuer-directory-"));
  directories.push(directory);
  const dbPath = options.path ?? join(directory, "desk.sqlite");
  const db = new Desk(dbPath);
  openDesks.push(db);
  const companyFundamentals = new CompanyFundamentals({
    db,
    externalRequestsEnabled: options.enabled ?? false,
    secCompanyFactsEnabled: options.approved ?? false,
    userAgent: options.userAgent ?? "",
    fetcher,
  });
  const app = createApp({ db, dbPath, pipeline: { snapshot: options.snapshot ?? (() => ({})) } as unknown as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [], companyFundamentals });
  return { app, db, companyFundamentals, directory };
}

function directoryFetcher() {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input) === SEC_ISSUER_DIRECTORY_URL) {
      return new Response(sourceBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(input) === "https://www.sec.gov/files/company_tickers.json") {
      return new Response(JSON.stringify({ "0": { cik_str: 2, ticker: "ACME", title: "Wrong CIK" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("SEC issuer directory research workflow", () => {
  it("requires an explicit confirmed SEC directory check and the separate source scope", async () => {
    const fetcher = directoryFetcher();
    const { app } = setup(fetcher, { enabled: true, approved: false, userAgent: "Sentiment Desk test security@example.org" });
    const before = await app.request("/api/sec-issuer-directory?q=Acme");
    expect(await before.json()).toMatchObject({ state: "not_loaded", rows: [], canRefresh: false });

    const invalid = await app.request("/api/sec-issuer-directory/refresh", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ confirmUse: false }),
    });
    expect(invalid.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();

    const blocked = await app.request("/api/sec-issuer-directory/refresh", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ confirmUse: true }),
    });
    expect(await blocked.json()).toMatchObject({ state: "unavailable", canRefresh: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("searches the bounded saved SEC mapping, records the body digest, and restores the saved issuer after restart", async () => {
    const fetcher = directoryFetcher();
    const first = setup(fetcher, { enabled: true, approved: true, userAgent: "Sentiment Desk test security@example.org" });
    const refreshed = await first.app.request("/api/sec-issuer-directory/refresh", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ confirmUse: true }),
    });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ receipt: { source: SEC_ISSUER_DIRECTORY_URL, sha256: sourceSha256, rowCount: 2 } });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const search = await first.app.request("/api/sec-issuer-directory?q=Industrial");
    const result = await search.json() as { rows: Array<{ cik: string; name: string; ticker: string; exchange: string | null }>; freshness: string };
    expect(result.freshness).toBe("current");
    expect(result.rows).toEqual([{ cik: "0000000001", name: "Acme Industrial Holdings Inc.", ticker: "ACME", exchange: "NYSE" }]);

    const selected = result.rows[0]!;
    const saved = await first.app.request("/api/sec-issuer-research-subjects", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ cik: selected.cik, ticker: selected.ticker, name: selected.name, exchange: selected.exchange }),
    });
    const savedBody = await saved.json();
    expect(saved.status, JSON.stringify(savedBody)).toBe(201);
    expect(savedBody).toMatchObject({ item: { kind: "sec_issuer_research", companyId: "sec-0000000001", cik: selected.cik,
      identityReceipt: { source: SEC_ISSUER_DIRECTORY_URL, sha256: sourceSha256 } }, created: true });

    const briefResponse = await first.app.request("/api/companies/sec-0000000001/research-brief");
    expect(briefResponse.status).toBe(200);
    const brief = await briefResponse.json() as { brief: { asOfMs: number }; snapshotKey: string };
    const decisionResponse = await first.app.request("/api/companies/sec-0000000001/research-brief/decisions", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ requestKey: randomUUID(), asOfMs: brief.brief.asOfMs, snapshotKey: brief.snapshotKey,
        decision: "insufficient_evidence", rationale: "No facts have been retrieved for this issuer yet.", evidenceRoles: [], nextCheckDate: null }),
    });
    expect(decisionResponse.status).toBe(200);
    expect(await decisionResponse.json()).toMatchObject({ decision: { decision: "insufficient_evidence", companyId: "sec-0000000001" } });

    const wrongTicker = await first.app.request("/api/sec-issuer-research-subjects", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ cik: selected.cik, ticker: "FAKE", name: selected.name, exchange: selected.exchange }),
    });
    expect(wrongTicker.status).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);

    first.db.close();
    openDesks.splice(openDesks.indexOf(first.db), 1);
    const restarted = new Desk(join(first.directory, "desk.sqlite"));
    openDesks.push(restarted);
    const restored = restarted.secIssuerResearchSubjects();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ companyId: "sec-0000000001", cik: selected.cik, ticker: "ACME" });
    expect(restarted.readSecIssuerDirectorySnapshot()).toMatchObject({ sha256: sourceSha256, sourceBody });
  });

  it("does not save CompanyFacts when the current SEC ticker directory maps to another CIK", async () => {
    const fetcher = directoryFetcher();
    const { app, db, companyFundamentals } = setup(fetcher, { enabled: true, approved: true, userAgent: "Sentiment Desk test security@example.org" });
    await app.request("/api/sec-issuer-directory/refresh", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ confirmUse: true }),
    });
    await app.request("/api/sec-issuer-research-subjects", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ cik: "0000000001", ticker: "ACME", name: "Acme Industrial Holdings Inc.", exchange: "NYSE" }),
    });

    const result = await companyFundamentals.refresh("sec-0000000001", randomUUID());
    expect(result.facts).toEqual([]);
    expect(result.lastRefreshError).toContain("no longer maps ACME to the saved research issuer CIK");
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      SEC_ISSUER_DIRECTORY_URL,
      "https://www.sec.gov/files/company_tickers.json",
    ]);
    expect(db.latestCompanyFundamentals("sec-0000000001")).toBeNull();
  });

  it("returns the saved issuer when its realtime snapshot cannot be broadcast", async () => {
    const fetcher = directoryFetcher();
    const snapshot = vi.fn(() => { throw new Error("transient snapshot failure"); });
    const { app, db } = setup(fetcher, { enabled: true, approved: true,
      userAgent: "Sentiment Desk test security@example.org", snapshot });
    await app.request("/api/sec-issuer-directory/refresh", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ confirmUse: true }),
    });

    const saved = await app.request("/api/sec-issuer-research-subjects", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ cik: "0000000001", ticker: "ACME", name: "Acme Industrial Holdings Inc.", exchange: "NYSE" }),
    });

    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ item: { kind: "sec_issuer_research", companyId: "sec-0000000001" }, created: true });
    expect(db.secIssuerResearchSubjects()).toHaveLength(1);
    expect(snapshot).toHaveBeenCalledOnce();
  });
});
