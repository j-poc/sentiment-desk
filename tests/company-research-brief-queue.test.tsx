/** @vitest-environment jsdom */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { loadCompanies } from "../server/config.js";
import type { CompanyResearchDecisionQueueItem } from "../shared/company-research-brief.js";
import { TestDesk as Desk } from "./test-desk.js";
import { CompanyResearchDecisionQueueView } from "../web/src/components/AnalystResearchQueueView.js";

const directories: string[] = [];
const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-decision-queue-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.sqlite");
  const companies = loadCompanies();
  const db = new Desk(dbPath);
  db.seedCompanies(companies);
  const apple = companies.find((company) => company.ticker === "AAPL")!;
  const adobe = companies.find((company) => company.ticker === "ADBE")!;
  const configuredPublicCompanyIds = new Set([apple.id, adobe.id]);
  const app = createApp({
    db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [],
    configuredPublicCompanyIds,
  });
  return { db, app, companies, apple, adobe };
}

function saveDecision(db: Desk, input: {
  companyId: string; asOfMs: number; rationale: string; nextCheckDate: string | null; factIds?: string[]; observationIds?: string[];
}) {
  const factIds = input.factIds ?? [];
  const observationIds = input.observationIds ?? [];
  return db.saveCompanyResearchDecision({
    requestKey: randomUUID(), companyId: input.companyId, asOfMs: input.asOfMs, snapshotId: `snapshot-${input.asOfMs}`,
    snapshotKey: String(input.asOfMs).padStart(64, "0"), factIds, observationIds,
    evidenceRoles: observationIds.map((observationId) => ({ observationId, role: "not_reviewed" as const })),
    decision: "investigate_further", rationale: input.rationale, nextCheckDate: input.nextCheckDate,
  });
}

describe("saved Company Research Decisions in My Research", () => {
  it("returns only the latest immutable decisions for configured public issuers in saved-time order", async () => {
    const { db, app, companies, apple, adobe } = setup();
    try {
      let savedAt = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => savedAt++);
      saveDecision(db, { companyId: apple.id, asOfMs: 1_700_000_000_000, rationale: "Older Apple decision", nextCheckDate: null });
      saveDecision(db, { companyId: apple.id, asOfMs: 1_710_000_000_000, rationale: "Latest Apple decision", nextCheckDate: "2099-01-01", factIds: ["f1", "f2"], observationIds: ["o1"] });
      saveDecision(db, { companyId: adobe.id, asOfMs: 1_720_000_000_000, rationale: "Adobe decision", nextCheckDate: "2000-01-01", factIds: ["f3"], observationIds: ["o2", "o3"] });
      const outsideConfiguredScope = companies.find((company) => company.id !== apple.id && company.id !== adobe.id)!;
      saveDecision(db, { companyId: outsideConfiguredScope.id, asOfMs: 1_730_000_000_000, rationale: "Not in configured scope", nextCheckDate: null });

      const response = await app.request("/api/research-queue/company-decisions");
      expect(response.status).toBe(200);
      const body = await response.json() as { items: unknown[] };
      expect(body).toMatchObject({ items: [
        { company: { companyId: adobe.id, name: adobe.name, ticker: "ADBE" }, decision: { rationale: "Adobe decision", asOfMs: 1_720_000_000_000 }, factCount: 1, observationCount: 2 },
        { company: { companyId: apple.id, name: apple.name, ticker: "AAPL" }, decision: { rationale: "Latest Apple decision", asOfMs: 1_710_000_000_000, nextCheckDate: "2099-01-01" }, factCount: 2, observationCount: 1 },
      ] });
      expect(JSON.stringify(body)).not.toContain("Older Apple decision");
      expect(JSON.stringify(body)).not.toContain("Not in configured scope");
    } finally { db.close(); }
  });

  it("renders independent loading, empty, failure/retry and explicit Desk-navigation behavior", () => {
    const item: CompanyResearchDecisionQueueItem = {
      company: { companyId: "apple", name: "Apple Inc.", ticker: "AAPL", cik: "0000320193" },
      decision: {
        id: "decision-1", requestKey: "request-1", companyId: "apple", asOfMs: 1_700_000_000_123,
        snapshotId: "snapshot-1", snapshotKey: "a".repeat(64), factIds: ["fact-1", "fact-2"],
        observationIds: ["obs-1"], evidenceRoles: [{ observationId: "obs-1", role: "not_reviewed" }],
        decision: "insufficient_evidence", rationale: "The saved sources do not independently support the claim.",
        nextCheckDate: "2000-01-01", createdAt: 1_700_000_100_456,
      },
      factCount: 2,
      observationCount: 1,
    };
    const retry = vi.fn();
    const open = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const render = (props: Parameters<typeof CompanyResearchDecisionQueueView>[0]) => act(() => root.render(<CompanyResearchDecisionQueueView {...props} />));

    render({ items: [], state: "loading", error: null, onRetry: retry, onOpen: open });
    expect(host.textContent).toContain("Loading saved company decisions");
    render({ items: [], state: "ready", error: null, onRetry: retry, onOpen: open });
    expect(host.textContent).toContain("No saved company research decisions");
    render({ items: [], state: "failed", error: "Saved decision read failed.", onRetry: retry, onOpen: open });
    expect(host.textContent).toContain("Source-record and SEC filing queues remain available");
    act(() => host.querySelector("button")?.click());
    expect(retry).toHaveBeenCalledOnce();

    render({ items: [item], state: "ready", error: null, onRetry: retry, onOpen: open });
    expect(host.textContent).toContain("The saved sources do not independently support the claim.");
    expect(host.textContent).toContain("2000-01-01 · overdue");
    expect(host.textContent).toContain(new Date(item.decision.asOfMs).toISOString());
    expect(host.textContent).toContain("2 SEC facts");
    expect(host.textContent).toContain("1 public-source record");
    expect(host.textContent).toContain("separate from saved source-record reviews and SEC filing tasks");
    const action = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Open AAPL research brief"));
    expect(action).not.toBeNull();
    act(() => action!.click());
    expect(open).toHaveBeenCalledWith(item);
    const upcoming = {
      ...item,
      decision: { ...item.decision, id: "decision-2", nextCheckDate: "2099-01-01" },
    };
    render({ items: [item, upcoming], state: "ready", error: null, onRetry: retry, onOpen: open });
    expect(host.textContent).toContain("2099-01-01 · upcoming");
    host.remove();
  });
});
