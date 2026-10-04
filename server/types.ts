export type SourceKind = "rss" | "x" | "sec" | "finnhub" | "reddit";
export type CollectorId =
  | "legacy_unknown"
  | "demo_simulation"
  | "google_news_rss"
  | "yahoo_finance_rss"
  | "yahoo_quote"
  | "gdelt_doc_api"
  | "sec_edgar"
  | "finnhub"
  | "reddit"
  | "x"
  | "yahoo_chart";
export type EvidenceChannel = "news" | "filing" | "social" | "market_context";
export type TimeBasis = "publisher_declared" | "provider_observed" | "unknown" | "legacy_unknown";
export type DeliveryHealthState = "current" | "processing" | "overdue" | "failed" | "partial" | "never" | "disabled";

export type SecDocumentRole = "8k_primary" | "earnings_exhibit_99_1";
export type SecDocumentOutcome = "success" | "empty" | "failed" | "invalid" | "rate_limited" | "paused";
export type SecSelectionReason = "primary_selected" | "unique_exhibit_selected" | "missing_exhibit" | "ambiguous_exhibit" | "invalid_exhibit_link" | "primary_unavailable" | "exhibit_unavailable" | "unverified_event_link" | "storage_paused";
export type SecItem202Link = { kind: "linked"; itemCode: "2.02"; exhibitNumber: "99.1"; supportingText: string } | { kind: "unverified"; reason: "missing_item_body" | "missing_results_attachment_reference" | "different_results_exhibit" | "ambiguous_results_reference" | "conflicting_table_description" };
export interface SecDocumentAttempt {
  role: SecDocumentRole; url: string; startedAt: number; completedAt: number; retrievedAt: number | null;
  httpStatus: number | null; outcome: SecDocumentOutcome; bodyBytes: number | null; bodySha256: string | null;
  excerpt: string; errorCode: string | null;
}
export interface SecDocumentContext {
  version: "sec-document-context/1"; cik: string; accessionNo: string; primaryUrl: string;
  acceptedAt: number; filedAt: number | null; classificationInputStatus: "ready" | "incomplete";
  selectionReason: SecSelectionReason; item202Link: SecItem202Link | null; selectedRole: SecDocumentRole | null; selectedUrl: string | null;
  documents: SecDocumentAttempt[];
}

/** Historical verification evidence shown separately from live Desk observations. */
export interface ArchivedRun {
  label: string;
  company: string;
  ticker: string;
  sourceTitle: string;
  sourceUrl: string;
  filedAt: number;
  sourcePublishedAt: number;
  collectedAt: number;
  scoredAt: number;
  receiptId: string;
  receiptDigest: string;
  sourceAdapter: string;
  sentiment: "negative" | "neutral" | "positive";
  eventType: string;
  model: string;
  confidence: number;
  requestDigest: string;
  rubricDigest: string;
}

/**
 * Source tiers rank publishing venues by expected reliability for business
 * reporting. The tier is a deterministic prior; Jev's per-item credibility
 * judgment blends with it at scoring time. Both live in the stored score so
 * the blend is always auditable.
 */
export type SourceTier = "wire" | "major" | "trade" | "blog" | "social" | "filing";

export interface Company {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  aliases: string[];
  color: string;
  /** True when the name doubles as a common word (Apple, Meta, Intel, Amazon the river): text-matched mentions face a stricter identity bar. */
  ambiguous?: boolean;
}

/**
 * A mention as normalized from a source, before scoring. Provenance rules:
 * Source and collection clocks are separate. Missing publication and provider
 * observation times remain null; retrievedAt is our own clock.
 */
export interface RawMention {
  companyId: string;
  kind: SourceKind;
  sourceName: string;
  sourceUrl: string;
  tier: SourceTier;
  title: string;
  snippet: string;
  publishedAt: number | null;
  providerObservedAt?: number | null;
  retrievedAt: number;
  collector?: CollectorId;
  publisherName?: string;
  publisherDomain?: string | null;
  sourceItemId?: string | null;
  /** Immutable request receipt that first delivered this observation. */
  deliveryId?: string | null;
  adapterVersion?: string;
  responseDigest?: string | null;
  /** SEC only: the filing date declared by EDGAR (distinct from acceptance). */
  filedAt?: number;
  /** True when the item arrived via a symbol-scoped query (Yahoo ticker feed, Finnhub, X, Reddit, SEC): the scoping itself is identity evidence. */
  scoped?: boolean;
}

/** The state block sent to Jev: everything the model may judge on. */
export interface JevState {
  company: {
    id: string;
    name: string;
    ticker: string;
    sector: string;
  };
  mention: {
    title: string;
    snippet: string;
    source: {
      collector: CollectorId;
      /** The collected item link; it may be an aggregator redirect rather than the publisher site. */
      collectionUrl: string;
      tier: SourceTier;
      publisherName: string;
      publisherDomain: string | null;
    };
    publishedAt: string;
  };
  /** TradingAgents-style reflection: measured 30-minute reactions after this
   * desk's own past judgments on this company, included for calibration.
   * Populated only when there are enough measured events to be meaningful. */
  deskMemory?: {
    overall?: string;
    byType?: Record<string, string>;
  };
}

export type MentionStatus = "pending" | "scoring" | "retrying" | "scored" | "off_target" | "classified" | "excluded" | "review_required" | "failed" | "corrupt";

export interface CategoricalClassification {
  provider: "openai_luna";
  modelRequested: string;
  modelReturned: string | null;
  serviceTierRequested: "default";
  serviceTier: string | null;
  promptVersion: string;
  promptSha256: string;
  schemaVersion: string;
  schemaSha256: string;
  sentiment: "negative" | "neutral" | "positive" | null;
  eventType: string | null;
  takeaway: string | null;
  about: boolean | null;
  material: boolean | null;
  investorRelevant: boolean | null;
  evidenceSufficient: boolean;
  summary: string | null;
  supportingExcerpt: string | null;
  disposition: "classified" | "excluded" | "review_required";
  responseId: string;
  responseSha256: string;
  inputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningTokens: number | null;
  totalTokens: number;
  estimatedCostUsd: number | null;
  latencyMs: number;
  classifiedAt: number;
}

export interface CategoricalTrendCounts {
  positive: number;
  neutral: number;
  negative: number;
  reviewRequired: number;
  excluded: number;
  total: number;
}

export interface CategoricalTrendPoint {
  bucketStartMs: number;
  fromMs: number;
  throughMs: number;
  counts: CategoricalTrendCounts;
}

export interface CategoricalTrendLineage {
  promptVersion: string;
  promptSha256: string;
  schemaVersion: string;
  schemaSha256: string;
  count: number;
}

export interface CategoricalTrendResult {
  companyId: string;
  windowHours: number;
  fromMs: number;
  throughMs: number;
  bucketMs: number;
  timeBasis: "classification_available_at";
  countBasis: "immutable_source_observation";
  snapshotGeneration: string;
  snapshotKey: string;
  points: CategoricalTrendPoint[];
  counts: CategoricalTrendCounts;
  eligibleObservationCount: number;
  candidateClassificationCount: number;
  withheldInvalidCount: number;
  latestClassifiedAt: number | null;
  lineages: CategoricalTrendLineage[];
}

export interface CategoricalBucketCursor {
  classifiedAt: number;
  id: string;
}

export interface CategoricalBucketEvidencePage {
  companyId: string;
  snapshotKey: string;
  bucketStartMs: number;
  bucketDurationMs: number;
  fromMs: number;
  throughMs: number;
  counts: CategoricalTrendCounts;
  items: MentionDTO[];
  nextCursor: CategoricalBucketCursor | null;
}

export interface MentionScore {
  sentiment: "negative" | "neutral" | "positive";
  pPos: number;
  pNeu: number;
  pNeg: number;
  confidence: number;
  about: number;
  material: number;
  novel: number;
  credible: number;
  investorRelevant: number;
  eventType: string;
  takeaway: string;
  magnitude: number;
  surprise: number;
  /** 0-100 event-strength composite: materiality, surprise, magnitude. */
  eventScore: number;
  /** Composite directional index in [-100, 100]. */
  impact: number;
  /** Relative weight of this mention inside any windowed index. */
  weight: number;
  engine: string;
  inputTokens: number;
  outputTokens: number;
  estimatedInputCostUsd: number;
  latencyMs: number;
  rubricSha: string;
  scoredAt: number;
}

export interface MentionDTO {
  id: string;
  companyId: string;
  source: {
    name: string; url: string; kind: SourceKind; tier: SourceTier;
    collector: CollectorId; publisher: string; publisherDomain: string | null;
    /** Null for retained legacy rows collected before request receipts were linked. */
    deliveryId: string | null;
  };
  title: string;
  snippet: string;
  /** Source-declared event time, null when the source did not provide one. */
  publishedAt: number | null;
  providerObservedAt: number | null;
  retrievedAt: number;
  ingestedAt: number;
  timeBasis: TimeBasis;
  collector: CollectorId;
  publisherName: string;
  publisherDomain: string | null;
  /** SEC only: EDGAR filing date (distinct from the acceptance timestamp). */
  filedAt?: number | null;
  status: MentionStatus;
  scoreRetryAt: number | null;
  usageCheckRequired: boolean;
  score: MentionScore | null;
  classification?: CategoricalClassification | null;
  error: string | null;
  secDocumentContext?: SecDocumentContext | null;
}

/** Minimal persisted evidence used by the deterministic Radar aggregation. */
export interface RadarItemEvidence {
  id: string;
  title: string;
  sourceUrl: string;
  publisherName: string;
  publisherDomain: string | null;
  publishedAt: number;
  retrievedAt: number;
  collector: CollectorId;
  eventType: string;
  sentiment: string;
  takeaway: string;
}

export interface EarningsSurprise {
  percent: number; // (actual - estimate) / |estimate| * 100
  period: string;
}

export interface CompanySnapshot {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  color: string;
  /** Weighted Jev-impact mean; the active window is 3h, falling back to 24h. */
  index: number | null;
  /** Window used for index, or null when there are no scored records. */
  indexWindow: "3h" | "24h" | null;
  /** Positive-weight scored source records included in index. Repeats can occur. */
  indexRecordCount: number;
  /** index now minus index over the full trailing day. */
  delta: number | null;
  sourceRecords24h: number;
  /** Latest collection time across saved identified source records, independent of the 24h count. */
  latestSourceCollectedAt: number | null;
  /** Next scheduled earnings date (ms), from the Finnhub calendar when configured. */
  earningsAt: number | null;
  /** Latest reported EPS surprise vs consensus, from Finnhub when configured. */
  lastSurprise: EarningsSurprise | null;
}

export interface SeriesPoint {
  bucketStartAtMs: number;
  bucketEndAtMs: number;
  weightedMeanImpact: number | null;
  scoredRecordCount: number;
  recordImpactMin: number | null;
  recordImpactMax: number | null;
  latestRecordScoredAtMs: number | null;
  bucketSnapshotKey: string | null;
  /** Compatibility aliases for the existing visual consumers. */
  t: number;
  v: number | null;
  n: number;
  itemImpactMin: number | null;
  itemImpactMax: number | null;
  lastScoredAt: number | null;
}

export interface ImpactDistributionBin {
  from: number;
  through: number;
  includeThrough: boolean;
  count: number;
}

export interface SeriesResult {
  metric: "weighted_mean_impact";
  bucketMs: number;
  windowStartMs: number;
  windowEndMs: number;
  loadedRecordCount: number;
  populatedBucketCount: number;
  points: SeriesPoint[];
  /** Latest Jev completion time across saved identified score history, even outside the visible window. */
  latestScoreAvailableAt: number | null;
}
