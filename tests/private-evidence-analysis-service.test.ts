import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateEvidenceAnalysisRecord, PrivateEvidenceItem } from "../shared/private-evidence.js";
import { createPrivateEvidenceAnalysisService, type PrivateEvidenceAnalysisAttempt, type PrivateEvidenceAnalysisServiceOptions } from "../server/private-evidence-analysis-service.js";
import { preparePrivateEvidenceAnalysisRequest } from "../server/private-evidence-analysis.js";
import { TestDesk } from "./test-desk.js";

const company = { id: "apple", name: "Apple", ticker: "AAPL", sector: "Consumer Electronics", aliases: [], color: "#ffffff" };
const content = "The selected note reports higher unit sales, but no source documents were attached.";
const evidence: PrivateEvidenceItem = {
  id: "6ba68529-6311-4c62-8d3e-8d1129ac35d0", companyId: company.id, title: "User note", sourceLabel: "Private research",
  fileName: null, asOfDate: null, importedAt: 1_791_464_400_000, content,
  sha256: createHash("sha256").update(content).digest("hex"), byteLength: Buffer.byteLength(content),
};

const baseOptions = (db: TestDesk, overrides: Partial<PrivateEvidenceAnalysisServiceOptions> = {}): PrivateEvidenceAnalysisServiceOptions => ({
  loopbackBound: true, privateStoreReady: true, externalRequestsEnabled: true, featureEnabled: true,
  apiKey: "test-key", accountUseApproved: true, maxRequestsPerDay: 1, maxRequestBytesPerDay: 260_000,
  maxDailyCostMicros: 100_000, utcDay: () => "2026-10-08", db,
  analyzer: { configured: true, analyzePrepared: vi.fn(async () => ({} as PrivateEvidenceAnalysisRecord)) },
  ...overrides,
});

function attempt(overrides: Partial<PrivateEvidenceAnalysisAttempt> = {}) {
  let began: { payloadSha256: string; evidenceSha256: string; requestBytes: number } | null = null;
  const value: PrivateEvidenceAnalysisAttempt = {
    begin: vi.fn((prepared) => { began = prepared; return true; }),
    cancelBeforeDispatch: vi.fn(() => { began = null; }),
    ...overrides,
  };
  return { value, began: () => began };
}

describe("private-note Luna dispatch gates", () => {
  let db: TestDesk | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  it("exposes dynamic readiness and blocks when external work or writable storage is paused", async () => {
    db = new TestDesk(":memory:");
    const writes = vi.spyOn(db, "storageCapacity");
    const external = vi.spyOn(db, "externalRequestAllowed");
    writes.mockReturnValue({ ...db.storageCapacity(), writesAllowed: true });
    external.mockReturnValue(true);
    const service = createPrivateEvidenceAnalysisService(baseOptions(db));
    expect(service.enabled).toBe(true);
    external.mockReturnValue(false);
    expect(service.enabled).toBe(false);
    expect(service.blockedReason).toBe("external_requests_are_paused");
    external.mockReturnValue(true);
    writes.mockReturnValue({ ...db.storageCapacity(), writesAllowed: false });
    expect(service.enabled).toBe(false);
    expect(service.blockedReason).toBe("private_evidence_storage_read_only");
    const selected = attempt();
    await expect(service.analyze(company, evidence, selected.value)).rejects.toMatchObject({ code: "private_evidence_analysis_disabled" });
    expect(selected.value.begin).not.toHaveBeenCalled();
  });

  it("reserves the shared requests, bytes and worst-case USD budget before dispatch and permits only one attempt", async () => {
    db = new TestDesk(":memory:");
    const prepared = preparePrivateEvidenceAnalysisRequest({ company, evidence });
    const analyzePrepared = vi.fn(async () => ({} as PrivateEvidenceAnalysisRecord));
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, {
      maxRequestBytesPerDay: prepared.requestBytes,
      maxDailyCostMicros: prepared.reservedCostMicros,
      analyzer: { configured: true, analyzePrepared },
    }));
    const selected = attempt();

    await service.analyze(company, evidence, selected.value);

    expect(selected.value.begin).toHaveBeenCalledWith({ payloadSha256: prepared.payloadSha256,
      evidenceSha256: evidence.sha256, requestBytes: prepared.requestBytes });
    expect(analyzePrepared).toHaveBeenCalledTimes(1);
    expect(db.getKv("openai:budget:2026-10-08:requests")).toBe("1");
    expect(db.getKv("openai:budget:2026-10-08:request-bytes")).toBe(String(prepared.requestBytes));
    expect(db.getKv("openai:budget:2026-10-08:cost-micros")).toBe(String(prepared.reservedCostMicros));

    const duplicate = attempt({ begin: vi.fn(() => false) });
    await expect(service.analyze(company, evidence, duplicate.value)).rejects.toMatchObject({ code: "private_evidence_analysis_attempt_already_recorded" });
    expect(analyzePrepared).toHaveBeenCalledTimes(1);
    expect(db.getKv("openai:budget:2026-10-08:requests")).toBe("1");
  });

  it("cancels a not-dispatched attempt and makes no provider call when the shared USD budget is exhausted", async () => {
    db = new TestDesk(":memory:");
    const prepared = preparePrivateEvidenceAnalysisRequest({ company, evidence });
    const analyzePrepared = vi.fn(async () => ({} as PrivateEvidenceAnalysisRecord));
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, {
      maxDailyCostMicros: prepared.reservedCostMicros - 1,
      analyzer: { configured: true, analyzePrepared },
    }));
    const selected = attempt();

    await expect(service.analyze(company, evidence, selected.value)).rejects.toMatchObject({ code: "private_evidence_analysis_budget_exhausted" });

    expect(selected.value.cancelBeforeDispatch).toHaveBeenCalledWith(prepared.payloadSha256);
    expect(analyzePrepared).not.toHaveBeenCalled();
    expect(db.getKv("openai:budget:2026-10-08:requests")).toBeUndefined();
  });

  it("cancels the pending record if reservation infrastructure fails before dispatch", async () => {
    db = new TestDesk(":memory:");
    const prepared = preparePrivateEvidenceAnalysisRequest({ company, evidence });
    const analyzePrepared = vi.fn(async () => ({} as PrivateEvidenceAnalysisRecord));
    const reserve = vi.spyOn(db, "reserveOpenAIEvaluationBudget").mockImplementation(() => { throw new Error("database unavailable"); });
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, {
      analyzer: { configured: true, analyzePrepared },
    }));
    const selected = attempt();

    await expect(service.analyze(company, evidence, selected.value)).rejects.toThrow("database unavailable");

    expect(selected.value.cancelBeforeDispatch).toHaveBeenCalledWith(prepared.payloadSha256);
    expect(analyzePrepared).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("keeps all configuration and authorization gates closed before any attempt is created", async () => {
    db = new TestDesk(":memory:");
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, {
      externalRequestsEnabled: false,
      featureEnabled: false,
      apiKey: "",
      accountUseApproved: false,
      maxRequestsPerDay: 0,
    }));
    const selected = attempt();
    expect(service.enabled).toBe(false);
    expect(service.blockedReason).toBe("external_requests_are_disabled");
    await expect(service.analyze(company, evidence, selected.value)).rejects.toMatchObject({ code: "private_evidence_analysis_disabled" });
    expect(selected.value.begin).not.toHaveBeenCalled();
  });
});
