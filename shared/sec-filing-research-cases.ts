import type { FundamentalComparison, FundamentalMetricKey, PersistedFundamentalFact, PersistedFundamentalPoint } from "./company-fundamentals.js";
import type { CompanyResearchDecision } from "./company-research-brief.js";
export type { CompanyResearchDecision } from "./company-research-brief.js";

export interface SavedSecFilingResearchDecision {
  id: string;
  requestKey: string;
  caseId: string;
  asOfMs: number;
  snapshotId: string;
  snapshotKey: string;
  factIds: string[];
  decision: CompanyResearchDecision;
  rationale: string;
  nextCheckDate: string | null;
  createdAt: number;
}

export interface SecFilingResearchCase {
  kind: "sec_filing_case";
  id: string;
  cik: string;
  triggeringAccession: string;
  filingSymbol: string;
  filingIssuer: string;
  filingUrl: string;
  listingProof: {
    retrievedAt: string;
    directoryCreatedAt: string;
    sources: Array<{ source: string; createdAt: string; retrievedAt: string }>;
    sha256: string;
  };
  identity: {
    status: "unverified" | "verified" | "mismatch";
    ticker: string | null;
    issuerName: string | null;
    receipt: { url: string; retrievedAt: string; sha256: string } | null;
  };
  createdAt: number;
}

export interface SecFilingResearchSubject {
  kind: "sec_filing_case";
  caseId: string;
  cik: string;
  ticker: string;
  issuerName: string;
}

export type SecFilingResearchFundamentalFact = Omit<PersistedFundamentalFact,
  "companyId" | "companyFactsDeliveryId" | "submissionsDeliveryId"> & {
  caseId: string;
  companyFactsSha256: string;
  submissionsSha256: string;
};

export interface SecFilingResearchFundamentalsView {
  kind: "sec_filing_case_fundamentals";
  caseId: string;
  state: "idle" | "ready" | "partial" | "empty" | "stale" | "blocked" | "failed";
  periodComparisonPolicyVersion: string;
  snapshotId: string | null;
  facts: SecFilingResearchFundamentalFact[];
  comparisons: FundamentalComparison[];
  points: PersistedFundamentalPoint[];
  coverage: string[];
  refreshAllowed: boolean;
  refreshBlockedReason: string | null;
  lastRefreshError: string | null;
  staleReason: string | null;
  latestAttemptAt: number | null;
  retrievedAt: number | null;
}

export interface SecFilingResearchBrief {
  schemaVersion: 1;
  subject: SecFilingResearchSubject;
  asOfMs: number;
  snapshotId: string | null;
  facts: SecFilingResearchFundamentalFact[];
  comparisons: FundamentalComparison[];
  coverage: { sec: "complete" | "partial" | "empty"; reasons: string[] };
  nextResearchQuestion: { question: string; metric: FundamentalMetricKey; currentFactId: string; priorFactId: string } | null;
  interpretationLimits: string[];
}

export interface SecFilingResearchBriefResponse {
  brief: SecFilingResearchBrief;
  snapshotKey: string;
  decision: SavedSecFilingResearchDecision | null;
  decisionStorageAvailable: boolean;
  decisionStorageUnavailableReason: string | null;
}

export interface SecFilingCaseDecisionQueueItem {
  target: SecFilingResearchSubject;
  decision: SavedSecFilingResearchDecision;
  factCount: number;
}

export interface SecFilingResearchCaseDetail {
  case: SecFilingResearchCase;
  fundamentals: SecFilingResearchFundamentalsView | null;
  brief: SecFilingResearchBriefResponse | null;
}

export interface SaveSecFilingResearchDecisionInput {
  requestKey: string;
  asOfMs: number;
  snapshotKey: string;
  factIds: string[];
  decision: CompanyResearchDecision;
  rationale: string;
  nextCheckDate: string | null;
}
