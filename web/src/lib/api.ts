/**
 * API client: typed mirrors of the server DTOs, fetch helpers, and one
 * EventSource wrapper with liveness callbacks. The browser never sees source
 * credentials; classifier retry is the only explicit write action.
 */
import { z } from "zod";
import { withReadDeadline } from "./bounded-read.js";
import type { ScoreBucketCoverage } from "../../../shared/score-bucket-coverage.js";
import type { CompanyFundamentalsView, FundamentalRefreshResult } from "../../../shared/company-fundamentals.js";
import type { AnalystResearchDisposition, AnalystResearchDispositionChange, AnalystSourceReview } from "../../../shared/analyst-research.js";
import type { SecFilingDetail, SecFilingsInboxView, SecFilingResearchTask } from "../../../shared/sec-filings-inbox.js";
import type { SavedSourceCoverageSnapshot } from "../../../shared/saved-source-coverage.js";
import type { SavedSourceSearchCursor, SavedSourceSearchPage } from "../../../shared/saved-source-search.js";
import type { CompanyResearchBriefResponse, CompanyResearchBriefResumeSnapshot, CompanyResearchDecision, CompanyResearchDecisionQueueItem, CompanyResearchEvidenceRoleChoice } from "../../../shared/company-research-brief.js";
import type {
  SecFilingCaseDecisionQueueItem,
  SecFilingResearchCase,
  SecFilingResearchCaseDetail,
  SaveSecFilingResearchDecisionInput,
  SecFilingResearchBriefResponse,
} from "../../../shared/sec-filing-research-cases.js";
export type { CompanyResearchDecisionQueueItem } from "../../../shared/company-research-brief.js";

/** Shared identity guard used before applying any selected-company response. */
export function isCurrentCompanySelection(requestCompanyId: string, selectedCompanyId: string | null): boolean {
  return selectedCompanyId !== null && requestCompanyId === selectedCompanyId;
}

export async function getCompanyFundamentals(companyId: string, signal?: AbortSignal): Promise<CompanyFundamentalsView> {
  return getJSON<CompanyFundamentalsView>(`/api/companies/${encodeURIComponent(companyId)}/fundamentals`, signal);
}

export async function refreshCompanyFundamentals(
  companyId: string,
  requestKey: string,
): Promise<FundamentalRefreshResult> {
  return requestJSON<FundamentalRefreshResult>(
    `/api/companies/${encodeURIComponent(companyId)}/fundamentals/refresh`,
    { method: "POST", body: JSON.stringify({ requestKey }) },
  );
}

export function getCompanyResearchBrief(companyId: string, signal?: AbortSignal, asOfMs?: number): Promise<CompanyResearchBriefResponse> {
  const query = asOfMs == null ? "" : `?asOfMs=${encodeURIComponent(String(asOfMs))}`;
  return getJSON<CompanyResearchBriefResponse>(`/api/companies/${encodeURIComponent(companyId)}/research-brief${query}`, signal);
}

export function saveCompanyResearchDecision(companyId: string, input: {
  requestKey: string; asOfMs: number; snapshotKey: string; decision: CompanyResearchDecision;
  rationale: string; evidenceRoles: CompanyResearchEvidenceRoleChoice[]; nextCheckDate: string | null;
}): Promise<CompanyResearchBriefResponse> {
  return requestJSON<CompanyResearchBriefResponse>(
    `/api/companies/${encodeURIComponent(companyId)}/research-brief/decisions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function getSecFilingsInbox(signal?: AbortSignal): Promise<SecFilingsInboxView> {
  return getJSON<SecFilingsInboxView>("/api/sec-filings-inbox", signal);
}

export function activateSecFilingsInbox(): Promise<SecFilingsInboxView> {
  return requestJSON<SecFilingsInboxView>("/api/sec-filings-inbox/activate", {
    method: "POST", body: JSON.stringify({ confirmUse: true }),
  });
}

export function inspectSecFiling(cik: string, accession: string): Promise<SecFilingDetail> {
  return requestJSON<SecFilingDetail>("/api/sec-filings-inbox/evidence", {
    method: "POST", body: JSON.stringify({ cik, accession, confirmUse: true }),
  });
}

export async function getSecFilingResearchCases(signal?: AbortSignal): Promise<SecFilingResearchCase[]> {
  return (await getJSON<{ items: SecFilingResearchCase[] }>("/api/sec-filing-research-cases", signal)).items;
}

export function createSecFilingResearchCase(cik: string, accession: string): Promise<{ case: SecFilingResearchCase; created: boolean }> {
  return requestJSON<{ case: SecFilingResearchCase; created: boolean }>("/api/sec-filing-research-cases", {
    method: "POST", body: JSON.stringify({ cik, accession }),
  });
}

export function getSecFilingResearchCase(id: string, signal?: AbortSignal): Promise<SecFilingResearchCaseDetail> {
  return getJSON<SecFilingResearchCaseDetail>(`/api/sec-filing-research-cases/${encodeURIComponent(id)}`, signal);
}

export async function verifySecFilingResearchCaseIdentity(id: string): Promise<SecFilingResearchCase> {
  const response = await requestJSON<{ case: SecFilingResearchCase }>(
    `/api/sec-filing-research-cases/${encodeURIComponent(id)}/verify-identity`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return response.case;
}

export function refreshSecFilingResearchCaseFundamentals(id: string, requestKey: string): Promise<SecFilingResearchCaseDetail> {
  return requestJSON<SecFilingResearchCaseDetail>(`/api/sec-filing-research-cases/${encodeURIComponent(id)}/fundamentals/refresh`, {
    method: "POST", body: JSON.stringify({ requestKey }),
  });
}

export function saveSecFilingResearchCaseDecision(id: string, input: SaveSecFilingResearchDecisionInput): Promise<SecFilingResearchBriefResponse> {
  return requestJSON<SecFilingResearchBriefResponse>(`/api/sec-filing-research-cases/${encodeURIComponent(id)}/research-brief/decisions`, {
    method: "POST", body: JSON.stringify(input),
  });
}

export async function getSecFilingResearchCaseDecisionQueue(signal?: AbortSignal): Promise<{ items: SecFilingCaseDecisionQueueItem[] }> {
  return getJSON<{ items: SecFilingCaseDecisionQueueItem[] }>("/api/research-queue/sec-filing-cases", signal);
}

export async function getSecFilingResearchTasks(signal?: AbortSignal): Promise<SecFilingResearchTask[]> {
  return (await getJSON<{ items: SecFilingResearchTask[] }>("/api/sec-filing-research-tasks", signal)).items;
}

export function saveSecFilingResearchTask(cik: string, accession: string, nextQuestion: string): Promise<SecFilingResearchTask> {
  return requestJSON<SecFilingResearchTask>("/api/sec-filing-research-tasks", {
    method: "POST", body: JSON.stringify({ cik, accession, nextQuestion }),
  });
}

export async function removeSecFilingResearchTask(cik: string, accession: string): Promise<SecFilingResearchTask[]> {
  return (await requestJSON<{ items: SecFilingResearchTask[] }>(`/api/sec-filing-research-tasks/${encodeURIComponent(cik)}/${encodeURIComponent(accession)}`, {
    method: "DELETE",
  })).items;
}

export function getSavedSourceCoverage(signal?: AbortSignal): Promise<SavedSourceCoverageSnapshot<Mention>> {
  return getJSON<SavedSourceCoverageSnapshot<Mention>>("/api/saved-source-coverage", signal);
}

export async function getSavedSourceSearch(input: {
  query: string;
  companyId: string | null;
  publisher: string;
  includeDismissed: boolean;
  snapshotAt: number | null;
  reviewRevision: number | null;
  cursor: SavedSourceSearchCursor | null;
  signal?: AbortSignal;
}): Promise<SavedSourceSearchPage<Mention>> {
  const params = new URLSearchParams({ q: input.query.trim(), limit: "25", includeDismissed: String(input.includeDismissed) });
  if (input.companyId) params.set("companyId", input.companyId);
  if (input.publisher.trim()) params.set("publisher", input.publisher.trim());
  if (input.snapshotAt != null) params.set("snapshotAt", String(input.snapshotAt));
  if (input.reviewRevision != null) params.set("reviewRevision", String(input.reviewRevision));
  if (input.cursor) params.set("cursor", JSON.stringify(input.cursor));
  const response = await fetch(`/api/saved-source-search?${params}`, { signal: input.signal });
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new ApiRequestError(response.status, typeof body?.error === "string" ? body.error : "saved_source_search_failed");
  }
  return body as SavedSourceSearchPage<Mention>;
}

export interface AnalystResearchQueueItem extends AnalystSourceReview {
  companyName: string;
  ticker: string;
  mention: Mention;
}

export async function getAnalystResearchQueue(signal?: AbortSignal): Promise<{ items: AnalystResearchQueueItem[] }> {
  return getJSON<{ items: AnalystResearchQueueItem[] }>("/api/research-queue", signal);
}

export async function getCompanyResearchDecisionQueue(signal?: AbortSignal): Promise<{ items: CompanyResearchDecisionQueueItem[] }> {
  return getJSON<{ items: CompanyResearchDecisionQueueItem[] }>("/api/research-queue/company-decisions", signal);
}

export async function getAnalystSourceReview(observationId: string, signal?: AbortSignal): Promise<AnalystSourceReview | null> {
  const result = await getJSON<{ review: AnalystSourceReview | null }>(
    `/api/mentions/${encodeURIComponent(observationId)}/research-review`, signal,
  );
  return result.review;
}

export async function updateAnalystSourceReview(
  observationId: string,
  input: { disposition: AnalystResearchDisposition; nextQuestion: string },
): Promise<AnalystSourceReview> {
  const result = await requestJSON<{ review: AnalystSourceReview }>(
    `/api/mentions/${encodeURIComponent(observationId)}/research-review`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.review;
}

export interface EarningsSurprise {
  percent: number;
  period: string;
}

export interface CompanySnapshot {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  color: string;
  index: number | null;
  indexWindow: "3h" | "24h" | null;
  indexRecordCount: number;
  delta: number | null;
  sourceRecords24h: number;
  latestSourceCollectedAt: number | null;
  earningsAt: number | null;
  lastSurprise: EarningsSurprise | null;
}

export type Sentiment = "negative" | "neutral" | "positive";
export type MentionStatus = "pending" | "scoring" | "retrying" | "scored" | "off_target" | "failed" | "corrupt" | "classified" | "excluded" | "review_required";

/** Luna categories remain separate from historical Jev probabilities and index values. */
export interface CategoricalClassification {
  attemptId: string | null;
  provider: "openai_luna";
  modelRequested: string;
  modelReturned: string | null;
  serviceTierRequested: "default";
  serviceTier: string | null;
  promptVersion: string;
  promptSha256: string;
  profileSha256: string | null;
  schemaVersion: string;
  schemaSha256: string;
  sentiment: Sentiment | null;
  eventType: string | null;
  takeaway: string | null;
  about: boolean | null;
  investorRelevant: boolean | null;
  material: boolean | null;
  evidenceSufficient: boolean;
  summary: string | null;
  supportingExcerpt: string | null;
  disposition: "classified" | "excluded" | "review_required";
  responseId: string | null;
  responseSha256: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
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
  profileSha256: string;
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
  items: Mention[];
  nextCursor: CategoricalBucketCursor | null;
}
export type SourceTier = "wire" | "major" | "trade" | "blog" | "social" | "filing";
export type CollectorId = "legacy_unknown" | "google_news_rss" | "yahoo_finance_rss" | "yahoo_quote" | "gdelt_doc_api" | "sec_edgar" | "sec_company_facts" | "finnhub" | "reddit" | "x" | "yahoo_chart";
export interface SecDocumentAttempt { role: "8k_primary" | "earnings_exhibit_99_1"; url: string; startedAt: number; completedAt: number; retrievedAt: number | null; httpStatus: number | null; outcome: "success" | "empty" | "failed" | "invalid" | "rate_limited" | "paused"; bodyBytes: number | null; bodySha256: string | null; excerpt: string; errorCode: string | null; }
export interface SecDocumentContext { version: "sec-document-context/1"; cik: string; accessionNo: string; primaryUrl: string; acceptedAt: number; filedAt: number | null; classificationInputStatus: "ready" | "incomplete"; selectionReason: "primary_selected" | "unique_exhibit_selected" | "missing_exhibit" | "ambiguous_exhibit" | "invalid_exhibit_link" | "primary_unavailable" | "exhibit_unavailable" | "unverified_event_link" | "storage_paused"; item202Link: { kind: "linked"; itemCode: "2.02"; exhibitNumber: "99.1"; supportingText: string } | { kind: "unverified"; reason: string } | null; selectedRole: SecDocumentAttempt["role"] | null; selectedUrl: string | null; documents: SecDocumentAttempt[]; }

export interface FirstRunEvidenceDTO {
  eligibleObservationCount: number;
  secCollectorEnabled: boolean;
  jevSecScoringEnabled: boolean;
  classifierProvider?: "openai_luna" | "typesafe";
  classifierSecClassificationEnabled?: boolean;
  classifierBlockedReason?: string | null;
}

export interface MentionScore {
  sentiment: Sentiment;
  pPos: number;
  pNeu: number;
  pNeg: number;
  confidence: number;
  about: number;
  material: number;
  novel: number;
  credible: number;
  eventType: string;
  takeaway: string;
  magnitude: number;
  surprise: number;
  eventScore: number;
  impact: number;
  weight: number;
  engine: string;
  inputTokens: number;
  outputTokens: number;
  estimatedInputCostUsd: number;
  latencyMs: number;
  rubricSha: string;
  scoredAt: number;
}

export interface Mention {
  id: string;
  companyId: string;
  source: { name: string; url: string; kind: "rss" | "x" | "sec" | "finnhub" | "reddit"; tier: SourceTier; collector: CollectorId; publisher: string; publisherDomain: string | null; deliveryId?: string | null };
  title: string;
  snippet: string;
  issuerIdentityStrong?: boolean;
  publishedAt: number | null;
  aggregatorPublishedAt?: number | null;
  providerObservedAt: number | null;
  retrievedAt: number;
  ingestedAt: number;
  timeBasis: "publisher_declared" | "aggregator_declared" | "provider_observed" | "unknown" | "legacy_unknown";
  collector: CollectorId;
  publisherName: string;
  publisherDomain: string | null;
  filedAt?: number | null;
  status: MentionStatus;
  scoreRetryAt: number | null;
  usageCheckRequired: boolean;
  score: MentionScore | null;
  classification?: CategoricalClassification | null;
  analystResearchDisposition?: "investigate" | "dismissed" | null;
  analystResearchDispositionUpdatedAt?: number | null;
  error: string | null;
  secDocumentContext?: SecDocumentContext | null;
}

export interface MentionPage {
  items: Mention[];
  nextCursor: { orderAt: number; ingestedAt: number; id: string } | null;
  setAsideCount: number;
  issuerIdentityReviewCount: number;
}

/** Read one page of retained company history; this route never starts collection. */
export function getCompanySavedHistoryPage(
  companyId: string,
  cursor: MentionPage["nextCursor"] = null,
  signal?: AbortSignal,
): Promise<MentionPage> {
  const params = new URLSearchParams({ filter: "history", limit: "100", includeDismissed: "true" });
  if (cursor != null) params.set("cursor", JSON.stringify(cursor));
  return getJSON<MentionPage>(`/api/companies/${encodeURIComponent(companyId)}/mentions-page?${params}`, signal);
}

export interface FollowedCompanyBaseline {
  id: string;
  companyId: string;
  version: number;
  capturedAt: number;
  eligibleObservationCount: number;
  policyVersion: string;
}

export interface FollowedEvidenceCursor {
  companyId: string;
  baselineId: string;
  snapshotAt: number;
  snapshotMaxRowId: number;
  ingestedAt: number;
  id: string;
}

export interface FollowedEvidenceItem extends Mention {
  publishedBeforeBaseline: boolean;
  ingestionCompletedAt: number;
  ingestionFinalizedAfterBaseline: boolean;
}

export interface FollowedEvidencePage {
  companyId: string;
  baseline: FollowedCompanyBaseline | null;
  asOfAt: number;
  eligibleObservationsNow: number;
  withheldFromBaseline: number;
  newEvidenceCount: number;
  items: FollowedEvidenceItem[];
  nextCursor: FollowedEvidenceCursor | null;
}

export interface FollowedBaselineCaptureResult {
  baseline: FollowedCompanyBaseline;
  reused: boolean;
}

export interface JevAttemptSummary {
  provider?: "typesafe" | "openai_luna";
  attemptId: string;
  attemptNumber: number;
  requestSha256: string;
  requestBytes: number;
  requestedModel: string;
  rubricSha256: string;
  promptSha256: string | null;
  reservedAt: number;
  dispatchAt: number | null;
  outcome: "prepared" | "dispatch_intent" | "response" | "rejected" | "unknown" | "not_sent";
  completedAt: number | null;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  resolvedModel: string | null;
  latencyMs: number | null;
  errorCategory: string | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  serviceTierRequested?: "default";
  serviceTier?: string | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number | null;
  reservedCostUsd?: number | null;
  responseId?: string | null;
  responseSha256?: string | null;
  schemaSha256?: string | null;
}

export interface ScoreBucketEvidencePage {
  bucketFromMs: number;
  bucketThroughMs: number;
  recordCount: number;
  matchingRecordCount: number;
  impactBin: number | null;
  weightedMeanImpact: number | null;
  recordImpactMin: number | null;
  recordImpactMax: number | null;
  snapshotKey: string;
  impactDistribution: ImpactDistributionBin[];
  coverageSummary: ScoreBucketCoverage;
  items: Mention[];
  nextCursor: { companyId: string; scoredAt: number; id: string; fromMs: number; throughMs: number; impactBin: number | null; snapshotKey: string } | null;
}

export interface ImpactDistributionBin {
  from: number;
  through: number;
  includeThrough: boolean;
  count: number;
}

export interface ReactionEvent {
  id: string;
  title: string;
  publishedAt: number | null;
  availableAt: number;
  sentiment: string;
  eventScore: number;
  eventType: string;
  r30: number | null;
  r240: number | null;
}

export interface ReactionSummary {
  n30m: number;
  n4h: number;
  median30m: number | null;
  median4h: number | null;
  hitRate: number | null;
}

export interface ReactionsDTO {
  ticker: string;
  events: ReactionEvent[];
  measuredEventCount: number;
  bull: ReactionSummary;
  bear: ReactionSummary;
  all: ReactionSummary;
}

export interface ValidationBucket {
  range: string;
  n: number;
  medianAbs30: number | null;
  median30: number | null;
  hitRate: number | null;
}

export interface ValidationDTO {
  hours: number;
  totalEvents: number;
  withReaction: number;
  rankIC: number | null;
  buckets: ValidationBucket[];
  generatedAt: number;
}

export type RadarEventType =
  | "results"
  | "corporate_action"
  | "legal_regulatory"
  | "leadership"
  | "product"
  | "analyst_action"
  | "macro_sector"
  | "other";

export interface RadarEvidenceItem {
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

export interface RadarPeriodSummary {
  sourceRows: number;
  headlineGroups: number;
  publisherCount: number;
  publisherJudgments: number;
  positive: number;
  neutral: number;
  negative: number;
  mixed: number;
}

export interface RadarDTO {
  hours: number;
  generatedAt: number;
  currentFrom: number;
  currentTo: number;
  previousFrom: number;
  previousTo: number;
  current: RadarPeriodSummary;
  previous: RadarPeriodSummary;
  headlineChange: number;
  untimedScored: number;
  unjudged: number;
  unclassified: number;
  categories: Array<{
    eventType: RadarEventType;
    current: RadarPeriodSummary;
    previous: RadarPeriodSummary;
    headlineChange: number;
    recentEvidence: Array<{
      title: string;
      latestPublishedAt: number;
      sources: RadarEvidenceItem[];
    }>;
    previousEvidence: Array<{
      title: string;
      latestPublishedAt: number;
      sources: RadarEvidenceItem[];
    }>;
  }>;
  coverage: HealthDTO["deliveryHealth"];
}

export interface RadarEvidencePageDTO {
  generatedAt: number;
  hours: number;
  period: "current" | "previous";
  eventType: RadarEventType;
  offset: number;
  total: number;
  items: RadarDTO["categories"][number]["recentEvidence"];
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
  /** Saved receipt/title cues, present only for historical Jev archive buckets. */
  sourceLineage?: {
    recordCount: number;
    receiptLinkedRecordCount: number;
    repeatedTitleRecordCount: number;
    exactNormalizedTitleCount: number;
  };
  /** Compatibility aliases retained while chart and watchlist consumers migrate. */
  t: number;
  v: number | null;
  n: number;
  itemImpactMin: number | null;
  itemImpactMax: number | null;
  lastScoredAt: number | null;
}

export interface SeriesResult {
  metric: "weighted_mean_impact";
  bucketMs: number;
  windowStartMs: number;
  windowEndMs: number;
  loadedRecordCount: number;
  populatedBucketCount: number;
  points: SeriesPoint[];
  latestScoreAvailableAt: number | null;
}

export interface JevHistoryWeekResult {
  companyId: string;
  weekStartMs: number;
  fromMs: number;
  throughMs: number;
  points: SeriesPoint[];
  latestEligibleScoreAtMs: number;
  olderWeekStartMs: number | null;
  newerWeekStartMs: number | null;
  latestWeekStartMs: number;
}

export async function getJevHistoryWeek(companyId: string, week: number | "latest", signal?: AbortSignal): Promise<JevHistoryWeekResult> {
  const suffix = week === "latest" ? "latest" : String(week);
  return getJSON<JevHistoryWeekResult>(`/api/companies/${encodeURIComponent(companyId)}/jev-history-week?week=${encodeURIComponent(suffix)}`, signal);
}

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  currency: string;
  at: number | null;
  retrievedAt: number;
  lastAttemptAt: number;
  delivery: "network" | "cache";
}

export interface MarketSnapshot {
  quotes: Record<string, Quote>;
  updatedAt: number;
}

export interface PricePoint {
  t: number;
  price: number;
  currency: string;
  collector: "yahoo_chart";
  retrievedAt: number;
  adapterVersion: string;
  deliveryId: string;
}

export interface PriceSeriesDTO {
  points: PricePoint[];
  delivery: "network" | "memory_cache" | "local_store";
  servedAt: number;
  sourceLatestAt: number | null;
  cacheAgeMs: number | null;
  refreshError: string | null;
  resampling: "source_observations_in_window";
  quarantine: { legacyUnknownRows: number | null; scope: "all_saved_history" };
}

export interface SourceHealth {
  enabled: boolean;
  ok: number;
  fail: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export interface HealthDTO {
  ok: boolean;
  externalRequestsEnabled: boolean;
  opportunityRadarEnabled: boolean;
  version: string;
  runtimeId: string;
  uptimeSec: number;
  sseClients: number;
  dbSizeBytes: number | null;
  storage: {
    state: "ready" | "capacity_paused" | "disk_pressure" | "checkpoint_blocked" | "measurement_failed";
    canStartExternalWork: boolean;
    writesAllowed: boolean;
    reason: string | null;
    mainBytes: number | null;
    walBytes: number | null;
    shmBytes: number | null;
    journalBytes: number | null;
    familyBytes: number | null;
    allocatedBytes: number | null;
    availableBytes: number | null;
    logicalDatabaseBytes: number | null;
    pageCount: number | null;
    pageSize: number | null;
    maxPageCount: number | null;
    maxDatabaseBytes: number;
    maxFamilyBytes: number;
    minimumFreeBytes: number;
    writeHeadroomBytes: number;
    checkedAt: number;
  };
  classifierUsage?: {
    requests: number;
    reservedRequests: number;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
    knownCostSubtotalUsd: number;
    unpricedAttempts: number;
    usageIncompleteAttempts: number;
    reservedCostUsd: number;
    unknownOutcomes: number;
  };
  alertDelivery: {
    configured: boolean;
    enabled: boolean;
    counts: {
      pending: number;
      sending: number;
      retrying: number;
      failed: number;
      paused: number;
    };
    recent: AlertDeliveryRecord[];
    nextCursor: string | null;
  };
  health: {
    externalRequestsEnabled: boolean;
    sourceApproval: {
      requestedCollectors: CollectorId[];
      approvedCollectors: CollectorId[];
      blockedRequestedCollectors: CollectorId[];
      typesafeAccountUseApproved: boolean;
      jevAllowedCollectors: CollectorId[];
      openaiAccountUseApproved?: boolean;
      openaiAllowedCollectors?: CollectorId[];
      openaiBlockedCollectors?: CollectorId[];
    };
    rss: SourceHealth;
    gdelt: SourceHealth;
    x: SourceHealth;
    quotes: SourceHealth;
    sec: SourceHealth;
    finnhub: SourceHealth;
    reddit: SourceHealth;
    jev: SourceHealth & { model: string };
    classifier?: SourceHealth & {
      provider: "openai_luna" | "typesafe";
      model: string;
      configured: boolean;
      blockedReason: string | null;
    };
  };
  deliveries: Array<{
    collector: CollectorId;
    companyId: string | null;
    result: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid";
    completedAt: number;
    parsedItemCount: number;
    adapterVersion: string;
    error: string | null;
  }>;
  deliveryHealth: Array<{
    collector: CollectorId;
    enabled: boolean;
    state: "current" | "processing" | "overdue" | "failed" | "partial" | "never" | "disabled";
    intervalSeconds: number;
    targetCount: number;
    coverageCount: number;
    latestDeliveryAt: number | null;
    latestResult: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid" | null;
    latestItemCount: number | null;
    latestError: string | null;
    adapterVersion: string | null;
    latestIngestionRequired: boolean;
    latestIngestionState: "processing" | "success" | "partial" | "failed" | null;
    latestIngestionExpectedCount: number | null;
    latestIngestionProcessedCount: number | null;
    latestIngestionInsertedCount: number | null;
    latestObservationAt: number | null;
    latestObservationBasis: "publisher_declared" | "provider_observed" | "unknown" | "legacy_unknown" | null;
    latestObservationRetrievedAt: number | null;
  }>;
  /** Saved provider judgments only; failed and retried requests are excluded. */
  usage: {
    judgedItems: number;
    inputTokens: number;
    outputTokens: number;
    estimatedInputCostUsd: number;
  };
  events: Array<{ at: number; level: string; source: string; message: string }>;
}

export interface AlertDeliveryRecord {
  alertId: string;
  observationId: string;
  companyId: string;
  ticker: string;
  title: string;
  state: "pending" | "sending" | "retrying" | "delivered" | "failed" | "expired" | "paused";
  attemptCount: number;
  createdAt: number;
  expiresAt: number;
  nextAttemptAt: number;
  lastOutcome: "delivered" | "retry" | "failed" | "ambiguous" | "expired" | null;
  lastHttpStatus: number | null;
  lastAttemptAt: number | null;
  lastErrorCategory: string | null;
}

export interface AlertDeliveryHistoryPage {
  items: AlertDeliveryRecord[];
  nextCursor: string | null;
}

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${code} (${status})`);
  }
}

export async function requestJSON<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) throw new ApiRequestError(
    response.status,
    typeof body?.error === "string" ? body.error : "request_failed",
  );
  return body as T;
}

const categoricalCountsSchema = z.object({
  positive: z.number().int().nonnegative(), neutral: z.number().int().nonnegative(),
  negative: z.number().int().nonnegative(), reviewRequired: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict().superRefine((counts, context) => {
  const sum = counts.positive + counts.neutral + counts.negative + counts.reviewRequired + counts.excluded;
  if (sum !== counts.total) context.addIssue({ code: "custom", message: "Categorical counts do not sum to total" });
});

const categoricalTrendSchema = z.object({
  companyId: z.string().min(1), windowHours: z.number().int().min(1).max(168),
  fromMs: z.number().int().nonnegative(), throughMs: z.number().int().positive(), bucketMs: z.literal(900000),
  timeBasis: z.literal("classification_available_at"), countBasis: z.literal("immutable_source_observation"),
  snapshotGeneration: z.string().uuid(), snapshotKey: z.string().min(1).max(2048),
  points: z.array(z.object({ bucketStartMs: z.number().int().nonnegative(), fromMs: z.number().int().nonnegative(), throughMs: z.number().int().positive(), counts: categoricalCountsSchema }).strict()),
  counts: categoricalCountsSchema,
  eligibleObservationCount: z.number().int().nonnegative(), candidateClassificationCount: z.number().int().nonnegative(),
  withheldInvalidCount: z.number().int().nonnegative(), latestClassifiedAt: z.number().int().nonnegative().nullable(),
  lineages: z.array(z.object({ promptVersion: z.string().min(1), promptSha256: z.string().regex(/^[a-f0-9]{64}$/), profileSha256: z.string().regex(/^[a-f0-9]{64}$/), schemaVersion: z.string().min(1), schemaSha256: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().positive() }).strict()),
}).strict().superRefine((result, context) => {
  if (result.counts.total !== result.eligibleObservationCount) context.addIssue({ code: "custom", message: "Trend totals do not match eligible observations" });
  if (result.counts.positive + result.counts.neutral + result.counts.negative + result.counts.reviewRequired + result.counts.excluded !== result.counts.total) {
    context.addIssue({ code: "custom", message: "Trend categories do not reconcile to the total" });
  }
  if (result.candidateClassificationCount - result.withheldInvalidCount !== result.eligibleObservationCount) context.addIssue({ code: "custom", message: "Candidate and withheld counts do not reconcile" });
  if (result.lineages.reduce((sum, lineage) => sum + lineage.count, 0) !== result.eligibleObservationCount) context.addIssue({ code: "custom", message: "Lineage counts do not reconcile" });
  if (result.points.reduce((sum, point) => sum + point.counts.total, 0) !== result.eligibleObservationCount) context.addIssue({ code: "custom", message: "Bucket counts do not reconcile" });
  const expectedPointCount = Math.floor((result.throughMs - 1) / result.bucketMs)
    - Math.floor(result.fromMs / result.bucketMs) + 1;
  if (result.points.length !== expectedPointCount || result.points.some((point, index) => {
    const expectedStart = Math.floor(result.fromMs / result.bucketMs) * result.bucketMs + index * result.bucketMs;
    return point.bucketStartMs !== expectedStart
      || point.fromMs !== Math.max(result.fromMs, expectedStart)
      || point.throughMs !== Math.min(result.throughMs, expectedStart + result.bucketMs);
  })) context.addIssue({ code: "custom", message: "Trend intervals do not cover the complete window" });
  if (result.points.some((point) => point.fromMs >= point.throughMs || point.fromMs < result.fromMs || point.throughMs > result.throughMs
    || point.bucketStartMs % result.bucketMs !== 0
    || point.counts.positive + point.counts.neutral + point.counts.negative + point.counts.reviewRequired + point.counts.excluded !== point.counts.total)) {
    context.addIssue({ code: "custom", message: "Trend bucket bounds are invalid" });
  }
});

const categoricalMentionSchema = z.object({
  id: z.string().min(1), companyId: z.string().min(1), title: z.string(),
  source: z.object({ url: z.string().url(), collector: z.string().min(1), deliveryId: z.string().min(1) }).passthrough(),
  classification: z.object({
    attemptId: z.string().min(1).nullable(),
    provider: z.literal("openai_luna"), modelRequested: z.literal("gpt-6-luna"), modelReturned: z.literal("gpt-6-luna"),
    promptVersion: z.string().min(1), promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    schemaVersion: z.string().min(1), schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    disposition: z.enum(["classified", "review_required", "excluded"]),
    sentiment: z.enum(["positive", "neutral", "negative"]).nullable(), classifiedAt: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

const categoricalBucketSchema = z.object({
  companyId: z.string().min(1), snapshotKey: z.string().min(1).max(2048),
  bucketStartMs: z.number().int().nonnegative(), bucketDurationMs: z.union([z.literal(900000), z.literal(1800000), z.literal(3600000), z.literal(10800000), z.literal(21600000)]),
  fromMs: z.number().int().nonnegative(), throughMs: z.number().int().positive(),
  counts: categoricalCountsSchema, items: z.array(categoricalMentionSchema),
  nextCursor: z.object({ classifiedAt: z.number().int().nonnegative(), id: z.string().min(1).max(200) }).strict().nullable(),
}).strict();

export async function getCategoricalTrend(companyId: string, hours: number): Promise<CategoricalTrendResult> {
  const result = await withReadDeadline((signal) => getJSON<unknown>(
    `/api/companies/${encodeURIComponent(companyId)}/categorical-series?hours=${encodeURIComponent(String(hours))}`, signal,
  ));
  return categoricalTrendSchema.parse(result) as CategoricalTrendResult;
}

export async function getCategoricalBucket(input: {
  companyId: string; snapshotKey: string; bucketStartMs: number; bucketDurationMs?: number; limit: number; cursor?: CategoricalBucketCursor | null;
}): Promise<CategoricalBucketEvidencePage> {
  const bucketDurationMs = input.bucketDurationMs ?? 900_000;
  if (![900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000].includes(bucketDurationMs)) throw new Error("Unsupported Luna bucket duration");
  const params = new URLSearchParams({ snapshot: input.snapshotKey, at: String(input.bucketStartMs), span: String(bucketDurationMs), limit: String(input.limit) });
  if (input.cursor) params.set("cursor", JSON.stringify(input.cursor));
  const result = await withReadDeadline((signal) => getJSON<unknown>(
    `/api/companies/${encodeURIComponent(input.companyId)}/categorical-bucket?${params}`, signal,
  ));
  return categoricalBucketSchema.parse(result) as unknown as CategoricalBucketEvidencePage;
}

export async function readBackendSnapshot(): Promise<{
  companies: CompanySnapshot[] | null;
  tape: Mention[] | null;
  quotes: MarketSnapshot | null;
  health: HealthDTO | null;
}> {
  const section = <T>(url: string) => withReadDeadline((signal) => getJSON<T>(url, signal)).catch(() => null);
  const [companies, tape, quotes, health] = await Promise.all([
    section<CompanySnapshot[]>("/api/companies"),
    section<Mention[]>("/api/tape?limit=60"),
    section<MarketSnapshot>("/api/quotes"),
    section<HealthDTO>("/api/health"),
  ]);
  return { companies, tape, quotes, health };
}

export async function lookupMentionsByIds(companyId: string, ids: string[]): Promise<Mention[]> {
  if (ids.length === 0) return [];
  return withReadDeadline(async (signal) => {
    const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/mentions/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
      signal,
    });
    if (!response.ok) throw new Error(`POST mention lookup -> ${response.status}`);
    const body = await response.json() as { items: Mention[] };
    return body.items;
  });
}

const retryErrorSchema = z.object({ error: z.string() });
const retryErrorCopy: Record<string, string> = {
  provider_usage_review_required: "Check provider usage before authorizing another attempt.",
  mention_not_retryable: "This item changed state. Refresh its details before retrying.",
  classifier_not_configured: "The selected classifier is blocked. Check its credentials, authorization and budgets.",
  classifier_source_not_allowed: "The selected classifier is not authorized to process this source. Check the source allowlist before retrying.",
  classifier_daily_budget_exhausted: "The classifier daily budget is exhausted. The item remains pending until the next UTC day.",
  jev_not_configured: "Jev is not configured in the running desk.",
  jev_daily_budget_exhausted: "The daily Jev input budget is exhausted. The item remains pending until the next UTC day.",
  retry_confirmation_required: "Confirm the new request and provider-usage review before retrying.",
};

export async function retryMention(
  id: string,
  confirmation: { confirmNewCharge: true; reviewedProviderUsage: boolean },
): Promise<void> {
  const response = await fetch(`/api/mentions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmation),
  });
  if (response.status === 202) return;

  const body: unknown = await response.json().catch(() => null);
  const parsed = retryErrorSchema.safeParse(body);
  const message = parsed.success
    ? retryErrorCopy[parsed.data.error] ?? "Classification retry failed."
    : "Classification retry failed. Refresh the desk and try again.";
  throw new Error(message);
}

export interface StreamHandlers {
  onHello?: (data: { now: number; runtimeId: string }) => void;
  onMention?: (m: Mention) => void;
  onResearchDisposition?: (change: AnalystResearchDispositionChange) => void;
  onCompany?: (s: CompanySnapshot) => void;
  onQuotes?: (s: MarketSnapshot) => void;
  onState?: (connected: boolean) => void;
}

/** EventSource with explicit event names; the browser reconnects natively. */
export function openStream(handlers: StreamHandlers): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", (e) => handlers.onHello?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("mention", (e) => handlers.onMention?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("research_review", (e) => handlers.onResearchDisposition?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("company", (e) => handlers.onCompany?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("quotes", (e) => handlers.onQuotes?.(JSON.parse((e as MessageEvent).data)));
  es.onopen = () => handlers.onState?.(true);
  es.onerror = () => handlers.onState?.(false);
  return () => es.close();
}
