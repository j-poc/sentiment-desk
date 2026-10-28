import { randomUUID, createHash } from "node:crypto";
import type { CollectorId, Company, SourceTier } from "./types.js";
import type { Desk, MentionRow, TypeSafeJevByokResultRecord } from "./db.js";
import { JevClient, JevError, prepareJevRequest } from "./jev.js";
import { RUBRIC, RUBRIC_SHA } from "./rubric.js";
import { applyPostRules, hasStrongIdentity, isFinanceRelevant, parseJudgment } from "./scoring.js";
import { TIER_WEIGHT } from "./sources/tiers.js";
import { ModelProviderCredentialVault } from "./model-provider-credential-vault.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import { validatedSourceClock } from "../shared/source-clock.js";
import {
  MODEL_PROVIDER_DAILY_COST_LIMIT_USD,
  MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT,
  MODEL_PROVIDER_DAILY_REQUEST_LIMIT,
  MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT,
} from "./model-provider-classifier.js";

const TYPESAFE_API = "https://api.typesafe.ai";
const JEV_MODEL = "jev-latest";
const REQUEST_COST_RESERVATION_MICROS = 10_000;
const REQUEST_TIMEOUT_MS = 25_000;

function utcDay(now: number): string { return new Date(now).toISOString().slice(0, 10); }
function sourceTime(mention: MentionRow) {
  const clock = validatedSourceClock({ timeBasis: mention.time_basis, collector: mention.collector,
    publisherAt: mention.publisher_published_at, aggregatorAt: mention.aggregator_published_at,
    providerObservedAt: mention.provider_observed_at });
  return { at: clock.at, basis: clock.basis };
}
function identityDigest(mention: MentionRow, company: Company): string {
  const clock = sourceTime(mention);
  const identity = {
    observationId: mention.id, companyId: company.id, name: company.name, ticker: company.ticker, sector: company.sector,
    collector: mention.collector, sourceTier: mention.source_tier, publisherName: mention.publisher_name,
    publisherDomain: mention.publisher_domain, title: mention.title, excerpt: mention.snippet,
    sourceUrl: mention.source_url, publisherPublishedAt: mention.publisher_published_at,
    aggregatorPublishedAt: mention.aggregator_published_at, providerObservedAt: mention.provider_observed_at,
    retrievedAt: mention.retrieved_at, sourceTime: clock,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

async function boundedJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("oversized_response");
  }
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("oversized_response"); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export class TypeSafeJevByokError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = "TypeSafeJevByokError"; }
}

/** Explicit, local-only Jev calls; stored lineage never enters the legacy scoring queue. */
export class TypeSafeJevByokService {
  constructor(private readonly options: {
    loopbackBound: boolean; db: Desk; vault: ModelProviderCredentialVault;
    externalRequestsEnabled: boolean;
    storageAllowsProviderRequests: () => boolean; allowedCollectors: ReadonlySet<CollectorId>; fetchImpl?: typeof fetch;
  }) {}

  private ensureLoopback(): void {
    if (!this.options.loopbackBound) throw new TypeSafeJevByokError("loopback_only", 403);
  }

  private get fetchImpl(): typeof fetch { return this.options.fetchImpl ?? fetch; }

  async status() {
    this.ensureLoopback();
    let configured = false;
    let credentialUnavailable = false;
    try { configured = await this.options.vault.load("typesafe_jev") !== null; }
    catch { credentialUnavailable = true; }
    const day = utcDay(Date.now());
    return {
      provider: "typesafe_jev" as const, configured, credentialUnavailable, model: JEV_MODEL,
      usage: { ...this.options.db.typeSafeJevByokUsage(day), verificationRequests: this.options.db.typeSafeJevByokVerificationUsage(day) },
      limits: { dailyRequests: MODEL_PROVIDER_DAILY_REQUEST_LIMIT, dailyRequestBytes: MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT,
        dailyCostUsd: MODEL_PROVIDER_DAILY_COST_LIMIT_USD, dailyVerificationRequests: MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT },
    };
  }

  async save(apiKey: string): Promise<{ configured: true }> {
    this.ensureLoopback();
    await this.options.vault.save("typesafe_jev", apiKey);
    return { configured: true };
  }

  async remove(): Promise<{ configured: false }> {
    this.ensureLoopback();
    await this.options.vault.remove("typesafe_jev");
    return { configured: false };
  }

  async verify(): Promise<{ model: string; available: boolean }> {
    this.ensureLoopback();
    if (!this.options.externalRequestsEnabled) throw new TypeSafeJevByokError("external_requests_disabled", 503);
    if (!this.options.storageAllowsProviderRequests()) throw new TypeSafeJevByokError("local_storage_paused", 503);
    let apiKey: string | null;
    try { apiKey = await this.options.vault.load("typesafe_jev"); }
    catch { throw new TypeSafeJevByokError("provider_credential_unavailable", 503); }
    if (!apiKey) throw new TypeSafeJevByokError("provider_credential_missing", 409);
    const reservation = this.options.db.reserveTypeSafeJevByokVerification({ id: randomUUID(),
      utcDay: utcDay(Date.now()), reservedAt: Date.now(), maxDailyRequests: MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT });
    if (reservation !== "reserved") throw new TypeSafeJevByokError(reservation, reservation === "storage_paused" ? 503 : 429);
    try {
      const response = await this.fetchImpl(`${TYPESAFE_API}/v1/models`, {
        method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await boundedJson(response);
      if (!response.ok) throw new Error("provider_rejected_catalog_request");
      const models = data && typeof data === "object" && !Array.isArray(data) ? (data as { models?: unknown }).models : null;
      const available = Array.isArray(models) && models.some((item) => !!item && typeof item === "object"
        && (item as { name?: unknown }).name === JEV_MODEL);
      return { model: JEV_MODEL, available };
    } catch (error) {
      if (error instanceof ExternalRequestPausedError) throw new TypeSafeJevByokError("provider_request_not_sent", 503);
      throw new TypeSafeJevByokError("provider_verification_failed", 502);
    }
  }

  async assess(input: { observationId: string; confirmDataSend: true; confirmProviderUsageReview: boolean }): Promise<TypeSafeJevByokResultRecord> {
    this.ensureLoopback();
    if (input.confirmDataSend !== true) throw new TypeSafeJevByokError("assessment_confirmation_required", 400);
    if (!this.options.externalRequestsEnabled) throw new TypeSafeJevByokError("external_requests_disabled", 503);
    if (!this.options.storageAllowsProviderRequests()) throw new TypeSafeJevByokError("local_storage_paused", 503);
    const mention = this.options.db.mentionRow(input.observationId);
    if (!mention) throw new TypeSafeJevByokError("unknown_real_source_observation", 404);
    const history = this.options.db.typeSafeJevByokAttemptHistory(mention.id);
    if (history.some(attempt => attempt.status === "unknown") && input.confirmProviderUsageReview !== true) {
      throw new TypeSafeJevByokError("provider_usage_review_required", 409);
    }
    if (!this.options.allowedCollectors.has(mention.collector as CollectorId)) throw new TypeSafeJevByokError("source_not_approved_for_model_processing", 403);
    const company = this.options.db.companies().find(item => item.id === mention.company_id);
    if (!company) throw new TypeSafeJevByokError("unknown_real_source_observation", 404);
    const strongIdentity = hasStrongIdentity({ company: { name: company.name, ticker: company.ticker, aliases: company.aliases, ambiguous: company.ambiguous },
      title: mention.title, snippet: mention.snippet, scoped: mention.scoped === 1 });
    if (!strongIdentity || !isFinanceRelevant({ title: mention.title, snippet: mention.snippet,
      tier: mention.source_tier, kind: mention.source_kind, ticker: company.ticker, companyName: company.name })) {
      throw new TypeSafeJevByokError("source_not_suitable_for_investor_classification", 409);
    }
    let apiKey: string | null;
    try { apiKey = await this.options.vault.load("typesafe_jev"); }
    catch { throw new TypeSafeJevByokError("provider_credential_unavailable", 503); }
    if (!apiKey) throw new TypeSafeJevByokError("provider_credential_missing", 409);

    const clock = sourceTime(mention);
    const requestState = {
      company: { name: company.name, ticker: company.ticker, sector: company.sector },
      mention: { title: mention.title, snippet: mention.snippet,
        source: { collector: mention.collector, tier: mention.source_tier, publisherName: mention.publisher_name,
          publisherDomain: mention.publisher_domain },
        sourceTime: { at: clock.at === null ? null : new Date(clock.at).toISOString(), basis: clock.basis } },
    };
    const prepared = prepareJevRequest(JEV_MODEL, requestState, RUBRIC, RUBRIC_SHA);
    if (prepared.requestBytes > MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT) throw new TypeSafeJevByokError("classification_request_too_large", 413);
    const sourceSha = identityDigest(mention, company);
    const attemptId = randomUUID();
    const reserved = this.options.db.reserveTypeSafeJevByokAttempt({ id: attemptId, observationId: mention.id,
      modelRequested: JEV_MODEL, sourceSha256: sourceSha, requestSha256: prepared.payloadSha256, requestBytes: prepared.requestBytes,
      rubricSha256: RUBRIC_SHA, utcDay: utcDay(Date.now()), reservedAt: Date.now(), costReservationMicros: REQUEST_COST_RESERVATION_MICROS,
      maxDailyRequests: MODEL_PROVIDER_DAILY_REQUEST_LIMIT, maxDailyBytes: MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT,
      maxDailyCostMicros: Math.ceil(MODEL_PROVIDER_DAILY_COST_LIMIT_USD * 1_000_000) });
    if (reserved !== "reserved") throw new TypeSafeJevByokError(reserved, reserved === "storage_paused" ? 503 : 429);
    if (!this.options.db.markTypeSafeJevByokDispatched(attemptId, Date.now())) {
      this.options.db.finishTypeSafeJevByokAttempt({ attemptId, outcome: "not_sent", completedAt: Date.now(), httpStatus: null,
        modelReturned: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null, latencyMs: null, errorCategory: "dispatch_intent_not_recorded" });
      throw new TypeSafeJevByokError("dispatch_intent_not_recorded", 503);
    }
    let responseHttpStatus: number | null = null;
    try {
      const client = new JevClient({ apiKey, baseUrl: TYPESAFE_API, model: JEV_MODEL, timeoutMs: REQUEST_TIMEOUT_MS, fetchImpl: this.fetchImpl });
      const judged = await client.judgePrepared(prepared);
      responseHttpStatus = judged.httpStatus;
      const currentMention = this.options.db.mentionRow(mention.id);
      const currentCompany = currentMention && this.options.db.companies().find(item => item.id === currentMention.company_id);
      if (!currentMention || !currentCompany || identityDigest(currentMention, currentCompany) !== sourceSha) {
        this.options.db.finishTypeSafeJevByokAttempt({ attemptId, outcome: "unknown", completedAt: Date.now(), httpStatus: judged.httpStatus,
          modelReturned: judged.model, inputTokens: judged.inputTokens, outputTokens: judged.outputTokens,
          estimatedCostUsd: client.costFor(judged.inputTokens), latencyMs: judged.latencyMs, errorCategory: "source_identity_changed_after_dispatch" });
        throw new TypeSafeJevByokError("source_identity_changed_after_dispatch", 409);
      }
      const parsed = parseJudgment(judged.answers);
      const strictAbout = company.ambiguous === true && !strongIdentity;
      const final = applyPostRules(parsed, TIER_WEIGHT[mention.source_tier as SourceTier], { strictAbout });
      const record = {
        modelRequested: JEV_MODEL, modelReturned: judged.model, sourceSha256: sourceSha, rubricSha256: RUBRIC_SHA,
        sourceTimeAt: clock.at, retrievedAt: mention.retrieved_at, sentiment: parsed.sentiment,
        pPositive: parsed.pPos, pNeutral: parsed.pNeu, pNegative: parsed.pNeg, confidence: parsed.confidence,
        about: parsed.about, investorRelevant: parsed.investorRelevant, material: parsed.material, novel: parsed.novel,
        credible: parsed.credible, eventType: parsed.eventType, magnitude: parsed.magnitude, surprise: parsed.surprise,
        takeaway: parsed.takeaway, eventScore: final.eventScore, impact: final.impact, weight: final.weight, excluded: final.exclude,
      };
      const saved = this.options.db.finishTypeSafeJevByokAttempt({ attemptId, outcome: "completed", completedAt: Date.now(),
        httpStatus: judged.httpStatus, modelReturned: judged.model, inputTokens: judged.inputTokens, outputTokens: judged.outputTokens,
        estimatedCostUsd: client.costFor(judged.inputTokens), latencyMs: judged.latencyMs, errorCategory: null, result: record });
      const result = saved && this.options.db.typeSafeJevByokResult(mention.id);
      if (!result || result.attemptId !== attemptId) throw new TypeSafeJevByokError("assessment_receipt_not_saved", 503);
      return result;
    } catch (error) {
      if (error instanceof TypeSafeJevByokError) throw error;
      const jevError = error instanceof JevError ? error : null;
      const outcome = error instanceof ExternalRequestPausedError ? "not_sent" : jevError?.outcomeUnknown ? "unknown"
        : responseHttpStatus !== null ? "rejected" : "rejected";
      try { this.options.db.finishTypeSafeJevByokAttempt({ attemptId, outcome, completedAt: Date.now(),
        httpStatus: jevError?.status ?? responseHttpStatus, modelReturned: null, inputTokens: null, outputTokens: null,
        estimatedCostUsd: null, latencyMs: null, errorCategory: outcome === "unknown" ? "provider_outcome_unknown"
          : outcome === "not_sent" ? "provider_request_not_sent" : "provider_rejected_or_invalid" }); } catch { /* keep the request fail-closed */ }
      throw new TypeSafeJevByokError(outcome === "unknown" ? "provider_outcome_unknown"
        : outcome === "not_sent" ? "provider_request_not_sent" : "provider_assessment_failed",
      outcome === "not_sent" ? 503 : jevError?.status ?? 502);
    }
  }

  result(observationId: string) {
    this.ensureLoopback();
    const mention = this.options.db.mentionRow(observationId);
    if (!mention) throw new TypeSafeJevByokError("unknown_real_source_observation", 404);
    return { result: this.options.db.typeSafeJevByokResult(observationId), attempts: this.options.db.typeSafeJevByokAttemptHistory(observationId) };
  }
}
