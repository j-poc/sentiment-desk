import type { FundamentalComparison, FundamentalMetricKey, PersistedFundamentalFact } from "./company-fundamentals.js";

/** Inputs for a brief are assembled from one server-validated persisted snapshot. */
export interface ResearchBriefCompany { companyId: string; name: string; ticker: string; cik: string | null; }

export interface ResearchBriefObservation {
  id: string;
  companyId: string;
  title: string;
  publisher: string;
  sourceUrl: string;
  sourceTime: number | null;
  retrievedAt: number;
  deliveryId: string;
  ingestedAt: number;
  snippet: string;
  status: string;
  collector: string;
  timeBasis: string;
  deliveryCompletedAt: number;
  ingestionCompletedAt: number;
  /** Descriptive raw label only. It must never affect support, risk, or research-worthiness. */
  sentiment?: number | null;
}

export interface CompanyResearchBriefInput {
  company: ResearchBriefCompany;
  asOfMs: number;
  snapshotId: string | null;
  facts: PersistedFundamentalFact[];
  comparisons: FundamentalComparison[];
  /** Already receipt-verified and eligible for private display by the server. */
  observations: ResearchBriefObservation[];
  coverage: { sec: "complete" | "partial" | "empty"; publicObservations: "complete" | "partial" | "empty"; reasons: string[] };
}

export interface CompanyResearchBrief {
  schemaVersion: 1;
  company: ResearchBriefCompany;
  asOfMs: number;
  snapshotId: string | null;
  coverage: CompanyResearchBriefInput["coverage"];
  facts: PersistedFundamentalFact[];
  comparisons: FundamentalComparison[];
  observations: ResearchBriefObservation[];
  nextResearchQuestion: { question: string; metric: FundamentalMetricKey; currentFactId: string; priorFactId: string } | null;
  missingEvidenceReason: string | null;
  interpretationLimits: string[];
}

export type CompanyResearchDecision = "investigate_further" | "insufficient_evidence" | "set_aside";
export type CompanyResearchEvidenceRole = "supports_assessment" | "challenges_assessment" | "context_only" | "not_reviewed";
export interface CompanyResearchEvidenceRoleChoice { observationId: string; role: CompanyResearchEvidenceRole; }

/** Analyst-authored choice bound to one immutable local evidence snapshot. */
export interface SavedCompanyResearchDecision {
  id: string;
  requestKey: string;
  companyId: string;
  asOfMs: number;
  snapshotId: string | null;
  snapshotKey: string;
  factIds: string[];
  observationIds: string[];
  evidenceRoles: CompanyResearchEvidenceRoleChoice[];
  decision: CompanyResearchDecision;
  rationale: string;
  nextCheckDate: string | null;
  createdAt: number;
}

/** Read-only projection of the newest immutable analyst decision for a public issuer. */
export interface CompanyResearchDecisionQueueItem {
  decision: SavedCompanyResearchDecision;
  company: ResearchBriefCompany;
  factCount: number;
  observationCount: number;
}

/** A read-only request to reconstruct one exact saved-evidence version. */
export interface CompanyResearchBriefResumeSnapshot {
  asOfMs: number;
  snapshotKey: string;
}

export interface CompanyResearchBriefResponse {
  brief: CompanyResearchBrief;
  snapshotKey: string;
  decision: SavedCompanyResearchDecision | null;
  decisionStorageAvailable: boolean;
  decisionStorageUnavailableReason: string | null;
}
