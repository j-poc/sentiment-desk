/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyResearchBriefResponse, SavedCompanyResearchDecision } from "../shared/company-research-brief.js";
import type { PersistedFundamentalFact } from "../shared/company-fundamentals.js";
import { CompanyResearchBriefPanel } from "../web/src/components/CompanyResearchBriefPanel.js";

const api = vi.hoisted(() => ({
  getBrief: vi.fn(),
  saveDecision: vi.fn(),
}));

vi.mock("../web/src/lib/api.js", () => ({
  ApiRequestError: class ApiRequestError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } },
  getCompanyResearchBrief: api.getBrief,
  saveCompanyResearchDecision: api.saveDecision,
}));

const AS_OF = 1_791_441_000_000;

function brief(companyId: string, name: string, ticker: string, evidenceTitle: string): CompanyResearchBriefResponse {
  const observationId = `${companyId}-observation`;
  return {
    brief: {
      schemaVersion: 1,
      company: { companyId, name, ticker, cik: null },
      asOfMs: AS_OF,
      snapshotId: null,
      coverage: { sec: "empty", publicObservations: "partial", reasons: [] },
      facts: [],
      comparisons: [],
      observations: [{
        id: observationId, companyId, title: evidenceTitle, publisher: "Publisher", sourceUrl: "https://example.com/source",
        sourceTime: AS_OF, retrievedAt: AS_OF, deliveryId: `${companyId}-delivery`, ingestedAt: AS_OF,
        snippet: "Saved source excerpt.", status: "eligible", collector: "google_news_rss", timeBasis: "publisher_declared",
        deliveryCompletedAt: AS_OF, ingestionCompletedAt: AS_OF,
      }],
      nextResearchQuestion: null,
      missingEvidenceReason: null,
      interpretationLimits: [],
    },
    snapshotKey: companyId.padEnd(64, "0").slice(0, 64),
    decision: null,
    decisionStorageAvailable: true,
    decisionStorageUnavailableReason: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function secFact(id: string, startDate: string, endDate: string, value: string): PersistedFundamentalFact {
  return {
    id, companyId: "apple", cik: "0000320193", metric: "revenue", value, unit: "USD",
    reportedDecimals: "-6", reportedPrecisionStatus: "declared", taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
    startDate, endDate, filingFocusYear: 2025, filingFocusPeriod: "FY", form: "10-K",
    accession: `0000320193-25-${id}`, filedAt: AS_OF, acceptedAt: AS_OF + 1_000, retrievedAt: AS_OF + 2_000,
    sourceUrl: `https://www.sec.gov/Archives/edgar/data/320193/${id}/index.html`, responseSha256: "a".repeat(64),
    companyFactsDeliveryId: `${id}-facts`, submissionsDeliveryId: `${id}-submissions`, durationClass: "annual", amended: false,
  };
}

describe("selected-company research brief panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.getBrief.mockImplementation(async (companyId: string) => companyId === "apple"
      ? brief("apple", "Apple", "AAPL", "APPLE_ONLY_SOURCE_EVIDENCE")
      : brief("adobe", "Adobe", "ADBE", "ADOBE_ONLY_SOURCE_EVIDENCE"));
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not let a pending Apple save replace Adobe's brief after a company switch", async () => {
    const apple = brief("apple", "Apple", "AAPL", "APPLE_ONLY_SOURCE_EVIDENCE");
    const adobe = brief("adobe", "Adobe", "ADBE", "ADOBE_ONLY_SOURCE_EVIDENCE");
    const pendingWrite = deferred<CompanyResearchBriefResponse>();
    api.getBrief.mockImplementation(async (companyId: string) => companyId === "apple" ? apple : adobe);
    api.saveDecision.mockReturnValue(pendingWrite.promise);

    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("APPLE_ONLY_SOURCE_EVIDENCE");

    const form = container.querySelector<HTMLFormElement>("form.crb-decision");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(api.saveDecision).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="adobe" companyName="Adobe" ticker="ADBE" />);
      await Promise.resolve();
    });
    expect(container.querySelector("h2")?.textContent).toContain("Adobe ADBE");
    expect(container.textContent).toContain("ADOBE_ONLY_SOURCE_EVIDENCE");

    const savedApple = {
      ...apple,
      decision: {
        id: "apple-decision", requestKey: "request-key", companyId: "apple", asOfMs: AS_OF, snapshotId: null,
        snapshotKey: apple.snapshotKey, factIds: [], observationIds: ["apple-observation"],
        evidenceRoles: [{ observationId: "apple-observation", role: "not_reviewed" as const }],
        decision: "insufficient_evidence" as const, rationale: "", nextCheckDate: null, createdAt: AS_OF,
      } satisfies SavedCompanyResearchDecision,
    };
    await act(async () => {
      pendingWrite.resolve(savedApple);
      await pendingWrite.promise;
    });

    expect(container.querySelector("h2")?.textContent).toContain("Adobe ADBE");
    expect(container.textContent).toContain("ADOBE_ONLY_SOURCE_EVIDENCE");
    expect(container.textContent).not.toContain("APPLE_ONLY_SOURCE_EVIDENCE");
  });

  it("keeps the decision draft editable while storage is paused and disables only saving", async () => {
    const paused = brief("apple", "Apple", "AAPL", "APPLE_ONLY_SOURCE_EVIDENCE");
    paused.decisionStorageAvailable = false;
    paused.decisionStorageUnavailableReason = "Free at least 1 GiB on the data volume before collection resume.";
    api.getBrief.mockResolvedValue(paused);

    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" />);
      await Promise.resolve();
    });

    const fieldset = container.querySelector("fieldset");
    const rationale = container.querySelector<HTMLTextAreaElement>("textarea");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save decision"));
    expect(container.textContent).toContain("Free at least 1 GiB on the data volume");
    expect(fieldset?.disabled).toBe(false);
    expect(rationale?.disabled).toBe(false);
    expect(save?.disabled).toBe(true);
  });

  it("shows both exact question facts even when a newer same-metric row hides the current fact from latest-per-metric", async () => {
    const data = brief("apple", "Apple", "AAPL", "APPLE_SOURCE_EVIDENCE");
    const prior = { ...secFact("prior-fact", "2023-10-01", "2024-09-28", "391035000000"), reportedDecimals: null, reportedPrecisionStatus: "missing" as const };
    const current = { ...secFact("question-current-fact", "2024-09-29", "2025-09-27", "416161000000"), reportedDecimals: null, reportedPrecisionStatus: "missing" as const };
    const newer = secFact("newer-fact", "2025-09-28", "2026-09-26", "430000000000");
    data.brief.facts = [prior, current, newer];
    data.brief.comparisons = [{
      metric: "revenue", state: "comparable", periodAlignment: "same_filing_52_week",
      currentFactId: current.id, priorFactId: prior.id, delta: "25126000000", percentChange: null,
      changeInterpretation: "reported_values_only",
      reason: "SEC source precision metadata is unavailable; this is arithmetic between returned CompanyFacts values only. Percentage change is withheld because the SEC source precision metadata is unavailable.",
    }];
    data.brief.nextResearchQuestion = {
      metric: "revenue", currentFactId: current.id, priorFactId: prior.id,
      question: "What explains the reported revenue difference?",
    };
    api.getBrief.mockResolvedValue(data);

    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" />);
      await Promise.resolve();
    });

    const pair = container.querySelector<HTMLElement>("[aria-label='SEC facts behind next research question']");
    expect(pair).not.toBeNull();
    expect(pair?.textContent).toContain("391,035,000,000 USD");
    expect(pair?.textContent).toContain("416,161,000,000 USD");
    expect(pair?.textContent).toContain("2023-10-01–2024-09-28");
    expect(pair?.textContent).toContain("annual duration");
    expect(pair?.textContent).toContain("Accepted");
    expect(pair?.textContent).toContain("Retrieved");
    expect(pair?.textContent).toContain("Reported arithmetic difference: 25126000000 USD · percentage change is withheld because the SEC source precision metadata is unavailable.");
    expect(pair?.textContent).not.toContain("the prior value is not positive");
    expect(pair?.textContent).toContain("Comparison note: SEC source precision metadata is unavailable");
    expect(pair?.textContent).toContain("accession 0000320193-25-prior-fact");
    expect(pair?.querySelectorAll("a[href^='https://www.sec.gov/Archives/edgar/data/']")).toHaveLength(2);
    expect(pair?.textContent).toContain("does not establish its cause, business significance, or materiality");
    expect(pair?.textContent).not.toContain("430000000000 USD");
    expect(container.querySelector(".crb-facts")?.textContent).toContain("430,000,000,000 USD");
    expect(container.querySelector(".crb-review-progress")?.textContent).toContain("0 support · 0 challenge · 0 context · 1 not reviewed");
  });

  it("puts the decision action before collapsed financial and public-source manifests", async () => {
    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" />);
      await Promise.resolve();
    });

    const leads = [...container.querySelectorAll<HTMLDetailsElement>("details.crb-section")]
      .find((section) => section.querySelector("summary")?.textContent?.includes("Public-source leads"));
    expect(leads).not.toBeNull();
    expect(leads?.open).toBe(false);
    expect(leads?.querySelector("summary")?.textContent).toContain("1 saved rows");
    const facts = [...container.querySelectorAll<HTMLDetailsElement>("details.crb-section")]
      .find((section) => section.querySelector("summary")?.textContent?.includes("Reported financial facts"));
    expect(facts?.open).toBe(false);
    const decision = container.querySelector("form.crb-decision");
    expect(decision).not.toBeNull();
    expect(decision!.compareDocumentPosition(leads!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await act(async () => {
      leads!.querySelector("summary")!.click();
      await Promise.resolve();
    });
    expect(leads?.open).toBe(true);
    expect(leads?.textContent).toContain("APPLE_ONLY_SOURCE_EVIDENCE");
    expect(leads?.textContent).toContain("Delivery completed");
  });

  it("reopens a decision only for the exact requested saved snapshot digest", async () => {
    const target = { asOfMs: AS_OF, snapshotKey: "saved-snapshot-digest" };
    const saved = brief("apple", "Apple", "AAPL", "TARGET_SNAPSHOT_EVIDENCE");
    saved.snapshotKey = target.snapshotKey;
    saved.decision = {
      id: "saved-decision", requestKey: "saved-request", companyId: "apple", asOfMs: AS_OF, snapshotId: "sec-snapshot",
      snapshotKey: target.snapshotKey, factIds: [], observationIds: ["apple-observation"],
      evidenceRoles: [{ observationId: "apple-observation", role: "supports_assessment" }],
      decision: "investigate_further", rationale: "Resume with this exact saved evidence.", nextCheckDate: null, createdAt: AS_OF + 1_000,
    };
    api.getBrief.mockResolvedValue(saved);

    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" resumeSnapshot={target} />);
      await Promise.resolve();
    });

    expect(api.getBrief).toHaveBeenCalledWith("apple", expect.any(AbortSignal), target.asOfMs);
    expect(container.textContent).toContain("TARGET_SNAPSHOT_EVIDENCE");
    expect(container.textContent).toContain("Resume with this exact saved evidence.");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("withholds evidence and the prior decision when requested-snapshot reconstruction has a missing or mismatched digest", async () => {
    const target = { asOfMs: AS_OF, snapshotKey: "requested-digest" };
    const reconstructedOther = brief("apple", "Apple", "AAPL", "WRONG_SNAPSHOT_EVIDENCE");
    reconstructedOther.decision = {
      id: "other-decision", requestKey: "other-request", companyId: "apple", asOfMs: AS_OF, snapshotId: null,
      snapshotKey: reconstructedOther.snapshotKey, factIds: [], observationIds: [], evidenceRoles: [],
      decision: "set_aside", rationale: "WRONG_SNAPSHOT_DECISION", nextCheckDate: null, createdAt: AS_OF,
    };
    const missingDigest = { ...brief("apple", "Apple", "AAPL", "MISSING_DIGEST_EVIDENCE"), snapshotKey: "" };
    api.getBrief.mockResolvedValueOnce(reconstructedOther).mockResolvedValueOnce(missingDigest);

    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" resumeSnapshot={target} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("could not be reconstructed with its exact digest");
    expect(container.textContent).not.toContain("WRONG_SNAPSHOT_EVIDENCE");
    expect(container.textContent).not.toContain("WRONG_SNAPSHOT_DECISION");
    expect(container.querySelector("form.crb-decision")).toBeNull();

    const retry = container.querySelector<HTMLButtonElement>("[role='alert'] button");
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
      await Promise.resolve();
    });
    expect(api.getBrief).toHaveBeenLastCalledWith("apple", undefined, target.asOfMs);
    expect(container.textContent).toContain("could not be reconstructed with its exact digest");
    expect(container.textContent).not.toContain("MISSING_DIGEST_EVIDENCE");
  });

  it("keeps a failed requested-snapshot reconstruction fail-closed", async () => {
    api.getBrief.mockRejectedValue(new Error("snapshot reconstruction unavailable"));
    await act(async () => {
      root.render(<CompanyResearchBriefPanel companyId="apple" companyName="Apple" ticker="AAPL" resumeSnapshot={{ asOfMs: AS_OF, snapshotKey: "requested-digest" }} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Evidence and decision are withheld");
    expect(container.textContent).not.toContain("APPLE_ONLY_SOURCE_EVIDENCE");
    expect(container.querySelector("form.crb-decision")).toBeNull();
  });
});
