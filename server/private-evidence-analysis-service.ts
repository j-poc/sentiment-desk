import type { Company } from "./types.js";
import type { PrivateEvidenceItem, PrivateEvidenceAnalysisRecord } from "../shared/private-evidence.js";
import type { Desk } from "./db.js";
import {
  PrivateEvidenceAnalysisError,
  type PrivateEvidenceAnalysisInput,
} from "./private-evidence-analysis.js";
import {
  ChatGPTPlanPrivateEvidenceAnalyzer,
  prepareChatGPTPlanPrivateEvidenceRequest,
  type PreparedChatGPTPlanPrivateEvidenceRequest,
} from "./chatgpt-plan-private-evidence.js";

export type PrivateEvidenceAnalysisAttempt = {
  begin: (prepared: { payloadSha256: string; evidenceSha256: string; requestBytes: number }) => boolean;
  cancelBeforeDispatch: (payloadSha256: string) => void;
};

type PlanAnalyzer = Pick<ChatGPTPlanPrivateEvidenceAnalyzer, "configured" | "analyzePrepared">;

export interface PrivateEvidenceAnalysisServiceOptions {
  loopbackBound: boolean;
  privateStoreReady: boolean;
  externalRequestsEnabled: boolean;
  planConnected: () => boolean;
  modelAvailable: () => boolean | null;
  planProviderPaused?: () => boolean;
  maxRequestsPerDay: number;
  maxRequestBytesPerDay: number;
  db: Pick<Desk, "externalRequestAllowed" | "storageCapacity" | "reserveChatGPTPlanAuxiliaryRequest" | "markChatGPTPlanAuxiliaryRequestDispatched" | "finishChatGPTPlanAuxiliaryRequest">;
  analyzer?: PlanAnalyzer;
  utcDay?: () => string;
};

export interface PrivateEvidenceAnalysisService {
  readonly enabled: boolean;
  readonly blockedReason: string | null;
  analyze: (company: Company, evidence: PrivateEvidenceItem, attempt: PrivateEvidenceAnalysisAttempt) => Promise<PrivateEvidenceAnalysisRecord>;
}

function unavailableReason(options: PrivateEvidenceAnalysisServiceOptions): string | null {
  if (!options.loopbackBound) return "private_evidence_requires_loopback_binding";
  if (!options.privateStoreReady) return "private_evidence_storage_unavailable";
  if (!options.externalRequestsEnabled) return "external_requests_are_disabled";
  if (!options.planConnected()) return "chatgpt_plan_not_connected";
  if (options.planProviderPaused?.()) return "chatgpt_plan_provider_paused";
  if (options.modelAvailable() === false) return "chatgpt_plan_model_unavailable";
  if (options.maxRequestsPerDay <= 0 || options.maxRequestBytesPerDay <= 0) return "chatgpt_plan_local_limits_disabled";
  if (!options.analyzer || options.analyzer.configured === false) return "chatgpt_plan_analyzer_unavailable";
  try {
    if (!options.db.storageCapacity().writesAllowed) return "private_evidence_storage_read_only";
    if (!options.db.externalRequestAllowed()) return "external_requests_are_paused";
  } catch {
    return "private_evidence_storage_unavailable";
  }
  return null;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function failureOutcome(error: unknown, dispatched: boolean): "not_sent" | "rejected" | "unknown" {
  if (!dispatched) return "not_sent";
  if (error instanceof PrivateEvidenceAnalysisError) {
    if (error.category === "not_configured" && !error.outcomeUnknown) return "not_sent";
    if (error.category === "provider_outcome_unknown" || error.category === "transport_unknown" || error.outcomeUnknown) return "unknown";
    if (error.category === "http_rejected" || error.category === "refused" || error.category === "invalid_response" ||
        error.category === "ungrounded_output" || error.category === "response_unreadable") return "rejected";
  }
  return "unknown";
}

export function createPrivateEvidenceAnalysisService(options: PrivateEvidenceAnalysisServiceOptions): PrivateEvidenceAnalysisService {
  const service: PrivateEvidenceAnalysisService = {
    get enabled() { return unavailableReason(options) === null; },
    get blockedReason() { return unavailableReason(options); },
    async analyze(company, evidence, attempt) {
      if (unavailableReason(options) !== null) throw codedError("private_evidence_analysis_disabled");

      const input: PrivateEvidenceAnalysisInput = { company, evidence };
      const prepared = prepareChatGPTPlanPrivateEvidenceRequest(input);
      if (!attempt.begin({ payloadSha256: prepared.request.payloadSha256, evidenceSha256: prepared.evidenceSha256, requestBytes: prepared.request.requestBytes })) {
        throw codedError("private_evidence_analysis_attempt_already_recorded");
      }
      let reservation: ReturnType<Desk["reserveChatGPTPlanAuxiliaryRequest"]>;
      const utcDay = (options.utcDay ?? (() => new Date().toISOString().slice(0, 10)))();
      try {
        reservation = options.db.reserveChatGPTPlanAuxiliaryRequest({
          utcDay,
          requestBytes: prepared.request.requestBytes,
          maxRequests: options.maxRequestsPerDay,
          maxRequestBytes: options.maxRequestBytesPerDay,
        });
      } catch (error) {
        attempt.cancelBeforeDispatch(prepared.request.payloadSha256);
        throw error;
      }
      if (!reservation.reserved) {
        attempt.cancelBeforeDispatch(prepared.request.payloadSha256);
        throw codedError(reservation.reason === "exhausted" || reservation.reason === "closed"
          ? "private_evidence_analysis_budget_exhausted" : "private_evidence_analysis_storage_read_only");
      }

      let dispatched = false;
      try {
        const result = await options.analyzer!.analyzePrepared(prepared, () => {
          const marked = options.db.markChatGPTPlanAuxiliaryRequestDispatched(reservation.id);
          dispatched = marked;
          return marked;
        });
        if (!options.db.finishChatGPTPlanAuxiliaryRequest(reservation.id, "completed")) {
          throw codedError("private_evidence_analysis_usage_receipt_failed");
        }
        return result;
      } catch (error) {
        const outcome = failureOutcome(error, dispatched);
        if (outcome === "not_sent") {
          // The note store's unique in-progress attempt represents consent to
          // one dispatch. Release it when plan/catalog preflight proves that
          // no POST occurred, so the user can retry after reconnecting.
          attempt.cancelBeforeDispatch(prepared.request.payloadSha256);
        }
        try { options.db.finishChatGPTPlanAuxiliaryRequest(reservation.id, outcome); }
        catch { /* startup recovery converts any durable in-flight reservation to a closed unknown outcome */ }
        if (error instanceof PrivateEvidenceAnalysisError && error.category === "not_configured" && !dispatched) {
          throw codedError("private_evidence_analysis_disabled");
        }
        throw error;
      }
    },
  };
  return service;
}

export type { PreparedChatGPTPlanPrivateEvidenceRequest };
