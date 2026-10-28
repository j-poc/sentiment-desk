import { randomUUID } from "node:crypto";
import type { CollectorId, Company } from "./types.js";
import type { Desk, MentionRow, ModelProviderClassificationRecord } from "./db.js";
import { deriveCategoricalDisposition } from "../shared/categorical-disposition.js";
import {
  type BYOKProvider,
  ModelProviderClassifier,
  ModelProviderError,
  MODEL_PROVIDER_DAILY_COST_LIMIT_USD,
  MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT,
  MODEL_PROVIDER_DAILY_REQUEST_LIMIT,
  MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT,
  prepareModelProviderRequest,
  sourceIdentityDigest,
} from "./model-provider-classifier.js";
import { ModelProviderCredentialVault } from "./model-provider-credential-vault.js";
import { hasStrongIdentity, isFinanceRelevant } from "./scoring.js";
import { validatedSourceClock } from "../shared/source-clock.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";

const SUPPORTED_PROVIDERS: readonly BYOKProvider[] = ["openai", "google_gemini"];

export class ModelProviderServiceError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = "ModelProviderServiceError"; }
}

function utcDay(now: number): string { return new Date(now).toISOString().slice(0, 10); }

function identityInput(mention: MentionRow, company: Company) {
  return {
    sourceId: mention.id,
    company: { name: company.name, ticker: company.ticker, sector: company.sector },
    source: { collector: mention.collector, publisher: mention.publisher_name, title: mention.title, excerpt: mention.snippet },
    sourceUrl: mention.source_url,
    retrievedAt: mention.retrieved_at,
  };
}

function sourceTime(mention: MentionRow): number | null {
  return validatedSourceClock({ timeBasis: mention.time_basis, collector: mention.collector,
    publisherAt: mention.publisher_published_at, aggregatorAt: mention.aggregator_published_at,
    providerObservedAt: mention.provider_observed_at }).at;
}

export class ModelProviderClassificationService {
  constructor(private readonly options: {
    loopbackBound: boolean;
    db: Desk;
    vault: ModelProviderCredentialVault;
    classifier: ModelProviderClassifier;
    externalRequestsEnabled: boolean;
    storageAllowsProviderRequests: () => boolean;
    allowedCollectors: ReadonlySet<CollectorId>;
  }) {}

  private ensureLoopback(): void {
    if (!this.options.loopbackBound) throw new ModelProviderServiceError("loopback_only", 403);
  }

  private provider(value: string): BYOKProvider {
    if (SUPPORTED_PROVIDERS.includes(value as BYOKProvider)) return value as BYOKProvider;
    throw new ModelProviderServiceError("unsupported_provider", 404);
  }

  async status(): Promise<{ loopback: boolean; providers: Array<{ provider: BYOKProvider; configured: boolean; credentialUnavailable: boolean; model: string; usage: { requests: number; requestBytes: number; estimatedCostUsd: number; verificationRequests: number }; limits: { dailyRequests: number; dailyRequestBytes: number; dailyCostUsd: number; dailyVerificationRequests: number } }> }> {
    this.ensureLoopback();
    const day = utcDay(Date.now());
    const providers = await Promise.all(SUPPORTED_PROVIDERS.map(async provider => {
      let configured = false;
      let credentialUnavailable = false;
      try { configured = await this.options.vault.load(provider) !== null; }
      catch { credentialUnavailable = true; }
      const usage = this.options.db.modelProviderDailyUsage(provider, day);
      const verificationRequests = this.options.db.modelProviderVerificationUsage(provider, day);
      return {
        provider,
        configured,
        credentialUnavailable,
        model: provider === "openai" ? "gpt-6-luna" : "gemini-3.8-flash",
        usage: { ...usage, verificationRequests },
        limits: {
          dailyRequests: MODEL_PROVIDER_DAILY_REQUEST_LIMIT,
          dailyRequestBytes: MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT,
          dailyCostUsd: MODEL_PROVIDER_DAILY_COST_LIMIT_USD,
          dailyVerificationRequests: MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT,
        },
      };
    }));
    return { loopback: true, providers };
  }

  async save(providerValue: string, apiKey: string): Promise<{ configured: true }> {
    this.ensureLoopback();
    const provider = this.provider(providerValue);
    await this.options.vault.save(provider, apiKey);
    return { configured: true };
  }

  async remove(providerValue: string): Promise<{ configured: false }> {
    this.ensureLoopback();
    const provider = this.provider(providerValue);
    await this.options.vault.remove(provider);
    return { configured: false };
  }

  async verify(providerValue: string): Promise<{ model: string; available: boolean }> {
    this.ensureLoopback();
    const provider = this.provider(providerValue);
    if (!this.options.externalRequestsEnabled) throw new ModelProviderServiceError("external_requests_disabled", 503);
    if (!this.options.storageAllowsProviderRequests()) throw new ModelProviderServiceError("local_storage_paused", 503);
    let apiKey: string | null;
    try { apiKey = await this.options.vault.load(provider); }
    catch { throw new ModelProviderServiceError("provider_credential_unavailable", 503); }
    if (!apiKey) throw new ModelProviderServiceError("provider_credential_missing", 409);
    const reservation = this.options.db.reserveModelProviderVerification({
      id: randomUUID(), provider, utcDay: utcDay(Date.now()), reservedAt: Date.now(),
      maxDailyRequests: MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT,
    });
    if (reservation !== "reserved") {
      throw new ModelProviderServiceError(reservation, reservation === "storage_paused" ? 503 : 429);
    }
    try { return await this.options.classifier.verify(provider, apiKey); }
    catch (error) {
      if (error instanceof ExternalRequestPausedError) throw new ModelProviderServiceError("provider_request_not_sent", 503);
      if (error instanceof ModelProviderError) throw new ModelProviderServiceError("provider_verification_failed", error.status ?? 502);
      throw new ModelProviderServiceError("provider_verification_failed", 502);
    }
  }

  async classify(input: { observationId: string; provider: string; confirmDataSend: true; confirmGeminiPaidService: boolean; confirmProviderUsageReview: boolean }): Promise<ModelProviderClassificationRecord> {
    this.ensureLoopback();
    if (input.confirmDataSend !== true) throw new ModelProviderServiceError("classification_confirmation_required", 400);
    const provider = this.provider(input.provider);
    if (!this.options.externalRequestsEnabled) throw new ModelProviderServiceError("external_requests_disabled", 503);
    if (provider === "google_gemini" && input.confirmGeminiPaidService !== true) {
      throw new ModelProviderServiceError("gemini_paid_service_attestation_required", 400);
    }
    if (!this.options.storageAllowsProviderRequests()) throw new ModelProviderServiceError("local_storage_paused", 503);
    const mention = this.options.db.mentionRow(input.observationId);
    if (!mention) throw new ModelProviderServiceError("unknown_real_source_observation", 404);
    const history = this.options.db.modelProviderAttemptHistory(mention.id, provider);
    if (history.some(attempt => attempt.status === "unknown") && input.confirmProviderUsageReview !== true) {
      throw new ModelProviderServiceError("provider_usage_review_required", 409);
    }
    if (!this.options.allowedCollectors.has(mention.collector as CollectorId)) throw new ModelProviderServiceError("source_not_approved_for_model_processing", 403);
    const company = this.options.db.companies().find(item => item.id === mention.company_id);
    if (!company) throw new ModelProviderServiceError("unknown_real_source_observation", 404);
    const strongIdentity = hasStrongIdentity({
      company: { name: company.name, ticker: company.ticker, aliases: company.aliases, ambiguous: company.ambiguous },
      title: mention.title,
      snippet: mention.snippet,
      scoped: mention.scoped === 1,
    });
    if (!strongIdentity || !isFinanceRelevant({
      title: mention.title, snippet: mention.snippet, tier: mention.source_tier, kind: mention.source_kind, ticker: company.ticker, companyName: company.name,
    })) throw new ModelProviderServiceError("source_not_suitable_for_investor_classification", 409);
    let apiKey: string | null;
    try { apiKey = await this.options.vault.load(provider); }
    catch { throw new ModelProviderServiceError("provider_credential_unavailable", 503); }
    if (!apiKey) throw new ModelProviderServiceError("provider_credential_missing", 409);

    const modelInput = {
      company: { name: company.name, ticker: company.ticker, sector: company.sector },
      source: { collector: mention.collector, publisher: mention.publisher_name, title: mention.title, excerpt: mention.snippet },
    };
    let prepared;
    try { prepared = prepareModelProviderRequest(provider, modelInput); }
    catch { throw new ModelProviderServiceError("classification_request_invalid", 400); }
    const now = Date.now();
    const attemptId = randomUUID();
    const sourceSha = sourceIdentityDigest(identityInput(mention, company));
    const reserve = this.options.db.reserveModelProviderAttempt({
      id: attemptId,
      observationId: mention.id,
      provider,
      modelRequested: prepared.requestedModel,
      sourceSha256: sourceSha,
      requestSha256: prepared.payloadSha256,
      requestBytes: prepared.requestBytes,
      promptVersion: prepared.promptVersion,
      promptSha256: prepared.promptSha256,
      schemaVersion: prepared.schemaVersion,
      schemaSha256: prepared.schemaSha256,
      utcDay: utcDay(now),
      reservedAt: now,
      costReservationMicros: Math.ceil(prepared.costReservationUsd * 1_000_000),
      maxDailyRequests: MODEL_PROVIDER_DAILY_REQUEST_LIMIT,
      maxDailyBytes: MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT,
      maxDailyCostMicros: Math.ceil(MODEL_PROVIDER_DAILY_COST_LIMIT_USD * 1_000_000),
    });
    if (reserve !== "reserved") {
      const errorStatus = reserve === "storage_paused" ? 503 : 429;
      throw new ModelProviderServiceError(reserve, errorStatus);
    }
    if (!this.options.db.markModelProviderDispatched(attemptId, Date.now())) {
      this.options.db.finishModelProviderAttempt({
        attemptId, outcome: "not_sent", completedAt: Date.now(), httpStatus: null, modelReturned: null,
        responseId: null, responseSha256: null, inputTokens: null, outputTokens: null,
        estimatedCostUsd: null, latencyMs: null, errorCategory: "dispatch_intent_not_recorded",
      });
      throw new ModelProviderServiceError("dispatch_intent_not_recorded", 503);
    }

    try {
      const result = await this.options.classifier.classify(provider, apiKey, modelInput);
      const currentMention = this.options.db.mentionRow(mention.id);
      const currentCompany = currentMention && this.options.db.companies().find(item => item.id === currentMention.company_id);
      if (!currentMention || !currentCompany || sourceIdentityDigest(identityInput(currentMention, currentCompany)) !== sourceSha) {
        this.options.db.finishModelProviderAttempt({
          attemptId, outcome: "unknown", completedAt: Date.now(), httpStatus: result.httpStatus,
          modelReturned: result.modelReturned, responseId: result.responseId, responseSha256: result.responseSha256,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedCostUsd: result.estimatedCostUsd,
          latencyMs: result.latencyMs, errorCategory: "source_identity_changed_after_dispatch",
        });
        throw new ModelProviderServiceError("source_identity_changed_after_dispatch", 409);
      }
      const raw = result.classification;
      const disposition = deriveCategoricalDisposition(raw, true);
      const completedAt = Date.now();
      const committed = this.options.db.finishModelProviderAttempt({
        attemptId,
        outcome: "completed",
        completedAt,
        httpStatus: result.httpStatus,
        modelReturned: result.modelReturned,
        responseId: result.responseId,
        responseSha256: result.responseSha256,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        latencyMs: result.latencyMs,
        errorCategory: null,
        categoricalReceipt: result.categoricalReceipt,
        classification: {
          modelReturned: result.modelReturned,
          sourceSha256: sourceSha,
          sourceTimeAt: sourceTime(mention),
          retrievedAt: mention.retrieved_at,
          sentiment: raw.sentiment,
          eventType: raw.eventType,
          takeaway: raw.takeaway,
          about: raw.about,
          material: raw.material,
          investorRelevant: raw.investorRelevant,
          evidenceSufficient: raw.evidenceSufficient,
          summary: raw.summary,
          supportingExcerpt: raw.supportingExcerpt,
          disposition,
        },
      });
      if (!committed) throw new ModelProviderServiceError("classification_receipt_not_saved", 503);
      const record = this.options.db.latestModelProviderClassification(mention.id, provider, attemptId);
      if (!record || record.attemptId !== attemptId) throw new ModelProviderServiceError("classification_receipt_not_saved", 503);
      return record;
    } catch (error) {
      if (error instanceof ModelProviderServiceError) throw error;
      const providerError = error instanceof ModelProviderError ? error : null;
      const outcome = providerError?.outcomeUnknown ? "unknown" : providerError?.requestDispatched === false ? "not_sent" : "rejected";
      try {
        this.options.db.finishModelProviderAttempt({
          attemptId,
          outcome,
          completedAt: Date.now(),
          httpStatus: providerError?.status ?? null,
          modelReturned: null,
          responseId: null,
          responseSha256: null,
          inputTokens: null,
          outputTokens: null,
          estimatedCostUsd: null,
          latencyMs: null,
          errorCategory: outcome === "unknown" ? "provider_outcome_unknown" : outcome === "not_sent" ? "provider_request_not_sent" : "provider_rejected_or_invalid",
        });
      } catch { /* preserve the generic failure and never replay automatically */ }
      if (error instanceof ModelProviderServiceError) throw error;
      const errorStatus = providerError?.status != null && providerError.status >= 400 && providerError.status <= 599 ? providerError.status : 502;
      throw new ModelProviderServiceError(outcome === "unknown" ? "provider_outcome_unknown"
        : outcome === "not_sent" ? "provider_request_not_sent" : "provider_classification_failed",
      outcome === "not_sent" ? 503 : errorStatus);
    }
  }

  result(observationId: string, providerValue: string): { result: ModelProviderClassificationRecord | null; attempts: ReturnType<Desk["modelProviderAttemptHistory"]> } {
    this.ensureLoopback();
    const provider = this.provider(providerValue);
    return {
      result: this.options.db.latestModelProviderClassification(observationId, provider),
      attempts: this.options.db.modelProviderAttemptHistory(observationId, provider),
    };
  }
}
