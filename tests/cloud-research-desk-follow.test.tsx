/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudResearchDesk } from "../web/src/components/CloudResearchDesk.js";

const backend = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../web/src/lib/supabase.js", () => ({
  cloudSupabase: backend,
  cloudFunctionErrorCode: vi.fn(async () => null),
}));

vi.mock("../web/src/components/CloudIssuerDirectory.js", () => ({
  CloudIssuerDirectory: () => null,
}));

const issuer = {
  id: "issuer-workspace", user_id: "user-1", cik: "0000000002", ticker: "TSTX",
  issuer_name: "Test Issuer Limited", exchange: "Test Exchange", selected_snapshot_id: "directory-snapshot",
  created_at: "2026-10-09T00:00:00Z",
};
const follow = {
  id: "follow-1", cik: issuer.cik, issuer_research_id: issuer.id,
  created_at: "2026-10-09T00:00:00Z", unfollowed_at: null,
};
const filingSnapshot = {
  id: "filing-snapshot", cik: issuer.cik, retrieved_at: new Date().toISOString(),
  completed_at: new Date().toISOString(), filing_count: 1, source_response_sha256: "a".repeat(64),
};
const baseline = {
  id: "baseline-1", follow_id: follow.id, cik: issuer.cik, snapshot_id: filingSnapshot.id,
  capture_key: "capture-1", version: 1, captured_at: new Date().toISOString(), filing_count: 1,
  evidence_digest: "b".repeat(64),
};

let followSaved = false;
let baselineSaved = false;
let baselineCaptureAttempts = 0;

function tableResult(table: string, maybeSingle = false) {
  const rows: Record<string, unknown> = {
    user_research_issuers: [issuer],
    sec_companyfacts_head: null,
    sec_submissions_head: { snapshot_id: filingSnapshot.id },
    sec_companyfacts_snapshots: null,
    sec_submissions_snapshots: filingSnapshot,
    sec_company_fact_values: [],
    sec_filing_observations: [],
    user_company_research_decisions: [],
    user_company_follows: followSaved ? [follow] : [],
    user_followed_evidence_baselines: baselineSaved ? [baseline] : [],
  };
  const value = rows[table] ?? [];
  return { data: maybeSingle ? value : value, error: null };
}

function queryFor(table: string) {
  const query: any = {
    select: () => query,
    order: () => query,
    limit: () => Promise.resolve(tableResult(table)),
    range: () => Promise.resolve(tableResult(table)),
    eq: () => query,
    in: () => query,
    insert: () => {
      if (table === "user_company_follows") followSaved = true;
      return query;
    },
    maybeSingle: () => Promise.resolve({ data: table === "user_company_follows" ? follow : tableResult(table, true).data, error: null }),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(tableResult(table)).then(resolve, reject),
  };
  return query;
}

describe("cloud research follow and baseline recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    followSaved = false;
    baselineSaved = false;
    baselineCaptureAttempts = 0;
    backend.from.mockImplementation((table: string) => queryFor(table));
    backend.rpc.mockImplementation(async (name: string) => {
      if (name === "capture_user_followed_evidence_baseline") {
        baselineCaptureAttempts += 1;
        if (baselineCaptureAttempts === 1) return { data: null, error: { code: "XX001", message: "fixture capture failure" } };
        baselineSaved = true;
        return { data: baseline.id, error: null };
      }
      if (name === "read_user_followed_filing_changes") return { data: [{
        snapshot_id: filingSnapshot.id, snapshot_retrieved_at: filingSnapshot.retrieved_at,
        snapshot_completed_at: filingSnapshot.completed_at, snapshot_filing_count: filingSnapshot.filing_count,
        snapshot_source_response_sha256: filingSnapshot.source_response_sha256,
        baseline_id: baselineSaved ? baseline.id : null,
        baseline_snapshot_id: baselineSaved ? baseline.snapshot_id : null,
        baseline_capture_key: baselineSaved ? baseline.capture_key : null,
        baseline_version: baselineSaved ? baseline.version : null,
        baseline_captured_at: baselineSaved ? baseline.captured_at : null,
        baseline_filing_count: baselineSaved ? baseline.filing_count : null,
        baseline_evidence_digest: baselineSaved ? baseline.evidence_digest : null,
        new_filing_count: 0, omitted_filing_count: 0, new_filings: [],
      }], error: null };
      throw new Error(`Unexpected RPC in focused UI test: ${name}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it("explains a failed initial baseline and exposes the existing capture action as retry", async () => {
    await act(async () => {
      root.render(<CloudResearchDesk userId="user-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Company research"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Follow this company"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[role='alert']")?.textContent).toContain("Company followed, but its initial filing baseline could not be saved");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("choose ‘Use current filings as baseline’ to retry");
    expect(container.textContent).not.toContain("No filing snapshot was available");

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Followed evidence"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Set current filings as baseline"));
    expect(retry).toBeDefined();
    expect(retry?.disabled).toBe(false);

    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(baselineCaptureAttempts).toBe(2);
    expect(container.textContent).toContain("Baseline v1 captured");
    expect(container.querySelector("[role='status']")?.textContent).toContain("A new comparison point was saved");
  });
});
