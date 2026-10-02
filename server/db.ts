import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type {
  CollectorId,
  CategoricalClassification,
  CategoricalBucketCursor,
  CategoricalBucketEvidencePage,
  CategoricalTrendCounts,
  CategoricalTrendLineage,
  Company,
  EvidenceChannel,
  MentionDTO,
  MentionScore,
  MentionStatus,
  RawMention,
  RadarItemEvidence,
  SourceKind,
  SourceTier,
  TimeBasis,
  SecDocumentContext,
} from "./types.js";
import { deliveryHealthState, type DeliveryHealthState } from "./delivery.js";
import { researchPublisherDomain } from "./publisher-domain.js";

// Historical simulation and unverified legacy rows stay in place for audit,
// but only observations with an identified collector can enter live research
// or current operational usage totals.
const REAL_MENTION_FILTER = "collector NOT IN ('demo_simulation', 'legacy_unknown') AND COALESCE(engine, '') <> 'demo-sim'";
const CATEGORICAL_BUCKET_MS = 15 * 60_000;
const REAL_CATEGORICAL_FILTER = `m.collector NOT IN ('demo_simulation', 'legacy_unknown')
  AND COALESCE(m.engine, '') <> 'demo-sim'
  AND c.provider = 'openai_luna' AND c.model_requested = 'gpt-6-luna' AND c.model_returned = 'gpt-6-luna'
  AND c.prompt_version <> '' AND length(c.prompt_sha256) = 64 AND c.prompt_sha256 NOT GLOB '*[^0-9a-f]*'
  AND c.schema_version <> '' AND length(c.schema_sha256) = 64 AND c.schema_sha256 NOT GLOB '*[^0-9a-f]*'
  AND c.response_id <> '' AND length(c.response_sha256) = 64 AND c.response_sha256 NOT GLOB '*[^0-9a-f]*'
  AND typeof(c.input_tokens) = 'integer' AND c.input_tokens >= 0
  AND typeof(c.output_tokens) = 'integer' AND c.output_tokens >= 0
  AND typeof(c.total_tokens) = 'integer' AND c.total_tokens >= 0
  AND typeof(c.latency_ms) = 'integer' AND c.latency_ms >= 0
  AND c.disposition IN ('classified', 'review_required', 'excluded')
  AND (c.sentiment IS NULL OR c.sentiment IN ('positive', 'neutral', 'negative'))
  AND c.classified_at >= 0 AND c.classified_at <= ?
  AND m.delivery_id IS NOT NULL AND m.source_url GLOB 'https://*'
  AND m.retrieved_at <= c.classified_at AND o.adapter_version = d.adapter_version
  AND d.id = m.delivery_id AND d.collector = m.collector AND d.company_id = m.company_id
  AND d.result IN ('success', 'partial')`;
const CATEGORICAL_COUNTS_SQL = `
  COUNT(*) AS total,
  SUM(CASE WHEN c.disposition='classified' AND c.sentiment='positive' THEN 1 ELSE 0 END) AS positive,
  SUM(CASE WHEN c.disposition='classified' AND c.sentiment='neutral' THEN 1 ELSE 0 END) AS neutral,
  SUM(CASE WHEN c.disposition='classified' AND c.sentiment='negative' THEN 1 ELSE 0 END) AS negative,
  SUM(CASE WHEN c.disposition='review_required' OR (c.disposition='classified' AND c.sentiment IS NULL) THEN 1 ELSE 0 END) AS review_required,
  SUM(CASE WHEN c.disposition='excluded' THEN 1 ELSE 0 END) AS excluded`;

interface CategoricalSnapshotToken {
  companyId: string;
  fromMs: number;
  throughMs: number;
  windowHours: number;
  bucketMs: number;
  maxRowId: number;
}

interface CategoricalAggregateRow extends Record<string, number | null> {
  bucket_start_ms: number;
  total: number | null;
  positive: number | null;
  neutral: number | null;
  negative: number | null;
  review_required: number | null;
  excluded: number | null;
}

function categoricalCounts(row?: Partial<CategoricalAggregateRow> | null): CategoricalTrendCounts {
  const counts: CategoricalTrendCounts = {
    positive: Number(row?.positive ?? 0),
    neutral: Number(row?.neutral ?? 0),
    negative: Number(row?.negative ?? 0),
    reviewRequired: Number(row?.review_required ?? 0),
    excluded: Number(row?.excluded ?? 0),
    total: Number(row?.total ?? 0),
  };
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)
    || counts.positive + counts.neutral + counts.negative + counts.reviewRequired + counts.excluded !== counts.total) {
    throw new Error("Stored Luna category counts are inconsistent");
  }
  return counts;
}

const SEC_OUTCOMES = new Set(["success", "empty", "failed", "invalid", "rate_limited"]);
const SEC_REASONS = new Set(["primary_selected", "unique_exhibit_selected", "missing_exhibit", "ambiguous_exhibit", "invalid_exhibit_link", "primary_unavailable", "exhibit_unavailable", "unverified_event_link"]);
function serializeSecDocumentContext(value: SecDocumentContext): string {
  if (value.version !== "sec-document-context/1" || !/^\d{1,10}$/.test(value.cik) || !/^\d{10}-\d{2}-\d{6}$/.test(value.accessionNo)
    || !Number.isSafeInteger(value.acceptedAt) || (value.filedAt != null && !Number.isSafeInteger(value.filedAt))
    || !SEC_REASONS.has(value.selectionReason) || !["ready", "incomplete"].includes(value.classificationInputStatus)
    || (value.item202Link != null && (value.item202Link.kind === "linked"
      ? value.item202Link.itemCode !== "2.02" || value.item202Link.exhibitNumber !== "99.1" || value.item202Link.supportingText.length > 1500
      : value.item202Link.kind !== "unverified" || !["missing_item_body", "missing_results_attachment_reference", "different_results_exhibit", "ambiguous_results_reference", "conflicting_table_description"].includes(value.item202Link.reason)))
    || !Array.isArray(value.documents) || value.documents.length > 2) throw new Error("SEC document context is invalid");
  for (const doc of value.documents) {
    if (!["8k_primary", "earnings_exhibit_99_1"].includes(doc.role) || !SEC_OUTCOMES.has(doc.outcome)
      || typeof doc.url !== "string" || doc.url.length > 2048 || typeof doc.excerpt !== "string" || doc.excerpt.length > 3000
      || !Number.isSafeInteger(doc.startedAt) || !Number.isSafeInteger(doc.completedAt)
      || (doc.retrievedAt != null && !Number.isSafeInteger(doc.retrievedAt))
      || (doc.bodyBytes != null && (!Number.isSafeInteger(doc.bodyBytes) || doc.bodyBytes < 0))
      || (doc.bodySha256 != null && !/^[a-f0-9]{64}$/.test(doc.bodySha256))
      || (doc.errorCode != null && !/^(?:http_429|http_error|redirect_rejected|content_type|body_too_large|timeout|request_failed|invalid_primary_url)$/.test(doc.errorCode))) throw new Error("SEC document attempt is invalid");
  }
  if (value.documents.length < 1 || value.documents[0]?.role !== "8k_primary"
    || value.documents[0]?.url !== value.primaryUrl
    || (value.documents.length === 2 && value.documents[1]?.role !== "earnings_exhibit_99_1")) throw new Error("SEC document attempt order is invalid");
  const archiveDirectory = `https://www.sec.gov/Archives/edgar/data/${Number(value.cik)}/${value.accessionNo.replace(/-/g, "")}/`;
  for (const doc of value.documents) {
    if (doc.errorCode !== "invalid_primary_url" && (!doc.url.startsWith(archiveDirectory) || !/^[^/]+\.htm(?:l)?$/i.test(doc.url.slice(archiveDirectory.length)) || /[?#]/.test(doc.url))) {
      throw new Error("SEC document URL is outside the filing archive directory");
    }
    if (doc.completedAt < doc.startedAt || (doc.retrievedAt != null && (doc.retrievedAt < doc.startedAt || doc.retrievedAt > doc.completedAt))) {
      throw new Error("SEC document attempt clocks are inconsistent");
    }
  }
  const selected = value.documents.find((doc) => doc.role === value.selectedRole && doc.url === value.selectedUrl);
  if (value.classificationInputStatus === "ready") {
    if (!value.selectedRole || !value.selectedUrl || !selected || selected.outcome !== "success" || !selected.excerpt
      || selected.retrievedAt == null || selected.bodySha256 == null
      || (value.selectedRole === "earnings_exhibit_99_1" && value.item202Link?.kind !== "linked")) throw new Error("Ready SEC context lacks validated selected evidence");
  } else if (value.selectedRole != null || value.selectedUrl != null) throw new Error("Incomplete SEC context cannot select a document");
  if (value.selectionReason === "unverified_event_link" && value.item202Link?.kind !== "unverified") throw new Error("Unverified event link reason lacks its validation outcome");
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 64 * 1024) throw new Error("SEC document context exceeds 64 KiB");
  return json;
}
function parseSecDocumentContext(json: string | null | undefined): SecDocumentContext | null {
  if (json == null) return null;
  try { return JSON.parse(serializeSecDocumentContext(JSON.parse(json) as SecDocumentContext)) as SecDocumentContext; } catch { return null; }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Source observations, Jev judgments, and delivery attempts have separate
 * persistence. The mentions view is a read-only compatibility projection for
 * the existing API while callers move to the domain records.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  sector TEXT NOT NULL,
  aliases TEXT NOT NULL,
  color TEXT NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS source_observations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  identity_key TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  collector TEXT NOT NULL,
  channel TEXT NOT NULL,
  publisher_name TEXT NOT NULL,
  publisher_domain TEXT,
  source_item_id TEXT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  publisher_published_at INTEGER,
  provider_observed_at INTEGER,
  retrieved_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  time_basis TEXT NOT NULL,
  legacy_published_at INTEGER,
  filed_at INTEGER,
  scoped INTEGER NOT NULL DEFAULT 0,
  response_digest TEXT,
  adapter_version TEXT NOT NULL,
  delivery_id TEXT REFERENCES source_deliveries(id)
);
CREATE INDEX IF NOT EXISTS observations_company_source_time ON source_observations(company_id, publisher_published_at);
CREATE INDEX IF NOT EXISTS observations_company_observed_time ON source_observations(company_id, provider_observed_at);
CREATE INDEX IF NOT EXISTS observations_company_retrieved ON source_observations(company_id, retrieved_at);
CREATE UNIQUE INDEX IF NOT EXISTS observations_identity_revision ON source_observations(identity_key, revision_digest);
CREATE TRIGGER IF NOT EXISTS source_observations_no_update BEFORE UPDATE ON source_observations
BEGIN SELECT RAISE(ABORT, 'source observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_observations_no_delete BEFORE DELETE ON source_observations
BEGIN SELECT RAISE(ABORT, 'source observations are immutable'); END;
CREATE TABLE IF NOT EXISTS jev_judgments (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES source_observations(id),
  status TEXT NOT NULL DEFAULT 'pending',
  sentiment TEXT,
  confidence REAL,
  p_pos REAL,
  p_neu REAL,
  p_neg REAL,
  about REAL,
  material REAL,
  novel REAL,
  credible REAL,
  investor_relevant REAL,
  event_type TEXT,
  takeaway TEXT,
  magnitude REAL,
  surprise REAL,
  event_score REAL,
  impact REAL,
  weight REAL,
  exclude INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  rubric_sha TEXT,
  score_error TEXT,
  scored_at INTEGER,
  score_attempts INTEGER NOT NULL DEFAULT 0,
  score_retry_at INTEGER,
  score_usage_check_required INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS judgments_status ON jev_judgments(status);
CREATE INDEX IF NOT EXISTS judgments_status_scored_at ON jev_judgments(status, scored_at, observation_id);
CREATE TABLE IF NOT EXISTS source_deliveries (
  id TEXT PRIMARY KEY,
  collector TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  request_key_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  parsed_item_count INTEGER NOT NULL,
  response_digest TEXT,
  adapter_version TEXT NOT NULL,
  error TEXT,
  processing_required INTEGER NOT NULL DEFAULT 0 CHECK (processing_required IN (0, 1)),
  sec_document_context_json TEXT,
  CHECK (parsed_item_count >= 0),
  CHECK (result IN ('success', 'empty', 'partial', 'failed', 'rate_limited', 'invalid'))
);
CREATE INDEX IF NOT EXISTS deliveries_collector_completed ON source_deliveries(collector, completed_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_health_group_latest
  ON source_deliveries(collector, company_id, adapter_version, completed_at DESC, started_at DESC)
  WHERE collector NOT IN ('demo_simulation', 'legacy_unknown');
CREATE INDEX IF NOT EXISTS deliveries_health_recent_degraded
  ON source_deliveries(collector, completed_at DESC, started_at DESC)
  WHERE result IN ('failed', 'rate_limited', 'invalid', 'partial');
CREATE INDEX IF NOT EXISTS deliveries_summary_latest
  ON source_deliveries(completed_at DESC, started_at DESC)
  WHERE collector NOT IN ('demo_simulation', 'legacy_unknown');
CREATE TRIGGER IF NOT EXISTS source_deliveries_no_update BEFORE UPDATE ON source_deliveries
BEGIN SELECT RAISE(ABORT, 'source deliveries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_deliveries_no_delete BEFORE DELETE ON source_deliveries
BEGIN SELECT RAISE(ABORT, 'source deliveries are immutable'); END;
CREATE TABLE IF NOT EXISTS source_ingestions (
  delivery_id TEXT PRIMARY KEY REFERENCES source_deliveries(id),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('processing', 'success', 'partial', 'failed')),
  expected_count INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  CHECK (expected_count >= 0 AND processed_count >= 0 AND inserted_count >= 0),
  CHECK (processed_count <= expected_count AND inserted_count <= processed_count),
  CHECK ((status = 'processing' AND completed_at IS NULL) OR (status <> 'processing' AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS source_ingestions_status ON source_ingestions(status, started_at DESC);
CREATE TRIGGER IF NOT EXISTS source_ingestions_terminal_immutable BEFORE UPDATE ON source_ingestions
WHEN OLD.status <> 'processing' OR NEW.status = 'processing'
  OR NEW.delivery_id <> OLD.delivery_id OR NEW.started_at <> OLD.started_at
  OR NEW.expected_count <> OLD.expected_count
BEGIN SELECT RAISE(ABORT, 'source ingestion outcome is immutable once finalized'); END;
CREATE TRIGGER IF NOT EXISTS source_ingestions_no_delete BEFORE DELETE ON source_ingestions
BEGIN SELECT RAISE(ABORT, 'source ingestion outcomes are immutable'); END;
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_points (
  ticker TEXT NOT NULL,
  t INTEGER NOT NULL,
  price REAL NOT NULL,
  collector TEXT NOT NULL DEFAULT 'legacy_unknown',
  currency TEXT,
  retrieved_at INTEGER,
  adapter_version TEXT NOT NULL DEFAULT 'legacy-unknown',
  delivery_id TEXT REFERENCES source_deliveries(id),
  PRIMARY KEY (ticker, t)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jev_request_attempts (
 id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES source_observations(id), runtime_id TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
 request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64), request_bytes INTEGER NOT NULL CHECK (request_bytes > 0),
 requested_model TEXT NOT NULL, rubric_sha TEXT NOT NULL CHECK (length(rubric_sha) = 64), reserved_at INTEGER NOT NULL,
 provider TEXT NOT NULL DEFAULT 'typesafe', reserved_cost_micros INTEGER NOT NULL DEFAULT 0,
 requested_service_tier TEXT, max_daily_cost_micros INTEGER NOT NULL DEFAULT 0, max_output_tokens INTEGER NOT NULL DEFAULT 0, budget_day TEXT, schema_sha256 TEXT,
 UNIQUE(observation_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS jev_attempts_observation ON jev_request_attempts(observation_id, attempt_number DESC);
CREATE TABLE IF NOT EXISTS desk_runtime_sessions (
 id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS jev_attempt_events (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES jev_request_attempts(id), event_type TEXT NOT NULL
 CHECK (event_type IN ('dispatch_intent', 'response', 'rejected', 'unknown', 'not_sent')),
 occurred_at INTEGER NOT NULL, http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
 input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0), output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
 resolved_model TEXT, latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0), error_category TEXT,
 cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0), cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
 reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
 total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0), response_id TEXT, response_sha256 TEXT,
 estimated_cost_usd REAL, response_service_tier TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jev_attempt_dispatch_once ON jev_attempt_events(attempt_id) WHERE event_type = 'dispatch_intent';
CREATE UNIQUE INDEX IF NOT EXISTS jev_attempt_terminal_once ON jev_attempt_events(attempt_id) WHERE event_type IN ('response', 'rejected', 'unknown', 'not_sent');
CREATE TRIGGER IF NOT EXISTS jev_request_attempts_no_update BEFORE UPDATE ON jev_request_attempts BEGIN SELECT RAISE(ABORT, 'Jev request attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jev_request_attempts_no_delete BEFORE DELETE ON jev_request_attempts BEGIN SELECT RAISE(ABORT, 'Jev request attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jev_attempt_events_no_update BEFORE UPDATE ON jev_attempt_events BEGIN SELECT RAISE(ABORT, 'Jev request attempt events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jev_attempt_events_no_delete BEFORE DELETE ON jev_attempt_events BEGIN SELECT RAISE(ABORT, 'Jev request attempt events are immutable'); END;
CREATE TABLE IF NOT EXISTS categorical_classifications (
 observation_id TEXT PRIMARY KEY REFERENCES source_observations(id), provider TEXT NOT NULL CHECK(provider='openai_luna'),
 model_requested TEXT NOT NULL, model_returned TEXT NOT NULL, requested_service_tier TEXT NOT NULL, service_tier TEXT,
 prompt_version TEXT NOT NULL, prompt_sha256 TEXT NOT NULL CHECK(length(prompt_sha256)=64),
 schema_version TEXT NOT NULL, schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256)=64), sentiment TEXT,
 event_type TEXT, takeaway TEXT, about INTEGER, material INTEGER, investor_relevant INTEGER,
 evidence_sufficient INTEGER NOT NULL CHECK(evidence_sufficient IN (0,1)), summary TEXT, supporting_excerpt TEXT,
 disposition TEXT NOT NULL CHECK(disposition IN ('classified','excluded','review_required')),
 response_id TEXT NOT NULL, response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
 input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER NOT NULL,
 reasoning_tokens INTEGER, total_tokens INTEGER NOT NULL, estimated_cost_usd REAL,
 latency_ms INTEGER NOT NULL, classified_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS categorical_classifications_no_update BEFORE UPDATE ON categorical_classifications BEGIN SELECT RAISE(ABORT, 'Categorical classifications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS categorical_classifications_no_delete BEFORE DELETE ON categorical_classifications BEGIN SELECT RAISE(ABORT, 'Categorical classifications are immutable'); END;
CREATE TABLE IF NOT EXISTS alert_outbox (
 id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, rule_version TEXT NOT NULL, payload TEXT NOT NULL,
 policy TEXT NOT NULL, destination_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
 owner_token TEXT, lease_until INTEGER, last_error_category TEXT,
 UNIQUE(observation_id, rule_version)
);
CREATE INDEX IF NOT EXISTS alert_outbox_priority_created ON alert_outbox(
  (CASE state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 WHEN 'sending' THEN 1 WHEN 'retrying' THEN 1 WHEN 'paused' THEN 1 ELSE 2 END),
  created_at DESC, id DESC
);
CREATE INDEX IF NOT EXISTS alert_outbox_state ON alert_outbox(state);
CREATE TABLE IF NOT EXISTS alert_attempts (
 id TEXT PRIMARY KEY, alert_id TEXT NOT NULL, claimed_at INTEGER NOT NULL, lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_receipts (
 id TEXT PRIMARY KEY, alert_id TEXT NOT NULL, attempt_id TEXT NOT NULL, completed_at INTEGER NOT NULL,
 outcome TEXT NOT NULL, http_status INTEGER
);
CREATE TRIGGER IF NOT EXISTS alert_attempts_no_update BEFORE UPDATE ON alert_attempts BEGIN SELECT RAISE(ABORT, 'alert attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS alert_attempts_no_delete BEFORE DELETE ON alert_attempts BEGIN SELECT RAISE(ABORT, 'alert attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS alert_receipts_no_update BEFORE UPDATE ON alert_receipts BEGIN SELECT RAISE(ABORT, 'alert receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS alert_receipts_no_delete BEFORE DELETE ON alert_receipts BEGIN SELECT RAISE(ABORT, 'alert receipts are immutable'); END;
CREATE UNIQUE INDEX IF NOT EXISTS alert_receipts_attempt_once ON alert_receipts(attempt_id);
`;

const retryRowSchema = z.object({
  status: z.string(),
  score_usage_check_required: z.number(),
  score_attempts: z.number(),
});

export interface MentionPageCursor {
  orderAt: number;
  ingestedAt: number;
  id: string;
}

export interface ScoreBucketCursor {
  scoredAt: number;
  id: string;
}

export type MentionFeedFilter = "all" | "bull" | "bear" | "material" | "offtarget" | "failed";

export interface MentionRow {
  id: string;
  company_id: string;
  delivery_id: string | null;
  sec_document_context_json?: string | null;
  source_name: string;
  source_url: string;
  source_kind: string;
  source_tier: string;
  title: string;
  snippet: string;
  published_at: number | null;
  publisher_published_at: number | null;
  provider_observed_at: number | null;
  retrieved_at: number;
  ingested_at: number;
  time_basis: string;
  collector: string;
  publisher_name: string;
  publisher_domain: string | null;
  filed_at: number | null;
  status: string;
  sentiment: string | null;
  confidence: number | null;
  p_pos: number | null;
  p_neu: number | null;
  p_neg: number | null;
  about: number | null;
  material: number | null;
  novel: number | null;
  credible: number | null;
  scoped: number;
  investor_relevant: number | null;
  event_type: string | null;
  takeaway: string | null;
  magnitude: number | null;
  surprise: number | null;
  event_score: number | null;
  impact: number | null;
  weight: number | null;
  exclude: number;
  engine: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  rubric_sha: string | null;
  score_error: string | null;
  scored_at: number | null;
  score_attempts: number;
  score_retry_at: number | null;
  score_usage_check_required: number;
  classification_provider?: string | null;
  classification_model_requested?: string | null;
  classification_model_returned?: string | null;
  classification_service_tier_requested?: string | null;
  classification_service_tier?: string | null;
  classification_prompt_version?: string | null;
  classification_prompt_sha256?: string | null;
  classification_schema_version?: string | null;
  classification_schema_sha256?: string | null;
  classification_sentiment?: string | null;
  classification_event_type?: string | null;
  classification_takeaway?: string | null;
  classification_about?: number | null;
  classification_material?: number | null;
  classification_investor_relevant?: number | null;
  classification_evidence_sufficient?: number | null;
  classification_summary?: string | null;
  classification_supporting_excerpt?: string | null;
  classification_disposition?: CategoricalClassification["disposition"] | null;
  classification_response_id?: string | null;
  classification_response_sha256?: string | null;
  classification_input_tokens?: number | null;
  classification_cached_input_tokens?: number | null;
  classification_cache_write_tokens?: number | null;
  classification_output_tokens?: number | null;
  classification_reasoning_tokens?: number | null;
  classification_total_tokens?: number | null;
  classification_estimated_cost_usd?: number | null;
  classification_latency_ms?: number | null;
  classification_classified_at?: number | null;
}

export type BudgetedScoreClaim =
  | { kind: "claimed"; row: MentionRow; attemptId: string }
  | { kind: "budget_exhausted" }
  | { kind: "not_claimed" };

export type JevAttemptOutcome = "response" | "rejected" | "unknown" | "not_sent";
export type ModelProvider = "typesafe" | "openai_luna";
export interface JevAttemptReceipt {
  attemptId: string;
  outcome: JevAttemptOutcome;
  occurredAt: number;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  resolvedModel: string | null;
  latencyMs: number | null;
  errorCategory: string | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  responseId?: string | null;
  responseSha256?: string | null;
  estimatedCostUsd?: number | null;
  responseServiceTier?: string | null;
}
export interface JevAttemptSummary {
  attemptId: string;
  attemptNumber: number;
  requestSha256: string;
  requestBytes: number;
  requestedModel: string;
  rubricSha256: string;
  reservedAt: number;
  dispatchAt: number | null;
  outcome: "prepared" | "dispatch_intent" | JevAttemptOutcome;
  completedAt: number | null;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  resolvedModel: string | null;
  latencyMs: number | null;
  errorCategory: string | null;
  provider: ModelProvider;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  responseId: string | null;
  responseSha256: string | null;
  estimatedCostUsd: number | null;
  reservedCostMicros: number;
  reservedCostUsd: number;
  schemaSha256: string | null;
  requestedServiceTier: string | null;
  responseServiceTier: string | null;
}

export interface AlertIntent { observationId: string; ruleVersion: string; payload: string; policy: string; destinationFingerprint: string; createdAt: number; expiresAt: number; }
export interface AlertClaim { id: string; alertId: string; payload: string; attempt: number; expiresAt: number; token: string; }
export interface AlertDeliverySummary {
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
export interface AlertDeliveryCursor {
  priority: 0 | 1 | 2;
  createdAt: number;
  alertId: string;
}
export interface AlertDeliveryPage {
  items: AlertDeliverySummary[];
  nextCursor: AlertDeliveryCursor | null;
}
export interface AlertDeliveryCounts {
  pending: number;
  sending: number;
  retrying: number;
  failed: number;
  paused: number;
}

export interface SourceDeliveryInput {
  collector: CollectorId;
  companyId: string | null;
  requestKey: string;
  startedAt: number;
  completedAt: number;
  result: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid";
  parsedItemCount: number;
  responseDigest?: string | null;
  adapterVersion: string;
  error?: string | null;
  /** True when each fetched item must pass through its domain-specific processor. */
  processingRequired?: boolean;
  secDocumentContext?: SecDocumentContext | null;
}

export interface SourceIngestionOutcomeInput {
  status: "success" | "partial" | "failed";
  processedCount: number;
  insertedCount: number;
  completedAt?: number;
  error?: string | null;
}

export interface DeliverySourceSchedule {
  collector: CollectorId;
  enabled: boolean;
  intervalSeconds: number;
  targetCount: number;
  /** Restrict health and coverage to receipts for this source's primary feed. */
  healthAdapterVersions?: readonly string[];
  /** Ignore global auxiliary receipts when this row measures company coverage. */
  healthCompanyOnly?: boolean;
}

export class CategoricalSnapshotUnavailableError extends Error {
  constructor() { super("categorical_snapshot_unavailable"); }
}

export class InvalidCategoricalBucketError extends Error {
  constructor(message = "invalid_categorical_bucket") { super(message); }
}

export class Desk {
  private readonly db: DatabaseSync;
  private readonly runtimeId: string;
  private readonly categoricalSnapshotSecret = randomBytes(32);
  private closed = false;

  constructor(dbPath: string) {
    this.runtimeId = randomUUID();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.prepare("INSERT INTO desk_runtime_sessions(id, pid, started_at) VALUES (?, ?, ?)")
      .run(this.runtimeId, process.pid, Date.now());
    this.recoverUnfinishedJevAttempts();
    this.db.exec("PRAGMA user_version = 9");
  }

  /** Migrate the v1 combined table atomically, retaining it for audit/rollback. */
  private migrate(): void {
    const observationCols = new Set(
      (this.db.prepare("PRAGMA table_info(source_observations)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!observationCols.has("delivery_id")) {
      this.db.exec("ALTER TABLE source_observations ADD COLUMN delivery_id TEXT REFERENCES source_deliveries(id)");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS observations_delivery ON source_observations(delivery_id)");
    const deliveryCols = new Set(
      (this.db.prepare("PRAGMA table_info(source_deliveries)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!deliveryCols.has("processing_required")) {
      this.db.exec("ALTER TABLE source_deliveries ADD COLUMN processing_required INTEGER NOT NULL DEFAULT 0 CHECK (processing_required IN (0, 1))");
    }
    if (!deliveryCols.has("sec_document_context_json")) this.db.exec("ALTER TABLE source_deliveries ADD COLUMN sec_document_context_json TEXT");
    const jevAttemptCols = new Set(
      (this.db.prepare("PRAGMA table_info(jev_request_attempts)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!jevAttemptCols.has("runtime_id")) {
      this.db.exec("ALTER TABLE jev_request_attempts ADD COLUMN runtime_id TEXT NOT NULL DEFAULT 'legacy-runtime'");
      this.db.prepare("INSERT OR IGNORE INTO desk_runtime_sessions(id, pid, started_at, closed_at) VALUES ('legacy-runtime', 0, 0, 0)").run();
    }

    const attemptAdditions: Array<[string, string]> = [
      ["provider", "TEXT NOT NULL DEFAULT 'typesafe'"],
      ["reserved_cost_micros", "INTEGER NOT NULL DEFAULT 0"],
      ["requested_service_tier", "TEXT"], ["max_daily_cost_micros", "INTEGER NOT NULL DEFAULT 0"],
      ["max_output_tokens", "INTEGER NOT NULL DEFAULT 0"], ["budget_day", "TEXT"], ["schema_sha256", "TEXT"],
    ];
    for (const [name, ddl] of attemptAdditions) {
      if (!jevAttemptCols.has(name)) this.db.exec(`ALTER TABLE jev_request_attempts ADD COLUMN ${name} ${ddl}`);
    }
    const eventCols = new Set((this.db.prepare("PRAGMA table_info(jev_attempt_events)").all() as Array<{ name: string }>).map((r) => r.name));
    for (const [name, ddl] of [
      ["cached_input_tokens", "INTEGER"], ["cache_write_tokens", "INTEGER"], ["reasoning_tokens", "INTEGER"], ["total_tokens", "INTEGER"],
      ["response_id", "TEXT"], ["response_sha256", "TEXT"], ["estimated_cost_usd", "REAL"],
      ["response_service_tier", "TEXT"],
    ] as Array<[string, string]>) {
      if (!eventCols.has(name)) this.db.exec(`ALTER TABLE jev_attempt_events ADD COLUMN ${name} ${ddl}`);
    }
    const categoricalCols = new Set((this.db.prepare("PRAGMA table_info(categorical_classifications)").all() as Array<{ name: string }>).map((r) => r.name));
    for (const [name, ddl] of [["requested_service_tier", "TEXT NOT NULL DEFAULT 'default'"], ["service_tier", "TEXT"]] as Array<[string, string]>) {
      if (!categoricalCols.has(name)) this.db.exec(`ALTER TABLE categorical_classifications ADD COLUMN ${name} ${ddl}`);
    }

    const priceCols = new Set(
      (this.db.prepare("PRAGMA table_info(price_points)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    const priceAdditions: Array<[string, string]> = [
      ["collector", "TEXT NOT NULL DEFAULT 'legacy_unknown'"],
      ["currency", "TEXT"],
      ["retrieved_at", "INTEGER"],
      ["adapter_version", "TEXT NOT NULL DEFAULT 'legacy-unknown'"],
      ["delivery_id", "TEXT"],
    ];
    for (const [name, ddl] of priceAdditions) {
      if (!priceCols.has(name)) this.db.exec(`ALTER TABLE price_points ADD COLUMN ${name} ${ddl}`);
    }

    const companyCols = new Set(
      (this.db.prepare("PRAGMA table_info(companies)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    if (!companyCols.has("ambiguous")) {
      this.db.exec("ALTER TABLE companies ADD COLUMN ambiguous INTEGER NOT NULL DEFAULT 0");
    }

    const object = this.db.prepare("SELECT type FROM sqlite_master WHERE name = 'mentions'").get() as
      | { type: string }
      | undefined;
    if (object?.type === "table") {
      const mentionCols = new Set(
        (this.db.prepare("PRAGMA table_info(mentions)").all() as Array<{ name: string }>).map((r) => r.name),
      );
      const additions: Array<[string, string]> = [
        ["event_type", "TEXT"], ["magnitude", "REAL"], ["surprise", "REAL"],
        ["event_score", "REAL"], ["investor_relevant", "REAL"], ["takeaway", "TEXT"],
        ["scoped", "INTEGER NOT NULL DEFAULT 0"], ["filed_at", "INTEGER"],
      ];
      for (const [name, ddl] of additions) {
        if (!mentionCols.has(name)) this.db.exec(`ALTER TABLE mentions ADD COLUMN ${name} ${ddl}`);
      }

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE mentions RENAME TO mentions_legacy_v1");
        const legacy = this.db.prepare("SELECT * FROM mentions_legacy_v1 ORDER BY id").all() as unknown as Array<Record<string, unknown>>;
        const insertObservation = this.db.prepare(
          `INSERT INTO source_observations
           (id, company_id, identity_key, revision_digest, collector, channel, publisher_name,
            publisher_domain, source_item_id, source_name, source_url, source_kind, source_tier,
            title, snippet, publisher_published_at, provider_observed_at, retrieved_at, ingested_at,
            time_basis, legacy_published_at, filed_at, scoped, response_digest, adapter_version)
           VALUES (?, ?, ?, 'legacy-v1', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'legacy-v1')`,
        );
        const insertJudgment = this.db.prepare(
          `INSERT INTO jev_judgments
           (id, observation_id, status, sentiment, confidence, p_pos, p_neu, p_neg, about, material,
            novel, credible, investor_relevant, event_type, takeaway, magnitude, surprise, event_score,
            impact, weight, exclude, engine, input_tokens, output_tokens, cost_usd, latency_ms,
            rubric_sha, score_error, scored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const r of legacy) {
          const oldId = String(r.id);
          const sourceKind = String(r.source_kind);
          const isSec = sourceKind === "sec";
          const collector: CollectorId = isSec ? "sec_edgar" : sourceKind === "x" || sourceKind === "reddit" || sourceKind === "finnhub" ? sourceKind : "legacy_unknown";
          const channel: EvidenceChannel = isSec ? "filing" : sourceKind === "x" || sourceKind === "reddit" ? "social" : "news";
          const status = String(r.status);
          const scoreFields = ["sentiment", "confidence", "p_pos", "p_neu", "p_neg", "about", "material", "novel", "credible", "investor_relevant", "event_type", "takeaway", "magnitude", "surprise", "event_score", "impact", "weight", "engine", "input_tokens", "output_tokens", "cost_usd", "latency_ms", "rubric_sha", "scored_at"];
          const corrupt = (status === "scored" || status === "off_target") && scoreFields.some((field) => r[field] == null);
          const migratedStatus = corrupt ? "corrupt" : status;
          const publisherTime = isSec ? nullableNumber(r.published_at) : null;
          const oldTime = nullableNumber(r.published_at);
          const retrievedAt = finiteNumber(r.retrieved_at) ?? 0;
          const sourceUrl = String(r.source_url ?? "");
          insertObservation.run(
            oldId, String(r.company_id), `legacy:${oldId}`, collector, channel, String(r.source_name ?? "Unknown"),
            oldId, String(r.source_name ?? "Unknown"), sourceUrl, sourceKind, String(r.source_tier ?? "blog"),
            String(r.title ?? ""), String(r.snippet ?? ""), publisherTime, retrievedAt, retrievedAt,
            isSec && publisherTime != null ? "publisher_declared" : "legacy_unknown", isSec ? null : oldTime,
            nullableNumber(r.filed_at), r.scoped === 1 ? 1 : 0,
          );
          const judgmentValues: SQLInputValue[] = [
            oldId, oldId, migratedStatus, r.sentiment ?? null, r.confidence ?? null, r.p_pos ?? null,
            r.p_neu ?? null, r.p_neg ?? null, r.about ?? null, r.material ?? null, r.novel ?? null,
            r.credible ?? null, r.investor_relevant ?? null, r.event_type ?? null, r.takeaway ?? null,
            r.magnitude ?? null, r.surprise ?? null, r.event_score ?? null, r.impact ?? null, r.weight ?? null,
            r.exclude === 1 ? 1 : 0, r.engine ?? null, r.input_tokens ?? null, r.output_tokens ?? null,
            r.cost_usd ?? null, r.latency_ms ?? null, r.rubric_sha ?? null,
            corrupt ? "Legacy row claimed a score but did not contain every required Jev field." : r.score_error ?? null,
            r.scored_at ?? null,
          ].map(sqlValue);
          insertJudgment.run(...judgmentValues);
        }
        this.createMentionsView();
        this.db.exec("PRAGMA user_version = 9");
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      return;
    }
    const judgmentCols = new Set(
      (this.db.prepare("PRAGMA table_info(jev_judgments)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!judgmentCols.has("score_attempts")) {
        this.db.exec("ALTER TABLE jev_judgments ADD COLUMN score_attempts INTEGER NOT NULL DEFAULT 0");
      }
      if (!judgmentCols.has("score_retry_at")) {
        this.db.exec("ALTER TABLE jev_judgments ADD COLUMN score_retry_at INTEGER");
      }
      if (!judgmentCols.has("score_usage_check_required")) {
        this.db.exec("ALTER TABLE jev_judgments ADD COLUMN score_usage_check_required INTEGER NOT NULL DEFAULT 0");
      }
      if (object?.type === "view") this.db.exec("DROP VIEW mentions");
      this.createMentionsView();
      this.db.exec("PRAGMA user_version = 9");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private createMentionsView(): void {
    this.db.exec(`CREATE VIEW mentions AS
      SELECT o.id, o.company_id, o.source_name, o.source_url, o.source_kind, o.source_tier,
        o.title, o.snippet, o.publisher_published_at AS published_at, o.publisher_published_at,
        o.provider_observed_at, o.retrieved_at, o.ingested_at, o.time_basis, o.collector, o.delivery_id,
        o.publisher_name, o.publisher_domain, o.filed_at, o.scoped, d.sec_document_context_json AS sec_document_context_json,
        COALESCE(c.disposition, j.status) AS status, j.sentiment, j.confidence, j.p_pos, j.p_neu, j.p_neg, j.about, j.material,
        j.novel, j.credible, j.investor_relevant, j.event_type, j.takeaway, j.magnitude,
        j.surprise, j.event_score, j.impact, j.weight, j.exclude, j.engine, j.input_tokens,
        j.output_tokens, j.cost_usd, j.latency_ms, j.rubric_sha, j.score_error, j.scored_at,
        j.score_attempts, j.score_retry_at, j.score_usage_check_required,
        c.provider AS classification_provider, c.model_requested AS classification_model_requested,
        c.model_returned AS classification_model_returned, c.requested_service_tier AS classification_service_tier_requested,
        c.service_tier AS classification_service_tier, c.prompt_version AS classification_prompt_version,
        c.prompt_sha256 AS classification_prompt_sha256, c.schema_version AS classification_schema_version,
        c.schema_sha256 AS classification_schema_sha256, c.sentiment AS classification_sentiment,
        c.event_type AS classification_event_type, c.takeaway AS classification_takeaway,
        c.about AS classification_about, c.material AS classification_material,
        c.investor_relevant AS classification_investor_relevant, c.evidence_sufficient AS classification_evidence_sufficient,
        c.summary AS classification_summary, c.supporting_excerpt AS classification_supporting_excerpt,
        c.disposition AS classification_disposition, c.response_id AS classification_response_id,
        c.response_sha256 AS classification_response_sha256, c.input_tokens AS classification_input_tokens,
        c.cached_input_tokens AS classification_cached_input_tokens, c.output_tokens AS classification_output_tokens,
        c.cache_write_tokens AS classification_cache_write_tokens,
        c.reasoning_tokens AS classification_reasoning_tokens, c.total_tokens AS classification_total_tokens,
        c.estimated_cost_usd AS classification_estimated_cost_usd, c.latency_ms AS classification_latency_ms,
        c.classified_at AS classification_classified_at
      FROM source_observations o JOIN jev_judgments j ON j.observation_id = o.id
      LEFT JOIN source_deliveries d ON d.id = o.delivery_id
      LEFT JOIN categorical_classifications c ON c.observation_id = o.id`);
  }

  private recoverUnfinishedJevAttempts(): void {
    const unfinished = this.db.prepare(`SELECT a.id, a.observation_id, a.attempt_number, a.provider, a.budget_day, s.pid, s.closed_at,
        a.reserved_cost_micros, a.max_daily_cost_micros,
        EXISTS(SELECT 1 FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type = 'dispatch_intent') AS dispatch_started
      FROM jev_request_attempts a LEFT JOIN desk_runtime_sessions s ON s.id = a.runtime_id
      WHERE NOT EXISTS (SELECT 1 FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response', 'rejected', 'unknown', 'not_sent'))
      ORDER BY a.reserved_at`).all() as Array<{ id: string; observation_id: string; attempt_number: number; provider: ModelProvider;
        budget_day: string | null; reserved_cost_micros: number; max_daily_cost_micros: number; pid: number | null; closed_at: number | null; dispatch_started: number }>;
    const abandoned = unfinished.filter((attempt) => attempt.closed_at != null || !processIsAlive(attempt.pid ?? 0));
    const scoring = this.db.prepare(`SELECT j.observation_id, j.score_attempts, a.id AS attempt_id, a.runtime_id, s.pid, s.closed_at,
        (SELECT e.event_type FROM jev_attempt_events e WHERE e.attempt_id=a.id AND e.event_type IN ('response','rejected','unknown','not_sent') LIMIT 1) AS terminal_outcome,
        (SELECT e.event_type FROM jev_attempt_events e WHERE e.attempt_id=a.id AND e.event_type='dispatch_intent' LIMIT 1) AS dispatch_event
      FROM jev_judgments j
      LEFT JOIN jev_request_attempts a ON a.observation_id=j.observation_id AND a.attempt_number=j.score_attempts
      LEFT JOIN desk_runtime_sessions s ON s.id=a.runtime_id
      WHERE j.status='scoring'`).all() as Array<{
        observation_id: string; score_attempts: number; attempt_id: string | null; runtime_id: string | null;
        pid: number | null; closed_at: number | null; terminal_outcome: JevAttemptOutcome | null; dispatch_event: string | null;
      }>;
    const recoverableScoring = scoring.filter((row) => !row.attempt_id || row.closed_at != null || !processIsAlive(row.pid ?? 0));
    if (abandoned.length === 0 && recoverableScoring.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO jev_attempt_events
        (id, attempt_id, event_type, occurred_at, error_category) VALUES (?, ?, ?, ?, ?)`);
      const now = Date.now();
      for (const attempt of abandoned) {
        const wasDispatched = attempt.dispatch_started === 1;
        insert.run(randomUUID(), attempt.id, wasDispatched ? "unknown" : "not_sent", now,
          wasDispatched ? "interrupted_after_dispatch" : "interrupted_before_dispatch");
        if (wasDispatched && attempt.provider === "openai_luna" && attempt.budget_day) {
          this.db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
            .run(`openai:budget:${attempt.budget_day}:closed`);
        }
      }
      const fail = this.db.prepare(`UPDATE jev_judgments SET status='failed', score_retry_at=NULL,
        score_usage_check_required=?, score_error=? WHERE observation_id=? AND status='scoring' AND score_attempts=?`);
      for (const row of recoverableScoring) {
        const attempt = unfinished.find((candidate) => candidate.id === row.attempt_id);
        const outcome = row.terminal_outcome ?? (attempt ? attempt.dispatch_started === 1 ? "unknown" : "not_sent" : "unknown");
        if (outcome === "unknown" && attempt?.provider === "openai_luna" && attempt.budget_day) {
          this.db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
            .run(`openai:budget:${attempt.budget_day}:closed`);
        }
        const needsUsageReview = outcome === "response" || outcome === "unknown" ? 1 : 0;
        const errorMessage = outcome === "not_sent"
          ? "Scoring was interrupted before provider dispatch; no request was sent."
          : outcome === "rejected"
            ? "Provider rejected the request before returning a judgment."
            : outcome === "response"
              ? "Provider returned a judgment response, but local scoring did not finish. Review provider usage before retrying."
              : "Scoring was interrupted after dispatch; provider outcome is unknown. Review provider usage before retrying.";
        fail.run(needsUsageReview, errorMessage, row.observation_id, row.score_attempts);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  seedCompanies(companies: Company[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO companies (id, name, ticker, sector, aliases, color, ambiguous)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, ticker=excluded.ticker,
         sector=excluded.sector, aliases=excluded.aliases, color=excluded.color, ambiguous=excluded.ambiguous`,
    );
    for (const c of companies) {
      upsert.run(c.id, c.name, c.ticker, c.sector, JSON.stringify(c.aliases), c.color, c.ambiguous ? 1 : 0);
    }
  }

  companies(): Company[] {
    const rows = this.db.prepare("SELECT * FROM companies ORDER BY ticker").all() as Array<{
      id: string; name: string; ticker: string; sector: string; aliases: string; color: string; ambiguous: number;
    }>;
    return rows.map((r) => ({
      ...r,
      aliases: JSON.parse(r.aliases) as string[],
      ambiguous: r.ambiguous === 1,
    }));
  }

  /** Exact same-collector source revisions are idempotent; similar headlines survive. */
  insertObservation(m: RawMentionInput): { inserted: boolean; observationId: string } {
    const collector = m.collector ?? legacyCollectorFor(m.kind);
    if (collector === "demo_simulation") throw new Error("Synthetic mentions cannot be ingested by the application");
    if (collector === "legacy_unknown") throw new Error("Source collector provenance is required before ingesting an observation");
    const sourceItemId = m.sourceItemId ?? null;
    const identityMaterial = `${m.companyId}\u0000${collector}\u0000${sourceItemId ?? canonicalUrl(m.sourceUrl)}`;
    const identityKey = createHash("sha256").update(identityMaterial).digest("hex");
    const publisherName = m.publisherName ?? m.sourceName;
    const publisherDomain = m.publisherDomain === undefined ? domainOf(m.sourceUrl) : m.publisherDomain;
    const providerObservedAt = m.providerObservedAt ?? null;
    const publisherPublishedAt = m.publishedAt ?? null;
    const adapterVersion = m.adapterVersion ?? `${collector}/1`;
    const deliveryId = m.deliveryId ?? null;
    if (deliveryId != null) {
      const delivery = this.db.prepare(
        `SELECT collector, company_id, adapter_version, result, sec_document_context_json FROM source_deliveries WHERE id = ?`,
      ).get(deliveryId) as { collector: string; company_id: string | null; adapter_version: string; result: string; sec_document_context_json: string | null } | undefined;
      if (!delivery) throw new Error("Source observation references a missing delivery receipt");
      const secContext = parseSecDocumentContext(delivery.sec_document_context_json);
      if (delivery.sec_document_context_json != null && !secContext) throw new Error("SEC delivery context is invalid");
      if (secContext) {
        const selectedDoc = secContext.documents.find((doc) => doc.role === secContext.selectedRole && doc.url === secContext.selectedUrl);
        if (secContext.classificationInputStatus !== "ready" || secContext.accessionNo !== sourceItemId
          || secContext.selectedUrl !== m.sourceUrl || !selectedDoc || selectedDoc.outcome !== "success"
          || selectedDoc.excerpt !== m.snippet || selectedDoc.retrievedAt !== m.retrievedAt
          || selectedDoc.bodySha256 !== m.responseDigest
          || m.publishedAt !== secContext.acceptedAt || (m.filedAt ?? null) !== secContext.filedAt) {
          throw new Error("SEC observation does not match its selected filing document evidence");
        }
      }
      if (delivery.collector !== collector || delivery.company_id !== m.companyId || delivery.adapter_version !== adapterVersion) {
        throw new Error("Source observation does not match its delivery receipt");
      }
      if (!["success", "partial"].includes(delivery.result)) {
        throw new Error("Source observation cannot reference an unsuccessful delivery receipt");
      }
    }
    const stableRevision = JSON.stringify({
      title: m.title.trim(), snippet: m.snippet.trim(), url: canonicalUrl(m.sourceUrl),
      publisherPublishedAt, filedAt: m.filedAt ?? null,
    });
    const revisionDigest = createHash("sha256").update(stableRevision).digest("hex");
    const observationId = `${m.companyId}:${createHash("sha256").update(`${identityMaterial}\u0000${revisionDigest}`).digest("hex")}`;
    const timeBasis: TimeBasis = publisherPublishedAt != null
      ? "publisher_declared"
      : providerObservedAt != null ? "provider_observed" : "unknown";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = this.db.prepare(
        `INSERT OR IGNORE INTO source_observations
         (id, company_id, identity_key, revision_digest, collector, channel, publisher_name,
          publisher_domain, source_item_id, source_name, source_url, source_kind, source_tier,
          title, snippet, publisher_published_at, provider_observed_at, retrieved_at, ingested_at,
          time_basis, legacy_published_at, filed_at, scoped, response_digest, adapter_version, delivery_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(
        observationId, m.companyId, identityKey, revisionDigest, collector, channelFor(m.kind), publisherName,
        publisherDomain, sourceItemId, m.sourceName, m.sourceUrl, m.kind, m.tier, m.title, m.snippet,
        publisherPublishedAt, providerObservedAt, m.retrievedAt, Date.now(), timeBasis, m.filedAt ?? null,
        m.scoped ? 1 : 0, m.responseDigest ?? null, adapterVersion, deliveryId,
      );
      if (Number(res.changes) > 0) {
        this.db.prepare("INSERT INTO jev_judgments (id, observation_id, status) VALUES (?, ?, 'pending')")
          .run(observationId, observationId);
      }
      this.db.exec("COMMIT");
      return { inserted: Number(res.changes) > 0, observationId };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Compatibility wrapper for source adapter fixtures. */
  insertMention(m: RawMentionInput): boolean {
    return this.insertObservation(m).inserted;
  }

  mentionRow(id: string): MentionRow | undefined {
    return this.db.prepare(`SELECT * FROM mentions WHERE id = ? AND ${REAL_MENTION_FILTER}`).get(id) as MentionRow | undefined;
  }

  /** All-time eligible research history, using the same exclusion policy as the Desk APIs. */
  realObservationCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM mentions WHERE ${REAL_MENTION_FILTER}`).get() as { count: number };
    return Number(row.count);
  }

  markScored(id: string, s: MentionScore, exclude: boolean, alert?: AlertIntent, receipt?: JevAttemptReceipt): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
    this.db
      .prepare(
        `UPDATE jev_judgments SET
           status = ?, sentiment = ?, confidence = ?, p_pos = ?, p_neu = ?, p_neg = ?,
           about = ?, material = ?, novel = ?, credible = ?, investor_relevant = ?, event_type = ?, takeaway = ?, magnitude = ?,
           surprise = ?, event_score = ?, impact = ?, weight = ?,
           exclude = ?, engine = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
           latency_ms = ?, rubric_sha = ?, score_error = NULL, scored_at = ?, score_retry_at = NULL,
           score_usage_check_required = 0
         WHERE observation_id = ?`,
      )
      .run(
        exclude ? "off_target" : "scored",
        s.sentiment,
        s.confidence,
        s.pPos,
        s.pNeu,
        s.pNeg,
        s.about,
        s.material,
        s.novel,
        s.credible,
        s.investorRelevant,
        s.eventType,
        s.takeaway,
        s.magnitude,
        s.surprise,
        s.eventScore,
        s.impact,
        s.weight,
        exclude ? 1 : 0,
        s.engine,
        s.inputTokens,
        s.outputTokens,
        s.estimatedInputCostUsd,
        s.latencyMs,
        s.rubricSha,
        s.scoredAt,
        id,
      );
    if (receipt) this.appendJevAttemptReceipt(receipt);
    if (alert && !exclude) this.db.prepare(`INSERT OR IGNORE INTO alert_outbox
      (id, observation_id, rule_version, payload, policy, destination_fingerprint, created_at, expires_at, state, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(randomUUID(), alert.observationId, alert.ruleVersion, alert.payload, alert.policy, alert.destinationFingerprint,
        alert.createdAt, alert.expiresAt, alert.createdAt);
    this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  claimAlert(now: number, destinationFingerprint: string, leaseMs: number, maxAttempts: number): AlertClaim | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE alert_outbox SET state='paused', owner_token=NULL, lease_until=NULL WHERE destination_fingerprint<>? AND state IN ('pending','retrying')").run(destinationFingerprint);
      this.db.prepare("UPDATE alert_outbox SET state='pending', next_attempt_at=?, owner_token=NULL, lease_until=NULL WHERE destination_fingerprint=? AND state='paused'").run(now, destinationFingerprint);
      const abandoned = this.db.prepare(`SELECT a.id AS attempt_id, a.alert_id, o.expires_at
        FROM alert_attempts a JOIN alert_outbox o ON o.id=a.alert_id
        LEFT JOIN alert_receipts r ON r.attempt_id=a.id
        WHERE o.state='sending' AND a.lease_until<=? AND r.id IS NULL`).all(now) as Array<{
          attempt_id: string; alert_id: string; expires_at: number;
        }>;
      const recordAbandoned = this.db.prepare(`INSERT OR IGNORE INTO alert_receipts
        (id, alert_id, attempt_id, completed_at, outcome, http_status) VALUES (?, ?, ?, ?, ?, NULL)`);
      for (const attempt of abandoned) {
        recordAbandoned.run(randomUUID(), attempt.alert_id, attempt.attempt_id, now,
          now >= attempt.expires_at ? "expired" : "ambiguous");
      }
      this.db.prepare("UPDATE alert_outbox SET state='expired', owner_token=NULL, lease_until=NULL WHERE expires_at <= ? AND state IN ('pending','sending','retrying')").run(now);
      this.db.prepare(`UPDATE alert_outbox SET
        state=CASE WHEN attempts>=? THEN 'failed' ELSE 'retrying' END,
        owner_token=NULL, lease_until=NULL,
        next_attempt_at=CASE WHEN attempts>=? THEN next_attempt_at ELSE ? END
        WHERE state='sending' AND lease_until<=? AND expires_at>?`).run(maxAttempts, maxAttempts, now, now, now);
      const row = this.db.prepare(`SELECT * FROM alert_outbox WHERE destination_fingerprint=? AND state IN ('pending','retrying')
        AND next_attempt_at<=? AND expires_at>? AND attempts<? ORDER BY created_at LIMIT 1`).get(destinationFingerprint, now, now, maxAttempts) as any;
      if (!row) { this.db.exec("COMMIT"); return null; }
      const token = randomUUID(), attemptId = randomUUID(), leaseUntil = Math.min(now + leaseMs, row.expires_at);
      const upd = this.db.prepare(`UPDATE alert_outbox SET state='sending', attempts=attempts+1, owner_token=?, lease_until=? WHERE id=? AND state IN ('pending','retrying')`).run(token, leaseUntil, row.id);
      if (!Number(upd.changes)) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("INSERT INTO alert_attempts(id, alert_id, claimed_at, lease_until) VALUES (?, ?, ?, ?)").run(attemptId, row.id, now, leaseUntil);
      this.db.exec("COMMIT"); return { id: attemptId, alertId: row.id, payload: row.payload, attempt: row.attempts + 1, expiresAt: row.expires_at, token };
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  nextAlertDispatchAt(now: number, destinationFingerprint: string, maxAttempts: number): number | null {
    const row = this.db.prepare(`SELECT MIN(
        CASE WHEN state='sending'
          THEN MIN(COALESCE(lease_until, next_attempt_at), expires_at)
          ELSE MIN(next_attempt_at, expires_at)
        END
      ) AS due_at
      FROM alert_outbox
      WHERE destination_fingerprint=? AND expires_at>?
        AND (state='sending' OR (state IN ('pending','retrying') AND attempts<?))`)
      .get(destinationFingerprint, now, maxAttempts) as { due_at: number | null };
    return row.due_at == null ? null : Number(row.due_at);
  }
  alertClaimValid(claim: AlertClaim, now: number): boolean {
    const row = this.db.prepare("SELECT state, owner_token, expires_at, lease_until FROM alert_outbox WHERE id=?").get(claim.alertId) as any;
    return !!row && row.state === 'sending' && row.owner_token === claim.token && row.expires_at > now && row.lease_until > now;
  }

  completeAlert(claim: AlertClaim, outcome: 'delivered'|'retry'|'failed'|'ambiguous'|'expired', now: number, httpStatus: number|null, errorCategory: string|null, retryAt: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state, owner_token, expires_at, attempts FROM alert_outbox WHERE id=?").get(claim.alertId) as any;
      if (!row || row.state !== 'sending' || row.owner_token !== claim.token) { this.db.exec("COMMIT"); return false; }
      const final = now >= row.expires_at ? 'expired' : outcome === 'delivered' ? 'delivered' : (outcome === 'retry' || outcome === 'ambiguous') && row.attempts < 5 ? 'retrying' : 'failed';
      this.db.prepare("INSERT INTO alert_receipts(id, alert_id, attempt_id, completed_at, outcome, http_status) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), claim.alertId, claim.id, now, now >= row.expires_at ? 'expired' : outcome, httpStatus);
      this.db.prepare("UPDATE alert_outbox SET state=?, owner_token=NULL, lease_until=NULL, next_attempt_at=?, last_error_category=? WHERE id=? AND owner_token=?")
        .run(final, retryAt, errorCategory, claim.alertId, claim.token);
      this.db.exec("COMMIT"); return true;
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  alertDeliverySummary(limit = 10): AlertDeliverySummary[] {
    return this.alertDeliveryPage(limit).items;
  }

  alertDeliveryPage(limit = 10, cursor?: AlertDeliveryCursor | null): AlertDeliveryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("alert delivery history limit must be between 1 and 20");
    const priority = "CASE o.state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 WHEN 'sending' THEN 1 WHEN 'retrying' THEN 1 WHEN 'paused' THEN 1 ELSE 2 END";
    const cursorClause = cursor ? `WHERE (${priority}) > ? OR ((${priority}) = ? AND
      (o.created_at < ? OR (o.created_at = ? AND o.id < ?)))` : "";
    const cursorValues = cursor ? [cursor.priority, cursor.priority, cursor.createdAt, cursor.createdAt, cursor.alertId] : [];
    const rows = this.db.prepare(`SELECT o.id AS alert_id, (${priority}) AS priority, o.created_at AS cursor_created_at,
        o.observation_id, m.company_id, c.ticker, m.title, o.state, o.attempts,
        o.created_at, o.expires_at, o.next_attempt_at, o.last_error_category,
        (SELECT r.outcome FROM alert_receipts r WHERE r.alert_id=o.id ORDER BY r.completed_at DESC, r.id DESC LIMIT 1) AS last_outcome,
        (SELECT r.http_status FROM alert_receipts r WHERE r.alert_id=o.id ORDER BY r.completed_at DESC, r.id DESC LIMIT 1) AS last_http_status,
        (SELECT r.completed_at FROM alert_receipts r WHERE r.alert_id=o.id ORDER BY r.completed_at DESC, r.id DESC LIMIT 1) AS last_attempt_at
      FROM alert_outbox o JOIN mentions m ON m.id=o.observation_id JOIN companies c ON c.id=m.company_id
      ${cursorClause}
      ORDER BY (${priority}), o.created_at DESC, o.id DESC LIMIT ?`).all(...cursorValues, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const items = visibleRows.map((row) => ({
      alertId: String(row.alert_id),
      observationId: String(row.observation_id), companyId: String(row.company_id), ticker: String(row.ticker), title: String(row.title),
      state: String(row.state) as AlertDeliverySummary["state"], attemptCount: Number(row.attempts), createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at), nextAttemptAt: Number(row.next_attempt_at),
      lastOutcome: row.last_outcome == null ? null : String(row.last_outcome) as NonNullable<AlertDeliverySummary["lastOutcome"]>,
      lastHttpStatus: row.last_http_status == null ? null : Number(row.last_http_status),
      lastAttemptAt: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
      lastErrorCategory: row.last_error_category == null ? null : String(row.last_error_category),
    }));
    const last = visibleRows.at(-1);
    const nextCursor = hasMore && last ? {
      priority: Number(last.priority) as AlertDeliveryCursor["priority"],
      createdAt: Number(last.cursor_created_at),
      alertId: String(last.alert_id),
    } : null;
    return { items, nextCursor };
  }

  alertDeliveryCounts(): AlertDeliveryCounts {
    const rows = this.db.prepare(`SELECT state, COUNT(*) AS count FROM alert_outbox
      WHERE state IN ('pending','sending','retrying','failed','paused') GROUP BY state`).all() as Array<{ state: string; count: number }>;
    const counts: AlertDeliveryCounts = { pending: 0, sending: 0, retrying: 0, failed: 0, paused: 0 };
    for (const row of rows) if (Object.hasOwn(counts, row.state)) counts[row.state as keyof AlertDeliveryCounts] = Number(row.count);
    return counts;
  }

  markFailed(id: string, error: string, usageCheckRequired: boolean): void {
    this.db
      .prepare("UPDATE jev_judgments SET status = 'failed', score_error = ?, score_retry_at = NULL, score_usage_check_required = ? WHERE observation_id = ? AND status IN ('pending', 'scoring')")
      .run(error.slice(0, 500), usageCheckRequired ? 1 : 0, id);
  }

  markRetrying(id: string, error: string, retryAt: number): void {
    this.db.prepare(
      "UPDATE jev_judgments SET status = 'retrying', score_error = ?, score_retry_at = ?, score_usage_check_required = 0 WHERE observation_id = ? AND status = 'scoring'",
    ).run(error.slice(0, 500), retryAt, id);
  }

  requeueFailed(id: string, reviewedProviderUsage: boolean): "queued" | "usage_review_required" | "not_retryable" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = retryRowSchema.safeParse(this.db.prepare(
        `SELECT status, score_usage_check_required, score_attempts FROM mentions
         WHERE id = ? AND ${REAL_MENTION_FILTER}`,
      ).get(id));
      if (!row.success || row.data.status !== "failed") {
        this.db.exec("COMMIT");
        return "not_retryable";
      }
      const usageReviewRequired = row.data.score_usage_check_required === 1 || row.data.score_attempts > 0;
      if (usageReviewRequired && !reviewedProviderUsage) {
        this.db.exec("COMMIT");
        return "usage_review_required";
      }
      const result = this.db.prepare(
        `UPDATE jev_judgments SET status = 'pending', score_error = NULL,
           score_retry_at = NULL, score_usage_check_required = 0
         WHERE observation_id = ? AND status = 'failed'
           AND observation_id IN (SELECT id FROM mentions WHERE ${REAL_MENTION_FILTER})`,
      ).run(id);
      this.db.exec("COMMIT");
      return Number(result.changes) === 1 ? "queued" : "not_retryable";
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  claimForScoring(id: string, now: number): MentionRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        `UPDATE jev_judgments SET status = 'scoring', score_attempts = score_attempts + 1,
           score_retry_at = NULL, score_error = NULL, score_usage_check_required = 0
         WHERE observation_id = ? AND observation_id IN (
           SELECT id FROM mentions WHERE ${REAL_MENTION_FILTER}
         ) AND (status = 'pending' OR (status = 'retrying' AND score_retry_at <= ?))`,
      ).run(id, now);
      const row = Number(result.changes) === 1
        ? this.db.prepare(`SELECT * FROM mentions WHERE id = ? AND ${REAL_MENTION_FILTER}`).get(id) as MentionRow | undefined
        : undefined;
      this.db.exec("COMMIT");
      return row;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  claimForScoringWithBudget(input: {
    id: string;
    now: number;
    allowedCollectors: readonly CollectorId[];
    utcDay: string;
    requestBytes: number;
    requestSha256: string;
    requestedModel: string;
    rubricSha256: string;
    maxRequests: number;
    maxRequestBytes: number;
    provider?: ModelProvider;
    maxDailyCostMicros?: number;
    reservedCostMicros?: number;
    requestedServiceTier?: "default";
    maxOutputTokens?: number;
    schemaSha256?: string;
  }): BudgetedScoreClaim {
    const provider = input.provider ?? "typesafe";
    if (input.allowedCollectors.length === 0) return { kind: "not_claimed" };
    if (!/^[a-f0-9]{64}$/.test(input.requestSha256) || !/^[a-f0-9]{64}$/.test(input.rubricSha256) || !input.requestedModel.trim()) {
      throw new Error("valid Jev request digest, rubric digest, and requested model are required for a scoring claim");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.utcDay) ||
      !Number.isSafeInteger(input.requestBytes) || input.requestBytes <= 0 ||
      !Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0 ||
      !Number.isSafeInteger(input.maxRequestBytes) || input.maxRequestBytes <= 0 ||
      (provider === "openai_luna" && (!Number.isSafeInteger(input.maxDailyCostMicros) || input.maxDailyCostMicros! <= 0 ||
        !Number.isSafeInteger(input.reservedCostMicros) || input.reservedCostMicros! <= 0 ||
        input.requestedServiceTier !== "default" || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens! <= 0 ||
        !/^[a-f0-9]{64}$/.test(input.schemaSha256 ?? "")))
    ) return { kind: "budget_exhausted" };

    const collectorSlots = input.allowedCollectors.map(() => "?").join(", ");
    const budgetPrefix = provider === "openai_luna" ? "openai:budget" : "jev:budget";
    const requestKey = `${budgetPrefix}:${input.utcDay}:requests`;
    const bytesKey = `${budgetPrefix}:${input.utcDay}:request-bytes`;
    const costKey = `${budgetPrefix}:${input.utcDay}:cost-micros`;
    const closedKey = `${budgetPrefix}:${input.utcDay}:closed`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db.prepare(`SELECT id FROM mentions
        WHERE id = ? AND ${REAL_MENTION_FILTER}
          AND collector IN (${collectorSlots})
          AND (status = 'pending' OR (status = 'retrying' AND score_retry_at <= ?))`)
        .get(input.id, ...input.allowedCollectors, input.now);
      if (!candidate) {
        this.db.exec("COMMIT");
        return { kind: "not_claimed" };
      }
      const closed = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(closedKey) as
        | { value: string }
        | undefined;
      if (closed && closed.value !== "0") {
        this.db.exec("COMMIT");
        return { kind: "budget_exhausted" };
      }

      const readCounter = (key: string): number | null => {
        const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
          | { value: string }
          | undefined;
        if (!row) return 0;
        const value = Number(row.value);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      };
      const requests = readCounter(requestKey);
      const requestBytes = readCounter(bytesKey);
      if (requests == null || requestBytes == null || requests + 1 > input.maxRequests) {
        this.db.exec("COMMIT");
        return { kind: "budget_exhausted" };
      }
      if (requestBytes + input.requestBytes > input.maxRequestBytes) {
        this.db.prepare(
          "INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
        ).run(closedKey);
        this.db.exec("COMMIT");
        return { kind: "budget_exhausted" };
      }
      const writeCounter = this.db.prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      let costMicros = 0;
      if (provider === "openai_luna") {
        const usedCost = readCounter(costKey);
        costMicros = input.reservedCostMicros!;
        if (usedCost == null || usedCost + costMicros > input.maxDailyCostMicros!) {
          this.db.exec("COMMIT");
          return { kind: "budget_exhausted" };
        }
        writeCounter.run(costKey, String(usedCost + costMicros));
      }
      writeCounter.run(requestKey, String(requests + 1));
      writeCounter.run(bytesKey, String(requestBytes + input.requestBytes));
      const result = this.db.prepare(`UPDATE jev_judgments SET status = 'scoring',
          score_attempts = score_attempts + 1, score_retry_at = NULL, score_error = NULL,
          score_usage_check_required = 0
        WHERE observation_id = ? AND observation_id IN (
          SELECT id FROM mentions WHERE ${REAL_MENTION_FILTER}
            AND collector IN (${collectorSlots})
        ) AND (status = 'pending' OR (status = 'retrying' AND score_retry_at <= ?))`)
        .run(input.id, ...input.allowedCollectors, input.now);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return { kind: "not_claimed" };
      }
      const row = this.db.prepare(`SELECT * FROM mentions WHERE id = ? AND ${REAL_MENTION_FILTER}`)
        .get(input.id) as MentionRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return { kind: "not_claimed" };
      }
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO jev_request_attempts
        (id, observation_id, runtime_id, attempt_number, request_sha256, request_bytes, requested_model, rubric_sha, reserved_at, provider, reserved_cost_micros,
         requested_service_tier, max_daily_cost_micros, max_output_tokens, budget_day, schema_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attemptId, input.id, this.runtimeId, row.score_attempts, input.requestSha256, input.requestBytes, input.requestedModel.trim(), input.rubricSha256, input.now, provider, costMicros,
          input.requestedServiceTier ?? null, input.maxDailyCostMicros ?? 0, input.maxOutputTokens ?? 0, input.utcDay, input.schemaSha256 ?? null);
      this.db.exec("COMMIT");
      return { kind: "claimed", row, attemptId };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recordJevDispatchIntent(attemptId: string, occurredAt: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.db.prepare(`SELECT a.observation_id, a.attempt_number, j.status, j.score_attempts
        FROM jev_request_attempts a JOIN jev_judgments j ON j.observation_id = a.observation_id WHERE a.id = ?`).get(attemptId) as
        | { observation_id: string; attempt_number: number; status: string; score_attempts: number }
        | undefined;
      if (!attempt || attempt.status !== "scoring" || attempt.attempt_number !== attempt.score_attempts) {
        this.db.exec("COMMIT");
        return false;
      }
      const alreadyStarted = this.db.prepare("SELECT 1 FROM jev_attempt_events WHERE attempt_id = ? AND event_type = 'dispatch_intent'").get(attemptId);
      const alreadyFinished = this.db.prepare("SELECT 1 FROM jev_attempt_events WHERE attempt_id = ? AND event_type IN ('response','rejected','unknown','not_sent')").get(attemptId);
      if (alreadyStarted || alreadyFinished) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db.prepare("INSERT INTO jev_attempt_events(id, attempt_id, event_type, occurred_at) VALUES (?, ?, 'dispatch_intent', ?)")
        .run(randomUUID(), attemptId, occurredAt);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recordJevAttemptReceipt(receipt: JevAttemptReceipt): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.appendJevAttemptReceipt(receipt);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private appendJevAttemptReceipt(receipt: JevAttemptReceipt): void {
    const attempt = this.db.prepare(`SELECT provider, reserved_cost_micros, budget_day, max_daily_cost_micros,
      max_output_tokens, request_bytes, requested_service_tier FROM jev_request_attempts WHERE id=?`).get(receipt.attemptId) as
      | { provider: ModelProvider; reserved_cost_micros: number; budget_day: string | null; max_daily_cost_micros: number;
          max_output_tokens: number; request_bytes: number; requested_service_tier: string | null }
      | undefined;
    if (!attempt) throw new Error("Jev attempt receipt has no matching request attempt");
    const dispatched = this.db.prepare("SELECT 1 FROM jev_attempt_events WHERE attempt_id = ? AND event_type = 'dispatch_intent'").get(receipt.attemptId);
    if (receipt.outcome === "not_sent" ? Boolean(dispatched) : !dispatched) {
      throw new Error("Jev attempt receipt does not match its dispatch-intent state");
    }
    this.db.prepare(`INSERT INTO jev_attempt_events
      (id, attempt_id, event_type, occurred_at, http_status, input_tokens, output_tokens, resolved_model, latency_ms, error_category,
       cached_input_tokens, cache_write_tokens, reasoning_tokens, total_tokens, response_id, response_sha256, estimated_cost_usd, response_service_tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), receipt.attemptId, receipt.outcome, receipt.occurredAt, receipt.httpStatus,
        receipt.inputTokens, receipt.outputTokens, receipt.resolvedModel, receipt.latencyMs, receipt.errorCategory,
        receipt.cachedInputTokens ?? null, receipt.cacheWriteInputTokens ?? null, receipt.reasoningTokens ?? null, receipt.totalTokens ?? null,
        receipt.responseId ?? null, receipt.responseSha256 ?? null, receipt.estimatedCostUsd ?? null, receipt.responseServiceTier ?? null);
    if (attempt.provider === "openai_luna" && attempt.budget_day) {
      const prefix = `openai:budget:${attempt.budget_day}`;
      const costKey = `${prefix}:cost-micros`;
      const reserved = Number(attempt.reserved_cost_micros);
      const current = Number(this.getKv(costKey) ?? "0");
      const knownCostMicros = receipt.estimatedCostUsd == null ? null : Math.ceil(receipt.estimatedCostUsd * 1_000_000);
      if (!Number.isSafeInteger(current) || current < reserved || !Number.isSafeInteger(reserved) || reserved < 0) {
        this.db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").run(`${prefix}:closed`);
      } else if (knownCostMicros != null) {
        const adjusted = receipt.outcome === "unknown"
          ? current + Math.max(0, knownCostMicros - reserved)
          : current - reserved + knownCostMicros;
        this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(costKey, String(adjusted));
        const outsideReservation = knownCostMicros > reserved || receipt.outcome === "response" &&
          ((receipt.inputTokens ?? Number.MAX_SAFE_INTEGER) > attempt.request_bytes ||
           (receipt.outputTokens ?? Number.MAX_SAFE_INTEGER) > attempt.max_output_tokens ||
           receipt.resolvedModel !== "gpt-6-luna" || receipt.responseServiceTier !== attempt.requested_service_tier);
        if (adjusted > attempt.max_daily_cost_micros || outsideReservation) {
          this.db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").run(`${prefix}:closed`);
        }
      } else if (receipt.outcome === "unknown" ||
        (receipt.outcome === "response" && ((receipt.inputTokens ?? Number.MAX_SAFE_INTEGER) > attempt.request_bytes ||
          (receipt.outputTokens ?? Number.MAX_SAFE_INTEGER) > attempt.max_output_tokens ||
          receipt.resolvedModel !== "gpt-6-luna" || receipt.responseServiceTier !== attempt.requested_service_tier))) {
        this.db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").run(`${prefix}:closed`);
      }
    }
  }

  recordCategoricalClassification(observationId: string, classification: CategoricalClassification, receipt: JevAttemptReceipt): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.appendJevAttemptReceipt(receipt);
      this.db.prepare(`INSERT INTO categorical_classifications
        (observation_id, provider, model_requested, model_returned, requested_service_tier, service_tier, prompt_version, prompt_sha256,
         schema_version, schema_sha256, sentiment, event_type, takeaway, about, material, investor_relevant,
         evidence_sufficient, summary, supporting_excerpt, disposition, response_id, response_sha256,
         input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, estimated_cost_usd, latency_ms, classified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(observationId, classification.provider, classification.modelRequested, classification.modelReturned,
          classification.serviceTierRequested, classification.serviceTier, classification.promptVersion, classification.promptSha256, classification.schemaVersion, classification.schemaSha256,
          classification.sentiment, classification.eventType, classification.takeaway,
          classification.about == null ? null : classification.about ? 1 : 0,
          classification.material == null ? null : classification.material ? 1 : 0,
          classification.investorRelevant == null ? null : classification.investorRelevant ? 1 : 0,
          classification.evidenceSufficient ? 1 : 0, classification.summary, classification.supportingExcerpt,
          classification.disposition, classification.responseId, classification.responseSha256, classification.inputTokens,
          classification.cachedInputTokens, classification.cacheWriteInputTokens, classification.outputTokens, classification.reasoningTokens,
          classification.totalTokens, classification.estimatedCostUsd, classification.latencyMs, classification.classifiedAt);
      const update = this.db.prepare("UPDATE jev_judgments SET status = ?, score_error = NULL, score_retry_at = NULL, score_usage_check_required = 0 WHERE observation_id = ? AND status = 'scoring'")
        .run(classification.disposition, observationId);
      if (Number(update.changes) !== 1) throw new Error("Categorical classification did not own the active judgment claim");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  jevAttemptHistory(observationId: string, limit = 10): JevAttemptSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Jev attempt history limit must be between 1 and 20");
    const rows = this.db.prepare(`SELECT a.id AS attempt_id, a.attempt_number, a.request_sha256, a.request_bytes,
        a.requested_model, a.rubric_sha, a.reserved_at,
        (SELECT occurred_at FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type = 'dispatch_intent') AS dispatch_at,
        COALESCE((SELECT event_type FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')),
          CASE WHEN EXISTS (SELECT 1 FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type = 'dispatch_intent') THEN 'dispatch_intent' ELSE 'prepared' END) AS outcome,
        (SELECT occurred_at FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS completed_at,
        (SELECT http_status FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS http_status,
        (SELECT input_tokens FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS input_tokens,
        (SELECT output_tokens FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS output_tokens,
        (SELECT resolved_model FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS resolved_model,
        (SELECT latency_ms FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS latency_ms,
        (SELECT error_category FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS error_category,
        a.provider, a.reserved_cost_micros,
        a.schema_sha256 AS schema_sha256,
        (SELECT cached_input_tokens FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS cached_input_tokens,
        (SELECT cache_write_tokens FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS cache_write_tokens,
        (SELECT reasoning_tokens FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS reasoning_tokens,
        (SELECT total_tokens FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS total_tokens,
        (SELECT response_id FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS response_id,
        (SELECT response_sha256 FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS response_sha256,
        (SELECT estimated_cost_usd FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS estimated_cost_usd
        , a.requested_service_tier AS requested_service_tier,
        (SELECT response_service_tier FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS response_service_tier
      FROM jev_request_attempts a WHERE a.observation_id = ? ORDER BY a.attempt_number DESC LIMIT ?`).all(observationId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      attemptId: String(row.attempt_id), attemptNumber: Number(row.attempt_number), requestSha256: String(row.request_sha256),
      requestBytes: Number(row.request_bytes), requestedModel: String(row.requested_model), rubricSha256: String(row.rubric_sha),
      reservedAt: Number(row.reserved_at), dispatchAt: row.dispatch_at == null ? null : Number(row.dispatch_at),
      outcome: String(row.outcome) as JevAttemptSummary["outcome"], completedAt: row.completed_at == null ? null : Number(row.completed_at),
      httpStatus: row.http_status == null ? null : Number(row.http_status), inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? null : Number(row.output_tokens), resolvedModel: row.resolved_model == null ? null : String(row.resolved_model),
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms), errorCategory: row.error_category == null ? null : String(row.error_category),
      provider: row.provider === "openai_luna" ? "openai_luna" : "typesafe",
      reservedCostMicros: Number(row.reserved_cost_micros ?? 0),
      reservedCostUsd: Number(row.reserved_cost_micros ?? 0) / 1_000_000,
      schemaSha256: row.schema_sha256 == null ? null : String(row.schema_sha256),
      cachedInputTokens: row.cached_input_tokens == null ? null : Number(row.cached_input_tokens),
      cacheWriteInputTokens: row.cache_write_tokens == null ? null : Number(row.cache_write_tokens),
      reasoningTokens: row.reasoning_tokens == null ? null : Number(row.reasoning_tokens),
      totalTokens: row.total_tokens == null ? null : Number(row.total_tokens),
      responseId: row.response_id == null ? null : String(row.response_id),
      responseSha256: row.response_sha256 == null ? null : String(row.response_sha256),
      estimatedCostUsd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
      requestedServiceTier: row.requested_service_tier == null ? null : String(row.requested_service_tier),
      responseServiceTier: row.response_service_tier == null ? null : String(row.response_service_tier),
    }));
  }

  recordDelivery(delivery: SourceDeliveryInput): string {
    if (delivery.collector === "demo_simulation") throw new Error("Synthetic deliveries cannot be recorded by the application");
    if (delivery.collector === "legacy_unknown") throw new Error("Source collector provenance is required before recording a delivery");
    if (delivery.secDocumentContext != null && delivery.collector !== "sec_edgar") throw new Error("SEC document context can only be stored on SEC deliveries");
    const secContextJson = delivery.secDocumentContext == null ? null : serializeSecDocumentContext(delivery.secDocumentContext);
    const id = randomUUID();
    this.db.prepare(
      `INSERT OR IGNORE INTO source_deliveries
       (id, collector, company_id, request_key_hash, started_at, completed_at, result,
        parsed_item_count, response_digest, adapter_version, error, processing_required, sec_document_context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, delivery.collector, delivery.companyId,
      createHash("sha256").update(delivery.requestKey).digest("hex"), delivery.startedAt,
      delivery.completedAt, delivery.result, delivery.parsedItemCount,
      delivery.responseDigest ?? null, delivery.adapterVersion,
      delivery.error ? delivery.error.slice(0, 500) : null, delivery.processingRequired ? 1 : 0, secContextJson,
    );
    return id;
  }

  /** Read the immutable SEC context attached to one delivery receipt. */
  secDeliveryContext(deliveryId: string): SecDocumentContext | null {
    const row = this.db.prepare("SELECT sec_document_context_json FROM source_deliveries WHERE id = ? AND collector = 'sec_edgar'")
      .get(deliveryId) as { sec_document_context_json: string | null } | undefined;
    return parseSecDocumentContext(row?.sec_document_context_json);
  }

  startDeliveryIngestion(deliveryId: string, expectedCount: number, startedAt = Date.now()): void {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || !Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new Error("Delivery ingestion counts and start time must be non-negative integers");
    }
    const delivery = this.db.prepare(
      `SELECT processing_required AS processingRequired, result FROM source_deliveries WHERE id = ?`,
    ).get(deliveryId) as { processingRequired: number; result: string } | undefined;
    if (!delivery) throw new Error("Cannot process an unknown source delivery");
    if (delivery.processingRequired !== 1) throw new Error("Source delivery is not marked for observation ingestion");
    if (!["success", "empty", "partial", "invalid"].includes(delivery.result)) {
      throw new Error("Only parsed source deliveries can enter observation ingestion");
    }
    this.db.prepare(
      `INSERT INTO source_ingestions (delivery_id, started_at, status, expected_count)
       VALUES (?, ?, 'processing', ?)`,
    ).run(deliveryId, startedAt, expectedCount);
  }

  finishDeliveryIngestion(deliveryId: string, outcome: SourceIngestionOutcomeInput): void {
    const completedAt = outcome.completedAt ?? Date.now();
    if (!Number.isSafeInteger(outcome.processedCount) || outcome.processedCount < 0 ||
      !Number.isSafeInteger(outcome.insertedCount) || outcome.insertedCount < 0 ||
      !Number.isSafeInteger(completedAt) || completedAt < 0) {
      throw new Error("Delivery ingestion counts and completion time must be non-negative integers");
    }
    const current = this.db.prepare(
      `SELECT expected_count AS expectedCount, status FROM source_ingestions WHERE delivery_id = ?`,
    ).get(deliveryId) as { expectedCount: number; status: string } | undefined;
    if (!current || current.status !== "processing") throw new Error("Source delivery has no active ingestion to finalize");
    if (outcome.processedCount > current.expectedCount || outcome.insertedCount > outcome.processedCount) {
      throw new Error("Delivery ingestion counts exceed the declared batch size");
    }
    if (outcome.status === "success" && outcome.processedCount !== current.expectedCount) {
      throw new Error("A successful ingestion must account for every normalized source item");
    }
    this.db.prepare(
      `UPDATE source_ingestions SET completed_at = ?, status = ?, processed_count = ?,
        inserted_count = ?, error = ? WHERE delivery_id = ? AND status = 'processing'`,
    ).run(
      completedAt, outcome.status, outcome.processedCount, outcome.insertedCount,
      outcome.error ? outcome.error.slice(0, 500) : null, deliveryId,
    );
  }

  deliverySummary(): Array<{
    collector: CollectorId; companyId: string | null; result: string; completedAt: number;
    parsedItemCount: number; adapterVersion: string; error: string | null;
  }> {
    const summaryColumns = `collector, company_id AS companyId, result, completed_at AS completedAt,
      parsed_item_count AS parsedItemCount, adapter_version AS adapterVersion, error`;
    const summaryFilter = "collector NOT IN ('demo_simulation', 'legacy_unknown')";
    const boundary = this.db.prepare(
      `SELECT completed_at AS completedAt, started_at AS startedAt
       FROM source_deliveries WHERE ${summaryFilter}
       ORDER BY completed_at DESC, started_at DESC LIMIT 1 OFFSET 59`,
    ).get() as { completedAt: number; startedAt: number } | undefined;
    const rows = boundary
      ? this.db.prepare(
        `SELECT ${summaryColumns} FROM source_deliveries
         WHERE ${summaryFilter} AND (completed_at, started_at) >= (?, ?)
         ORDER BY completed_at DESC, started_at DESC, rowid DESC LIMIT 60`,
      ).all(boundary.completedAt, boundary.startedAt)
      : this.db.prepare(
        `SELECT ${summaryColumns} FROM source_deliveries WHERE ${summaryFilter}
         ORDER BY completed_at DESC, started_at DESC, rowid DESC`,
      ).all();
    return rows as unknown as Array<{
      collector: CollectorId; companyId: string | null; result: string; completedAt: number;
      parsedItemCount: number; adapterVersion: string; error: string | null;
    }>;
  }

  deliveryHealth(sources: DeliverySourceSchedule[], now = Date.now()): Array<{
    collector: CollectorId;
    enabled: boolean;
    state: DeliveryHealthState;
    intervalSeconds: number;
    targetCount: number;
    coverageCount: number;
    latestDeliveryAt: number | null;
    latestResult: string | null;
    latestItemCount: number | null;
    latestError: string | null;
    adapterVersion: string | null;
    latestIngestionRequired: boolean;
    latestIngestionState: "processing" | "success" | "partial" | "failed" | null;
    latestIngestionExpectedCount: number | null;
    latestIngestionProcessedCount: number | null;
    latestIngestionInsertedCount: number | null;
    latestObservationAt: number | null;
    latestObservationBasis: TimeBasis | null;
    latestObservationRetrievedAt: number | null;
  }> {
    type DeliveryRow = {
      collector: CollectorId;
      companyId: string | null;
      completedAt: number;
      result: string;
      parsedItemCount: number;
      error: string | null;
      adapterVersion: string;
      processingRequired: number;
      ingestionState: "processing" | "success" | "partial" | "failed" | null;
      ingestionStartedAt: number | null;
      ingestionExpectedCount: number | null;
      ingestionProcessedCount: number | null;
      ingestionInsertedCount: number | null;
      ingestionError: string | null;
    };
    const deliveryGroups = this.db.prepare(
      `SELECT DISTINCT collector, company_id AS companyId, adapter_version AS adapterVersion
       FROM source_deliveries WHERE collector NOT IN ('demo_simulation', 'legacy_unknown')`,
    ).all() as unknown as Array<{ collector: CollectorId; companyId: string | null; adapterVersion: string }>;
    const latestForGroup = this.db.prepare(
      `SELECT d.collector, d.company_id AS companyId, d.completed_at AS completedAt, d.result,
        d.parsed_item_count AS parsedItemCount, d.error, d.adapter_version AS adapterVersion,
        d.processing_required AS processingRequired, i.status AS ingestionState,
        i.started_at AS ingestionStartedAt, i.expected_count AS ingestionExpectedCount,
        i.processed_count AS ingestionProcessedCount, i.inserted_count AS ingestionInsertedCount,
        i.error AS ingestionError
       FROM source_deliveries d LEFT JOIN source_ingestions i ON i.delivery_id = d.id
       WHERE d.collector = ? AND d.company_id IS ? AND d.adapter_version = ?
         AND d.collector NOT IN ('demo_simulation', 'legacy_unknown')
       ORDER BY d.completed_at DESC, d.started_at DESC, d.rowid DESC LIMIT 1`,
    );
    const attempts = deliveryGroups.flatMap((group) => {
      const latest = latestForGroup.get(group.collector, group.companyId, group.adapterVersion) as DeliveryRow | undefined;
      return latest ? [latest] : [];
    });
    const byCollector = new Map<CollectorId, DeliveryRow[]>();
    for (const row of attempts) byCollector.set(row.collector, [...(byCollector.get(row.collector) ?? []), row]);

    type ObservationRow = {
      collector: CollectorId;
      publisherPublishedAt: number | null;
      providerObservedAt: number | null;
      retrievedAt: number;
      timeBasis: TimeBasis;
    };
    const observations = this.db.prepare(
      `WITH ranked AS (
        SELECT collector, publisher_published_at AS publisherPublishedAt,
          provider_observed_at AS providerObservedAt, retrieved_at AS retrievedAt, time_basis AS timeBasis,
          ROW_NUMBER() OVER (PARTITION BY collector ORDER BY ingested_at DESC) AS rn
        FROM source_observations WHERE collector NOT IN ('demo_simulation', 'legacy_unknown')
      )
      SELECT collector, publisherPublishedAt, providerObservedAt, retrievedAt, timeBasis
      FROM ranked WHERE rn = 1`,
    ).all() as unknown as ObservationRow[];
    const observationByCollector = new Map(observations.map((row) => [row.collector, row]));

    return sources.map((source) => {
      const allRows = byCollector.get(source.collector) ?? [];
      const rows = allRows.filter((row) =>
        (source.healthAdapterVersions == null || source.healthAdapterVersions.includes(row.adapterVersion)) &&
        (!source.healthCompanyOnly || row.companyId !== null)
      );
      const latest = [...rows].sort((a, b) => b.completedAt - a.completedAt)[0] ?? null;
      const dueAfterMs = Math.max(source.intervalSeconds * 3_000, 180_000);
      const recent = rows.filter((row) => now - row.completedAt <= dueAfterMs);
      const coverageCount = new Set(recent.filter((row) =>
        row.companyId !== null && (row.result === "success" || row.result === "empty") &&
        (row.processingRequired !== 1 || row.ingestionState === "success")
      ).map((row) => row.companyId)).size;
      const recentFailureCount = recent.filter((row) =>
        ["failed", "rate_limited", "invalid"].includes(row.result) ||
        (row.processingRequired === 1 && (row.ingestionState === "failed" || row.ingestionState == null))
      ).length;
      const recentPartialCount = recent.filter((row) =>
        row.result === "partial" || (row.processingRequired === 1 && row.ingestionState === "partial")
      ).length;
      const degradedFilters = [
        "collector = ?",
        "completed_at >= ?",
        "result IN ('failed', 'rate_limited', 'invalid', 'partial')",
      ];
      const degradedParams: Array<string | number> = [source.collector, now - dueAfterMs];
      if (source.healthCompanyOnly) degradedFilters.push("company_id IS NOT NULL");
      if (source.healthAdapterVersions != null) {
        if (source.healthAdapterVersions.length === 0) degradedFilters.push("1 = 0");
        else {
          degradedFilters.push(`adapter_version IN (${source.healthAdapterVersions.map(() => "?").join(", ")})`);
          degradedParams.push(...source.healthAdapterVersions);
        }
      }
      const degradationRow: unknown = this.db.prepare(
        `SELECT error FROM source_deliveries WHERE ${degradedFilters.join(" AND ")}
         ORDER BY completed_at DESC, started_at DESC, rowid DESC LIMIT 1`,
      ).get(...degradedParams);
      const recentDegradationError = typeof degradationRow === "object" && degradationRow !== null &&
        "error" in degradationRow && (degradationRow.error === null || typeof degradationRow.error === "string")
        ? degradationRow.error : null;
      const observation = observationByCollector.get(source.collector);
      const state = deliveryHealthState({
        enabled: source.enabled,
        hasDelivery: latest != null,
        latestDeliveryAt: latest?.completedAt ?? null,
        latestResult: latest?.result ?? null,
        ingestionRequired: latest?.processingRequired === 1,
        ingestionState: latest?.ingestionState ?? null,
        ingestionStartedAt: latest?.ingestionStartedAt ?? null,
        recentFailureCount,
        recentPartialCount,
        coverageCount,
        targetCount: source.targetCount,
        now,
        intervalSeconds: source.intervalSeconds,
      });
      const latestIngestionError = latest?.processingRequired === 1
        ? latest.ingestionState == null ? "Observation ingestion did not start"
          : latest.ingestionState === "processing"
            ? now - (latest.ingestionStartedAt ?? latest.completedAt) > dueAfterMs
              ? "Observation ingestion stopped before completion"
              : "Observation ingestion is still in progress"
            : latest.ingestionState === "failed" || latest.ingestionState === "partial" ? latest.ingestionError ?? `Observation ingestion ${latest.ingestionState}`
              : null
        : null;
      return {
        collector: source.collector,
        enabled: source.enabled,
        state,
        intervalSeconds: source.intervalSeconds,
        targetCount: source.targetCount,
        coverageCount,
        latestDeliveryAt: latest?.completedAt ?? null,
        latestResult: latest?.result ?? null,
        latestItemCount: latest?.parsedItemCount ?? null,
        latestError: latestIngestionError ?? recentDegradationError ?? (state === "overdue" ? latest?.error ?? null : null),
        adapterVersion: latest?.adapterVersion ?? null,
        latestIngestionRequired: latest?.processingRequired === 1,
        latestIngestionState: latest?.ingestionState ?? null,
        latestIngestionExpectedCount: latest?.ingestionExpectedCount ?? null,
        latestIngestionProcessedCount: latest?.ingestionProcessedCount ?? null,
        latestIngestionInsertedCount: latest?.ingestionInsertedCount ?? null,
        latestObservationAt: observation?.publisherPublishedAt ?? observation?.providerObservedAt ?? null,
        latestObservationBasis: observation?.timeBasis ?? null,
        latestObservationRetrievedAt: observation?.retrievedAt ?? null,
      };
    });
  }

  mentionsForCompany(companyId: string, sinceMs: number, limit: number): MentionDTO[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mentions WHERE company_id = ? AND ${REAL_MENTION_FILTER}
           AND COALESCE(published_at, provider_observed_at, retrieved_at) >= ?
         ORDER BY COALESCE(published_at, provider_observed_at, retrieved_at) DESC, ingested_at DESC LIMIT ?`,
      )
      .all(companyId, sinceMs, limit) as unknown as MentionRow[];
    return rows.map(rowToDTO);
  }

  mentionsByIds(companyId: string, ids: string[]): MentionDTO[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT * FROM mentions WHERE company_id = ? AND ${REAL_MENTION_FILTER}
         AND id IN (${placeholders})`,
    ).all(companyId, ...ids) as unknown as MentionRow[];
    return rows.map(rowToDTO);
  }

  mentionsForCompanyPage({
    companyId,
    sinceMs,
    limit,
    cursor,
    filter,
  }: {
    companyId: string;
    sinceMs: number;
    limit: number;
    cursor: MentionPageCursor | null;
    filter: MentionFeedFilter;
  }): { items: MentionDTO[]; nextCursor: MentionPageCursor | null } {
    const filterSql: Record<MentionFeedFilter, string> = {
      all: "status IN ('pending', 'scoring', 'retrying', 'scored', 'off_target', 'classified', 'excluded', 'review_required', 'failed', 'corrupt')",
      bull: "(status = 'scored' AND sentiment = 'positive') OR (status = 'classified' AND classification_sentiment = 'positive')",
      bear: "(status = 'scored' AND sentiment = 'negative') OR (status = 'classified' AND classification_sentiment = 'negative')",
      material: "(status = 'scored' AND COALESCE(material, 0) >= 0.6) OR (status = 'classified' AND classification_material = 1)",
      offtarget: "status IN ('off_target', 'excluded')",
      failed: "status IN ('pending', 'retrying', 'scoring', 'failed', 'corrupt', 'review_required')",
    };
    const cursorFilter = cursor
      ? `AND (
           COALESCE(published_at, provider_observed_at, retrieved_at) < ?
           OR (COALESCE(published_at, provider_observed_at, retrieved_at) = ? AND ingested_at < ?)
           OR (COALESCE(published_at, provider_observed_at, retrieved_at) = ? AND ingested_at = ? AND id < ?)
         )`
      : "";
    const cursorParams = cursor
      ? [cursor.orderAt, cursor.orderAt, cursor.ingestedAt, cursor.orderAt, cursor.ingestedAt, cursor.id]
      : [];
    const rows = this.db.prepare(
      `SELECT *, COALESCE(published_at, provider_observed_at, retrieved_at) AS order_at
       FROM mentions WHERE company_id = ? AND ${REAL_MENTION_FILTER}
         AND (${filterSql[filter]})
         AND COALESCE(published_at, provider_observed_at, retrieved_at) >= ?
         ${cursorFilter}
       ORDER BY COALESCE(published_at, provider_observed_at, retrieved_at) DESC,
         ingested_at DESC, id DESC LIMIT ?`,
    ).all(companyId, sinceMs, ...cursorParams, limit + 1) as unknown as Array<MentionRow & { order_at: number }>;
    const hasMore = rows.length > limit;
    const last = hasMore ? rows[limit - 1] : undefined;
    return {
      items: rows.slice(0, limit).map(rowToDTO),
      nextCursor: last
        ? { orderAt: last.order_at, ingestedAt: last.ingested_at, id: last.id }
        : null,
    };
  }

  mentionsForScoreBucket({
    companyId,
    fromMs,
    throughMs,
    includeFromBoundary,
    limit,
    cursor,
  }: {
    companyId: string;
    fromMs: number;
    throughMs: number;
    includeFromBoundary: boolean;
    limit: number;
    cursor: ScoreBucketCursor | null;
  }): { items: MentionDTO[]; nextCursor: ScoreBucketCursor | null } {
    const fromOperator = includeFromBoundary ? ">=" : ">";
    const cursorClause = cursor
      ? "AND (scored_at < ? OR (scored_at = ? AND id < ?))"
      : "";
    const cursorParams = cursor ? [cursor.scoredAt, cursor.scoredAt, cursor.id] : [];
    const rows = this.db.prepare(
      `SELECT * FROM mentions
       WHERE company_id = ? AND ${REAL_MENTION_FILTER} AND status = 'scored'
         AND scored_at ${fromOperator} ? AND scored_at <= ? AND impact IS NOT NULL
         ${cursorClause}
       ORDER BY scored_at DESC, id DESC LIMIT ?`,
    ).all(companyId, fromMs, throughMs, ...cursorParams, limit + 1) as unknown as MentionRow[];
    const hasMore = rows.length > limit;
    const last = hasMore ? rows[limit - 1] : undefined;
    return {
      items: rows.slice(0, limit).map(rowToDTO),
      nextCursor: last?.scored_at == null ? null : { scoredAt: last.scored_at, id: last.id },
    };
  }

  scoredReactionEventsForCompany(companyId: string, sinceMs: number, asOfMs = Date.now()): Array<{
    id: string;
    title: string;
    publishedAt: number | null;
    availableAt: number;
    sentiment: string;
    eventScore: number;
    eventType: string;
  }> {
    return this.db.prepare(
      `SELECT id, title, published_at AS publishedAt, scored_at AS availableAt, sentiment, event_score AS eventScore,
         COALESCE(event_type, 'other') AS eventType
       FROM mentions
       WHERE company_id = ? AND ${REAL_MENTION_FILTER} AND status = 'scored'
         AND scored_at IS NOT NULL AND scored_at >= ? AND scored_at <= ? AND impact IS NOT NULL
       ORDER BY scored_at DESC, id DESC`,
    ).all(companyId, sinceMs, asOfMs) as unknown as Array<{
      id: string;
      title: string;
      publishedAt: number | null;
      availableAt: number;
      sentiment: string;
      eventScore: number;
      eventType: string;
    }>;
  }

  radarEvidence(companyId: string, fromMs: number, toMs: number, asOf = Number.MAX_SAFE_INTEGER): RadarItemEvidence[] {
    const rows = this.db.prepare(
      `SELECT id, title, source_url AS sourceUrl, publisher_name AS publisherName,
        publisher_domain AS publisherDomain, publisher_published_at AS publishedAt,
        retrieved_at AS retrievedAt, collector, event_type AS eventType,
        sentiment, takeaway
       FROM mentions
       WHERE company_id = ? AND ${REAL_MENTION_FILTER} AND status = 'scored' AND impact IS NOT NULL
         AND time_basis = 'publisher_declared' AND publisher_published_at >= ?
         AND publisher_published_at < ? AND ingested_at <= ? AND scored_at <= ?
       ORDER BY publisher_published_at DESC, ingested_at DESC`,
    ).all(companyId, fromMs, toMs, asOf, asOf) as unknown as RadarItemEvidence[];
    return rows.map((row) => ({
      ...row,
      publisherDomain: researchPublisherDomain(row.collector, row.publisherDomain),
    }));
  }

  radarUncounted(companyId: string, retrievedFromMs: number, retrievedToMs: number, asOf = Number.MAX_SAFE_INTEGER): {
    untimedScored: number;
    unjudged: number;
  } {
    const row = this.db.prepare(
      `SELECT
        SUM(CASE WHEN status IN ('scored', 'off_target') AND scored_at <= ? AND impact IS NOT NULL
          AND (time_basis != 'publisher_declared' OR publisher_published_at IS NULL) THEN 1 ELSE 0 END) AS untimedScored,
        SUM(CASE WHEN status IN ('pending', 'retrying', 'scoring', 'failed', 'corrupt')
          OR (status IN ('scored', 'off_target') AND scored_at > ?) THEN 1 ELSE 0 END) AS unjudged
       FROM mentions WHERE ${REAL_MENTION_FILTER} AND company_id = ? AND retrieved_at >= ? AND retrieved_at <= ? AND ingested_at <= ?`,
    ).get(asOf, asOf, companyId, retrievedFromMs, retrievedToMs, asOf) as {
      untimedScored: number | null;
      unjudged: number | null;
    };
    return { untimedScored: row.untimedScored ?? 0, unjudged: row.unjudged ?? 0 };
  }

  /**
   * Tape: scored mentions first-class, but pending ones stay visible so the
   * live flow is observable even before scoring is configured. Failed items
   * stay visible so a user can inspect the item-level failure and its
   * recovery state after a page reload.
   */
  recentVisible(limit: number): MentionDTO[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mentions WHERE ${REAL_MENTION_FILTER} AND status IN ('scored', 'off_target', 'classified', 'excluded', 'review_required', 'pending', 'retrying', 'scoring', 'failed', 'corrupt')
         ORDER BY COALESCE(published_at, provider_observed_at, retrieved_at) DESC, ingested_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as MentionRow[];
    return rows.map(rowToDTO);
  }

  /** Identified scored mentions keyed to the time the Jev result became available. */
  scoredMentions(sinceMs: number, asOfMs = Date.now(), companyId?: string): Array<{
    companyId: string;
    availableAt: number;
    impact: number;
    weight: number;
    scoredAt: number;
    eventType: string;
    takeaway: string;
  }> {
    const companyClause = companyId == null ? "" : " AND company_id = ?";
    const params = companyId == null ? [sinceMs, asOfMs] : [sinceMs, asOfMs, companyId];
    const rows = this.db
      .prepare(
        `SELECT company_id, scored_at, impact, weight, event_type, takeaway FROM mentions
         WHERE ${REAL_MENTION_FILTER} AND status = 'scored' AND scored_at IS NOT NULL
           AND scored_at >= ? AND scored_at <= ? AND impact IS NOT NULL${companyClause}
         ORDER BY scored_at, id`,
      )
      .all(...params) as unknown as Array<{
        company_id: string;
        scored_at: number;
        impact: number;
        weight: number;
        event_type: string;
        takeaway: string;
      }>;
    return rows.map((r) => ({
      companyId: r.company_id,
      availableAt: r.scored_at,
      impact: r.impact,
      weight: r.weight,
      scoredAt: r.scored_at,
      eventType: r.event_type,
      takeaway: r.takeaway,
    }));
  }

  /** Saved GPT-6 Luna observations, bucketed by classification availability. */
  categoricalTrendSnapshot(companyId: string, windowHours: number, now = Date.now()): {
    companyId: string;
    windowHours: number;
    fromMs: number;
    throughMs: number;
    bucketMs: number;
    snapshotGeneration: string;
    snapshotKey: string;
    counts: CategoricalTrendCounts;
    aggregates: Array<{ bucketStartMs: number; counts: CategoricalTrendCounts }>;
    eligibleObservationCount: number;
    candidateClassificationCount: number;
    withheldInvalidCount: number;
    latestClassifiedAt: number | null;
    lineages: CategoricalTrendLineage[];
  } {
    if (!Number.isSafeInteger(windowHours) || windowHours < 1 || windowHours > 168 || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("invalid_categorical_window");
    }
    const fromMs = now - windowHours * 60 * 60_000;
    const throughMs = now;
    const maxRow = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_row_id FROM categorical_classifications").get() as { max_row_id: number };
    const maxRowId = Number(maxRow.max_row_id);
    if (!Number.isSafeInteger(maxRowId) || maxRowId < 0) throw new Error("categorical_row_id_out_of_range");
    const snapshot = { companyId, fromMs, throughMs, windowHours, bucketMs: CATEGORICAL_BUCKET_MS, maxRowId };
    const snapshotKey = this.encodeCategoricalSnapshot(snapshot);
    const baseJoin = `FROM mentions m
      JOIN source_observations o ON o.id=m.id
      JOIN categorical_classifications c ON c.observation_id=m.id
      JOIN source_deliveries d ON d.id=m.delivery_id`;
    const scope = `m.company_id=? AND ${REAL_MENTION_FILTER.replaceAll("collector", "m.collector").replaceAll("engine", "m.engine")}
      AND c.classified_at>=? AND c.classified_at<? AND c.rowid<=?`;
    const validScope = `m.company_id=? AND ${REAL_CATEGORICAL_FILTER}
      AND c.classified_at>=? AND c.classified_at<? AND c.rowid<=?`;
    const candidateRow = this.db.prepare(`SELECT COUNT(*) AS count FROM mentions m
      JOIN source_observations o ON o.id=m.id
      JOIN categorical_classifications c ON c.observation_id=m.id
      WHERE ${scope} AND c.provider='openai_luna' AND c.model_requested='gpt-6-luna'`).get(
      companyId, fromMs, throughMs, maxRowId,
    ) as { count: number };
    const aggregateRows = this.db.prepare(`SELECT (c.classified_at / ${CATEGORICAL_BUCKET_MS}) * ${CATEGORICAL_BUCKET_MS} AS bucket_start_ms,
      ${CATEGORICAL_COUNTS_SQL}
      ${baseJoin} WHERE ${validScope}
      GROUP BY bucket_start_ms ORDER BY bucket_start_ms`).all(
      companyId, throughMs, fromMs, throughMs, maxRowId,
    ) as unknown as CategoricalAggregateRow[];
    const aggregates = aggregateRows.map((row) => ({ bucketStartMs: Number(row.bucket_start_ms), counts: categoricalCounts(row) }));
    const counts = aggregates.reduce<CategoricalTrendCounts>((total, row) => ({
      positive: total.positive + row.counts.positive,
      neutral: total.neutral + row.counts.neutral,
      negative: total.negative + row.counts.negative,
      reviewRequired: total.reviewRequired + row.counts.reviewRequired,
      excluded: total.excluded + row.counts.excluded,
      total: total.total + row.counts.total,
    }), { positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0 });
    const latestRow = this.db.prepare(`SELECT MAX(c.classified_at) AS latest ${baseJoin} WHERE ${validScope}`)
      .get(companyId, throughMs, fromMs, throughMs, maxRowId) as { latest: number | null };
    const lineageRows = this.db.prepare(`SELECT c.prompt_version, c.prompt_sha256, c.schema_version, c.schema_sha256, COUNT(*) AS count
      ${baseJoin} WHERE ${validScope}
      GROUP BY c.prompt_version, c.prompt_sha256, c.schema_version, c.schema_sha256
      ORDER BY count DESC, c.prompt_version, c.schema_version`).all(
      companyId, throughMs, fromMs, throughMs, maxRowId,
    ) as Array<{ prompt_version: string; prompt_sha256: string; schema_version: string; schema_sha256: string; count: number }>;
    const candidateClassificationCount = Number(candidateRow.count);
    const eligibleObservationCount = counts.total;
    return {
      companyId, windowHours, fromMs, throughMs, bucketMs: CATEGORICAL_BUCKET_MS,
      snapshotGeneration: this.runtimeId, snapshotKey, counts, aggregates,
      eligibleObservationCount, candidateClassificationCount,
      withheldInvalidCount: Math.max(0, candidateClassificationCount - eligibleObservationCount),
      latestClassifiedAt: latestRow.latest == null ? null : Number(latestRow.latest),
      lineages: lineageRows.map((row) => ({
        promptVersion: row.prompt_version, promptSha256: row.prompt_sha256,
        schemaVersion: row.schema_version, schemaSha256: row.schema_sha256, count: Number(row.count),
      })),
    };
  }

  categoricalBucketEvidence(input: {
    companyId: string;
    snapshotKey: string;
    bucketStartMs: number;
    bucketDurationMs?: number;
    limit: number;
    cursor: CategoricalBucketCursor | null;
  }): CategoricalBucketEvidencePage {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
      || !Number.isSafeInteger(input.bucketStartMs) || input.bucketStartMs < 0) {
      throw new InvalidCategoricalBucketError();
    }
    const snapshot = this.decodeCategoricalSnapshot(input.snapshotKey, input.companyId);
    const bucketDurationMs = input.bucketDurationMs ?? snapshot.bucketMs;
    if (![snapshot.bucketMs, snapshot.bucketMs * 2, snapshot.bucketMs * 4, snapshot.bucketMs * 12, snapshot.bucketMs * 24].includes(bucketDurationMs)
      || input.bucketStartMs % bucketDurationMs !== 0) throw new InvalidCategoricalBucketError();
    const fromMs = Math.max(snapshot.fromMs, input.bucketStartMs);
    const throughMs = Math.min(snapshot.throughMs, input.bucketStartMs + bucketDurationMs);
    if (fromMs >= throughMs) throw new InvalidCategoricalBucketError();
    const baseJoin = `FROM mentions m
      JOIN source_observations o ON o.id=m.id
      JOIN categorical_classifications c ON c.observation_id=m.id
      JOIN source_deliveries d ON d.id=m.delivery_id`;
    const scope = `m.company_id=? AND ${REAL_CATEGORICAL_FILTER}
      AND c.classified_at>=? AND c.classified_at<? AND c.rowid<=?`;
    if (input.cursor) {
      if (!Number.isSafeInteger(input.cursor.classifiedAt) || input.cursor.classifiedAt < fromMs || input.cursor.classifiedAt >= throughMs
        || typeof input.cursor.id !== "string" || input.cursor.id.length < 1 || input.cursor.id.length > 200) {
        throw new InvalidCategoricalBucketError("invalid_cursor");
      }
      const cursorExists = this.db.prepare(`SELECT 1 AS ok ${baseJoin}
        WHERE ${scope} AND m.id=? AND c.classified_at=? LIMIT 1`).get(
        input.companyId, snapshot.throughMs, fromMs, throughMs, snapshot.maxRowId,
        input.cursor.id, input.cursor.classifiedAt,
      );
      if (!cursorExists) throw new InvalidCategoricalBucketError("invalid_cursor");
    }
    const countRow = this.db.prepare(`SELECT ${CATEGORICAL_COUNTS_SQL} ${baseJoin}
      WHERE ${scope}`).get(input.companyId, snapshot.throughMs, fromMs, throughMs, snapshot.maxRowId) as CategoricalAggregateRow;
    const cursorClause = input.cursor
      ? "AND (c.classified_at < ? OR (c.classified_at = ? AND m.id < ?))"
      : "";
    const cursorParams = input.cursor ? [input.cursor.classifiedAt, input.cursor.classifiedAt, input.cursor.id] : [];
    const rows = this.db.prepare(`SELECT m.* ${baseJoin}
      WHERE ${scope} ${cursorClause}
      ORDER BY c.classified_at DESC, m.id DESC LIMIT ?`).all(
      input.companyId, snapshot.throughMs, fromMs, throughMs, snapshot.maxRowId,
      ...cursorParams, input.limit + 1,
    ) as unknown as MentionRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = pageRows.map(rowToDTO);
    if (items.some((item) => item.classification == null || item.status === "corrupt")) {
      throw new Error("Stored Luna classification failed DTO validation");
    }
    const last = items.at(-1);
    return {
      companyId: input.companyId,
      snapshotKey: input.snapshotKey,
      bucketStartMs: input.bucketStartMs,
      bucketDurationMs,
      fromMs,
      throughMs,
      counts: categoricalCounts(countRow),
      items,
      nextCursor: hasMore && last?.classification ? { classifiedAt: last.classification.classifiedAt, id: last.id } : null,
    };
  }

  private encodeCategoricalSnapshot(snapshot: CategoricalSnapshotToken): string {
    const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
    const signature = createHmac("sha256", this.categoricalSnapshotSecret).update(`v1.${payload}`).digest("base64url");
    return `v1.${payload}.${signature}`;
  }

  private decodeCategoricalSnapshot(snapshotKey: string, companyId: string): CategoricalSnapshotToken {
    if (typeof snapshotKey !== "string" || snapshotKey.length > 2048) throw new CategoricalSnapshotUnavailableError();
    const parts = snapshotKey.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new CategoricalSnapshotUnavailableError();
    const expected = createHmac("sha256", this.categoricalSnapshotSecret).update(`v1.${parts[1]}`).digest();
    let actual: Buffer;
    try { actual = Buffer.from(parts[2]!, "base64url"); } catch { throw new CategoricalSnapshotUnavailableError(); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CategoricalSnapshotUnavailableError();
    try {
      const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as CategoricalSnapshotToken;
      const maxRow = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_row_id FROM categorical_classifications").get() as { max_row_id: number };
      if (parsed.companyId !== companyId || !Number.isSafeInteger(parsed.fromMs) || !Number.isSafeInteger(parsed.throughMs)
        || parsed.fromMs < 0 || parsed.throughMs <= parsed.fromMs || !Number.isSafeInteger(parsed.windowHours)
        || parsed.windowHours < 1 || parsed.windowHours > 168 || parsed.bucketMs !== CATEGORICAL_BUCKET_MS
        || !Number.isSafeInteger(parsed.maxRowId) || parsed.maxRowId < 0 || parsed.maxRowId > Number(maxRow.max_row_id)) {
        throw new CategoricalSnapshotUnavailableError();
      }
      return parsed;
    } catch (error) {
      if (error instanceof CategoricalSnapshotUnavailableError) throw error;
      throw new CategoricalSnapshotUnavailableError();
    }
  }

  upsertPricePoint(input: {
    ticker: string;
    t: number;
    price: number;
    collector: "yahoo_quote" | "yahoo_chart";
    currency: string;
    retrievedAt: number;
    adapterVersion: string;
    deliveryId: string;
  }): boolean {
    if (!Number.isFinite(input.t) || input.t <= 0
      || !Number.isFinite(input.price) || input.price <= 0
      || !/^[A-Z]{3}$/.test(input.currency)
      || !Number.isFinite(input.retrievedAt) || input.retrievedAt <= 0
      || !input.adapterVersion.trim() || !input.deliveryId.trim()) {
      throw new Error("Price point requires source time, value, currency, retrieval time, adapter version, and delivery receipt");
    }
    const receipt = this.db.prepare(`SELECT collector, result, adapter_version FROM source_deliveries WHERE id = ?`)
      .get(input.deliveryId) as { collector: string; result: string; adapter_version: string } | undefined;
    if (!receipt || receipt.collector !== input.collector
      || !["success", "partial"].includes(receipt.result)
      || receipt.adapter_version !== input.adapterVersion) {
      throw new Error("Price point delivery receipt does not match its source collector and adapter");
    }
    const result = this.db
      .prepare(`INSERT INTO price_points (ticker, t, price, collector, currency, retrieved_at, adapter_version, delivery_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker, t) DO UPDATE SET price = excluded.price, collector = excluded.collector,
          currency = excluded.currency, retrieved_at = excluded.retrieved_at,
          adapter_version = excluded.adapter_version, delivery_id = excluded.delivery_id
        WHERE (price_points.collector = 'legacy_unknown' OR price_points.collector = 'yahoo_quote')
          AND excluded.collector = 'yahoo_chart'`)
      .run(input.ticker, Math.floor(input.t / 1000) * 1000, input.price, input.collector,
        input.currency, Math.floor(input.retrievedAt), input.adapterVersion, input.deliveryId);
    return result.changes > 0;
  }

  priceWindow(ticker: string, sinceMs: number, asOfMs = Date.now()): Array<{
    t: number;
    price: number;
    currency: string;
    collector: "yahoo_chart";
    retrievedAt: number;
    adapterVersion: string;
    deliveryId: string;
  }> {
    return this.db
      .prepare(`SELECT p.t, p.price, p.currency, p.collector, p.retrieved_at AS retrievedAt,
          p.adapter_version AS adapterVersion, p.delivery_id AS deliveryId
        FROM price_points p WHERE p.ticker = ? AND p.t >= ? AND p.retrieved_at <= ? AND p.collector = 'yahoo_chart'
          AND p.currency GLOB '[A-Z][A-Z][A-Z]' AND p.retrieved_at > 0 AND p.price > 0
          AND p.delivery_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM source_deliveries d WHERE d.id = p.delivery_id
              AND d.collector = p.collector AND d.adapter_version = p.adapter_version
              AND d.result IN ('success', 'partial'))
        ORDER BY p.t`)
      .all(ticker, sinceMs, asOfMs) as unknown as Array<{
        t: number;
        price: number;
        currency: string;
        collector: "yahoo_chart";
        retrievedAt: number;
        adapterVersion: string;
        deliveryId: string;
      }>;
  }

  pendingIds(limit: number, allowedCollectors: readonly CollectorId[]): string[] {
    if (allowedCollectors.length === 0) return [];
    const collectorSlots = allowedCollectors.map(() => "?").join(", ");
    return (
      this.db.prepare(`SELECT id FROM mentions
        WHERE ${REAL_MENTION_FILTER}
          AND collector IN (${collectorSlots})
          AND (status = 'pending' OR (status = 'retrying' AND score_retry_at <= ?))
        ORDER BY COALESCE(published_at, provider_observed_at, retrieved_at) DESC LIMIT ?`)
        .all(...allowedCollectors, Date.now(), limit) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** Scored, non-excluded events across the watchlist with ticker identity. */
  scoredMentionEvents(
    sinceMs: number,
    asOfMs = Date.now(),
  ): Array<{
    companyId: string;
    ticker: string;
    publishedAt: number | null;
    availableAt: number;
    sentiment: string;
    eventScore: number;
    eventType: string;
    title: string;
  }> {
    return this.db
      .prepare(
        `SELECT m.company_id AS companyId, c.ticker AS ticker, m.published_at AS publishedAt,
                m.scored_at AS availableAt,
                m.sentiment AS sentiment, m.event_score AS eventScore,
                COALESCE(m.event_type, 'other') AS eventType, m.title AS title
         FROM mentions m JOIN companies c ON c.id = m.company_id
         WHERE m.collector NOT IN ('demo_simulation', 'legacy_unknown') AND COALESCE(m.engine, '') <> 'demo-sim'
           AND m.status = 'scored' AND m.scored_at IS NOT NULL
           AND m.scored_at >= ? AND m.scored_at <= ? AND m.impact IS NOT NULL
         ORDER BY m.scored_at, m.id`,
      )
      .all(sinceMs, asOfMs) as unknown as Array<{
        companyId: string;
        ticker: string;
        publishedAt: number | null;
        availableAt: number;
        sentiment: string;
        eventScore: number;
        eventType: string;
        title: string;
      }>;
  }

  sourceActivity24h(sinceMs: number): Map<string, { sourceRecords24h: number; latestCollectedAt: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT company_id,
                SUM(CASE WHEN retrieved_at >= ? THEN 1 ELSE 0 END) AS count_24h,
                MAX(retrieved_at) AS latest_collected_at
         FROM mentions WHERE ${REAL_MENTION_FILTER} GROUP BY company_id`,
      )
      .all(sinceMs) as Array<{ company_id: string; count_24h: number; latest_collected_at: number | null }>;
    return new Map(rows.map((r) => [r.company_id, {
      sourceRecords24h: r.count_24h,
      latestCollectedAt: r.latest_collected_at,
    }]));
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Atomically replace a group of cached facts so stale values are not mixed with a fresh response. */
  setKvEntriesAtomically(entries: ReadonlyArray<readonly [string, string]>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) this.setKv(key, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Atomically change persisted state and append its matching event. */
  transitionKvWithEvent(input: {
    key: string;
    when: { equals: string } | { notEquals: string };
    value: string;
    event: { level: "info" | "warn" | "error"; source: string; message: string };
  }): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(input.key) as
        | { value: string }
        | undefined;
      if ("equals" in input.when) {
        if (current?.value !== input.when.equals) {
          this.db.exec("COMMIT");
          return false;
        }
      } else if (current?.value === input.when.notEquals) {
        this.db.exec("COMMIT");
        return false;
      }
      this.setKv(input.key, input.value);
      this.logEvent(input.event.level, input.event.source, input.event.message);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  remainingJevRequests(input: { utcDay: string; maxRequests: number; maxRequestBytes: number; provider?: ModelProvider; maxDailyCostMicros?: number }): number {
    const provider = input.provider ?? "typesafe";
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.utcDay) ||
      !Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0 ||
      !Number.isSafeInteger(input.maxRequestBytes) || input.maxRequestBytes <= 0 ||
      (provider === "openai_luna" && (!Number.isSafeInteger(input.maxDailyCostMicros) || input.maxDailyCostMicros! <= 0))
    ) return 0;
    const prefix = provider === "openai_luna" ? "openai:budget" : "jev:budget";
    const closed = this.getKv(`${prefix}:${input.utcDay}:closed`);
    if (closed !== undefined && closed !== "0") return 0;
    const requests = this.getKv(`${prefix}:${input.utcDay}:requests`);
    const requestBytes = this.getKv(`${prefix}:${input.utcDay}:request-bytes`);
    const cost = this.getKv(`${prefix}:${input.utcDay}:cost-micros`);
    const usedRequests = requests === undefined ? 0 : Number(requests);
    const usedBytes = requestBytes === undefined ? 0 : Number(requestBytes);
    if (
      !Number.isSafeInteger(usedRequests) || usedRequests < 0 ||
      !Number.isSafeInteger(usedBytes) || usedBytes < 0 ||
      (provider === "openai_luna" && (!Number.isSafeInteger(Number(cost ?? "0")) || Number(cost ?? "0") + 1 > input.maxDailyCostMicros!)) ||
      usedBytes >= input.maxRequestBytes
    ) return 0;
    return Math.max(0, input.maxRequests - usedRequests);
  }

  logEvent(level: "info" | "warn" | "error", source: string, message: string): void {
    this.db.prepare("INSERT INTO events (at, level, source, message) VALUES (?, ?, ?, ?)").run(
      Date.now(),
      level,
      source,
      message.slice(0, 500),
    );
  }

  recentEvents(limit: number): Array<{ at: number; level: string; source: string; message: string }> {
    return this.db
      .prepare("SELECT at, level, source, message FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ at: number; level: string; source: string; message: string }>;
  }

  usageSince(sinceMs: number): {
    judgedItems: number;
    inputTokens: number;
    outputTokens: number;
    estimatedInputCostUsd: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS judged_items,
                COALESCE(SUM(input_tokens), 0) AS in_tok,
                COALESCE(SUM(output_tokens), 0) AS out_tok,
                COALESCE(SUM(cost_usd), 0) AS estimated_input_cost_usd
         FROM mentions
         WHERE scored_at >= ?
           AND status IN ('scored', 'off_target')
           AND ${REAL_MENTION_FILTER}`,
      )
      .get(sinceMs) as {
        judged_items: number;
        in_tok: number;
        out_tok: number;
        estimated_input_cost_usd: number;
      };
    return {
      judgedItems: row.judged_items,
      inputTokens: row.in_tok,
      outputTokens: row.out_tok,
      estimatedInputCostUsd: row.estimated_input_cost_usd,
    };
  }

  classifierUsageSince(sinceMs: number): {
    requests: number; reservedRequests: number; inputTokens: number | null; cachedInputTokens: number | null; cacheWriteInputTokens: number | null; outputTokens: number | null;
    reasoningTokens: number | null; totalTokens: number | null; estimatedCostUsd: number | null; knownCostSubtotalUsd: number;
    reservedCostUsd: number; unknownOutcomes: number; unpricedAttempts: number; usageIncompleteAttempts: number;
  } {
    const row = this.db.prepare(`SELECT COUNT(*) AS reserved_requests,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM jev_attempt_events e WHERE e.attempt_id=a.id AND e.event_type='dispatch_intent') THEN 1 ELSE 0 END) AS requests,
      SUM(e.input_tokens) AS input_tokens, SUM(e.cached_input_tokens) AS cached_input_tokens,
      SUM(e.cache_write_tokens) AS cache_write_input_tokens, SUM(e.output_tokens) AS output_tokens,
      SUM(e.reasoning_tokens) AS reasoning_tokens, SUM(e.total_tokens) AS total_tokens,
      SUM(e.estimated_cost_usd) AS known_cost_subtotal_usd,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM jev_attempt_events d WHERE d.attempt_id=a.id AND d.event_type='dispatch_intent')
        AND (e.event_type IS NULL OR e.event_type IN ('response','unknown') AND e.estimated_cost_usd IS NULL) THEN 1 ELSE 0 END) AS unpriced_attempts,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM jev_attempt_events d WHERE d.attempt_id=a.id AND d.event_type='dispatch_intent')
        AND (e.event_type IS NULL OR e.input_tokens IS NULL OR e.output_tokens IS NULL OR e.total_tokens IS NULL) THEN 1 ELSE 0 END) AS usage_incomplete_attempts,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM jev_attempt_events d WHERE d.attempt_id=a.id AND d.event_type='dispatch_intent') AND e.cached_input_tokens IS NULL THEN 1 ELSE 0 END) AS cached_incomplete,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM jev_attempt_events d WHERE d.attempt_id=a.id AND d.event_type='dispatch_intent') AND e.cache_write_tokens IS NULL THEN 1 ELSE 0 END) AS cache_write_incomplete,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM jev_attempt_events d WHERE d.attempt_id=a.id AND d.event_type='dispatch_intent') AND e.reasoning_tokens IS NULL THEN 1 ELSE 0 END) AS reasoning_incomplete,
      COALESCE(SUM(a.reserved_cost_micros),0) AS reserved_cost_micros,
      SUM(CASE WHEN e.event_type='unknown' THEN 1 ELSE 0 END) AS unknown_outcomes
      FROM jev_request_attempts a LEFT JOIN jev_attempt_events e ON e.attempt_id=a.id AND e.event_type IN ('response','rejected','unknown')
      WHERE a.provider='openai_luna' AND a.reserved_at>=?`).get(sinceMs) as Record<string, number | null>;
    const unpricedAttempts = row.unpriced_attempts ?? 0;
    const requests = row.requests ?? 0;
    const usageIncompleteAttempts = row.usage_incomplete_attempts ?? 0;
    return {
      requests, reservedRequests: row.reserved_requests ?? 0, inputTokens: usageIncompleteAttempts > 0 ? null : row.input_tokens ?? 0,
      cachedInputTokens: requests === 0 ? 0 : (row.cached_incomplete ?? 0) > 0 ? null : row.cached_input_tokens ?? 0,
      cacheWriteInputTokens: requests === 0 ? 0 : (row.cache_write_incomplete ?? 0) > 0 ? null : row.cache_write_input_tokens ?? 0,
      outputTokens: usageIncompleteAttempts > 0 ? null : row.output_tokens ?? 0,
      reasoningTokens: requests === 0 ? 0 : (row.reasoning_incomplete ?? 0) > 0 ? null : row.reasoning_tokens ?? 0,
      totalTokens: usageIncompleteAttempts > 0 ? null : row.total_tokens ?? 0,
      estimatedCostUsd: unpricedAttempts > 0 ? null : row.known_cost_subtotal_usd ?? 0,
      knownCostSubtotalUsd: row.known_cost_subtotal_usd ?? 0, reservedCostUsd: (row.reserved_cost_micros ?? 0) / 1_000_000,
      unknownOutcomes: row.unknown_outcomes ?? 0, unpricedAttempts,
      usageIncompleteAttempts,
    };
  }

  close(): void {
    if (this.closed) return;
    this.db.prepare("UPDATE desk_runtime_sessions SET closed_at=? WHERE id=? AND closed_at IS NULL").run(Date.now(), this.runtimeId);
    this.db.close();
    this.closed = true;
  }
}

export function rowToDTO(r: MentionRow): MentionDTO {
  const wantsScore = r.status === "scored" || r.status === "off_target";
  const wantsClassification = r.status === "classified" || r.status === "excluded" || r.status === "review_required";
  const values = [r.p_pos, r.p_neu, r.p_neg, r.confidence, r.about, r.material, r.novel,
    r.credible, r.investor_relevant, r.magnitude, r.surprise, r.event_score, r.impact,
    r.weight, r.input_tokens, r.output_tokens, r.cost_usd, r.latency_ms, r.scored_at];
  const complete = wantsScore && values.every((v) => typeof v === "number" && Number.isFinite(v))
    && (r.sentiment === "positive" || r.sentiment === "neutral" || r.sentiment === "negative")
    && typeof r.event_type === "string" && typeof r.takeaway === "string"
    && typeof r.engine === "string" && typeof r.rubric_sha === "string";
  const classificationNumbers = [r.classification_input_tokens, r.classification_output_tokens,
    r.classification_total_tokens,
    r.classification_latency_ms, r.classification_classified_at];
  const classificationComplete = wantsClassification && r.classification_provider === "openai_luna" &&
    typeof r.classification_model_requested === "string" && typeof r.classification_model_returned === "string" &&
    typeof r.classification_prompt_version === "string" && typeof r.classification_prompt_sha256 === "string" &&
    typeof r.classification_schema_version === "string" && typeof r.classification_schema_sha256 === "string" &&
    (r.classification_sentiment == null || typeof r.classification_sentiment === "string") &&
    (r.classification_event_type == null || typeof r.classification_event_type === "string") &&
    (r.classification_takeaway == null || typeof r.classification_takeaway === "string") &&
    typeof r.classification_evidence_sufficient === "number" &&
    typeof r.classification_disposition === "string" && typeof r.classification_response_id === "string" &&
    typeof r.classification_response_sha256 === "string" && classificationNumbers.every((value) => typeof value === "number" && Number.isFinite(value));
  const status: MentionStatus = r.status === "corrupt" || (wantsScore && !complete) || (wantsClassification && !classificationComplete)
    ? "corrupt"
    : (r.status as MentionStatus);
  const score: MentionScore | null = complete ? {
    sentiment: r.sentiment as MentionScore["sentiment"],
    pPos: r.p_pos!, pNeu: r.p_neu!, pNeg: r.p_neg!, confidence: r.confidence!,
    about: r.about!, material: r.material!, novel: r.novel!, credible: r.credible!,
    investorRelevant: r.investor_relevant!, eventType: r.event_type!, takeaway: r.takeaway!,
    magnitude: r.magnitude!, surprise: r.surprise!, eventScore: r.event_score!, impact: r.impact!,
    weight: r.weight!, engine: r.engine!,
    inputTokens: r.input_tokens!,
    outputTokens: r.output_tokens!,
    estimatedInputCostUsd: r.cost_usd!,
    latencyMs: r.latency_ms!, rubricSha: r.rubric_sha!, scoredAt: r.scored_at!,
  } : null;
  const classification: CategoricalClassification | null = classificationComplete ? {
    provider: "openai_luna",
        modelRequested: r.classification_model_requested!, modelReturned: r.classification_model_returned!,
        serviceTierRequested: "default", serviceTier: r.classification_service_tier ?? null,
    promptVersion: r.classification_prompt_version!, promptSha256: r.classification_prompt_sha256!,
    schemaVersion: r.classification_schema_version!, schemaSha256: r.classification_schema_sha256!,
    sentiment: r.classification_sentiment as CategoricalClassification["sentiment"],
    eventType: r.classification_event_type ?? null, takeaway: r.classification_takeaway ?? null,
    about: nullableBoolean(r.classification_about), material: nullableBoolean(r.classification_material),
    investorRelevant: nullableBoolean(r.classification_investor_relevant), evidenceSufficient: r.classification_evidence_sufficient === 1,
    summary: r.classification_summary ?? null, supportingExcerpt: r.classification_supporting_excerpt ?? null,
    disposition: r.classification_disposition!, responseId: r.classification_response_id!, responseSha256: r.classification_response_sha256!,
    inputTokens: r.classification_input_tokens!, cachedInputTokens: r.classification_cached_input_tokens ?? null,
    cacheWriteInputTokens: r.classification_cache_write_tokens ?? null,
    outputTokens: r.classification_output_tokens!, reasoningTokens: r.classification_reasoning_tokens ?? null,
    totalTokens: r.classification_total_tokens!, estimatedCostUsd: r.classification_estimated_cost_usd ?? null,
    latencyMs: r.classification_latency_ms!, classifiedAt: r.classification_classified_at!,
  } : null;
  return {
    id: r.id,
    companyId: r.company_id,
    collector: r.collector as CollectorId,
    publisherName: r.publisher_name,
    publisherDomain: researchPublisherDomain(r.collector, r.publisher_domain),
    source: {
      name: r.source_name,
      url: r.source_url,
      kind: r.source_kind as SourceKind,
      tier: r.source_tier as SourceTier,
      collector: r.collector as CollectorId,
      publisher: r.publisher_name,
      publisherDomain: researchPublisherDomain(r.collector, r.publisher_domain),
      deliveryId: r.delivery_id ?? null,
    },
    title: r.title,
    snippet: r.snippet,
    publishedAt: r.publisher_published_at,
    retrievedAt: r.retrieved_at,
    ingestedAt: r.ingested_at,
    providerObservedAt: r.provider_observed_at,
    timeBasis: r.time_basis as TimeBasis,
    filedAt: r.filed_at ?? null,
    status,
    scoreRetryAt: r.score_retry_at ?? null,
    // Older failed judgments may predate the persisted flag. Any failed row
    // with a recorded attempt could have reached the provider, so require an
    // explicit usage review even when that legacy flag is false.
    usageCheckRequired: r.score_usage_check_required === 1 || (r.status === "failed" && r.score_attempts > 0),
    score,
    classification,
    error: status === "corrupt" ? (r.score_error ?? "Stored judgment is incomplete and was withheld.") : r.score_error,
    secDocumentContext: parseSecDocumentContext(r.sec_document_context_json),
  };
}

function nullableBoolean(value: number | null | undefined): boolean | null {
  return value == null ? null : value === 1;
}

export type RawMentionInput = RawMention;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sqlValue(value: unknown): SQLInputValue {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : finiteNumber(value);
}

function domainOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ocid$|cmpid$)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

function legacyCollectorFor(kind: SourceKind): CollectorId {
  if (kind === "sec") return "sec_edgar";
  if (kind === "x" || kind === "reddit" || kind === "finnhub") return kind;
  return "legacy_unknown";
}

function channelFor(kind: SourceKind): EvidenceChannel {
  if (kind === "sec") return "filing";
  if (kind === "x" || kind === "reddit") return "social";
  return "news";
}
