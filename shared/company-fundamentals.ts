/** Saved, source-linked SEC CompanyFacts view for a configured Desk company. */
export type FundamentalMetricKey = "revenue" | "operating_income" | "net_income" | "operating_cash_flow";
export type FundamentalsState = "idle" | "loading" | "refreshing" | "ready" | "partial" | "empty" | "stale" | "blocked" | "failed";
export type FundamentalPeriodAlignment = "calendar_anniversary" | "same_filing_52_week" | "same_filing_53_week";

export interface PersistedFundamentalFact {
  id: string;
  companyId: string;
  cik: string;
  metric: FundamentalMetricKey;
  value: string;
  unit: string;
  /** SEC XBRL decimals attribute, if CompanyFacts supplied one; never inferred from val. */
  reportedDecimals: string | null;
  reportedPrecisionStatus: "declared" | "missing" | "invalid";
  taxonomy: string;
  concept: string;
  startDate: string | null;
  endDate: string;
  /** SEC CompanyFacts fy metadata describes the report's fiscal focus, not this fact's period. */
  filingFocusYear: number | null;
  filingFocusPeriod: string | null;
  form: string;
  accession: string;
  filedAt: number | null;
  acceptedAt: number | null;
  retrievedAt: number;
  sourceUrl: string;
  responseSha256: string;
  companyFactsDeliveryId: string;
  submissionsDeliveryId: string;
  durationClass: "annual" | "quarter" | "ytd_q2" | "ytd_q3" | "unknown";
  amended: boolean;
}

export interface FundamentalComparison {
  metric: FundamentalMetricKey;
  state: "comparable" | "insufficient" | "not_comparable";
  periodAlignment: FundamentalPeriodAlignment | null;
  currentFactId: string | null;
  priorFactId: string | null;
  delta: string | null;
  percentChange: string | null;
  changeInterpretation: "reported_values_only" | "change_exceeds_precision" | "within_reported_precision" | "no_reported_difference" | "withheld";
  reason: string | null;
}

/** Null points represent genuine periods with no eligible saved fact. */
export interface PersistedFundamentalPoint {
  periodEnd: string;
  metric: FundamentalMetricKey;
  value: string | null;
  unit: string;
  reportedDecimals: string | null;
  reportedPrecisionStatus: "declared" | "missing" | "invalid";
}

export interface CompanyFundamentalsView {
  companyId: string;
  state: Exclude<FundamentalsState, "loading" | "refreshing">;
  periodComparisonPolicyVersion: string;
  snapshotId: string | null;
  facts: PersistedFundamentalFact[];
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

export interface FundamentalRefreshResult extends CompanyFundamentalsView {
  refresh: "completed" | "reused" | "blocked";
}
