/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudResearchDesk } from "../web/src/components/CloudResearchDesk.js";

const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), invoke: vi.fn() }));
vi.mock("../web/src/lib/supabase.js", () => ({ cloudSupabase: { ...backend, functions: { invoke: backend.invoke } } }));
vi.mock("../web/src/components/CloudIssuerDirectory.js", () => ({ CloudIssuerDirectory: () => null }));

const issuers = [
  { id: "issuer-a", user_id: "user-1", cik: "0000000001", ticker: "AAA", issuer_name: "Alpha Company", exchange: "Nasdaq", selected_snapshot_id: "directory", created_at: "2026-10-10T00:00:00Z" },
  { id: "issuer-b", user_id: "user-1", cik: "0000000002", ticker: "BBB", issuer_name: "Beta Company", exchange: "NYSE", selected_snapshot_id: "directory", created_at: "2026-10-09T00:00:00Z" },
];
const now = new Date().toISOString();
const snapshots = new Map<string, { id: string; cik: string; retrieved_at: string; completed_at: string; fact_count?: number; filing_count?: number; source_response_sha256: string }>(issuers.flatMap((issuer) => [
  [`facts-${issuer.cik}`, { id: `facts-${issuer.cik}`, cik: issuer.cik, retrieved_at: now, completed_at: now, fact_count: 0, source_response_sha256: "a".repeat(64) }],
  [`filings-${issuer.cik}`, { id: `filings-${issuer.cik}`, cik: issuer.cik, retrieved_at: now, completed_at: now, filing_count: 0, source_response_sha256: "b".repeat(64) }],
]));

function queryFor(table: string) {
  const filters: Record<string, unknown> = {};
  const query: any = {
    select: () => query,
    order: () => query,
    limit: () => Promise.resolve(read()),
    range: () => Promise.resolve(read()),
    eq: (column: string, value: unknown) => { filters[column] = value; return query; },
    in: () => query,
    maybeSingle: () => Promise.resolve(read(true)),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(read()).then(resolve, reject),
  };
  function read(single = false) {
    let rows: unknown;
    if (table === "user_research_issuers") rows = issuers;
    else if (table === "user_company_follows" || table === "user_followed_evidence_baselines" || table === "user_company_research_decisions"
      || table === "sec_company_fact_values" || table === "sec_filing_observations") rows = [];
    else if (table === "sec_companyfacts_head") rows = { snapshot_id: `facts-${filters.cik}` };
    else if (table === "sec_submissions_head") rows = { snapshot_id: `filings-${filters.cik}` };
    else if (table === "sec_companyfacts_snapshots" || table === "sec_submissions_snapshots") rows = snapshots.get(String(filters.id)) ?? null;
    else rows = [];
    return { data: single ? rows : rows, error: null };
  }
  return query;
}

function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  if (!(element instanceof HTMLSelectElement)) element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("cloud company-specific analyst drafts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    backend.from.mockImplementation((table: string) => queryFor(table));
    backend.rpc.mockReset();
    backend.invoke.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("restores each issuer's rationale, decision, and next-check date after switching companies", async () => {
    await act(async () => {
      root.render(<CloudResearchDesk userId="user-1" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Company research"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const selects = container.querySelectorAll<HTMLSelectElement>("select");
    const issuerSelect = selects[0]!;
    const decisionSelect = selects[2]!;
    const dateInput = container.querySelector<HTMLInputElement>('input[type="date"]')!;
    const rationale = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      setValue(decisionSelect, "set_aside");
      setValue(dateInput, "2027-01-10");
      setValue(rationale, "Alpha only: verify annual margin trend.");
    });

    await act(async () => {
      setValue(issuerSelect, issuers[1]!.cik);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rationale.value).toBe("");
    expect(dateInput.value).toBe("");
    expect(decisionSelect.value).toBe("investigate_further");

    await act(async () => {
      setValue(decisionSelect, "insufficient_evidence");
      setValue(dateInput, "2027-02-10");
      setValue(rationale, "Beta only: wait for a complete annual filing.");
      setValue(issuerSelect, issuers[0]!.cik);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rationale.value).toBe("Alpha only: verify annual margin trend.");
    expect(dateInput.value).toBe("2027-01-10");
    expect(decisionSelect.value).toBe("set_aside");
    expect(container.textContent).toContain("Alpha Company");
  });
});

afterEach(() => { document.body.innerHTML = ""; });
