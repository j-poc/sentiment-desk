import type { Company } from "./types.js";
import type { PrivateEvidenceItem, PrivateEvidenceAnalysisRecord } from "../shared/private-evidence.js";
import type { Desk } from "./db.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import {
  PrivateEvidenceAnalyzer,
  preparePrivateEvidenceAnalysisRequest,
  type PreparedPrivateEvidenceAnalysisRequest,
} from "./private-evidence-analysis.js";

export type PrivateEvidenceAnalysisAttempt = {
  begin: (prepared: { payloadSha256: string; evidenceSha256: string; requestBytes: number }) => boolean;
  cancelBeforeDispatch: (payloadSha256: string) => void;
};

export interface PrivateEvidenceAnalysisServiceOptions {
  loopbackBound: boolean;
  privateStoreReady: boolean;
  externalRequestsEnabled: boolean;
  featureEnabled: boolean;
  apiKey: string;
  accountUseApproved: boolean;
  maxRequestsPerDay: number;
  maxRequestBytesPerDay: number;
  maxDailyCostMicros: number;
  db: Pick<Desk, "externalRequestAllowed" | "storageCapacity" | "reserveOpenAIEvaluationBudget">;
  analyzer?: Pick<PrivateEvidenceAnalyzer, "configured" | "analyzePrepared">;
  utcDay?: () => string;
}

export interface PrivateEvidenceAnalysisService {
  readonly enabled: boolean;
  readonly blockedReason: string | null;
  analyze: (company: Company, evidence: PrivateEvidenceItem, attempt: PrivateEvidenceAnalysisAttempt) => Promise<PrivateEvidenceAnalysisRecord>;
}

function unavailableReason(options: PrivateEvidenceAnalysisServiceOptions, analyzer: Pick<PrivateEvidenceAnalyzer, "configured" | "analyzePrepared">): string | null {
  if (!options.loopbackBound) return "private_evidence_requires_loopback_binding";
  if (!options.privateStoreReady) return "private_evidence_storage_unavailable";
  if (!options.externalRequestsEnabled) return "external_requests_are_disabled";
  if (!options.featureEnabled) return "private_note_analysis_is_disabled_by_operator";
  if (options.apiKey.trim() === "") return "openai_api_key_is_missing";
  if (!options.accountUseApproved) return "openai_account_use_is_not_approved";
  if (options.maxRequestsPerDay <= 0 || options.maxRequestBytesPerDay <= 0 || options.maxDailyCostMicros <= 0) {
    return "shared_openai_daily_budgets_are_disabled";
  }
  if (analyzer.configured === false) return "openai_api_key_is_missing";
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

export function createPrivateEvidenceAnalysisService(options: PrivateEvidenceAnalysisServiceOptions): PrivateEvidenceAnalysisService {
  const analyzer = options.analyzer ?? new PrivateEvidenceAnalyzer({ apiKey: options.apiKey });
  const service: PrivateEvidenceAnalysisService = {
    get enabled() { return unavailableReason(options, analyzer) === null; },
    get blockedReason() { return unavailableReason(options, analyzer); },
    async analyze(company, evidence, attempt) {
      if (unavailableReason(options, analyzer) !== null) throw codedError("private_evidence_analysis_disabled");

      const prepared = preparePrivateEvidenceAnalysisRequest({ company, evidence });
      if (!attempt.begin({ payloadSha256: prepared.payloadSha256, evidenceSha256: prepared.evidenceSha256, requestBytes: prepared.requestBytes })) {
        throw codedError("private_evidence_analysis_attempt_already_recorded");
      }
      let reservation: ReturnType<Desk["reserveOpenAIEvaluationBudget"]>;
      try {
        reservation = options.db.reserveOpenAIEvaluationBudget({
          utcDay: (options.utcDay ?? (() => new Date().toISOString().slice(0, 10)))(),
          requests: 1,
          requestBytes: prepared.requestBytes,
          costMicros: prepared.reservedCostMicros,
          maxRequests: options.maxRequestsPerDay,
          maxRequestBytes: options.maxRequestBytesPerDay,
          maxDailyCostMicros: options.maxDailyCostMicros,
        });
      } catch (error) {
        attempt.cancelBeforeDispatch(prepared.payloadSha256);
        throw error;
      }
      if (!reservation.reserved) {
        attempt.cancelBeforeDispatch(prepared.payloadSha256);
        throw codedError(reservation.reason === "exhausted"
          ? "private_evidence_analysis_budget_exhausted" : "private_evidence_analysis_storage_read_only");
      }
      try {
        return await analyzer.analyzePrepared(prepared) as PrivateEvidenceAnalysisRecord;
      } catch (error) {
        if (error instanceof ExternalRequestPausedError) throw codedError("private_evidence_analysis_external_requests_paused");
        throw error;
      }
    },
  };
  return service;
}

export type { PreparedPrivateEvidenceAnalysisRequest };
