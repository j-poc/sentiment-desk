import type { CategoricalBucketCursor, CategoricalBucketEvidencePage, CategoricalTrendCounts, CategoricalTrendResult } from "./types.js";
import type { Desk, JevAttemptReceipt, ModelProvider, RawMentionInput } from "./db.js";
import { rowToDTO } from "./db.js";
import { createHash } from "node:crypto";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import { JevError, prepareJevRequest, type PreparedJevRequest } from "./jev.js";
import { OpenAIClassifierError, OPENAI_PROMPT_VERSION, OPENAI_SCHEMA_VERSION, prepareOpenAIRequest, type OpenAIClassifierResult, type PreparedOpenAIRequest } from "./openai-classifier.js";
import { RUBRIC, RUBRIC_SHA } from "./rubric.js";
import { researchPublisherDomain } from "./publisher-domain.js";
import { StorageCapacityError } from "./storage-capacity.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import {
  applyPostRules,
  bucketMsFor,
  forwardReturn,
  hasStrongIdentity,
  parseJudgment,
  shouldAlert,
  weightedBucketSeries,
  summarizeReactions,
  weightedIndex,
} from "./scoring.js";
import { TIER_WEIGHT } from "./sources/tiers.js";
import type {
  Company,
  CategoricalClassification,
  CompanySnapshot,
  CollectorId,
  EarningsSurprise,
  JevState,
  MentionScore,
  SeriesPoint,
  SeriesResult,
  SourceTier,
} from "./types.js";

/**
 * The pipeline ties ingestion to judgment: normalized mentions enter, validated
 * Jev judgments leave, the index recomputes, and every change is broadcast.
 * Scoring runs through a bounded-concurrency queue so a burst of mentions never
 * stampedes the API, and a failed judgment is marked failed, never silently
 * dropped and never replaced by a default score.
 */

export interface JudgeFn {
  (state: JevState, prepared: PreparedJevRequest): Promise<{
    answers: Record<string, unknown>;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    httpStatus: number;
  }>;
}

export interface PipelineDeps {
  db: Desk;
  judge: JudgeFn | null;
  classifier?: ((prepared: PreparedOpenAIRequest) => Promise<OpenAIClassifierResult>) | null;
  provider?: ModelProvider;
  hub: Hub;
  health: HealthTracker;
  engineLabel: string;
  inputPricePerMTok: number;
  concurrency: number;
  allowedCollectors: ReadonlySet<CollectorId>;
  externalRequestsEnabled?: boolean;
  dailyBudget: {
    utcDay: () => string;
    maxRequests: number;
    maxRequestBytes: number;
    maxDailyCostMicros?: number;
  };
  alert?: { webhookUrl: string; eventScore: number; impact: number; freshMinutes: number };
}

export type OperatorRetryResult =
  | "queued"
  | "usage_review_required"
  | "not_retryable"
  | "jev_unavailable"
  | "classifier_not_configured"
  | "classifier_source_not_allowed"
  | "classifier_daily_budget_exhausted"
  | "budget_exhausted"
  | "storage_paused";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_JEV_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;

function safeJevFailureMessage(error: unknown): string {
  if (!(error instanceof JevError)) return "Jev scoring failed due to an internal processing error";
  if (error.status != null && (error.status < 200 || error.status >= 300)) return `TypeSafe request failed (HTTP ${error.status})`;
  if (error.status != null) return `TypeSafe response failed validation (HTTP ${error.status})`;
  if (error.outcomeUnknown) return "TypeSafe request outcome is unknown";
  return "TypeSafe request failed before a valid response was received";
}

export class Pipeline {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private inFlight = 0;
  private readonly idleWaiters = new Set<() => void>();
  private memoryCache: Map<string, { at: number; block: JevState["deskMemory"] }> = new Map();
  private alertDispatchPromise: Promise<void> | null = null;
  private alertDispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private alertDispatchDueAt: number | null = null;
  private alertDispatchStopped = false;
  private readonly pendingCompanySnapshots = new Map<string, ReturnType<typeof setImmediate>>();
  private companySnapshotsStopped = false;

  private companyCache: Map<
    string,
    { name: string; ticker: string; sector: string; color: string; aliases: string[]; ambiguous?: boolean }
  > | null = null;

  constructor(private readonly deps: PipelineDeps) {
    if (this.alertDeliveryEnabled) queueMicrotask(() => { void this.dispatchAlerts().catch(() => undefined); });
  }

  get alertDeliveryConfigured(): boolean { return Boolean(this.deps.alert?.webhookUrl); }
  get alertDeliveryEnabled(): boolean { return this.alertDeliveryConfigured && this.deps.externalRequestsEnabled !== false; }

  /** Insert a normalized source observation; exact replays do not reach classification. */
  ingest(m: RawMentionInput): boolean {
    if (!m.deliveryId) throw new Error("A persisted source delivery receipt is required before an observation can be ingested");
    const stored = this.deps.db.insertObservation(m);
    if (stored.inserted) {
      const persisted = this.deps.db.mentionRow(stored.observationId);
      if (persisted) {
        this.deps.hub.broadcast("mention", rowToDTO(persisted));
        this.scheduleCompanySnapshot(persisted.company_id);
      }
    }
    const collector = m.collector ?? "legacy_unknown";
    if (stored.inserted && this.deps.externalRequestsEnabled !== false && this.activeProviderReady && this.deps.allowedCollectors.has(collector) && this.hasDailyBudgetCapacity()) {
      this.enqueue(stored.observationId);
    }
    return stored.inserted;
  }

  /** Re-queue existing pending mentions (used after rubric migrations). */
  drainPending(limit = 1_000): number {
    if (this.deps.externalRequestsEnabled === false || !this.activeProviderReady || this.deps.allowedCollectors.size === 0
      || !this.deps.db.canStartExternalWork()) return 0;
    const remaining = this.remainingDailyRequests();
    if (remaining <= 0) return 0;
    const ids = this.deps.db.pendingIds(Math.min(limit, remaining), [...this.deps.allowedCollectors]);
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }

  retryFailed(id: string, reviewedProviderUsage: boolean): OperatorRetryResult {
    if (this.deps.externalRequestsEnabled === false || !this.activeProviderReady) return this.activeProvider === "openai_luna" ? "classifier_not_configured" : "jev_unavailable";
    if (!this.deps.db.prepareExternalWork()) return "storage_paused";
    const current = this.deps.db.mentionRow(id);
    if (!current) return "not_retryable";
    if (![...this.deps.allowedCollectors].some((collector) => collector === current.collector)) {
      return "classifier_source_not_allowed";
    }
    if (!this.hasDailyBudgetCapacity()) return this.activeProvider === "openai_luna" ? "classifier_daily_budget_exhausted" : "budget_exhausted";
    let result: ReturnType<Desk["requeueFailed"]>;
    try {
      result = this.deps.db.requeueFailed(id, reviewedProviderUsage);
    } catch (error) {
      if (error instanceof StorageCapacityError) return "storage_paused";
      throw error;
    }
    if (result !== "queued") return result;
    const requeued = this.deps.db.mentionRow(id);
    if (requeued) this.deps.hub.broadcast("mention", rowToDTO(requeued));
    this.deps.db.logEvent(
      "info",
      this.activeProvider,
      `operator authorized a new ${this.activeProvider === "openai_luna" ? "OpenAI Luna" : "Jev"} input for failed judgment ${id}; provider usage review=${reviewedProviderUsage}`,
    );
    this.enqueue(id);
    return "queued";
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.pump();
  }

  private remainingDailyRequests(): number {
    return this.deps.db.remainingJevRequests({
      utcDay: this.deps.dailyBudget.utcDay(),
      maxRequests: this.deps.dailyBudget.maxRequests,
      maxRequestBytes: this.deps.dailyBudget.maxRequestBytes,
      provider: this.activeProvider,
      maxDailyCostMicros: this.deps.dailyBudget.maxDailyCostMicros,
    });
  }

  private get activeProvider(): ModelProvider { return this.deps.provider ?? "typesafe"; }
  private get activeProviderReady(): boolean {
    return this.activeProvider === "openai_luna" ? Boolean(this.deps.classifier) : Boolean(this.deps.judge);
  }

  private hasDailyBudgetCapacity(): boolean {
    return this.remainingDailyRequests() > 0;
  }

  private pump(): void {
    while (this.inFlight < this.deps.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      this.queued.delete(id);
      this.inFlight += 1;
      void this.scoreOne(id).catch((error: unknown) => {
        if (!(error instanceof StorageCapacityError)) {
          console.error("[desk] classification worker failed without changing persisted state:", error);
        }
      }).finally(() => {
        this.inFlight -= 1;
        this.pump();
        this.resolveIdleWaiters();
      });
    }
  }

  waitForIdle(): Promise<void> {
    if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async waitForAlertIdle(): Promise<void> {
    while (this.alertDispatchPromise) await this.alertDispatchPromise;
  }

  stop(): void {
    this.alertDispatchStopped = true;
    if (this.alertDispatchTimer != null) clearTimeout(this.alertDispatchTimer);
    this.alertDispatchTimer = null;
    this.alertDispatchDueAt = null;
    this.companySnapshotsStopped = true;
    for (const timer of this.pendingCompanySnapshots.values()) clearImmediate(timer);
    this.pendingCompanySnapshots.clear();
  }

  private scheduleCompanySnapshot(companyId: string): void {
    if (this.companySnapshotsStopped || this.pendingCompanySnapshots.has(companyId)) return;
    const timer = setImmediate(() => {
      this.pendingCompanySnapshots.delete(companyId);
      if (this.companySnapshotsStopped) return;
      try {
        this.deps.hub.broadcast("company", this.snapshot(companyId));
      } catch (error) {
        console.error("[desk] deferred company snapshot broadcast failed:", error);
      }
    });
    this.pendingCompanySnapshots.set(companyId, timer);
  }

  private broadcastCompanySnapshot(companyId: string): void {
    const timer = this.pendingCompanySnapshots.get(companyId);
    if (timer) {
      clearImmediate(timer);
      this.pendingCompanySnapshots.delete(companyId);
    }
    this.deps.hub.broadcast("company", this.snapshot(companyId));
  }

  private resolveIdleWaiters(): void {
    if (this.inFlight !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async scoreOne(id: string): Promise<void> {
    const db = this.deps.db;
    const queuedRow = db.mentionRow(id);
    if (this.deps.externalRequestsEnabled === false || !queuedRow || (queuedRow.status !== "pending" && queuedRow.status !== "retrying")) return;
    if (![...this.deps.allowedCollectors].some((collector) => collector === queuedRow.collector)) return;
    if (!db.prepareExternalWork()) return;

    if (this.activeProvider === "openai_luna") {
      await this.classifyOne(id);
      return;
    }

    if (!this.deps.judge) {
      // No engine configured: leave the real observation pending. An
      // intentionally absent provider is not a failed provider request.
      return;
    }
    if (!this.hasDailyBudgetCapacity()) return;

    const meta = this.companyMeta(queuedRow.company_id);
    // Lexically ambiguous names matched by text alone (Google News, GDELT)
    // must clear a much higher about bar: "apple sauce" is not Apple Inc.
    const strongIdentity = hasStrongIdentity({
      company: { name: meta.name, ticker: meta.ticker, aliases: meta.aliases, ambiguous: meta.ambiguous },
      title: queuedRow.title,
      snippet: queuedRow.snippet,
      scoped: queuedRow.scoped === 1,
    });
    const strictAbout = meta.ambiguous === true && !strongIdentity;
    const deskMemory = this.memoryFor(queuedRow.company_id, meta.ticker);
    const state: JevState = {
      company: {
        id: queuedRow.company_id,
        name: meta.name,
        ticker: meta.ticker,
        sector: meta.sector,
      },
      mention: {
        title: queuedRow.title,
        snippet: queuedRow.snippet,
        source: {
          collector: queuedRow.collector as CollectorId,
          collectionUrl: queuedRow.source_url,
          tier: queuedRow.source_tier as SourceTier,
          publisherName: queuedRow.publisher_name,
          publisherDomain: researchPublisherDomain(queuedRow.collector, queuedRow.publisher_domain),
        },
        publishedAt: queuedRow.published_at == null
          ? "Unknown (publisher did not provide a timestamp)"
          : new Date(queuedRow.published_at).toISOString(),
      },
      deskMemory,
    };

    const prepared = prepareJevRequest(this.deps.engineLabel, state, RUBRIC, RUBRIC_SHA);
    const claim = db.claimForScoringWithBudget({
      id,
      now: Date.now(),
      allowedCollectors: [...this.deps.allowedCollectors],
      utcDay: this.deps.dailyBudget.utcDay(),
      requestBytes: prepared.requestBytes,
      requestSha256: prepared.payloadSha256,
      requestedModel: prepared.requestedModel,
      rubricSha256: prepared.rubricSha256,
      maxRequests: this.deps.dailyBudget.maxRequests,
      maxRequestBytes: this.deps.dailyBudget.maxRequestBytes,
    });
    if (claim.kind !== "claimed") return;
    const row = claim.row;
    this.deps.hub.broadcast("mention", rowToDTO(row));

    let judgeResponse: Awaited<ReturnType<JudgeFn>> | null = null;
    let attemptReceiptPersisted = false;
    let dispatchIntentRecorded = false;
    let scoreCommitted = false;
    try {
      if (!db.recordJevDispatchIntent(claim.attemptId, Date.now())) {
        throw new Error("Jev dispatch intent could not be durably recorded; request was not sent");
      }
      dispatchIntentRecorded = true;
      const out = await this.deps.judge(state, prepared);
      judgeResponse = out;
      if (
        !Number.isSafeInteger(out.inputTokens) || out.inputTokens < 0 ||
        !Number.isSafeInteger(out.outputTokens) || out.outputTokens < 0
      ) {
        throw new Error("Jev returned invalid token usage; score withheld");
      }
      const parsed = parseJudgment(out.answers);
      const tier = row.source_tier as SourceTier;
      const final = applyPostRules(parsed, TIER_WEIGHT[tier], { strictAbout: strictAbout });
      const inputTokens = out.inputTokens;
      const score: MentionScore = {
        sentiment: parsed.sentiment,
        pPos: parsed.pPos,
        pNeu: parsed.pNeu,
        pNeg: parsed.pNeg,
        confidence: parsed.confidence,
        about: parsed.about,
        material: parsed.material,
        novel: parsed.novel,
        credible: parsed.credible,
        investorRelevant: parsed.investorRelevant,
        eventType: parsed.eventType,
        takeaway: parsed.takeaway,
        magnitude: parsed.magnitude,
        surprise: parsed.surprise,
        eventScore: final.eventScore,
        impact: final.impact,
        weight: final.weight,
        engine: out.model,
        inputTokens,
        outputTokens: out.outputTokens,
        estimatedInputCostUsd: (inputTokens / 1_000_000) * this.deps.inputPricePerMTok,
        latencyMs: out.latencyMs,
        rubricSha: RUBRIC_SHA,
        scoredAt: Date.now(),
      };
      const alert = this.alertIntent(row, score, final.exclude);
      db.markScored(id, score, final.exclude, alert, {
        attemptId: claim.attemptId,
        outcome: "response",
        occurredAt: Date.now(),
        httpStatus: out.httpStatus,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        resolvedModel: out.model,
        latencyMs: out.latencyMs,
        errorCategory: null,
      });
      scoreCommitted = true;
      attemptReceiptPersisted = true;
      this.deps.health.recordJev(true);

      const updated = db.mentionRow(id);
      if (updated) {
        this.deps.hub.broadcast("mention", rowToDTO(updated));
        this.broadcastCompanySnapshot(row.company_id);
        await this.dispatchAlerts();
      }
    } catch (err) {
      if (scoreCommitted) {
        try { db.logEvent("warn", "pipeline", `score saved for ${id}; a follow-up notification failed`); } catch { /* keep the committed judgment authoritative */ }
        return;
      }
      const storagePaused = err instanceof ExternalRequestPausedError && err.dispatchedRequests === 0;
      const message = safeJevFailureMessage(err);
      if (!attemptReceiptPersisted) {
        const status = err instanceof JevError ? err.status ?? null : judgeResponse?.httpStatus ?? null;
        const outcome: JevAttemptReceipt["outcome"] = storagePaused
          ? "not_sent"
          : judgeResponse
          ? "response"
          : err instanceof JevError && err.status != null && (err.status < 500 || err.status === 529)
            ? "rejected"
            : dispatchIntentRecorded
              ? "unknown"
              : "not_sent";
        const category = storagePaused
          ? "storage_paused"
          : judgeResponse
          ? "response_validation_failed"
          : outcome === "rejected"
            ? status === 429 || status === 529 ? "provider_overloaded" : "http_rejected"
            : outcome === "unknown"
              ? err instanceof JevError && err.status != null ? "provider_outcome_unknown" : "transport_outcome_unknown"
              : "dispatch_intent_not_recorded";
        try {
          db.recordJevAttemptReceipt({
            attemptId: claim.attemptId,
            outcome,
            occurredAt: Date.now(),
            httpStatus: status,
            inputTokens: judgeResponse?.inputTokens ?? null,
            outputTokens: judgeResponse?.outputTokens ?? null,
            resolvedModel: judgeResponse?.model ?? null,
            latencyMs: judgeResponse?.latencyMs ?? null,
            errorCategory: category,
          });
          attemptReceiptPersisted = true;
        } catch {
          // Startup recovery will close an unfinished attempt conservatively from its durable dispatch intent.
        }
      }
      if (storagePaused) {
        const retryAt = Date.now() + RETRY_BASE_MS;
        db.markRetrying(id, "Storage admission paused the request before dispatch; no provider call was sent. It will retry automatically.", retryAt);
        const updated = db.mentionRow(id);
        if (updated) this.deps.hub.broadcast("mention", rowToDTO(updated));
        return;
      }
      if (err instanceof JevError && err.retryable && row.score_attempts < MAX_JEV_ATTEMPTS) {
        const backoffMs = RETRY_BASE_MS * 2 ** (row.score_attempts - 1);
        const retryAt = Date.now() + Math.max(backoffMs, err.retryAfterMs ?? 0);
        db.markRetrying(id, `${message}; retry ${row.score_attempts + 1} of ${MAX_JEV_ATTEMPTS} is scheduled`, retryAt);
      } else {
        const outcomeNote = err instanceof JevError && err.outcomeUnknown
          ? "; provider outcome is unknown, so automatic retry is withheld to avoid a duplicate charge"
          : "";
        const usageCheckRequired = judgeResponse !== null || (
          err instanceof JevError && (err.outcomeUnknown || err.status != null)
        );
        db.markFailed(id, `${message}${outcomeNote}`, usageCheckRequired);
      }
      this.deps.health.recordJev(false, message);
      db.logEvent("warn", "jev", `score failed for ${id}: ${message}`);
      const updated = db.mentionRow(id);
      if (updated) this.deps.hub.broadcast("mention", rowToDTO(updated));
    }
  }

  private async classifyOne(id: string): Promise<void> {
    const db = this.deps.db;
    const row = db.mentionRow(id);
    const classifier = this.deps.classifier;
    if (!row || (row.status !== "pending" && row.status !== "retrying") || !classifier || !this.hasDailyBudgetCapacity()) return;
    const collector = row.collector as CollectorId;
    if (!this.deps.allowedCollectors.has(collector)) return;
    if (!db.prepareExternalWork()) return;
    const meta = this.companyMeta(row.company_id);
    const strongIdentity = hasStrongIdentity({
      company: { name: meta.name, ticker: meta.ticker, aliases: meta.aliases, ambiguous: meta.ambiguous },
      title: row.title, snippet: row.snippet, scoped: row.scoped === 1,
    });
    const prepared = prepareOpenAIRequest({
      company: { name: meta.name, ticker: meta.ticker, sector: meta.sector },
      source: { collector, publisher: row.publisher_name, title: row.title, excerpt: row.snippet },
    });
    const maxOutputCostMicros = prepared.maxOutputTokens * 0.5;
    const reservedCostMicros = Math.ceil(prepared.requestBytes * 0.125 + maxOutputCostMicros);
    const claim = db.claimForScoringWithBudget({
      id, now: Date.now(), allowedCollectors: [...this.deps.allowedCollectors],
      utcDay: this.deps.dailyBudget.utcDay(), requestBytes: prepared.requestBytes,
      requestSha256: prepared.payloadSha256, requestedModel: prepared.requestedModel,
      rubricSha256: prepared.profileSha256, maxRequests: this.deps.dailyBudget.maxRequests,
      maxRequestBytes: this.deps.dailyBudget.maxRequestBytes, provider: "openai_luna",
      maxDailyCostMicros: this.deps.dailyBudget.maxDailyCostMicros ?? 0, reservedCostMicros,
      requestedServiceTier: prepared.requestedServiceTier, maxOutputTokens: prepared.maxOutputTokens,
      schemaSha256: prepared.schemaSha256,
    });
    if (claim.kind !== "claimed") return;
    const claimed = claim.row;
    this.deps.hub.broadcast("mention", rowToDTO(claimed));
    let result: OpenAIClassifierResult | null = null;
    let intentRecorded = false;
    let receiptRecorded = false;
    try {
      if (!db.recordJevDispatchIntent(claim.attemptId, Date.now())) throw new Error("OpenAI dispatch intent could not be durably recorded; request was not sent");
      intentRecorded = true;
      result = await classifier(prepared);
      const { classification: raw, usage } = result;
      const disposition: CategoricalClassification["disposition"] = raw.about === false || raw.investorRelevant === false
        ? "excluded"
        : !strongIdentity || !raw.evidenceSufficient || raw.about == null || raw.material == null || raw.investorRelevant == null ||
          raw.sentiment == null || raw.eventType == null || raw.takeaway == null
          ? "review_required"
          : "classified";
      const classification: CategoricalClassification = {
        provider: "openai_luna", modelRequested: prepared.requestedModel, modelReturned: result.modelReturned,
        serviceTierRequested: prepared.requestedServiceTier, serviceTier: result.serviceTier,
        promptVersion: OPENAI_PROMPT_VERSION, promptSha256: prepared.promptSha256,
        schemaVersion: OPENAI_SCHEMA_VERSION, schemaSha256: prepared.schemaSha256,
        ...raw, disposition, responseId: result.responseId, responseSha256: result.responseSha256,
        inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
        estimatedCostUsd: usage.estimatedCostUsd, latencyMs: result.latencyMs, classifiedAt: Date.now(),
      };
      db.recordCategoricalClassification(id, classification, {
        attemptId: claim.attemptId, outcome: "response", occurredAt: Date.now(), httpStatus: result.httpStatus,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, resolvedModel: result.modelReturned,
        latencyMs: result.latencyMs, errorCategory: null, cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens, reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens, responseId: result.responseId,
        responseSha256: result.responseSha256, estimatedCostUsd: usage.estimatedCostUsd,
        responseServiceTier: result.serviceTier,
      });
      receiptRecorded = true;
      this.deps.health.recordClassifier(true);
      const updated = db.mentionRow(id);
      if (updated) {
        this.deps.hub.broadcast("mention", rowToDTO(updated));
        this.broadcastCompanySnapshot(claimed.company_id);
      }
    } catch (error) {
      const storagePaused = error instanceof ExternalRequestPausedError && error.dispatchedRequests === 0;
      const e = error instanceof OpenAIClassifierError ? error : null;
      const responseSeen = result != null || (e?.status != null && e.status >= 200 && e.status < 300);
      if (!receiptRecorded) {
        const outcome: JevAttemptReceipt["outcome"] = storagePaused ? "not_sent" : e?.outcomeUnknown ? "unknown" : responseSeen ? "response" : e?.status != null ? "rejected" : intentRecorded ? "unknown" : "not_sent";
        try {
          db.recordJevAttemptReceipt({
            attemptId: claim.attemptId, outcome, occurredAt: Date.now(), httpStatus: e?.status ?? result?.httpStatus ?? null,
            inputTokens: e?.usage?.inputTokens ?? result?.usage.inputTokens ?? null,
            outputTokens: e?.usage?.outputTokens ?? result?.usage.outputTokens ?? null,
            resolvedModel: result?.modelReturned ?? e?.returnedModel ?? null, latencyMs: e?.latencyMs ?? result?.latencyMs ?? null,
            errorCategory: storagePaused ? "storage_paused" : e ? e.outcomeUnknown ? "provider_outcome_unknown" : e.status === 429 ? "rate_limited_or_quota_exhausted" : "provider_rejected_or_response_invalid" : "internal_or_transport_outcome_unknown",
            cachedInputTokens: e?.usage?.cachedInputTokens ?? result?.usage.cachedInputTokens ?? null, reasoningTokens: e?.usage?.reasoningTokens ?? result?.usage.reasoningTokens ?? null,
            cacheWriteInputTokens: e?.usage?.cacheWriteInputTokens ?? result?.usage.cacheWriteInputTokens ?? null,
            totalTokens: e?.usage?.totalTokens ?? result?.usage.totalTokens ?? null, responseId: e?.responseId ?? result?.responseId ?? null,
            responseSha256: e?.responseSha256 ?? result?.responseSha256 ?? null, estimatedCostUsd: e?.usage?.estimatedCostUsd ?? result?.usage.estimatedCostUsd ?? null,
            responseServiceTier: e?.serviceTier ?? result?.serviceTier ?? null,
          });
          receiptRecorded = true;
        } catch { /* runtime recovery closes the durable attempt conservatively */ }
      }
      if (storagePaused) {
        const retryAt = Date.now() + RETRY_BASE_MS;
        db.markRetrying(id, "Storage admission paused the request before dispatch; no OpenAI call was sent. It will retry automatically.", retryAt);
        const updated = db.mentionRow(id);
        if (updated) this.deps.hub.broadcast("mention", rowToDTO(updated));
        return;
      }
      const message = e?.message ?? "OpenAI classification failed due to internal processing error";
      if (e?.retryable && claimed.score_attempts < MAX_JEV_ATTEMPTS) {
        const retryAt = Date.now() + Math.max(RETRY_BASE_MS * 2 ** (claimed.score_attempts - 1), e.retryAfterMs ?? 0);
        db.markRetrying(id, `${message}; retry ${claimed.score_attempts + 1} of ${MAX_JEV_ATTEMPTS} is scheduled`, retryAt);
      } else {
        const usageCheckRequired = Boolean(e?.outcomeUnknown || responseSeen || e?.status != null && e.status >= 500);
        db.markFailed(id, `${message}${e?.outcomeUnknown ? "; provider outcome is unknown, reservation retained and retry withheld" : ""}`, usageCheckRequired);
      }
      this.deps.health.recordClassifier(false, message);
      db.logEvent("warn", "classifier", `categorical classification failed for ${id}: ${message}`);
      const updated = db.mentionRow(id);
      if (updated) this.deps.hub.broadcast("mention", rowToDTO(updated));
    }
  }

  private alertIntent(row: { id: string; company_id: string; title: string; published_at: number | null }, score: MentionScore, excluded: boolean) {
    const alert = this.deps.alert;
    if (!this.alertDeliveryEnabled || !alert?.webhookUrl || excluded || row.published_at == null) return undefined;
    const now = Date.now();
    const meta = this.companyMeta(row.company_id);
    if (
      !shouldAlert({
        eventScore: score.eventScore,
        impact: score.impact,
        publishedAt: row.published_at,
        now,
        thresholdScore: alert.eventScore,
        thresholdImpact: alert.impact,
        freshMs: alert.freshMinutes * 60_000,
      })
    ) {
      return undefined;
    }
    const impact = score.impact;
    const eventScore = score.eventScore;
    const arrow = impact > 0 ? "↑" : impact < 0 ? "↓" : "·";
    const text = `${arrow} ${meta.ticker} ${impact > 0 ? "+" : ""}${impact.toFixed(0)} (event ${Math.round(eventScore)}) — ${row.title.slice(0, 140)}`;
    const destinationFingerprint = createHash("sha256").update(alert.webhookUrl).digest("hex");
    const policy = JSON.stringify({ eventScore: alert.eventScore, impact: alert.impact, freshMinutes: alert.freshMinutes, maxAttempts: 5, ttlMs: 24 * 60 * 60_000 });
    return {
      observationId: row.id,
      ruleVersion: createHash("sha256").update(policy).digest("hex"),
      payload: JSON.stringify({ text, content: text }),
      policy,
      destinationFingerprint,
      createdAt: now,
      expiresAt: Math.min(now + 24 * 60 * 60_000, row.published_at + alert.freshMinutes * 60_000),
    };
  }

  async dispatchAlerts(): Promise<void> {
    const alert = this.deps.alert;
    if (this.alertDispatchStopped || !this.alertDeliveryEnabled || !alert?.webhookUrl) return;
    if (this.alertDispatchPromise) return this.alertDispatchPromise;
    if (this.alertDispatchTimer != null) clearTimeout(this.alertDispatchTimer);
    this.alertDispatchTimer = null;
    this.alertDispatchDueAt = null;
    const run = this.drainAlertOutbox(alert.webhookUrl);
    const wrapped = run.finally(() => {
      if (this.alertDispatchPromise === wrapped) this.alertDispatchPromise = null;
    });
    this.alertDispatchPromise = wrapped;
    return wrapped;
  }

  private async drainAlertOutbox(webhookUrl: string): Promise<void> {
    const fingerprint = createHash("sha256").update(webhookUrl).digest("hex");
    try {
      while (!this.alertDispatchStopped) {
        if (!this.deps.db.prepareExternalWork()) {
          this.scheduleAlertWake(Date.now() + 30_000);
          return;
        }
        const now = Date.now();
        const claim = this.deps.db.claimAlert(now, fingerprint, 10_000, 5);
        if (!claim) {
          const dueAt = this.deps.db.nextAlertDispatchAt(now, fingerprint, 5);
          if (dueAt != null) this.scheduleAlertWake(dueAt);
          return;
        }
        if (!this.deps.db.alertClaimValid(claim, Date.now())) continue;
        let outcome: "delivered" | "retry" | "failed" | "ambiguous" = "failed";
        let status: number | null = null;
        let category: string | null = null;
        try {
          const response = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": claim.alertId }, body: claim.payload, signal: AbortSignal.timeout(5_000) });
          status = response.status;
          outcome = response.ok ? "delivered" : response.status >= 500 || response.status === 429 ? "retry" : "failed";
          if (!response.ok) category = response.status === 429 ? "http_rate_limited" : response.status >= 500 ? "http_server_error" : "http_rejected";
        } catch (error) {
          if (error instanceof ExternalRequestPausedError && error.dispatchedRequests === 0) {
            this.deps.db.deferAlertBeforeDispatch(claim, Date.now(), Date.now() + RETRY_BASE_MS);
            this.scheduleAlertWake(Date.now() + RETRY_BASE_MS);
            return;
          }
          outcome = "ambiguous"; category = "transport_ambiguous";
        }
        const backoff = Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, claim.attempt - 1));
        this.deps.db.completeAlert(claim, outcome, Date.now(), status, category, backoff);
        // Keep draining independent alerts after retryable and permanent failures.
        // The saved next-attempt time below schedules only work that is not due yet.
      }
    } catch {
      try { this.deps.db.logEvent("warn", "alerts", "alert dispatch worker failed; saved delivery intent remains pending"); } catch { /* preserve primary delivery state */ }
      this.scheduleAlertWake(Date.now() + 5_000);
    }
  }

  private scheduleAlertWake(dueAt: number): void {
    if (this.alertDispatchStopped || !this.alertDeliveryEnabled) return;
    if (this.alertDispatchTimer != null && this.alertDispatchDueAt != null && this.alertDispatchDueAt <= dueAt) return;
    if (this.alertDispatchTimer != null) clearTimeout(this.alertDispatchTimer);
    this.alertDispatchDueAt = dueAt;
    this.alertDispatchTimer = setTimeout(() => {
      this.alertDispatchTimer = null;
      this.alertDispatchDueAt = null;
      void this.dispatchAlerts();
    }, Math.max(1, Math.min(2_147_483_647, dueAt - Date.now())));
    this.alertDispatchTimer.unref?.();
  }

  /**
   * Reflection context: timely 30-minute reactions after this desk's own past
   * judgments became available, cached for 10 minutes and
   * attached to scoring state for calibration. Omitted below 5 measured
   * events — no memory is better than a noisy one.
   */
  private memoryFor(companyId: string, ticker: string): JevState["deskMemory"] {
    const cached = this.memoryCache.get(companyId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.block;
    let block: JevState["deskMemory"] | undefined;
    try {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const events = this.deps.db.scoredMentionEvents(since, now).filter((e) => e.companyId === companyId);
      const series = this.deps.db.priceWindow(ticker, since - 60 * 60 * 1000, now);
      const rows = events.map((e) => ({
        sentiment: e.sentiment,
        eventType: e.eventType,
        r30: forwardReturn(series, e.availableAt, 30 * 60_000, now),
        r240: null,
      }));
      const overall = summarizeReactions(rows);
      if (overall.n30m >= 5) {
        const fmt = (v: number | null) => (v == null ? "--" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
        const byType: Record<string, string> = {};
        for (const t of new Set(rows.map((r) => r.eventType))) {
          const s = summarizeReactions(rows.filter((r) => r.eventType === t));
          if (s.n30m >= 3) byType[t] = `n30m=${s.n30m}, median30m=${fmt(s.median30m)}, direction_match=${s.hitRate ?? "-"}%`;
        }
        block = {
          overall: `n30m=${overall.n30m}, median30m=${fmt(overall.median30m)}, direction_match=${overall.hitRate ?? "-"}%`,
          byType,
        };
        this.deps.db.logEvent("info", "memory", `${ticker}: ${block.overall}`);
      }
    } catch {
      block = undefined;
    }
    this.memoryCache.set(companyId, { at: Date.now(), block });
    return block;
  }

  private companyMeta(companyId: string): {
    name: string;
    ticker: string;
    sector: string;
    color: string;
    aliases: string[];
    ambiguous?: boolean;
  } {
    if (!this.companyCache) {
      this.companyCache = new Map(
        this.deps.db.companies().map((c) => [c.id, c] as const),
      );
    }
    return (
      this.companyCache.get(companyId) ?? {
        name: companyId,
        ticker: companyId,
        sector: "",
        color: "#64748b",
        aliases: [],
        ambiguous: false,
      }
    );
  }

  snapshot(companyId: string): CompanySnapshot {
    const now = Date.now();
    const companies = new Map(this.deps.db.companies().map((c) => [c.id, c] as const));
    const events = this.deps.db.scoredMentions(now - DAY_MS, now);
    const activity = this.deps.db.sourceActivity24h(now - DAY_MS);
    const extras = this.earningsExtras();
    return this.computeSnapshot(companies, activity, events, companyId, now, extras);
  }

  snapshots(): CompanySnapshot[] {
    const now = Date.now();
    const companies = this.deps.db.companies();
    const byId = new Map(companies.map((c) => [c.id, c] as const));
    const events = this.deps.db.scoredMentions(now - DAY_MS, now);
    const activity = this.deps.db.sourceActivity24h(now - DAY_MS);
    const extras = this.earningsExtras();
    return companies.map((c) => this.computeSnapshot(byId, activity, events, c.id, now, extras));
  }

  /** Measured earnings facts (Finnhub) cached in kv, surfaced on snapshots. */
  private earningsExtras(): Map<string, { earningsAt: number | null; lastSurprise: EarningsSurprise | null }> {
    const out = new Map<string, { earningsAt: number | null; lastSurprise: EarningsSurprise | null }>();
    for (const c of this.deps.db.companies()) {
      const earningsRaw = this.deps.db.getKv(`finnhub:earnings:${c.id}`);
      const surpriseRaw = this.deps.db.getKv(`finnhub:surprise:${c.id}`);
      const earningsAt = earningsRaw ? Number(earningsRaw) : NaN;
      let lastSurprise: EarningsSurprise | null = null;
      try {
        lastSurprise = surpriseRaw ? (JSON.parse(surpriseRaw) as EarningsSurprise) : null;
      } catch {
        lastSurprise = null;
      }
      out.set(c.id, {
        earningsAt: Number.isFinite(earningsAt) ? earningsAt : null,
        lastSurprise,
      });
    }
    return out;
  }

  private computeSnapshot(
    companies: Map<string, { id: string; name: string; ticker: string; sector: string; color: string }>,
    activity: Map<string, { sourceRecords24h: number; latestCollectedAt: number | null }>,
    events: Array<{ companyId: string; availableAt: number; impact: number; weight: number }>,
    companyId: string,
    now: number,
    extras: Map<string, { earningsAt: number | null; lastSurprise: EarningsSurprise | null }> = new Map(),
  ): CompanySnapshot {
    const meta = companies.get(companyId);
    const own = events.filter((m) => m.companyId === companyId);
    const currentEvents = own.filter((m) => m.availableAt >= now - CURRENT_WINDOW_MS);
    const current = weightedIndex(currentEvents);
    const baseline = weightedIndex(own);
    const index = current ?? baseline;
    const indexWindow = current != null ? "3h" : baseline != null ? "24h" : null;
    const indexEvents = indexWindow === "3h" ? currentEvents : indexWindow === "24h" ? own : [];
    const companyActivity = activity.get(companyId);
    return {
      id: companyId,
      name: meta?.name ?? companyId,
      ticker: meta?.ticker ?? companyId,
      sector: meta?.sector ?? "",
      color: meta?.color ?? "#64748b",
      index,
      indexWindow,
      indexRecordCount: indexEvents.filter((event) => event.weight > 0).length,
      delta: current != null && baseline != null ? Math.round((current - baseline) * 100) / 100 : null,
      sourceRecords24h: companyActivity?.sourceRecords24h ?? 0,
      latestSourceCollectedAt: companyActivity?.latestCollectedAt ?? null,
      earningsAt: extras.get(companyId)?.earningsAt ?? null,
      lastSurprise: extras.get(companyId)?.lastSurprise ?? null,
    };
  }

  series(companyId: string, windowHours: number): SeriesResult {
    const now = Date.now();
    const windowMs = windowHours * 60 * 60 * 1000;
    const bucketMs = bucketMsFor(windowHours);
    // Rebuild from the company's full identified history so an older event
    // still seeds the same index when the user changes the visible window.
    const items = this.deps.db.scoredMentions(0, now, companyId);
    const points = weightedBucketSeries(items, windowMs, bucketMs, now);
    return {
      metric: "weighted_mean_impact",
      bucketMs,
      windowStartMs: now - windowMs,
      windowEndMs: now,
      loadedRecordCount: points.reduce((total, point) => total + point.scoredRecordCount, 0),
      populatedBucketCount: points.filter((point) => point.scoredRecordCount > 0).length,
      points,
      latestScoreAvailableAt: items.reduce<number | null>(
        (latest, item) => Math.max(latest ?? item.availableAt, item.availableAt),
        null,
      ),
    };
  }

  categoricalSeries(companyId: string, windowHours: number, now = Date.now()): CategoricalTrendResult {
    const snapshot = this.deps.db.categoricalTrendSnapshot(companyId, windowHours, now);
    const aggregateByStart = new Map(snapshot.aggregates.map((item) => [item.bucketStartMs, item.counts]));
    const points: CategoricalTrendResult["points"] = [];
    const firstBucket = Math.floor(snapshot.fromMs / snapshot.bucketMs) * snapshot.bucketMs;
    for (let bucketStartMs = firstBucket; bucketStartMs < snapshot.throughMs; bucketStartMs += snapshot.bucketMs) {
      const fromMs = Math.max(snapshot.fromMs, bucketStartMs);
      const throughMs = Math.min(snapshot.throughMs, bucketStartMs + snapshot.bucketMs);
      if (fromMs < throughMs) points.push({
        bucketStartMs,
        fromMs,
        throughMs,
        counts: aggregateByStart.get(bucketStartMs) ?? emptyCategoricalTrendCounts(),
      });
    }
    const sum = points.reduce<CategoricalTrendCounts>((counts, point) => addCategoricalTrendCounts(counts, point.counts), emptyCategoricalTrendCounts());
    if (!sameCategoricalTrendCounts(sum, snapshot.counts) || sum.total !== snapshot.eligibleObservationCount) {
      throw new Error("Luna category trend totals did not reconcile to the saved classification count");
    }
    return {
      companyId: snapshot.companyId,
      windowHours: snapshot.windowHours,
      fromMs: snapshot.fromMs,
      throughMs: snapshot.throughMs,
      bucketMs: snapshot.bucketMs,
      timeBasis: "classification_available_at",
      countBasis: "immutable_source_observation",
      snapshotGeneration: snapshot.snapshotGeneration,
      snapshotKey: snapshot.snapshotKey,
      points,
      counts: snapshot.counts,
      eligibleObservationCount: snapshot.eligibleObservationCount,
      candidateClassificationCount: snapshot.candidateClassificationCount,
      withheldInvalidCount: snapshot.withheldInvalidCount,
      latestClassifiedAt: snapshot.latestClassifiedAt,
      lineages: snapshot.lineages,
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
    return this.deps.db.categoricalBucketEvidence(input);
  }
}

function emptyCategoricalTrendCounts(): CategoricalTrendCounts {
  return { positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0, total: 0 };
}

function addCategoricalTrendCounts(a: CategoricalTrendCounts, b: CategoricalTrendCounts): CategoricalTrendCounts {
  return {
    positive: a.positive + b.positive,
    neutral: a.neutral + b.neutral,
    negative: a.negative + b.negative,
    reviewRequired: a.reviewRequired + b.reviewRequired,
    excluded: a.excluded + b.excluded,
    total: a.total + b.total,
  };
}

function sameCategoricalTrendCounts(a: CategoricalTrendCounts, b: CategoricalTrendCounts): boolean {
  return a.positive === b.positive && a.neutral === b.neutral && a.negative === b.negative
    && a.reviewRequired === b.reviewRequired
    && a.excluded === b.excluded && a.total === b.total;
}
