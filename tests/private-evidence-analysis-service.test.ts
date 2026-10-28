import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateEvidenceAnalysisRecord, PrivateEvidenceItem } from "../shared/private-evidence.js";
import { createPrivateEvidenceAnalysisService, type PrivateEvidenceAnalysisAttempt, type PrivateEvidenceAnalysisServiceOptions } from "../server/private-evidence-analysis-service.js";
import type { PreparedChatGPTPlanPrivateEvidenceRequest } from "../server/chatgpt-plan-private-evidence.js";
import { prepareChatGPTPlanPrivateEvidenceRequest } from "../server/chatgpt-plan-private-evidence.js";
import { PrivateEvidenceAnalysisError } from "../server/private-evidence-analysis.js";
import { TestDesk } from "./test-desk.js";

const company = { id: "apple", name: "Apple", ticker: "AAPL", sector: "Consumer Electronics", aliases: [], color: "#ffffff" };
const content = "The selected note reports higher unit sales, but no source documents were attached.";
const evidence: PrivateEvidenceItem = {
  id: "6ba68529-6311-4c62-8d3e-8d1129ac35d0", companyId: company.id, title: "User note", sourceLabel: "Private research",
  fileName: null, asOfDate: null, importedAt: 1_791_464_400_000,
  sha256: createHash("sha256").update(content).digest("hex"), byteLength: Buffer.byteLength(content), content,
};
type AnalyzePrepared = (prepared: PreparedChatGPTPlanPrivateEvidenceRequest, beforeDispatch?: () => boolean) => Promise<PrivateEvidenceAnalysisRecord>;
const defaultAnalyze: AnalyzePrepared = async (_prepared, beforeDispatch) => {
  if (beforeDispatch?.() !== true) throw new Error("pre-dispatch marker rejected");
  return {} as PrivateEvidenceAnalysisRecord;
};
const baseOptions = (db: TestDesk, overrides: Partial<PrivateEvidenceAnalysisServiceOptions> = {}): PrivateEvidenceAnalysisServiceOptions => ({
  loopbackBound: true, privateStoreReady: true, externalRequestsEnabled: true,
  planConnected: () => true, modelAvailable: () => true, maxRequestsPerDay: 1, maxRequestBytesPerDay: 260_000,
  utcDay: () => "2026-10-08", db,
  analyzer: { configured: true, analyzePrepared: vi.fn(defaultAnalyze) },
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

describe("private-note ChatGPT-plan dispatch gates", () => {
  let db: TestDesk | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  it("dynamically blocks when the ChatGPT plan, model, external gate, or writable storage is unavailable", async () => {
    db = new TestDesk(":memory:");
    vi.spyOn(db, "storageCapacity").mockReturnValue({ ...db.storageCapacity(), writesAllowed: true });
    vi.spyOn(db, "externalRequestAllowed").mockReturnValue(true);
    let connected = true;
    let modelAvailable: boolean | null = true;
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, { planConnected: () => connected, modelAvailable: () => modelAvailable }));
    expect(service.enabled).toBe(true);
    connected = false;
    expect(service.blockedReason).toBe("chatgpt_plan_not_connected");
    connected = true; modelAvailable = false;
    expect(service.blockedReason).toBe("chatgpt_plan_model_unavailable");
    modelAvailable = null;
    expect(service.enabled).toBe(true);
    vi.mocked(db.externalRequestAllowed).mockReturnValue(false);
    expect(service.blockedReason).toBe("external_requests_are_paused");
    const selected = attempt();
    await expect(service.analyze(company, evidence, selected.value)).rejects.toMatchObject({ code: "private_evidence_analysis_disabled" });
    expect(selected.value.begin).not.toHaveBeenCalled();
  });

  it("reserves the exact serialized private request in the same daily request and byte budget as public classifications", async () => {
    db = new TestDesk(":memory:");
    vi.spyOn(db, "storageCapacity").mockReturnValue({ ...db.storageCapacity(), writesAllowed: true });
    vi.spyOn(db, "externalRequestAllowed").mockReturnValue(true);
    const prepared = prepareChatGPTPlanPrivateEvidenceRequest({ company, evidence });
    const analyzePrepared = vi.fn(defaultAnalyze);
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, {
      maxRequestBytesPerDay: prepared.request.requestBytes,
      analyzer: { configured: true, analyzePrepared },
    }));
    const selected = attempt();
    await service.analyze(company, evidence, selected.value);
    expect(selected.value.begin).toHaveBeenCalledWith({
      payloadSha256: prepared.request.payloadSha256,
      evidenceSha256: evidence.sha256,
      requestBytes: prepared.request.requestBytes,
    });
    expect(analyzePrepared).toHaveBeenCalledTimes(1);
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:requests")).toBe("1");
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:request-bytes")).toBe(String(prepared.request.requestBytes));
    expect(db.planUsageSince(new Date("2026-10-08T00:00:00.000Z").getTime())).toMatchObject({
      requests: 1, requestBytes: prepared.request.requestBytes,
    });
    const columns = db.testDb.prepare("PRAGMA table_info(chatgpt_plan_auxiliary_requests)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("note_text");
    expect(columns.map((column) => column.name)).not.toContain("evidence_id");
    expect(JSON.stringify(db.testDb.prepare("SELECT * FROM chatgpt_plan_auxiliary_requests").all())).not.toContain(content);
  });

  it("rejects over-cap work before dispatch and releases the reservation", async () => {
    db = new TestDesk(":memory:");
    const prepared = prepareChatGPTPlanPrivateEvidenceRequest({ company, evidence });
    const analyzePrepared = vi.fn(defaultAnalyze);
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, {
      maxRequestBytesPerDay: prepared.request.requestBytes - 1,
      analyzer: { configured: true, analyzePrepared },
    }));
    const selected = attempt();
    await expect(service.analyze(company, evidence, selected.value)).rejects.toMatchObject({ code: "private_evidence_analysis_budget_exhausted" });
    expect(selected.value.cancelBeforeDispatch).toHaveBeenCalledWith(prepared.request.payloadSha256);
    expect(analyzePrepared).not.toHaveBeenCalled();
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:requests")).toBeUndefined();
  });

  it("serializes concurrent requests so only one can consume the last daily request", async () => {
    db = new TestDesk(":memory:");
    vi.spyOn(db, "storageCapacity").mockReturnValue({ ...db.storageCapacity(), writesAllowed: true });
    vi.spyOn(db, "externalRequestAllowed").mockReturnValue(true);
    const analyzePrepared = vi.fn(defaultAnalyze);
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, { analyzer: { configured: true, analyzePrepared } }));
    const outcomes = await Promise.allSettled([
      service.analyze(company, evidence, attempt().value),
      service.analyze(company, evidence, attempt().value),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(analyzePrepared).toHaveBeenCalledTimes(1);
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:requests")).toBe("1");
  });

  it("cancels the selected-note attempt after confirmed pre-dispatch failure and retains unknown dispatched outcomes", async () => {
    db = new TestDesk(":memory:");
    vi.spyOn(db, "storageCapacity").mockReturnValue({ ...db.storageCapacity(), writesAllowed: true });
    vi.spyOn(db, "externalRequestAllowed").mockReturnValue(true);
    const notSent = vi.fn(async (_request: PreparedChatGPTPlanPrivateEvidenceRequest, beforeDispatch?: () => boolean) => {
      // Model-catalog preflight occurs before the durable pre-dispatch hook.
      expect(beforeDispatch).toBeDefined();
      throw new PrivateEvidenceAnalysisError("not_configured", "model preflight stopped request");
    }) as AnalyzePrepared;
    const service = createPrivateEvidenceAnalysisService(baseOptions(db, { analyzer: { configured: true, analyzePrepared: notSent } }));
    const selected = attempt();
    await expect(service.analyze(company, evidence, selected.value)).rejects.toMatchObject({ code: "private_evidence_analysis_disabled" });
    expect(selected.value.cancelBeforeDispatch).toHaveBeenCalledWith(prepareChatGPTPlanPrivateEvidenceRequest({ company, evidence }).request.payloadSha256);
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:requests")).toBe("0");
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:request-bytes")).toBe("0");

    const recovered = createPrivateEvidenceAnalysisService(baseOptions(db, { analyzer: { configured: true, analyzePrepared: vi.fn(defaultAnalyze) } }));
    await expect(recovered.analyze(company, evidence, selected.value)).resolves.toBeDefined();
    expect(selected.value.begin).toHaveBeenCalledTimes(2);
    expect(db.getKv("chatgpt-plan:budget:2026-10-08:requests")).toBe("1");

    const unknown = vi.fn(async (_request: PreparedChatGPTPlanPrivateEvidenceRequest, beforeDispatch?: () => boolean) => {
      expect(beforeDispatch?.()).toBe(true);
      throw new PrivateEvidenceAnalysisError("transport_unknown", "stream interrupted", { outcomeUnknown: true });
    }) as AnalyzePrepared;
    const retryService = createPrivateEvidenceAnalysisService(baseOptions(db, {
      utcDay: () => "2026-10-09", analyzer: { configured: true, analyzePrepared: unknown },
    }));
    const unknownAttempt = attempt();
    await expect(retryService.analyze(company, evidence, unknownAttempt.value)).rejects.toMatchObject({ category: "transport_unknown" });
    expect(unknownAttempt.value.cancelBeforeDispatch).not.toHaveBeenCalled();
    expect(db.getKv("chatgpt-plan:budget:2026-10-09:closed")).toBe("1");
    expect(db.planUsageSince(0)).toMatchObject({ requests: 2, unknownOutcomes: 1 });
    expect(db.reserveChatGPTPlanAuxiliaryRequest({ utcDay: "2026-10-09", requestBytes: 1, maxRequests: 1, maxRequestBytes: 260_000 }))
      .toMatchObject({ reserved: false, reason: "closed" });
  });
});
