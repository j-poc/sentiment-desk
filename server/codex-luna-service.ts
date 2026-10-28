import { createHash, randomUUID } from "node:crypto";
import type { Desk, MentionRow } from "./db.js";
import type { CollectorId, Company } from "./types.js";
import { boundClassificationInput, validateCategoricalPayload, OPENAI_PROMPT_SHA256, OPENAI_SCHEMA_SHA256 } from "./openai-classifier.js";
import { CodexLunaError, readExistingCodexSessionStatus, runCodexLuna } from "./codex-luna-runner.js";
import { codexLunaSavedSchema, type CodexLunaSaved } from "../shared/codex-luna.js";
import { deriveCategoricalDisposition } from "../shared/categorical-disposition.js";
import { validatedSourceClock } from "../shared/source-clock.js";

export class CodexLunaServiceError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

function sourceInput(mention: MentionRow, company: Company) {
  return boundClassificationInput({ company: { name: company.name, ticker: company.ticker, sector: company.sector },
    source: { collector: mention.collector, publisher: mention.publisher_name, title: mention.title, excerpt: mention.snippet } });
}
function sha(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sourceSha(mention: MentionRow, company: Company): string {
  return sha({ observationId: mention.id, companyId: company.id, input: sourceInput(mention,company),
    sourceUrl: mention.source_url, retrievedAt: mention.retrieved_at, deliveryId: mention.delivery_id });
}

export class CodexLunaService {
  constructor(private readonly options: {
    db: Desk; externalRequestsEnabled: () => boolean; allowedCollectors: ReadonlySet<CollectorId>;
    run?: typeof runCodexLuna; sessionStatus?: typeof readExistingCodexSessionStatus;
  }) {}

  async status() {
    const session = await (this.options.sessionStatus ?? readExistingCodexSessionStatus)();
    const today = Math.floor(Date.now()/86400000)*86400000;
    const attempts = this.options.db.codexLunaAttempts();
    return { provider: "codex_luna" as const, configured: session.configured, model: "gpt-6-luna",
      experimental: true, externalRequestsEnabled: this.options.externalRequestsEnabled(),
      usage: { requests: attempts.filter(item => item.reservedAt>=today && item.status!=="not_sent").length },
      limits: { dailyRequests: 20, dailyRequestBytes: 512_000 },
      unknownOutcome: attempts.some(item => item.status==="unknown") };
  }

  result(observationId: string) {
    const mention = this.options.db.mentionRow(observationId);
    if (!mention) throw new CodexLunaServiceError("unknown_real_source_observation",404);
    const attempts = this.options.db.codexLunaAttempts(mention.company_id).filter(item => item.observationId===observationId);
    const result = attempts.map(item => this.validSaved(item.result)).find(item => item!==null) ?? null;
    return { result, attempts: attempts.map(({ result: _result, ...item }) => ({ ...item, modelRequested: "gpt-6-luna",
      modelReturned: null, httpStatus: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null, errorCategory: item.error })) };
  }

  private validSaved(value: unknown): CodexLunaSaved|null {
    const parsed = codexLunaSavedSchema.safeParse(value);
    if (!parsed.success) return null;
    const record = parsed.data;
    const source = this.options.db.codexLunaSource(record.observationId);
    const company = source && this.options.db.companies().find(item => item.id===source.company_id);
    if (!source || !company || record.companyId!==company.id || record.sourceSha256!==sourceSha(source,company)
      || record.requestSha256!==sha(sourceInput(source,company)) || record.retrievedAt!==source.retrieved_at) return null;
    const clock = validatedSourceClock({ timeBasis: source.time_basis, collector: source.collector,
      publisherAt: source.publisher_published_at, aggregatorAt: source.aggregator_published_at, providerObservedAt: source.provider_observed_at });
    if (record.sourceTimeAt!==clock.at) return null;
    try {
      const classification = validateCategoricalPayload({ sentiment: record.sentiment, event_type: record.eventType, takeaway: record.takeaway,
        about: record.about, material: record.material, investor_relevant: record.investorRelevant,
        evidence_sufficient: record.evidenceSufficient, summary: record.summary, supporting_excerpt: record.supportingExcerpt }, sourceInput(source,company));
      if (deriveCategoricalDisposition(classification,true)!==record.disposition) return null;
    } catch { return null; }
    return record;
  }

  series(companyId: string, hours: number) {
    if (!Number.isSafeInteger(hours) || hours<1 || hours>168) throw new CodexLunaServiceError("invalid_categorical_window",400);
    if (!this.options.db.companies().some(item => item.id===companyId)) throw new CodexLunaServiceError("unknown_company",404);
    const throughMs = Date.now(); const fromMs = throughMs-hours*3600000;
    const seen = new Set<string>();
    const items = this.options.db.codexLunaAttempts(companyId).flatMap(attempt => {
      const classification = this.validSaved(attempt.result);
      if (!classification || seen.has(classification.observationId)) return [];
      seen.add(classification.observationId);
      const time = classification.sourceTimeAt ?? classification.createdAt;
      if (time<fromMs || time>=throughMs) return [];
      const mention = this.options.db.mentionsByIds(companyId,[classification.observationId])[0];
      return mention ? [{ classification, mention }] : [];
    });
    return { companyId, hours, fromMs, throughMs, items };
  }

  async classify(observationId: string, consent: { confirmDataSend: boolean; confirmProviderUsageReview: boolean }) {
    if (consent.confirmDataSend!==true) throw new CodexLunaServiceError("classification_confirmation_required",400);
    this.ensureDispatchAllowed();
    const source = this.options.db.codexLunaSource(observationId);
    const company = source && this.options.db.companies().find(item => item.id===source.company_id);
    if (!source || !company || !this.options.allowedCollectors.has(source.collector as CollectorId)) {
      throw new CodexLunaServiceError("source_not_suitable_for_investor_classification");
    }
    const existing = this.result(observationId).result;
    if (existing) return existing;
    if (this.options.db.codexLunaAttempts().some(item => item.status==="unknown") && !consent.confirmProviderUsageReview) {
      throw new CodexLunaServiceError("provider_usage_review_required");
    }
    if (!(await (this.options.sessionStatus ?? readExistingCodexSessionStatus)()).configured) {
      throw new CodexLunaServiceError("codex_sign_in_unavailable");
    }
    const input = sourceInput(source,company);
    const requestBytes = Buffer.byteLength(JSON.stringify(input));
    if (requestBytes>24576) throw new CodexLunaServiceError("classification_request_too_large",413);
    const id = randomUUID(); const sourceDigest = sourceSha(source,company);
    const block = this.options.db.reserveCodexLunaAttempt({ id, observationId, companyId: company.id,
      sourceSha256: sourceDigest, requestBytes, reservedAt: Date.now() });
    if (block) throw new CodexLunaServiceError(block,429);
    let dispatched = false;
    try {
      const completion = await (this.options.run ?? runCodexLuna)(input, () => {
        this.ensureDispatchAllowed();
        if (!this.options.db.dispatchCodexLunaAttempt(id)) throw new CodexLunaServiceError("dispatch_intent_not_recorded",503);
        dispatched = true;
      });
      if (!dispatched) throw new CodexLunaServiceError("dispatch_intent_not_recorded",503);
      const sourceTimeAt = validatedSourceClock({ timeBasis: source.time_basis, collector: source.collector,
        publisherAt: source.publisher_published_at, aggregatorAt: source.aggregator_published_at, providerObservedAt: source.provider_observed_at }).at;
      const { classification, classifiedAt, ...receipt } = completion;
      const record = codexLunaSavedSchema.parse({ ...receipt, ...classification, provider: "codex_luna", attemptId: id,
        observationId, companyId: company.id, sourceSha256: sourceDigest, requestSha256: sha(input),
        promptSha256: OPENAI_PROMPT_SHA256, schemaSha256: OPENAI_SCHEMA_SHA256,
        sourceTimeAt, retrievedAt: source.retrieved_at, createdAt: classifiedAt,
        disposition: deriveCategoricalDisposition(classification,true) });
      if (!this.validSaved(record)) throw new CodexLunaServiceError("source_changed_after_dispatch");
      this.options.db.finishCodexLunaAttempt(id,"completed",record,null);
      return record;
    } catch (error) {
      const code = error instanceof CodexLunaServiceError || error instanceof CodexLunaError ? error.code : "codex_request_failed";
      this.options.db.finishCodexLunaAttempt(id,dispatched ? "unknown" : "not_sent",null,code);
      throw new CodexLunaServiceError(code,dispatched ? 502 : 503);
    }
  }

  private ensureDispatchAllowed() {
    if (!this.options.externalRequestsEnabled()) throw new CodexLunaServiceError("external_requests_disabled",503);
    if (!this.options.db.canStartExternalWork()) throw new CodexLunaServiceError("local_storage_paused",503);
  }
}
