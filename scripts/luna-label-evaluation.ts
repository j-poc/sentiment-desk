import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";
import { classificationMetrics, sha256Bytes, sha256Json } from "./jev-label-evaluation.js";
export { sha256Bytes };

const HEX_256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/;
export const LUNA_DIAGNOSTIC_PROFILE = "sec_edgar_luna_product24_diagnostic_v1" as const;
export const LUNA_PROFILE_VERSION = "luna-independent-agent-diagnostic/1" as const;
const ISO_TIME = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(HEX_256);
const sentimentSchema = z.enum(["negative", "neutral", "positive"]);
const eventTypeSchema = z.enum(EVENT_TYPES);
const takeawaySchema = z.enum(TAKEAWAY_KEYS);
const sentimentClasses = ["negative", "neutral", "positive"] as const;

const productCompanies = (JSON.parse(readFileSync(new URL("../config/companies.json", import.meta.url), "utf8")) as { companies: Array<{ id: string; name: string; ticker: string; sector: string }> }).companies;
const productCompanyById = new Map(productCompanies.map((company) => [company.id, company]));
const productCompanyIds = productCompanies.map(({ id }) => id).sort();
export const PRODUCT_COMPANY_UNIVERSE_SHA256 = createHash("sha256").update(JSON.stringify(productCompanyIds), "utf8").digest("hex");

const companySchema = z.object({ id: z.string().min(1).max(200), name: z.string().trim().min(1).max(160), ticker: z.string().trim().min(1).max(24), sector: z.string().trim().min(1).max(120) }).strict();
const sourceInputSchema = z.object({
  company: z.object({ name: z.string().max(160), ticker: z.string().max(24), sector: z.string().max(120) }).strict(),
  source: z.object({ collector: z.string().max(48), publisher: z.string().max(120), title: z.string().max(500), excerpt: z.string().max(4_000) }).strict(),
}).strict();
const secCaseProvenanceSchema = z.object({
  observationId: z.string().min(1).max(200), company: companySchema,
  cik: z.string().regex(/^\d{10}$/), accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  filingType: z.string().min(1).max(30), filingAt: ISO_TIME, acceptedAt: ISO_TIME,
  sourceUrl: z.string().url().max(2_000), collector: z.string().trim().min(1).max(48), publisher: z.string().trim().min(1).max(120),
  title: z.string().max(500), excerpt: z.string().max(4_000), rawSourceSha256: digestSchema, excerptSha256: digestSchema, sourceReceiptSha256: digestSchema,
}).strict();
const requestBindingSchema = z.object({
  requestedModel: z.string().min(1).max(200), requestedServiceTier: z.literal("default"), payloadSha256: digestSchema, requestBytes: z.number().int().positive(),
  promptSha256: digestSchema, schemaSha256: digestSchema, profileSha256: digestSchema,
}).strict();
const labelValuesSchema = z.object({
  sentiment: sentimentSchema.nullable(), eventType: eventTypeSchema.nullable(), takeaway: takeawaySchema.nullable(),
  about: z.boolean().nullable(), material: z.boolean().nullable(), investorRelevant: z.boolean().nullable(), evidenceSufficient: z.boolean().nullable(),
}).strict();
const labelFieldSchema = z.enum(["sentiment", "eventType", "takeaway", "about", "material", "investorRelevant"]);
const labelFieldRationalesSchema = z.object({
  sentiment: z.string().trim().min(8).max(1_000), eventType: z.string().trim().min(8).max(1_000), takeaway: z.string().trim().min(8).max(1_000),
  about: z.string().trim().min(8).max(1_000), material: z.string().trim().min(8).max(1_000), investorRelevant: z.string().trim().min(8).max(1_000), evidenceSufficient: z.string().trim().min(8).max(1_000),
}).strict();
const reviewerSchema = z.object({
  id: z.string().min(1).max(200), kind: z.literal("independent_subagent"), agentThreadId: z.string().min(1).max(200),
  configuredModel: z.string().min(1).max(200), resolvedModel: z.string().min(1).max(200).nullable(), modelSettingsSha256: digestSchema,
  modelResolutionEvidenceSha256: digestSchema.nullable(), independenceAttested: z.literal(true), blindedToLunaOutputsAttested: z.literal(true),
}).strict();
const reviewerLabelsSchema = z.object({ reviewerId: z.string().min(1).max(200), labels: labelValuesSchema, rationales: labelFieldRationalesSchema }).strict();
const lunaCaseSchema = secCaseProvenanceSchema.extend({
  input: sourceInputSchema, requestBinding: requestBindingSchema, reviews: z.array(reviewerLabelsSchema).length(2), adjudication: reviewerLabelsSchema.optional(),
  expectedAbstentions: z.array(labelFieldSchema),
}).strict();
const budgetSchema = z.object({
  maxRequests: z.number().int().positive(), maxEstimatedCostUsd: z.number().finite().positive(),
  inputPerMillionUsd: z.number().finite().nonnegative(), cachedInputPerMillionUsd: z.number().finite().nonnegative(), cacheWritePerMillionUsd: z.number().finite().nonnegative(), outputPerMillionUsd: z.number().finite().nonnegative(),
  openAIAccountReadback: z.object({
    kind: z.literal("openai_account_spend_limit_readback"), observedAt: ISO_TIME, availableBudgetUsd: z.number().finite().nonnegative(), artifactSha256: digestSchema,
  }).strict(),
  accountOwnerApproval: z.object({ attested: z.literal(true), approvedAt: ISO_TIME, approvalRecordSha256: digestSchema }).strict(),
}).strict();
const sampleStratumSchema = z.object({ cik: z.string().regex(/^\d{10}$/), eligibleCount: z.number().int().positive(), selectedCount: z.number().int().positive() }).strict();

export const lunaLabelSetV2Schema = z.object({
  schemaVersion: z.literal(2), stage: z.enum(["pilot", "final"]), studyId: z.string().min(1).max(200), source: z.literal("sec_edgar"),
  evaluationProfile: z.literal(LUNA_DIAGNOSTIC_PROFILE), profileVersion: z.literal(LUNA_PROFILE_VERSION),
  sampleSeed: z.number().int().safe(), samplingWindowStart: ISO_TIME, samplingWindowEnd: ISO_TIME, sampledAt: ISO_TIME, frozenAt: ISO_TIME,
  analysisCodeRevision: z.string().regex(COMMIT_SHA), analysisCodeDirty: z.literal(false),
  requestedModel: z.string().min(1).max(200), promptVersion: z.string().min(1).max(200), schemaVersionName: z.string().min(1).max(200),
  requestedServiceTier: z.literal("default"),
  promptSha256: digestSchema, schemaSha256: digestSchema, profileSha256: digestSchema,
  productCompanyUniverseSha256: digestSchema, populationFrameSha256: digestSchema, sampleManifestSha256: digestSchema,
  evaluationBudget: budgetSchema.optional(),
  populationFrame: z.array(secCaseProvenanceSchema).min(1), samplePlan: z.array(sampleStratumSchema).min(1),
  reviewers: z.array(reviewerSchema).min(2).max(3),
  agentLabelProtocol: z.object({
    version: z.literal("independent-subagents-blinded-v1"), frozenAt: ISO_TIME, lunaOutputsOpenedAt: ISO_TIME.nullable(), chronologyArtifactSha256: digestSchema,
  }).strict(),
  items: z.array(lunaCaseSchema).min(1),
}).strict();

const classificationSchema = z.object({
  sentiment: sentimentSchema.nullable(), eventType: eventTypeSchema.nullable(), takeaway: takeawaySchema.nullable(),
  about: z.boolean().nullable(), material: z.boolean().nullable(), investorRelevant: z.boolean().nullable(), evidenceSufficient: z.boolean(),
  summary: z.string().max(500).nullable(), supportingExcerpt: z.string().max(240).nullable(),
  disposition: z.enum(["classified", "excluded", "review_required"]),
}).strict();
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative().nullable(), cacheWriteInputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(), totalTokens: z.number().int().nonnegative(), estimatedCostUsd: z.number().finite().nonnegative().nullable(),
}).strict();
const attemptSchema = z.object({
  attemptNumber: z.number().int().positive(), outcome: z.enum(["completed", "refused", "incomplete", "invalid_output", "rejected", "unknown", "not_sent"]),
  requestPayloadSha256: digestSchema,
  submitted: z.boolean(), httpStatus: z.number().int().min(100).max(599).nullable(), responseId: z.string().min(1).max(200).nullable(),
  responseSha256: digestSchema.nullable(), modelReturned: z.string().min(1).max(200).nullable(), serviceTier: z.string().min(1).max(80).nullable(), latencyMs: z.number().finite().nonnegative().nullable(),
  classification: classificationSchema.nullable(), usage: usageSchema.nullable(),
}).strict();
const runItemSchema = z.object({
  observationId: z.string().min(1).max(200), requestPayloadSha256: digestSchema,
  terminalStatus: z.enum(["completed", "refused", "incomplete", "invalid_output", "rejected", "unknown", "not_sent", "not_attempted"]),
  attempts: z.array(attemptSchema).max(3),
}).strict();
export const lunaModelRunV1Schema = z.object({
  schemaVersion: z.literal(1), studyId: z.string().min(1).max(200), runId: z.string().min(1).max(200), labelsSha256: digestSchema,
  sampleManifestSha256: digestSchema, evaluationProfile: z.literal(LUNA_DIAGNOSTIC_PROFILE), profileSha256: digestSchema,
  analysisCodeRevision: z.string().regex(COMMIT_SHA), sourceTreeDirty: z.literal(false), startedAt: ISO_TIME, requestCount: z.number().int().nonnegative(),
  requestedModel: z.string().min(1).max(200), maxRequests: z.number().int().positive(), maxEstimatedCostUsd: z.number().finite().positive(),
  inputPerMillionUsd: z.number().finite().nonnegative(), cachedInputPerMillionUsd: z.number().finite().nonnegative(), cacheWritePerMillionUsd: z.number().finite().nonnegative(), outputPerMillionUsd: z.number().finite().nonnegative(),
  items: z.array(runItemSchema),
}).strict();

export type LunaLabelSetV2 = z.infer<typeof lunaLabelSetV2Schema>;
export type LunaModelRunV1 = z.infer<typeof lunaModelRunV1Schema>;
export type LunaClassification = z.infer<typeof classificationSchema>;
export type LunaUsage = z.infer<typeof usageSchema>;

export interface LunaClassifierContract {
  model: string;
  serviceTier: "default";
  profileSha256: string;
  promptVersion: string;
  schemaVersion: string;
  promptSha256: string;
  schemaSha256: string;
  pricing: { inputPerMillionUsd: number; cachedInputPerMillionUsd: number; cacheWritePerMillionUsd: number; outputPerMillionUsd: number };
  prepareRequest(input: LunaLabelSetV2["items"][number]["input"], model?: string): { body: string; payloadSha256: string; requestBytes: number; requestedModel: string; promptSha256: string; schemaSha256: string; profileSha256: string };
  estimateCost(inputTokens: number, cachedInputTokens: number | null, cacheWriteInputTokens: number | null, outputTokens: number, modelReturned: string | null, serviceTier: string | null): number | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hashCanonical(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function assertSecSource(row: z.infer<typeof secCaseProvenanceSchema>): void {
  const url = new URL(row.sourceUrl);
  if (url.protocol !== "https:" || !["sec.gov", "www.sec.gov"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) throw new Error(`case ${row.observationId} has a non-canonical SEC source URL`);
  const expected = `/Archives/edgar/data/${String(Number(row.cik))}/${row.accession.replaceAll("-", "")}/`;
  if (!url.pathname.startsWith(expected)) throw new Error(`case ${row.observationId} URL does not bind its CIK and accession`);
  if (Date.parse(row.acceptedAt) < Date.parse(row.filingAt) || Date.parse(row.acceptedAt) < Date.parse("2000-01-01T00:00:00Z")) throw new Error(`case ${row.observationId} has invalid SEC chronology`);
  if (sha256Bytes(Buffer.from(row.excerpt, "utf8")) !== row.excerptSha256) throw new Error(`case ${row.observationId} excerpt digest does not match the exact prepared text`);
}

export function sampleManifestSha256(items: readonly z.infer<typeof secCaseProvenanceSchema>[]): string {
  return hashCanonical([...items].map(({ observationId, company, cik, accession, filingType, filingAt, acceptedAt, sourceUrl, collector, publisher, title, excerpt, rawSourceSha256, excerptSha256, sourceReceiptSha256 }) => ({ observationId, company, cik, accession, filingType, filingAt, acceptedAt, sourceUrl, collector, publisher, title, excerpt, rawSourceSha256, excerptSha256, sourceReceiptSha256 })).sort((a, b) => a.observationId.localeCompare(b.observationId)));
}

export function selectLunaSample<T extends { observationId: string; cik: string }>(populationFrame: readonly T[], seed: number, targetCount = 30): T[] {
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > populationFrame.length) throw new Error("Luna sample seed and target count must be safe and within the eligible frame");
  const byCik = new Map<string, T[]>();
  for (const item of populationFrame) byCik.set(item.cik, [...(byCik.get(item.cik) ?? []), item]);
  const rank = (left: T, right: T) => sha256Json(`${seed}:${left.observationId}`).localeCompare(sha256Json(`${seed}:${right.observationId}`)) || left.observationId.localeCompare(right.observationId);
  const initial = [...byCik.values()].flatMap((items) => [...items].sort(rank).slice(0, 2));
  const rankedInitial = [...initial].sort(rank);
  const selected = initial.length >= targetCount
    ? rankedInitial.slice(0, targetCount)
    : [...initial, ...populationFrame.filter((item) => !initial.some((picked) => picked.observationId === item.observationId)).sort(rank).slice(0, targetCount - initial.length)];
  return selected.sort((a, b) => a.observationId.localeCompare(b.observationId));
}

function resolveLabels(item: LunaLabelSetV2["items"][number]): LunaLabelSetV2["items"][number]["reviews"][number]["labels"] {
  if (new Set(item.expectedAbstentions).size !== item.expectedAbstentions.length) throw new Error(`case ${item.observationId} repeats an expected abstention field`);
  const fields = Object.keys(item.reviews[0]!.labels) as Array<keyof typeof item.reviews[number]["labels"]>;
  const result = {} as Record<keyof typeof item.reviews[number]["labels"], string | boolean | null>;
  for (const field of fields) {
    const adjudicated = item.adjudication?.labels[field];
    const left = item.reviews[0]!.labels[field]; const right = item.reviews[1]!.labels[field];
    result[field] = adjudicated !== undefined && adjudicated !== null ? adjudicated : left === right ? left : null;
  }
  for (const field of item.expectedAbstentions) {
    const adjudicated = item.adjudication?.labels[field];
    const left = item.reviews[0]!.labels[field]; const right = item.reviews[1]!.labels[field];
    if (adjudicated !== null && adjudicated !== undefined || !item.adjudication && (left !== null || right !== null)) throw new Error(`case ${item.observationId} marks ${field} as abstain without a frozen null reference`);
    result[field] = null;
  }
  return result as LunaLabelSetV2["items"][number]["reviews"][number]["labels"];
}

function rawAgreement(labels: LunaLabelSetV2) {
  const fields = Object.keys(labels.items[0]!.reviews[0]!.labels) as Array<keyof typeof labels.items[number]["reviews"][number]["labels"]>;
  return Object.fromEntries(fields.map((field) => {
    const left = labels.items.map((item) => item.reviews[0]!.labels[field]); const right = labels.items.map((item) => item.reviews[1]!.labels[field]);
    const exact = left.reduce((count, value, index) => count + Number(value === right[index]), 0);
    const jointlyLabeled = left.reduce((count, value, index) => count + Number(value !== null && right[index] !== null), 0);
    const jointlyAgree = left.reduce((count, value, index) => count + Number(value !== null && value === right[index]), 0);
    return [field, { selectedCases: labels.items.length, exactAgreementsIncludingAbstentions: exact, rawAgreementIncludingAbstentions: labels.items.length ? exact / labels.items.length : null, jointlyLabeled, jointlyAgree, agreementWhenBothLabeled: jointlyLabeled ? jointlyAgree / jointlyLabeled : null, abstainedByEither: labels.items.length - jointlyLabeled, disagreements: labels.items.filter((item) => item.reviews[0]!.labels[field] !== item.reviews[1]!.labels[field]).map((item) => item.observationId) }];
  }));
}

export function parseLunaLabelSet(value: unknown, classifier: LunaClassifierContract): LunaLabelSetV2 {
  const labels = lunaLabelSetV2Schema.parse(value);
  if (labels.evaluationProfile !== LUNA_DIAGNOSTIC_PROFILE || labels.profileVersion !== LUNA_PROFILE_VERSION) throw new Error("unsupported categorical Luna evaluation profile");
  if (labels.requestedModel !== classifier.model || labels.requestedServiceTier !== classifier.serviceTier || labels.promptVersion !== classifier.promptVersion || labels.schemaVersionName !== classifier.schemaVersion || labels.promptSha256 !== classifier.promptSha256 || labels.schemaSha256 !== classifier.schemaSha256 || labels.profileSha256 !== classifier.profileSha256) throw new Error("frozen Luna classifier model, service tier, prompt, schema or profile identity differs from the loaded production classifier");
  if (labels.productCompanyUniverseSha256 !== PRODUCT_COMPANY_UNIVERSE_SHA256) throw new Error("Luna diagnostic does not bind the current configured product company universe");
  for (const item of [...labels.populationFrame, ...labels.items]) {
    const configured = productCompanyById.get(item.company.id);
    if (!configured) throw new Error(`Luna case ${item.observationId} falls outside the configured product company universe`);
    if (item.company.name !== configured.name || item.company.ticker !== configured.ticker || item.company.sector !== configured.sector) throw new Error(`Luna case ${item.observationId} company identity does not match configured company ${configured.id}`);
  }
  if (labels.items.length < 30 || new Set(labels.items.map(({ company }) => company.id)).size < 8) throw new Error("Luna product24 diagnostic requires at least 30 cases across 8 configured product companies");
  if (Date.parse(labels.samplingWindowStart) >= Date.parse(labels.samplingWindowEnd) || Date.parse(labels.samplingWindowEnd) > Date.parse(labels.sampledAt) || Date.parse(labels.sampledAt) > Date.parse(labels.frozenAt) || labels.agentLabelProtocol.frozenAt !== labels.frozenAt) throw new Error("Luna sample and blind-label chronology is invalid");
  if (labels.stage === "final" && (!labels.evaluationBudget || labels.evaluationBudget.maxRequests < labels.items.length || labels.evaluationBudget.maxEstimatedCostUsd > labels.evaluationBudget.openAIAccountReadback.availableBudgetUsd || Date.parse(labels.evaluationBudget.accountOwnerApproval.approvedAt) > Date.parse(labels.frozenAt))) throw new Error("final Luna labels require a pre-frozen owner-approved spend budget within the independently read OpenAI account limit and covering every selected case");
  if (labels.agentLabelProtocol.lunaOutputsOpenedAt !== null && Date.parse(labels.agentLabelProtocol.lunaOutputsOpenedAt) < Date.parse(labels.frozenAt)) throw new Error("Luna outputs cannot be opened before the blinded reference set is frozen");
  const reviewerIds = labels.reviewers.map(({ id }) => id); const threads = labels.reviewers.map(({ agentThreadId }) => agentThreadId);
  if (new Set(reviewerIds).size !== reviewerIds.length || new Set(threads).size !== threads.length) throw new Error("independent reference agents must have distinct IDs and thread identities");
  const frame = new Map(labels.populationFrame.map((item) => [item.observationId, item]));
  if (frame.size !== labels.populationFrame.length || labels.items.length !== new Set(labels.items.map(({ observationId }) => observationId)).size) throw new Error("Luna source frame or selected cases contain duplicate IDs");
  for (const item of labels.populationFrame) assertSecSource(item);
  for (const item of labels.items) {
    assertSecSource(item);
    const source = frame.get(item.observationId);
    if (!source || sampleManifestSha256([source]) !== sampleManifestSha256([item])) throw new Error(`selected case ${item.observationId} differs from its frozen source frame`);
    if (item.input.company.name !== item.company.name || item.input.company.ticker !== item.company.ticker || item.input.company.sector !== item.company.sector || item.input.source.collector !== item.collector || item.input.source.publisher !== item.publisher || item.input.source.title !== item.title || item.input.source.excerpt !== item.excerpt) throw new Error(`case ${item.observationId} request input differs from frozen company/source identity`);
    const prepared = classifier.prepareRequest(item.input, labels.requestedModel);
    if (prepared.profileSha256 !== classifier.profileSha256) throw new Error(`case ${item.observationId} prepared profile digest differs from loaded classifier`);
    const binding = item.requestBinding;
    const requestBody = JSON.parse(prepared.body) as { service_tier?: unknown };
    if (requestBody.service_tier !== labels.requestedServiceTier || binding.requestedServiceTier !== labels.requestedServiceTier || prepared.payloadSha256 !== binding.payloadSha256 || prepared.requestBytes !== binding.requestBytes || prepared.requestedModel !== binding.requestedModel || prepared.promptSha256 !== binding.promptSha256 || prepared.schemaSha256 !== binding.schemaSha256 || prepared.profileSha256 !== binding.profileSha256 || binding.promptSha256 !== labels.promptSha256 || binding.schemaSha256 !== labels.schemaSha256 || binding.profileSha256 !== labels.profileSha256) throw new Error(`case ${item.observationId} request does not bind the frozen source, prompt, schema, model, service tier and profile`);
    if (item.reviews[0]!.reviewerId !== reviewerIds[0] || item.reviews[1]!.reviewerId !== reviewerIds[1]) throw new Error(`case ${item.observationId} reviewer identities do not bind the frozen primary-reviewer roster`);
    if (item.adjudication && (reviewerIds.length !== 3 || item.adjudication.reviewerId !== reviewerIds[2])) throw new Error(`case ${item.observationId} adjudicator must be the separately declared third independent reviewer`);
    resolveLabels(item);
  }
  if (sampleManifestSha256(labels.populationFrame) !== labels.populationFrameSha256 || sampleManifestSha256(labels.items) !== labels.sampleManifestSha256) throw new Error("Luna source-frame or selected-case digest does not match its rows");
  const expectedSample = selectLunaSample(labels.populationFrame, labels.sampleSeed, labels.items.length);
  if (canonicalJson(labels.items.map(({ observationId }) => observationId).sort()) !== canonicalJson(expectedSample.map(({ observationId }) => observationId))) throw new Error("Luna sample does not match frozen issuer-stratified seed selection and deterministic top-up");
  const frameCounts = new Map<string, number>(); const selectedCounts = new Map<string, number>();
  for (const item of labels.populationFrame) frameCounts.set(item.cik, (frameCounts.get(item.cik) ?? 0) + 1);
  for (const item of labels.items) selectedCounts.set(item.cik, (selectedCounts.get(item.cik) ?? 0) + 1);
  const expectedPlan = [...frameCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cik, eligibleCount]) => ({ cik, eligibleCount, selectedCount: selectedCounts.get(cik) ?? 0 })).filter(({ selectedCount }) => selectedCount > 0);
  if (canonicalJson(labels.samplePlan) !== canonicalJson(expectedPlan)) throw new Error("Luna sample plan does not report the exact seeded source counts by issuer");
  if (labels.evaluationBudget && (labels.evaluationBudget.inputPerMillionUsd !== classifier.pricing.inputPerMillionUsd || labels.evaluationBudget.cachedInputPerMillionUsd !== classifier.pricing.cachedInputPerMillionUsd || labels.evaluationBudget.cacheWritePerMillionUsd !== classifier.pricing.cacheWritePerMillionUsd || labels.evaluationBudget.outputPerMillionUsd !== classifier.pricing.outputPerMillionUsd)) throw new Error("frozen Luna spend schedule differs from the loaded classifier pricing schedule");
  return labels;
}

export function parseLunaModelRun(value: unknown, labels: LunaLabelSetV2, classifier: LunaClassifierContract): LunaModelRunV1 {
  const run = lunaModelRunV1Schema.parse(value);
  if (labels.stage !== "final") throw new Error("a Luna model run is only valid for a frozen final label set");
  if (!labels.evaluationBudget) throw new Error("a final Luna run requires pre-frozen account-approved spend controls");
  if (run.studyId !== labels.studyId || run.sampleManifestSha256 !== labels.sampleManifestSha256 || run.evaluationProfile !== labels.evaluationProfile || run.profileSha256 !== labels.profileSha256 || run.analysisCodeRevision !== labels.analysisCodeRevision || run.sourceTreeDirty || run.requestedModel !== labels.requestedModel) throw new Error("Luna run identity differs from the frozen label and request profile");
  if (Date.parse(run.startedAt) < Date.parse(labels.frozenAt) || labels.agentLabelProtocol.lunaOutputsOpenedAt !== run.startedAt) throw new Error("Luna run start does not match the blinded freeze chronology");
  if (run.maxRequests !== labels.evaluationBudget.maxRequests || run.maxEstimatedCostUsd !== labels.evaluationBudget.maxEstimatedCostUsd || run.inputPerMillionUsd !== labels.evaluationBudget.inputPerMillionUsd || run.cachedInputPerMillionUsd !== labels.evaluationBudget.cachedInputPerMillionUsd || run.cacheWritePerMillionUsd !== labels.evaluationBudget.cacheWritePerMillionUsd || run.outputPerMillionUsd !== labels.evaluationBudget.outputPerMillionUsd) throw new Error("Luna run budget and cost schedule differ from the pre-frozen approved controls");
  if (new Set(run.items.map(({ observationId }) => observationId)).size !== run.items.length) throw new Error("Luna run contains duplicate observation IDs");
  const byId = new Map(labels.items.map((item) => [item.observationId, item]));
  let submittedCount = 0;
  for (const item of run.items) {
    const labelItem = byId.get(item.observationId);
    if (!labelItem || item.requestPayloadSha256 !== labelItem.requestBinding.payloadSha256) throw new Error(`Luna run request digest does not match selected case ${item.observationId}`);
    if (!item.attempts.length) {
      if (item.terminalStatus !== "not_attempted") throw new Error(`Luna case ${item.observationId} has no attempt ledger but is not marked unattempted`);
      continue;
    }
    if (item.terminalStatus === "not_attempted") throw new Error(`Luna case ${item.observationId} has attempts but is marked unattempted`);
    if (item.attempts.some((attempt, index) => attempt.attemptNumber !== index + 1)) throw new Error(`Luna case ${item.observationId} attempt numbers are not consecutive`);
    if (item.attempts.slice(0, -1).some((attempt) => attempt.outcome === "unknown" || attempt.outcome === "completed" || attempt.outcome === "refused" || attempt.outcome === "incomplete" || attempt.outcome === "invalid_output")) throw new Error(`Luna case ${item.observationId} retries after a terminal or unknown outcome`);
    if (item.attempts.slice(0, -1).some((attempt) => attempt.outcome === "rejected" && attempt.httpStatus !== 429)) throw new Error(`Luna case ${item.observationId} retries after a non-rate-limit rejection`);
    if (item.attempts[item.attempts.length - 1]!.outcome !== item.terminalStatus) throw new Error(`Luna case ${item.observationId} terminal status differs from its last attempt`);
    for (const attempt of item.attempts) {
      if (attempt.requestPayloadSha256 !== labelItem.requestBinding.payloadSha256) throw new Error(`Luna attempt request digest does not match frozen request for ${item.observationId}/${attempt.attemptNumber}`);
      if (attempt.outcome === "not_sent" ? attempt.submitted : !attempt.submitted) throw new Error(`Luna attempt ${item.observationId}/${attempt.attemptNumber} submission flag conflicts with its terminal outcome`);
      if (attempt.submitted) submittedCount += 1;
      if (attempt.outcome === "not_sent" && (attempt.httpStatus !== null || attempt.responseId !== null || attempt.responseSha256 !== null || attempt.classification !== null || attempt.usage !== null)) throw new Error(`not-sent Luna attempt ${item.observationId}/${attempt.attemptNumber} must not contain a provider response`);
      if (attempt.outcome === "completed") {
        if (attempt.httpStatus === null || attempt.httpStatus < 200 || attempt.httpStatus >= 300 || !attempt.responseId || !attempt.responseSha256 || !attempt.modelReturned || attempt.latencyMs === null || !attempt.classification || !attempt.usage) throw new Error(`completed Luna attempt ${item.observationId}/${attempt.attemptNumber} lacks complete response and usage evidence`);
        if (attempt.classification.supportingExcerpt !== null && (!attempt.classification.supportingExcerpt.trim() || !(labelItem.title.includes(attempt.classification.supportingExcerpt) || labelItem.excerpt.includes(attempt.classification.supportingExcerpt)))) throw new Error(`Luna case ${item.observationId} contains a quotation absent from the frozen SEC source text`);
        if (attempt.classification.evidenceSufficient && (!attempt.classification.summary || !attempt.classification.supportingExcerpt)) throw new Error(`Luna case ${item.observationId} claims sufficient evidence without a supported summary and quotation`);
      } else if (attempt.classification !== null) throw new Error(`non-completed Luna attempt ${item.observationId}/${attempt.attemptNumber} contains an accepted classification`);
      if (["rejected", "unknown"].includes(attempt.outcome) && attempt.httpStatus !== null && attempt.outcome === "rejected" && attempt.httpStatus >= 200 && attempt.httpStatus < 300) throw new Error(`Luna case ${item.observationId} rejected attempt has a successful HTTP status`);
      if (attempt.usage) {
        if (attempt.usage.cachedInputTokens !== null && attempt.usage.cacheWriteInputTokens !== null && attempt.usage.cachedInputTokens + attempt.usage.cacheWriteInputTokens > attempt.usage.inputTokens || attempt.usage.reasoningTokens !== null && attempt.usage.reasoningTokens > attempt.usage.outputTokens || attempt.usage.totalTokens !== attempt.usage.inputTokens + attempt.usage.outputTokens) throw new Error(`Luna case ${item.observationId} token totals are inconsistent`);
        const expectedCost = classifier.estimateCost(attempt.usage.inputTokens, attempt.usage.cachedInputTokens, attempt.usage.cacheWriteInputTokens, attempt.usage.outputTokens, attempt.modelReturned, attempt.serviceTier);
        if (expectedCost === null ? attempt.usage.estimatedCostUsd !== null : attempt.usage.estimatedCostUsd === null || Math.abs(expectedCost - attempt.usage.estimatedCostUsd) > Math.max(1e-12, expectedCost * 1e-9)) throw new Error(`Luna case ${item.observationId} cost does not match the production classifier cost function, model, tier and complete token breakdown`);
      }
    }
  }
  if (run.requestCount !== submittedCount) throw new Error("Luna request count does not match the immutable per-attempt ledger");
  return run;
}

function resolveCaseLabels(item: LunaLabelSetV2["items"][number]) { return resolveLabels(item); }
function referenceState(item: LunaLabelSetV2["items"][number], field: keyof LunaLabelSetV2["items"][number]["reviews"][number]["labels"]) {
  if (field !== "evidenceSufficient" && item.expectedAbstentions.includes(field)) return "abstention" as const;
  return resolveCaseLabels(item)[field] === null ? "unresolved" as const : "resolved" as const;
}
function acceptedClassification(item: LunaModelRunV1["items"][number] | null | undefined): LunaClassification | null {
  if (!item || item.terminalStatus !== "completed") return null;
  return item.attempts[item.attempts.length - 1]?.classification ?? null;
}
function precisionForInclusion(labels: readonly boolean[], predictions: readonly (boolean | null)[]) {
  const predictedPositive = predictions.reduce((count, value) => count + Number(value === true), 0);
  const truePositive = labels.reduce((count, value, index) => count + Number(value && predictions[index] === true), 0);
  const actualPositive = labels.filter(Boolean).length;
  return { precision: predictedPositive ? truePositive / predictedPositive : null, predictedPositive, truePositive, denominator: labels.length, inclusionRecall: actualPositive ? truePositive / actualPositive : null, actualPositive, inclusionRecallDenominator: actualPositive };
}
function gateStatus(metric: ReturnType<typeof classificationMetrics>, allClasses: readonly string[]) {
  const missing = allClasses.filter((name) => metric.perClass[name]!.support === 0);
  const weak = allClasses.filter((name) => metric.perClass[name]!.support > 0 && (metric.perClass[name]!.precision === null || metric.perClass[name]!.recall === null || metric.perClass[name]!.precision! < 0.7 || metric.perClass[name]!.recall! < 0.7));
  const status = metric.total === 0 ? "UNVERIFIED" : missing.length || weak.length || metric.macroF1 !== null && metric.macroF1 < 0.8 ? "FAIL" : metric.macroF1 === null ? "UNVERIFIED" : "PASS";
  return { status, macroF1: metric.macroF1, targetMacroF1: 0.8, representedClasses: allClasses.filter((name) => metric.perClass[name]!.support > 0), requiredClasses: allClasses, missingClasses: missing, representedClassTarget: { precision: 0.7, recall: 0.7 }, classFailures: weak, metrics: metric };
}

function exactReferenceStatus(
  cases: Array<{ item: LunaLabelSetV2["items"][number]; reference: ReturnType<typeof resolveCaseLabels>; run: LunaModelRunV1["items"][number] | null }>,
  field: "eventType" | "takeaway" | "material" | "evidenceSufficient",
) {
  const resolved = cases.filter(({ item }) => referenceState(item, field) === "resolved");
  const abstentions = cases.filter(({ item }) => referenceState(item, field) === "abstention");
  const unresolved = cases.filter(({ item }) => referenceState(item, field) === "unresolved");
  const mismatches = [...resolved, ...abstentions].flatMap(({ item, reference, run }) => {
    const classification = acceptedClassification(run);
    const prediction = classification?.[field] ?? null;
    const expected = referenceState(item, field) === "abstention" ? null : reference[field];
    return classification && prediction === expected ? [] : [{ observationId: item.observationId, reference: expected, prediction, outputStatus: run?.terminalStatus ?? "missing" }];
  });
  const status = mismatches.length > 0 || resolved.length === 0 && abstentions.length === 0 || unresolved.length > 0 ? "UNVERIFIED" : "PASS";
  return {
    status,
    rule: "exact agreement with resolved blinded subagent references; references are not ground truth or a calibrated quality threshold",
    selectedCases: cases.length,
    resolvedReferenceCases: resolved.length,
    unresolvedReferenceCases: unresolved.length,
    expectedAbstentionCases: abstentions.length,
    correctAbstentionCases: abstentions.filter(({ run }) => acceptedClassification(run)?.[field] === null && acceptedClassification(run) !== null).length,
    mismatchCount: mismatches.length,
    requiresIndependentReview: mismatches.length > 0,
    mismatches,
  };
}

export function analyzeLunaPilot(labels: LunaLabelSetV2): Record<string, unknown> {
  const unresolved = labels.items.flatMap((item) => Object.keys(item.reviews[0]!.labels).filter((field) => referenceState(item, field as keyof typeof item.reviews[number]["labels"]) === "unresolved").map((field) => ({ observationId: item.observationId, field })));
  return { mode: "luna-agent-reference-pilot", status: "UNVERIFIED", statusScope: "agent-reference agreement only; no classifier run is present", evaluationProfile: labels.evaluationProfile, labelAuthority: "independent_subagents", humanGroundTruth: "NOT_PROVIDED", statisticalCertification: "UNVERIFIED", investmentValue: "UNVERIFIED", selectedCaseDenominator: labels.items.length, issuerCount: new Set(labels.items.map(({ cik }) => cik)).size, companyCount: new Set(labels.items.map(({ company }) => company.id)).size, rawAgentAgreement: rawAgreement(labels), unresolvedReferences: unresolved, unresolvedReferenceFieldCount: unresolved.length, unresolvedReferenceFieldRate: unresolved.length / (labels.items.length * 7), caseBindings: labels.items.map((item) => ({ observationId: item.observationId, company: item.company, cik: item.cik, accession: item.accession, filingType: item.filingType, filingAt: item.filingAt, acceptedAt: item.acceptedAt, sourceUrl: item.sourceUrl, rawSourceSha256: item.rawSourceSha256, excerptSha256: item.excerptSha256, sourceReceiptSha256: item.sourceReceiptSha256, requestBinding: item.requestBinding })), blindedProtocol: labels.agentLabelProtocol, limitations: ["Independent agents are references, not human ground truth.", "No Luna classifier run is present; classifier quality and execution remain UNVERIFIED.", "Source rights and receipt authenticity require the separately bound evidence package."] };
}

export function analyzeLunaFinal(input: { labels: LunaLabelSetV2; labelsSha256: string; run: LunaModelRunV1 | null }): Record<string, any> {
  const { labels, run } = input;
  if (!run) return { ...analyzeLunaPilot(labels), mode: "luna-final-diagnostic", runId: null, provenanceExecutionStatus: "UNVERIFIED", qualityStatus: "UNVERIFIED", reason: "no saved Luna model run was provided", labelsSha256: input.labelsSha256 };
  if (run.labelsSha256 !== input.labelsSha256) throw new Error("Luna run label digest does not bind the exact frozen label bytes");
  const byRunId = new Map(run.items.map((item) => [item.observationId, item]));
  const unresolvedReferences: Array<{ observationId: string; field: string }> = [];
  const cases = labels.items.map((item) => ({ item, reference: resolveCaseLabels(item), run: byRunId.get(item.observationId) ?? null }));
  const fields = ["sentiment", "eventType", "takeaway", "about", "material", "investorRelevant", "evidenceSufficient"] as const;
  for (const row of cases) for (const field of fields) if (referenceState(row.item, field) === "unresolved") unresolvedReferences.push({ observationId: row.item.observationId, field });
  const sentimentCases = cases.filter(({ reference }) => reference.sentiment !== null);
  const sentimentMetrics = classificationMetrics({ labels: sentimentCases.map(({ reference }) => reference.sentiment!), predictions: sentimentCases.map(({ run: result }) => acceptedClassification(result)?.sentiment ?? null), classes: sentimentClasses });
  const sentimentAbstentions = cases.filter(({ item }) => referenceState(item, "sentiment") === "abstention");
  const sentimentAbstentionMismatches = sentimentAbstentions.filter(({ run: result }) => {
    const classification = acceptedClassification(result);
    return !classification || classification.sentiment !== null;
  }).map(({ item }) => item.observationId);
  const rawSentimentGate = gateStatus(sentimentMetrics, sentimentClasses);
  const sentimentGate = sentimentAbstentionMismatches.length && rawSentimentGate.status === "PASS" ? { ...rawSentimentGate, status: "UNVERIFIED", abstentionMismatchCount: sentimentAbstentionMismatches.length, abstentionMismatches: sentimentAbstentionMismatches } : { ...rawSentimentGate, abstentionMismatchCount: sentimentAbstentionMismatches.length, abstentionMismatches: sentimentAbstentionMismatches };
  const inclusion = (field: "about" | "investorRelevant") => {
    const rows = cases.filter(({ item }) => referenceState(item, field) === "resolved");
    const metric = precisionForInclusion(rows.map(({ reference }) => reference[field]!), rows.map(({ run: result }) => acceptedClassification(result)?.[field] ?? null));
    const abstentionRows = cases.filter(({ item }) => referenceState(item, field) === "abstention");
    const abstentionMismatches = abstentionRows.filter(({ run: result }) => {
      const classification = acceptedClassification(result);
      return !classification || classification[field] !== null;
    }).map(({ item, run: result }) => ({ observationId: item.observationId, prediction: acceptedClassification(result)?.[field] ?? null, outputStatus: result?.terminalStatus ?? "missing" }));
    const unresolvedReferenceCases = cases.filter(({ item }) => referenceState(item, field) === "unresolved").length;
    const missedResolvedInclusions = rows.filter(({ reference, run: result }) => reference[field] === true && acceptedClassification(result)?.[field] !== true).map(({ item }) => item.observationId);
    const metricStatus = metric.precision === null ? "UNVERIFIED" : metric.precision < 0.9 ? "FAIL" : "PASS";
    const status = abstentionMismatches.length && metricStatus === "PASS" ? "UNVERIFIED" : metricStatus;
    return { status, targetPrecision: 0.9, ...metric, resolvedReferenceCases: rows.length, selectedCases: labels.items.length, expectedAbstentionCases: abstentionRows.length, correctAbstentionCases: abstentionRows.length - abstentionMismatches.length, abstentionMismatchCount: abstentionMismatches.length, abstentionMismatches, missedResolvedInclusions, unresolvedReferenceCases };
  };
  const inclusionMetrics = { about: inclusion("about"), investorRelevant: inclusion("investorRelevant") };
  const gatedFields = fields;
  const referenceEligibility = {
    status: cases.some(({ item }) => gatedFields.some((field) => referenceState(item, field) === "unresolved")) ? "UNVERIFIED" : "PASS",
    selectedCaseDenominator: cases.length,
    requiredResolvedFields: gatedFields,
    fields: Object.fromEntries(gatedFields.map((field) => {
      const resolvedCases = cases.filter(({ item }) => referenceState(item, field) === "resolved").length;
      const abstentionCases = cases.filter(({ item }) => referenceState(item, field) === "abstention").length;
      const unresolvedCases = cases.filter(({ item }) => referenceState(item, field) === "unresolved").length;
      return [field, { selectedCases: cases.length, resolvedCases, abstentionCases, unresolvedCases, coverage: cases.length ? (resolvedCases + abstentionCases) / cases.length : null }];
    })),
    metricScope: "Resolved-reference subset scores are diagnostic; unresolved required references prevent full-cohort qualification.",
  };
  const qualityGateStatuses = [sentimentGate.status, inclusionMetrics.about.status, inclusionMetrics.investorRelevant.status, referenceEligibility.status];
  const expectedIds = new Set(labels.items.map(({ observationId }) => observationId));
  const missingIds = [...expectedIds].filter((id) => !byRunId.has(id)); const unexpectedIds = [...byRunId.keys()].filter((id) => !expectedIds.has(id));
  const failed = run.items.filter(({ terminalStatus }) => ["refused", "incomplete", "invalid_output", "rejected", "not_sent", "not_attempted"].includes(terminalStatus));
  const unknown = run.items.filter(({ terminalStatus }) => terminalStatus === "unknown");
  const attempts = run.items.flatMap((item) => item.attempts);
  const submittedAttempts = attempts.filter(({ submitted }) => submitted);
  const missingUsage = submittedAttempts.filter(({ usage }) => usage === null).length;
  const usageRows = submittedAttempts.flatMap((attempt) => attempt.usage ? [attempt.usage] : []);
  const incompleteUsage = usageRows.filter((usage) => usage.cachedInputTokens === null || usage.cacheWriteInputTokens === null || usage.reasoningTokens === null).length;
  const unpricedAttempts = usageRows.filter((usage) => usage.estimatedCostUsd === null).length;
  const knownCostSubtotal = usageRows.reduce((sum, usage) => sum + (usage.estimatedCostUsd ?? 0), 0);
  const totalCost = missingUsage || unpricedAttempts ? null : knownCostSubtotal;
  const completed = run.items.filter(({ terminalStatus }) => terminalStatus === "completed");
  const finalAttempts = completed.map((item) => item.attempts[item.attempts.length - 1]!);
  const returnedModels = [...new Set(finalAttempts.flatMap(({ modelReturned }) => modelReturned ? [modelReturned] : []))];
  const returnedTiers = [...new Set(finalAttempts.flatMap(({ serviceTier }) => serviceTier ? [serviceTier] : []))];
  const missingReturnedModelCount = finalAttempts.filter(({ modelReturned }) => !modelReturned).length;
  const missingReturnedTierCount = finalAttempts.filter(({ serviceTier }) => !serviceTier).length;
  const returnedModelStatus = returnedModels.some((model) => model !== run.requestedModel) ? "FAIL"
    : missingReturnedModelCount > 0 || returnedModels.length === 0 ? "UNVERIFIED" : "PASS";
  const returnedTierStatus = returnedTiers.some((tier) => tier !== labels.requestedServiceTier) ? "FAIL"
    : missingReturnedTierCount > 0 || returnedTiers.length === 0 ? "UNVERIFIED" : "PASS";
  const retryableRateLimitAttempts = submittedAttempts.filter(({ outcome, httpStatus }) => outcome === "rejected" && httpStatus === 429).length;
  const requestMismatch = run.requestCount !== submittedAttempts.length;
  const executionIntegrityFailure = missingIds.length > 0 || unexpectedIds.length > 0 || run.items.length !== labels.items.length
    || requestMismatch || failed.length > 0 || run.requestCount > run.maxRequests || knownCostSubtotal > run.maxEstimatedCostUsd
    || returnedModelStatus === "FAIL" || returnedTierStatus === "FAIL";
  const executionEvidenceIncomplete = unknown.length > 0 || missingUsage > 0 || incompleteUsage > 0 || unpricedAttempts > 0
    || run.requestCount < labels.items.length || returnedModelStatus !== "PASS" || returnedTierStatus !== "PASS";
  const executionStatus = executionIntegrityFailure ? "FAIL" : executionEvidenceIncomplete ? "UNVERIFIED" : "PASS";
  const eventTypeCases = cases.filter(({ reference }) => reference.eventType !== null);
  const eventTypeMetrics = classificationMetrics({ labels: eventTypeCases.map(({ reference }) => reference.eventType!), predictions: eventTypeCases.map(({ run: result }) => acceptedClassification(result)?.eventType ?? null), classes: EVENT_TYPES });
  const eventTypeReference = exactReferenceStatus(cases, "eventType");
  const takeawayCases = cases.filter(({ reference }) => reference.takeaway !== null);
  const takeawayMetrics = classificationMetrics({ labels: takeawayCases.map(({ reference }) => reference.takeaway!), predictions: takeawayCases.map(({ run: result }) => acceptedClassification(result)?.takeaway ?? null), classes: TAKEAWAY_KEYS });
  const takeawayReference = exactReferenceStatus(cases, "takeaway");
  const materialCases = cases.filter(({ reference }) => reference.material !== null);
  const materialMetrics = classificationMetrics({ labels: materialCases.map(({ reference }) => String(reference.material)), predictions: materialCases.map(({ run: result }) => { const prediction = acceptedClassification(result)?.material; return prediction === null || prediction === undefined ? null : String(prediction); }), classes: ["false", "true"] });
  const materialReference = exactReferenceStatus(cases, "material");
  const evidenceCases = cases.filter(({ reference }) => reference.evidenceSufficient !== null);
  const evidenceMetrics = classificationMetrics({ labels: evidenceCases.map(({ reference }) => String(reference.evidenceSufficient)), predictions: evidenceCases.map(({ run: result }) => { const prediction = acceptedClassification(result)?.evidenceSufficient; return prediction === null || prediction === undefined ? null : String(prediction); }), classes: ["false", "true"] });
  const evidenceSufficiencyReference = exactReferenceStatus(cases, "evidenceSufficient");
  const structuredStatuses = [qualityGateStatuses[0]!, qualityGateStatuses[1]!, qualityGateStatuses[2]!, qualityGateStatuses[3]!, eventTypeReference.status, takeawayReference.status, materialReference.status, evidenceSufficiencyReference.status];
  const structuredClassificationStatus = structuredStatuses.includes("FAIL") ? "FAIL" : structuredStatuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
  const rawTotal = usageRows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalInput = usageRows.reduce((sum, row) => sum + row.inputTokens, 0); const cachedInputKnown = usageRows.filter((row) => row.cachedInputTokens !== null).reduce((sum, row) => sum + row.cachedInputTokens!, 0); const cacheWriteKnown = usageRows.filter((row) => row.cacheWriteInputTokens !== null).reduce((sum, row) => sum + row.cacheWriteInputTokens!, 0); const totalOutput = usageRows.reduce((sum, row) => sum + row.outputTokens, 0); const reasoningKnown = usageRows.filter((row) => row.reasoningTokens !== null).reduce((sum, row) => sum + row.reasoningTokens!, 0);
  const completedAttempts = completed.flatMap((item) => item.attempts.filter(({ outcome }) => outcome === "completed"));
  const generatedSummaryCases = cases.filter(({ run: result }) => Boolean(acceptedClassification(result)?.summary?.trim())).length;
  const narrativeAssessment = {
    status: generatedSummaryCases > 0 ? "UNVERIFIED" : "NOT_APPLICABLE",
    selectedCases: cases.length,
    generatedSummaryCases,
    assessedSummaryCases: 0,
    reason: generatedSummaryCases > 0
      ? "No frozen narrative references or validated judge assess summary claim support and usefulness; exact quote presence does not establish entailment."
      : "No generated summaries were available to assess.",
  };
  const qualityStatus = structuredClassificationStatus === "FAIL"
    ? "FAIL"
    : structuredClassificationStatus === "UNVERIFIED" || narrativeAssessment.status === "UNVERIFIED" ? "UNVERIFIED" : "PASS";
  const status = executionStatus === "FAIL" || qualityStatus === "FAIL"
    ? "FAIL"
    : executionStatus === "UNVERIFIED" || qualityStatus === "UNVERIFIED" ? "UNVERIFIED" : "PASS";
  return {
    mode: "luna-final-categorical-evaluation", status, statusScope: "bounded product24 structured-field diagnostic; generated narrative support/usefulness remains unverified; not human-ground-truth accuracy, statistical certification, or investment value",
    evaluationProfile: labels.evaluationProfile, labelAuthority: "independent_subagents", humanGroundTruth: "NOT_PROVIDED", statisticalCertification: "UNVERIFIED", investmentValue: "UNVERIFIED",
    studyId: labels.studyId, runId: run.runId, labelsSha256: input.labelsSha256, sampleManifestSha256: labels.sampleManifestSha256,
    selectedCaseDenominator: labels.items.length, issuerCount: new Set(labels.items.map(({ cik }) => cik)).size, companyCount: new Set(labels.items.map(({ company }) => company.id)).size,
    rawAgentAgreement: rawAgreement(labels), unresolvedReferences, unresolvedReferenceFieldCount: unresolvedReferences.length, unresolvedReferenceFieldDenominator: labels.items.length * fields.length, unresolvedReferenceFieldRate: unresolvedReferences.length / (labels.items.length * fields.length),
    resolvedReferenceDenominators: { sentiment: sentimentCases.length, about: inclusionMetrics.about.resolvedReferenceCases, investorRelevant: inclusionMetrics.investorRelevant.resolvedReferenceCases, eventType: eventTypeCases.length, takeaway: takeawayCases.length, material: materialCases.length, evidenceSufficient: evidenceCases.length },
    expectedAbstentionDenominators: Object.fromEntries(fields.map((field) => [field, cases.filter(({ item }) => referenceState(item, field) === "abstention").length])),
    qualityStatus, structuredClassificationStatus, narrativeAssessment, referenceEligibility, provenanceExecutionStatus: executionStatus,
    quality: { sentiment: sentimentGate, inclusionPrecision: inclusionMetrics, eventTypeReference, eventTypeDescriptive: { selectedCases: labels.items.length, resolvedReferenceCases: eventTypeCases.length, missingClasses: EVENT_TYPES.filter((name) => eventTypeMetrics.perClass[name]!.support === 0), metrics: eventTypeMetrics }, takeawayReference, takeawayDescriptive: { selectedCases: labels.items.length, resolvedReferenceCases: takeawayCases.length, missingClasses: TAKEAWAY_KEYS.filter((name) => takeawayMetrics.perClass[name]!.support === 0), metrics: takeawayMetrics }, materialReference, materialDescriptive: { selectedCases: labels.items.length, resolvedReferenceCases: materialCases.length, metrics: materialMetrics }, evidenceSufficiencyReference, evidenceSufficiencyDescriptive: { selectedCases: labels.items.length, resolvedReferenceCases: evidenceCases.length, metrics: evidenceMetrics }, modelCompletionCoverage: { selectedCases: labels.items.length, completedCases: completed.length, rate: completed.length / labels.items.length } },
    execution: { status: executionStatus, requestedModel: run.requestedModel, requestedServiceTier: labels.requestedServiceTier, selectedCases: labels.items.length, runCases: run.items.length, missingIds, unexpectedIds, failedCases: failed.map(({ observationId, terminalStatus }) => ({ observationId, terminalStatus })), unknownCases: unknown.map(({ observationId }) => observationId), requestCount: run.requestCount, maxRequests: run.maxRequests, totalEstimatedCostUsd: totalCost, knownCostSubtotalUsd: knownCostSubtotal, maxEstimatedCostUsd: run.maxEstimatedCostUsd, usageMissingAttempts: missingUsage, incompleteUsageBreakdownAttempts: incompleteUsage, unpricedAttempts, retryableRateLimitAttempts, returnedModels, returnedTiers, missingReturnedModelCount, missingReturnedTierCount, returnedModelStatus, returnedTierStatus, latencyMs: { mean: completedAttempts.length ? completedAttempts.reduce((sum, attempt) => sum + attempt.latencyMs!, 0) / completedAttempts.length : null, max: completedAttempts.length ? Math.max(...completedAttempts.map((attempt) => attempt.latencyMs!)) : null } },
    usage: { inputTokens: totalInput, cachedInputTokensKnownSubtotal: cachedInputKnown, cachedInputTokensUnknownAttempts: usageRows.filter((row) => row.cachedInputTokens === null).length, cacheWriteInputTokensKnownSubtotal: cacheWriteKnown, cacheWriteInputTokensUnknownAttempts: usageRows.filter((row) => row.cacheWriteInputTokens === null).length, uncachedInputTokens: usageRows.filter((row) => row.cachedInputTokens !== null && row.cacheWriteInputTokens !== null).reduce((sum, row) => sum + row.inputTokens - row.cachedInputTokens! - row.cacheWriteInputTokens!, 0), outputTokens: totalOutput, reasoningTokensKnownSubtotal: reasoningKnown, reasoningTokensUnknownAttempts: usageRows.filter((row) => row.reasoningTokens === null).length, reasoningTokensAreIncludedInOutput: true, totalTokens: rawTotal, estimatedCostUsd: totalCost, knownCostSubtotalUsd: knownCostSubtotal, ratesPerMillionUsd: { input: run.inputPerMillionUsd, cachedInput: run.cachedInputPerMillionUsd, cacheWrite: run.cacheWritePerMillionUsd, output: run.outputPerMillionUsd } },
    perCase: labels.items.map((item) => { const result = byRunId.get(item.observationId); return { observationId: item.observationId, company: item.company, cik: item.cik, accession: item.accession, filingType: item.filingType, filingAt: item.filingAt, acceptedAt: item.acceptedAt, sourceUrl: item.sourceUrl, source: { collector: item.collector, publisher: item.publisher }, rawSourceSha256: item.rawSourceSha256, excerptSha256: item.excerptSha256, sourceReceiptSha256: item.sourceReceiptSha256, requestBinding: item.requestBinding, reference: resolveCaseLabels(item), modelStatus: result?.terminalStatus ?? "missing", prediction: acceptedClassification(result), attempts: result?.attempts ?? [] }; }),
    blindedProtocol: labels.agentLabelProtocol,
    limitations: ["Independent agent labels are references, not human ground truth.", "All selected cases remain in referenceEligibility; unresolved required references keep structured classification unverified. Resolved-subset scores do not assign a true class to unresolved references.", "Event type, takeaway, materiality and evidence sufficiency disagreements are routed to independent review because the references are not ground truth; they cannot produce a pass or an automatic model-error claim.", "Generated summary support and usefulness are not evaluated by a frozen reference set or validated judge; substring quote presence does not establish entailment, so any run containing summaries stays unverified.", "All intervals/population claims and investment value remain unverified; the 30-case issuer sample is a bounded diagnostic.", "Source-rights and SEC receipt authenticity are established by the separately bound evidence package, not model agreement."],
  };
}
