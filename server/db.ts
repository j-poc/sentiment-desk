import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type {
  CollectorId,
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
} from "./types.js";
import { deliveryHealthState, type DeliveryHealthState } from "./delivery.js";
import { researchPublisherDomain } from "./publisher-domain.js";

// Historical simulation and unverified legacy rows stay in place for audit,
// but only observations with an identified collector can enter live research
// or current operational usage totals.
const REAL_MENTION_FILTER = "collector NOT IN ('demo_simulation', 'legacy_unknown') AND COALESCE(engine, '') <> 'demo-sim'";

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
  CHECK (parsed_item_count >= 0),
  CHECK (result IN ('success', 'empty', 'partial', 'failed', 'rate_limited', 'invalid'))
);
CREATE INDEX IF NOT EXISTS deliveries_collector_completed ON source_deliveries(collector, completed_at DESC);
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
 resolved_model TEXT, latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0), error_category TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jev_attempt_dispatch_once ON jev_attempt_events(attempt_id) WHERE event_type = 'dispatch_intent';
CREATE UNIQUE INDEX IF NOT EXISTS jev_attempt_terminal_once ON jev_attempt_events(attempt_id) WHERE event_type IN ('response', 'rejected', 'unknown', 'not_sent');
CREATE TRIGGER IF NOT EXISTS jev_request_attempts_no_update BEFORE UPDATE ON jev_request_attempts BEGIN SELECT RAISE(ABORT, 'Jev request attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jev_request_attempts_no_delete BEFORE DELETE ON jev_request_attempts BEGIN SELECT RAISE(ABORT, 'Jev request attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jev_attempt_events_no_update BEFORE UPDATE ON jev_attempt_events BEGIN SELECT RAISE(ABORT, 'Jev request attempt events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jev_attempt_events_no_delete BEFORE DELETE ON jev_attempt_events BEGIN SELECT RAISE(ABORT, 'Jev request attempt events are immutable'); END;
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
}

export type BudgetedScoreClaim =
  | { kind: "claimed"; row: MentionRow; attemptId: string }
  | { kind: "budget_exhausted" }
  | { kind: "not_claimed" };

export type JevAttemptOutcome = "response" | "rejected" | "unknown" | "not_sent";
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

export class Desk {
  private readonly db: DatabaseSync;
  private readonly runtimeId: string;
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
    const jevAttemptCols = new Set(
      (this.db.prepare("PRAGMA table_info(jev_request_attempts)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!jevAttemptCols.has("runtime_id")) {
      this.db.exec("ALTER TABLE jev_request_attempts ADD COLUMN runtime_id TEXT NOT NULL DEFAULT 'legacy-runtime'");
      this.db.prepare("INSERT OR IGNORE INTO desk_runtime_sessions(id, pid, started_at, closed_at) VALUES ('legacy-runtime', 0, 0, 0)").run();
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
        o.publisher_name, o.publisher_domain, o.filed_at, o.scoped,
        j.status, j.sentiment, j.confidence, j.p_pos, j.p_neu, j.p_neg, j.about, j.material,
        j.novel, j.credible, j.investor_relevant, j.event_type, j.takeaway, j.magnitude,
        j.surprise, j.event_score, j.impact, j.weight, j.exclude, j.engine, j.input_tokens,
        j.output_tokens, j.cost_usd, j.latency_ms, j.rubric_sha, j.score_error, j.scored_at,
        j.score_attempts, j.score_retry_at, j.score_usage_check_required
      FROM source_observations o JOIN jev_judgments j ON j.observation_id = o.id`);
  }

  private recoverUnfinishedJevAttempts(): void {
    const unfinished = this.db.prepare(`SELECT a.id, a.observation_id, a.attempt_number, s.pid, s.closed_at,
        EXISTS(SELECT 1 FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type = 'dispatch_intent') AS dispatch_started
      FROM jev_request_attempts a LEFT JOIN desk_runtime_sessions s ON s.id = a.runtime_id
      WHERE NOT EXISTS (SELECT 1 FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response', 'rejected', 'unknown', 'not_sent'))
      ORDER BY a.reserved_at`).all() as Array<{ id: string; observation_id: string; attempt_number: number; pid: number | null; closed_at: number | null; dispatch_started: number }>;
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
      }
      const fail = this.db.prepare(`UPDATE jev_judgments SET status='failed', score_retry_at=NULL,
        score_usage_check_required=?, score_error=? WHERE observation_id=? AND status='scoring' AND score_attempts=?`);
      for (const row of recoverableScoring) {
        const attempt = unfinished.find((candidate) => candidate.id === row.attempt_id);
        const outcome = row.terminal_outcome ?? (attempt ? attempt.dispatch_started === 1 ? "unknown" : "not_sent" : "unknown");
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
        `SELECT collector, company_id, adapter_version, result FROM source_deliveries WHERE id = ?`,
      ).get(deliveryId) as { collector: string; company_id: string | null; adapter_version: string; result: string } | undefined;
      if (!delivery) throw new Error("Source observation references a missing delivery receipt");
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
  }): BudgetedScoreClaim {
    if (input.allowedCollectors.length === 0) return { kind: "not_claimed" };
    if (!/^[a-f0-9]{64}$/.test(input.requestSha256) || !/^[a-f0-9]{64}$/.test(input.rubricSha256) || !input.requestedModel.trim()) {
      throw new Error("valid Jev request digest, rubric digest, and requested model are required for a scoring claim");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.utcDay) ||
      !Number.isSafeInteger(input.requestBytes) || input.requestBytes <= 0 ||
      !Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0 ||
      !Number.isSafeInteger(input.maxRequestBytes) || input.maxRequestBytes <= 0
    ) return { kind: "budget_exhausted" };

    const collectorSlots = input.allowedCollectors.map(() => "?").join(", ");
    const requestKey = `jev:budget:${input.utcDay}:requests`;
    const bytesKey = `jev:budget:${input.utcDay}:request-bytes`;
    const closedKey = `jev:budget:${input.utcDay}:closed`;
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
        (id, observation_id, runtime_id, attempt_number, request_sha256, request_bytes, requested_model, rubric_sha, reserved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attemptId, input.id, this.runtimeId, row.score_attempts, input.requestSha256, input.requestBytes, input.requestedModel.trim(), input.rubricSha256, input.now);
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
    const exists = this.db.prepare("SELECT 1 FROM jev_request_attempts WHERE id = ?").get(receipt.attemptId);
    if (!exists) throw new Error("Jev attempt receipt has no matching request attempt");
    const dispatched = this.db.prepare("SELECT 1 FROM jev_attempt_events WHERE attempt_id = ? AND event_type = 'dispatch_intent'").get(receipt.attemptId);
    if (receipt.outcome === "not_sent" ? Boolean(dispatched) : !dispatched) {
      throw new Error("Jev attempt receipt does not match its dispatch-intent state");
    }
    this.db.prepare(`INSERT INTO jev_attempt_events
      (id, attempt_id, event_type, occurred_at, http_status, input_tokens, output_tokens, resolved_model, latency_ms, error_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), receipt.attemptId, receipt.outcome, receipt.occurredAt, receipt.httpStatus,
        receipt.inputTokens, receipt.outputTokens, receipt.resolvedModel, receipt.latencyMs, receipt.errorCategory);
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
        (SELECT error_category FROM jev_attempt_events e WHERE e.attempt_id = a.id AND e.event_type IN ('response','rejected','unknown','not_sent')) AS error_category
      FROM jev_request_attempts a WHERE a.observation_id = ? ORDER BY a.attempt_number DESC LIMIT ?`).all(observationId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      attemptId: String(row.attempt_id), attemptNumber: Number(row.attempt_number), requestSha256: String(row.request_sha256),
      requestBytes: Number(row.request_bytes), requestedModel: String(row.requested_model), rubricSha256: String(row.rubric_sha),
      reservedAt: Number(row.reserved_at), dispatchAt: row.dispatch_at == null ? null : Number(row.dispatch_at),
      outcome: String(row.outcome) as JevAttemptSummary["outcome"], completedAt: row.completed_at == null ? null : Number(row.completed_at),
      httpStatus: row.http_status == null ? null : Number(row.http_status), inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? null : Number(row.output_tokens), resolvedModel: row.resolved_model == null ? null : String(row.resolved_model),
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms), errorCategory: row.error_category == null ? null : String(row.error_category),
    }));
  }

  recordDelivery(delivery: SourceDeliveryInput): string {
    if (delivery.collector === "demo_simulation") throw new Error("Synthetic deliveries cannot be recorded by the application");
    if (delivery.collector === "legacy_unknown") throw new Error("Source collector provenance is required before recording a delivery");
    const id = randomUUID();
    this.db.prepare(
      `INSERT OR IGNORE INTO source_deliveries
       (id, collector, company_id, request_key_hash, started_at, completed_at, result,
        parsed_item_count, response_digest, adapter_version, error, processing_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, delivery.collector, delivery.companyId,
      createHash("sha256").update(delivery.requestKey).digest("hex"), delivery.startedAt,
      delivery.completedAt, delivery.result, delivery.parsedItemCount,
      delivery.responseDigest ?? null, delivery.adapterVersion,
      delivery.error ? delivery.error.slice(0, 500) : null, delivery.processingRequired ? 1 : 0,
    );
    return id;
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
    return this.db.prepare(
      `SELECT collector, company_id AS companyId, result, completed_at AS completedAt,
        parsed_item_count AS parsedItemCount, adapter_version AS adapterVersion, error
       FROM source_deliveries WHERE collector NOT IN ('demo_simulation', 'legacy_unknown') ORDER BY completed_at DESC, started_at DESC, rowid DESC LIMIT 60`,
    ).all() as unknown as Array<{
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
    const attempts = this.db.prepare(
      `WITH ranked AS (
        SELECT d.collector, d.company_id AS companyId, d.completed_at AS completedAt, d.result,
          d.parsed_item_count AS parsedItemCount, d.error, d.adapter_version AS adapterVersion,
          d.processing_required AS processingRequired, i.status AS ingestionState,
          i.started_at AS ingestionStartedAt, i.expected_count AS ingestionExpectedCount,
          i.processed_count AS ingestionProcessedCount, i.inserted_count AS ingestionInsertedCount,
          i.error AS ingestionError,
          ROW_NUMBER() OVER (PARTITION BY d.collector, COALESCE(d.company_id, ''), d.adapter_version
            ORDER BY d.completed_at DESC, d.started_at DESC, d.rowid DESC) AS rn
        FROM source_deliveries d LEFT JOIN source_ingestions i ON i.delivery_id = d.id
        WHERE d.collector NOT IN ('demo_simulation', 'legacy_unknown')
      )
      SELECT collector, companyId, completedAt, result, parsedItemCount, error, adapterVersion,
        processingRequired, ingestionState, ingestionStartedAt, ingestionExpectedCount,
        ingestionProcessedCount, ingestionInsertedCount, ingestionError
      FROM ranked WHERE rn = 1`,
    ).all() as unknown as DeliveryRow[];
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
      all: "status IN ('pending', 'scoring', 'retrying', 'scored', 'off_target', 'failed', 'corrupt')",
      bull: "status = 'scored' AND sentiment = 'positive'",
      bear: "status = 'scored' AND sentiment = 'negative'",
      material: "status = 'scored' AND COALESCE(material, 0) >= 0.6",
      offtarget: "status = 'off_target'",
      failed: "status IN ('pending', 'retrying', 'scoring', 'failed', 'corrupt')",
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
        `SELECT * FROM mentions WHERE ${REAL_MENTION_FILTER} AND status IN ('scored', 'pending', 'retrying', 'scoring', 'failed', 'corrupt')
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

  remainingJevRequests(input: { utcDay: string; maxRequests: number; maxRequestBytes: number }): number {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.utcDay) ||
      !Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0 ||
      !Number.isSafeInteger(input.maxRequestBytes) || input.maxRequestBytes <= 0
    ) return 0;
    const closed = this.getKv(`jev:budget:${input.utcDay}:closed`);
    if (closed !== undefined && closed !== "0") return 0;
    const requests = this.getKv(`jev:budget:${input.utcDay}:requests`);
    const requestBytes = this.getKv(`jev:budget:${input.utcDay}:request-bytes`);
    const usedRequests = requests === undefined ? 0 : Number(requests);
    const usedBytes = requestBytes === undefined ? 0 : Number(requestBytes);
    if (
      !Number.isSafeInteger(usedRequests) || usedRequests < 0 ||
      !Number.isSafeInteger(usedBytes) || usedBytes < 0 ||
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

  close(): void {
    if (this.closed) return;
    this.db.prepare("UPDATE desk_runtime_sessions SET closed_at=? WHERE id=? AND closed_at IS NULL").run(Date.now(), this.runtimeId);
    this.db.close();
    this.closed = true;
  }
}

export function rowToDTO(r: MentionRow): MentionDTO {
  const wantsScore = r.status === "scored" || r.status === "off_target";
  const values = [r.p_pos, r.p_neu, r.p_neg, r.confidence, r.about, r.material, r.novel,
    r.credible, r.investor_relevant, r.magnitude, r.surprise, r.event_score, r.impact,
    r.weight, r.input_tokens, r.output_tokens, r.cost_usd, r.latency_ms, r.scored_at];
  const complete = wantsScore && values.every((v) => typeof v === "number" && Number.isFinite(v))
    && (r.sentiment === "positive" || r.sentiment === "neutral" || r.sentiment === "negative")
    && typeof r.event_type === "string" && typeof r.takeaway === "string"
    && typeof r.engine === "string" && typeof r.rubric_sha === "string";
  const status: MentionStatus = r.status === "corrupt" || (wantsScore && !complete)
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
    error: status === "corrupt" ? (r.score_error ?? "Stored Jev judgment is incomplete and was withheld.") : r.score_error,
  };
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
