import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { EVENT_TYPES, RUBRIC_SHA } from "../server/rubric.js";

const HEX_256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/;
const PRODUCT24_PROFILE = "sec_edgar_product24_diagnostic_v1" as const;
const LEGACY_PROFILE = "sec_edgar_scoped_standard_v1" as const;
const productCompanyIds: string[] = (JSON.parse(readFileSync(new URL("../config/companies.json", import.meta.url), "utf8")) as { companies: Array<{ id: string }> }).companies.map(({ id }) => id).sort(compareCodeUnits);
const productCompanyUniverseSha256 = createHash("sha256").update(JSON.stringify(productCompanyIds), "utf8").digest("hex");
const SENTIMENTS = ["negative", "neutral", "positive"] as const;
const SENTIMENT_CLASSES = ["negative", "neutral", "positive"] as const;
const EVENT_CLASSES = EVENT_TYPES;
const INCLUSION_CUTOFFS = { about: { standard: 0.5, strictIdentity: 0.8 }, investorRelevant: { standard: 0.35, strictIdentity: 0.5 } } as const;
const EVENT_SCHEMA = z.enum(EVENT_TYPES);
const ISO_TIME = z.string().datetime({ offset: true });

const digestSchema = z.string().regex(HEX_256, "expected a lowercase SHA-256 digest");
const labelValuesSchema = z.object({
  about: z.boolean(),
  investorRelevant: z.boolean(),
  sentiment: z.enum(SENTIMENTS),
  eventType: EVENT_SCHEMA,
}).strict();

const provenanceSchema = z.object({
  observationId: z.string().min(1).max(200),
  companyId: z.string().min(1).max(200),
  strictAbout: z.boolean(),
  collectorVersion: z.string().trim().min(1).max(120),
  parserVersion: z.string().trim().min(1).max(120),
  cik: z.string().regex(/^\d{10}$/),
  accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  filingType: z.string().min(1).max(30),
  filingAt: ISO_TIME,
  acceptedAt: ISO_TIME,
  sourceUrl: z.string().url().max(2000),
  excerptSha256: digestSchema,
  jevInputSha256: digestSchema,
}).strict();

const reviewerLabelSchema = z.object({
  reviewerId: z.string().min(1).max(200),
  labels: labelValuesSchema,
  rationale: z.string().trim().min(12).max(2000),
}).strict();

const sampleStratumSchema = z.object({
  filingType: z.string().min(1).max(30),
  acceptanceQuarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  eligibleCount: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
}).strict();

const evaluationBudgetSchema = z.object({
  maxRequests: z.number().int().positive(),
  maxEstimatedCostUsd: z.number().finite().positive(),
  inputPricePerMTokUsd: z.number().finite().nonnegative(),
  outputPricePerMTokUsd: z.number().finite().nonnegative(),
  accountOwnerApproval: z.object({
    attested: z.literal(true),
    approvedAt: ISO_TIME,
    approvalRecordSha256: digestSchema,
  }).strict(),
}).strict();

const labelItemSchema = provenanceSchema.extend({
  reviews: z.array(reviewerLabelSchema).length(2),
  adjudication: reviewerLabelSchema.optional(),
}).strict();
const agentLabelValuesSchema = z.object({
  about: z.boolean().nullable(),
  investorRelevant: z.boolean().nullable(),
  sentiment: z.enum(SENTIMENTS).nullable(),
  eventType: EVENT_SCHEMA.nullable(),
}).strict();
const agentReviewerLabelSchema = z.object({
  reviewerId: z.string().min(1).max(200),
  labels: agentLabelValuesSchema,
  rationale: z.string().trim().min(12).max(2000),
}).strict();
const agentLabelItemSchema = provenanceSchema.extend({
  reviews: z.array(agentReviewerLabelSchema).length(2),
  adjudication: agentReviewerLabelSchema.optional(),
}).strict();

const labelSetV2Schema = z.object({
  schemaVersion: z.literal(2),
  stage: z.enum(["pilot", "final"]),
  studyId: z.string().min(1).max(200),
  source: z.literal("sec_edgar"),
  evaluationProfile: z.literal(LEGACY_PROFILE),
  sampleSeed: z.number().int().safe(),
  samplingWindowStart: ISO_TIME,
  samplingWindowEnd: ISO_TIME,
  sampledAt: ISO_TIME,
  frozenAt: ISO_TIME,
  analysisCodeRevision: z.string().regex(COMMIT_SHA),
  analysisCodeDirty: z.literal(false),
  rubricSha256: digestSchema,
  populationFrameSha256: digestSchema,
  evaluationBudget: evaluationBudgetSchema.optional(),
  populationFrame: z.array(provenanceSchema).min(1),
  samplePlan: z.array(sampleStratumSchema).min(1),
  sampleManifestSha256: digestSchema,
  reviewers: z.array(z.object({
    id: z.string().min(1).max(200),
    qualifiedHumanAttested: z.literal(true),
  }).strict()).min(2).max(3),
  items: z.array(labelItemSchema).min(1),
}).strict();

const agentReviewerSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.literal("independent_subagent"),
  agentThreadId: z.string().min(1).max(200),
  configuredModel: z.string().min(1).max(200),
  resolvedModel: z.string().min(1).max(200).nullable(),
  modelResolutionEvidence: digestSchema.nullable(),
  independenceAttested: z.literal(true),
  blindedToJevOutputsAttested: z.literal(true),
}).strict();

const labelSetV3Schema = labelSetV2Schema.extend({
  schemaVersion: z.literal(3),
  evaluationProfile: z.enum([LEGACY_PROFILE, PRODUCT24_PROFILE]),
  productCompanyUniverseSha256: digestSchema.optional(),
  reviewers: z.array(agentReviewerSchema).min(2).max(3),
  items: z.array(agentLabelItemSchema).min(1),
  agentLabelProtocol: z.object({
    version: z.literal("independent-subagents-blinded-v1"),
    frozenAt: ISO_TIME,
    jevOutputsOpenedAt: ISO_TIME,
  }).strict(),
});

const labelSetSchema = z.discriminatedUnion("schemaVersion", [labelSetV2Schema, labelSetV3Schema]);

const probabilitySchema = z.object({
  negative: z.number().min(0).max(1),
  neutral: z.number().min(0).max(1),
  positive: z.number().min(0).max(1),
}).strict();

const modelScoreSchema = z.object({
  sentiment: z.enum(SENTIMENTS),
  eventType: EVENT_SCHEMA,
  about: z.number().min(0).max(1),
  investorRelevant: z.number().min(0).max(1),
  sentimentProbabilities: probabilitySchema,
  resolvedModel: z.string().regex(/^jev-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
  rubricSha256: digestSchema,
}).strict();

const attemptSchema = z.object({
  outcome: z.enum(["response", "rejected", "transport_error", "unknown"]),
  submitted: z.boolean(),
  payloadSha256: digestSchema,
  statusCode: z.number().int().min(100).max(599).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().finite().nonnegative(),
  usageReconciled: z.boolean(),
}).strict();

const modelRunItemSchema = z.object({
  observationId: z.string().min(1).max(200),
  terminalStatus: z.enum(["scored", "off_target", "failed", "corrupt", "unknown"]),
  score: modelScoreSchema.nullable(),
  attempts: z.array(attemptSchema).max(3),
}).strict();

const modelRunSchema = z.object({
  runId: z.string().min(1).max(200),
  studyId: z.string().min(1).max(200),
  labelsSha256: digestSchema,
  sampleManifestSha256: digestSchema,
  rubricSha256: digestSchema,
  codeRevision: z.string().regex(COMMIT_SHA),
  sourceTreeDirty: z.literal(false),
  requestedModel: z.string().min(1).max(200),
  startedAt: ISO_TIME,
  requestCount: z.number().int().nonnegative().optional(),
  inputPricePerMTokUsd: z.number().finite().nonnegative().optional(),
  outputPricePerMTokUsd: z.number().finite().nonnegative().optional(),
  items: z.array(modelRunItemSchema),
}).strict();

export type LabelSet = z.infer<typeof labelSetSchema>;
export type ModelRun = z.infer<typeof modelRunSchema>;
export type ClassMetric = {
  support: number;
  predicted: number;
  truePositive: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
};
export type ClassificationMetrics = {
  matrix: Record<string, Record<string, number>>;
  total: number;
  exactCount: number;
  exactAgreement: number | null;
  majorityBaseline: number | null;
  macroF1: number | null;
  perClass: Record<string, ClassMetric>;
};

type Provenance = z.infer<typeof provenanceSchema>;
type ResolvedLabels = z.infer<typeof labelValuesSchema>;
type MetricInterval = { lower: number; upper: number; width: number } | null;

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

/** Hash the exact JSON request body JevClient sends, excluding HTTP headers and secrets. */
export function jevRequestPayloadSha256(model: string, state: unknown, questions: unknown): string {
  return sha256Json({ model, state, questions });
}

function manifestProjection(item: Provenance): Provenance {
  return {
    observationId: item.observationId,
    companyId: item.companyId,
    strictAbout: item.strictAbout,
    collectorVersion: item.collectorVersion,
    parserVersion: item.parserVersion,
    cik: item.cik,
    accession: item.accession,
    filingType: item.filingType,
    filingAt: item.filingAt,
    acceptedAt: item.acceptedAt,
    sourceUrl: item.sourceUrl,
    excerptSha256: item.excerptSha256,
    jevInputSha256: item.jevInputSha256,
  };
}

function acceptanceQuarter(acceptedAt: string): string {
  const time = new Date(acceptedAt);
  const quarter = Math.floor(time.getUTCMonth() / 3) + 1;
  return `${time.getUTCFullYear()}-Q${quarter}`;
}

function stratumKey(filingType: string, quarter: string): string {
  return `${filingType}\u0000${quarter}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sampledRank(seed: number, observationId: string): string {
  return sha256Json(`${seed}:${observationId}`);
}

export function sampleManifestSha256(items: readonly Provenance[]): string {
  const manifest = [...items]
    .map(manifestProjection)
    .sort((left, right) => compareCodeUnits(left.observationId, right.observationId));
  return sha256Json(manifest);
}

function validateSecProvenance(item: Provenance): void {
  const url = new URL(item.sourceUrl);
  if (url.protocol !== "https:" || !["sec.gov", "www.sec.gov"].includes(url.hostname.toLowerCase())) {
    throw new Error(`observation ${item.observationId} is outside the HTTPS SEC EDGAR source boundary`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`observation ${item.observationId} has non-canonical SEC URL components`);
  }
  const accessionPath = item.accession.replaceAll("-", "");
  const cikPath = String(Number(item.cik));
  const expectedPrefix = `/Archives/edgar/data/${cikPath}/${accessionPath}/`;
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new Error(`observation ${item.observationId} SEC URL does not bind its CIK and accession`);
  }
}

export function parseLabelSet(value: unknown): LabelSet {
  const parsed = labelSetSchema.parse(value);
  if (parsed.populationFrame.some((item) => item.strictAbout) || parsed.items.some((item) => item.strictAbout)) {
    throw new Error("sec_edgar_scoped_standard_v1 does not exercise the strict identity path; use an applicable source profile");
  }
  if (parsed.rubricSha256 !== RUBRIC_SHA) throw new Error("label set rubric SHA does not match the current frozen Jev rubric");
  if (parsed.schemaVersion === 3 && parsed.evaluationProfile === PRODUCT24_PROFILE) {
    if (parsed.productCompanyUniverseSha256 !== productCompanyUniverseSha256) throw new Error("product24 diagnostic profile does not bind the current configured company universe");
    if ([...parsed.populationFrame, ...parsed.items].some((item) => !productCompanyIds.includes(item.companyId))) {
      throw new Error("product24 diagnostic profile contains a company outside the configured 24-company product universe");
    }
    if (parsed.items.length < 30 || new Set(parsed.items.map((item) => item.companyId)).size < 8) {
      throw new Error("product24 diagnostic profile requires at least 30 cases across at least 8 configured product companies");
    }
  } else if (parsed.schemaVersion === 3 && parsed.productCompanyUniverseSha256 !== undefined) {
    throw new Error("product company universe binding is only valid for the product24 diagnostic profile");
  }
  if (Date.parse(parsed.samplingWindowStart) >= Date.parse(parsed.samplingWindowEnd)) throw new Error("sampling window must have positive duration");
  if (Date.parse(parsed.samplingWindowEnd) > Date.parse(parsed.sampledAt)) throw new Error("sample snapshot predates the end of its sampling window");
  if (Date.parse(parsed.sampledAt) > Date.parse(parsed.frozenAt)) throw new Error("sample freeze predates sampling");
  if (parsed.stage === "final") {
    if (!parsed.evaluationBudget) throw new Error("final label set requires a frozen, account-owner-approved evaluation budget");
    if (parsed.evaluationBudget.maxRequests < parsed.items.length) throw new Error("frozen request ceiling is below the selected sample size");
    if (Date.parse(parsed.evaluationBudget.accountOwnerApproval.approvedAt) > Date.parse(parsed.frozenAt)) {
      throw new Error("evaluation budget approval must predate the frozen sample");
    }
  }

  const reviewerIds = parsed.reviewers.map((reviewer) => reviewer.id);
  if (new Set(reviewerIds).size !== reviewerIds.length) throw new Error("reviewer IDs must be distinct");
  if (reviewerIds.length !== 2 && reviewerIds.length !== 3) throw new Error("the study permits two reviewers and, when needed, one adjudicator");
  if (parsed.schemaVersion === 3) {
    const agentThreads = parsed.reviewers.map((reviewer) => reviewer.agentThreadId);
    if (new Set(agentThreads).size !== agentThreads.length) throw new Error("independent agents must have distinct thread identities");
    if (parsed.agentLabelProtocol.frozenAt !== parsed.frozenAt) throw new Error("agent label protocol freeze time must match the frozen sample chronology");
    if (Date.parse(parsed.agentLabelProtocol.jevOutputsOpenedAt) < Date.parse(parsed.frozenAt)) {
      throw new Error("Jev outputs cannot be opened before blinded agent labels are frozen");
    }
  }
  const primaryReviewerIds = new Set(reviewerIds.slice(0, 2));
  if (parsed.items.length !== new Set(parsed.items.map((item) => item.observationId)).size) {
    throw new Error("sample contains duplicate observation IDs");
  }
  if (parsed.populationFrame.length !== new Set(parsed.populationFrame.map((item) => item.observationId)).size) {
    throw new Error("population frame contains duplicate observation IDs");
  }
  const accessionUnits = parsed.populationFrame.map((item) => `${item.cik}:${item.accession}`);
  if (accessionUnits.length !== new Set(accessionUnits).size) throw new Error("population frame contains duplicate issuer-filing units");

  for (const item of parsed.populationFrame) {
    validateSecProvenance(item);
    if (Date.parse(item.acceptedAt) < Date.parse(parsed.samplingWindowStart) || Date.parse(item.acceptedAt) > Date.parse(parsed.samplingWindowEnd)) {
      throw new Error(`population observation ${item.observationId} falls outside the frozen sampling window`);
    }
    if (Date.parse(item.acceptedAt) < Date.parse(item.filingAt)) throw new Error(`observation ${item.observationId} acceptance time precedes its filing time`);
  }
  if (sampleManifestSha256(parsed.populationFrame) !== parsed.populationFrameSha256) {
    throw new Error("population frame digest does not match all eligible provenance rows");
  }

  const frameById = new Map(parsed.populationFrame.map((item) => [item.observationId, item]));
  for (const item of parsed.items) {
    const frameItem = frameById.get(item.observationId);
    if (!frameItem || sha256Json(manifestProjection(item)) !== sha256Json(manifestProjection(frameItem))) {
      throw new Error(`sample observation ${item.observationId} does not match the frozen population frame`);
    }
    const rowReviewerIds = item.reviews.map((review) => review.reviewerId);
    if (new Set(rowReviewerIds).size !== 2 || !rowReviewerIds.every((id) => primaryReviewerIds.has(id))) {
      throw new Error(`observation ${item.observationId} must have both named primary reviewers`);
    }
    const differs = parsed.schemaVersion === 3
      ? !sameAgentLabels(item.reviews[0]!.labels, item.reviews[1]!.labels)
      : !sameLabels(item.reviews[0]!.labels as ResolvedLabels, item.reviews[1]!.labels as ResolvedLabels);
    const hasAgentAbstention = parsed.schemaVersion === 3 && (Object.values(item.reviews[0]!.labels).some((value) => value === null) || Object.values(item.reviews[1]!.labels).some((value) => value === null));
    if (item.adjudication) {
      if (item.adjudication.reviewerId === item.reviews[0]!.reviewerId || item.adjudication.reviewerId === item.reviews[1]!.reviewerId) {
        throw new Error(`observation ${item.observationId} adjudication must use a third reviewer`);
      }
      if (!reviewerIds.includes(item.adjudication.reviewerId)) throw new Error(`observation ${item.observationId} adjudicator is not attested in the reviewer roster`);
    }
    if (!differs && !hasAgentAbstention && item.adjudication) throw new Error(`observation ${item.observationId} has unnecessary adjudication`);
    if (parsed.schemaVersion === 2 && parsed.stage === "final" && differs && !item.adjudication) {
      throw new Error(`final sample has unresolved reviewer disagreement for ${item.observationId}`);
    }
  }

  const frameStrata = new Map<string, number>();
  for (const item of parsed.populationFrame) {
    const key = stratumKey(item.filingType, acceptanceQuarter(item.acceptedAt));
    frameStrata.set(key, (frameStrata.get(key) ?? 0) + 1);
  }
  const selectedStrata = new Map<string, number>();
  for (const item of parsed.items) {
    const key = stratumKey(item.filingType, acceptanceQuarter(item.acceptedAt));
    selectedStrata.set(key, (selectedStrata.get(key) ?? 0) + 1);
  }
  const plans = new Map(parsed.samplePlan.map((stratum) => [stratumKey(stratum.filingType, stratum.acceptanceQuarter), stratum]));
  if (plans.size !== parsed.samplePlan.length || plans.size !== frameStrata.size) throw new Error("sample plan must declare every population stratum exactly once");
  for (const [key, eligibleCount] of frameStrata) {
    const plan = plans.get(key);
    if (!plan || plan.eligibleCount !== eligibleCount || plan.sampleCount !== (selectedStrata.get(key) ?? 0) || plan.sampleCount > plan.eligibleCount) {
      throw new Error("sample plan counts do not match the population frame and selected labels");
    }
    const frameRows = parsed.populationFrame.filter((item) => stratumKey(item.filingType, acceptanceQuarter(item.acceptedAt)) === key);
    const expectedIds = [...frameRows]
      .sort((left, right) => compareCodeUnits(sampledRank(parsed.sampleSeed, left.observationId), sampledRank(parsed.sampleSeed, right.observationId)) || compareCodeUnits(left.observationId, right.observationId))
      .slice(0, plan.sampleCount)
      .map((item) => item.observationId)
      .sort();
    const actualIds = parsed.items
      .filter((item) => stratumKey(item.filingType, acceptanceQuarter(item.acceptedAt)) === key)
      .map((item) => item.observationId)
      .sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new Error("sample rows do not match deterministic stratified selection from the frozen seed");
  }

  if (sampleManifestSha256(parsed.items) !== parsed.sampleManifestSha256) {
    throw new Error("sample manifest digest does not match the provenance rows");
  }
  return parsed;
}

export function parseModelRun(value: unknown): ModelRun {
  const parsed = modelRunSchema.parse(value);
  if (new Set(parsed.items.map((item) => item.observationId)).size !== parsed.items.length) {
    throw new Error("model run contains duplicate observation IDs");
  }
  for (const item of parsed.items) {
    if (["scored", "off_target"].includes(item.terminalStatus) !== (item.score !== null)) {
      throw new Error(`model run score and terminal status disagree for ${item.observationId}`);
    }
    for (const score of item.score ? [item.score] : []) {
      const probabilityTotal = score.sentimentProbabilities.negative + score.sentimentProbabilities.neutral + score.sentimentProbabilities.positive;
      if (Math.abs(probabilityTotal - 1) > 0.001) throw new Error(`sentiment probabilities do not sum to one for ${item.observationId}`);
    }
    let submittedRequestSeen = false;
    for (let index = 0; index < item.attempts.length; index += 1) {
      const attempt = item.attempts[index]!;
      if (attempt.outcome === "unknown" && item.attempts.slice(index + 1).some((later) => later.submitted)) {
        throw new Error(`unsafe resubmission after unknown provider outcome for ${item.observationId}`);
      }
      if (attempt.submitted && submittedRequestSeen) {
        throw new Error(`duplicate submitted provider request for ${item.observationId}; evaluation samples permit at most one call per observation`);
      }
      if (attempt.submitted) submittedRequestSeen = true;
      if (attempt.outcome === "response" && (!attempt.submitted || attempt.statusCode === null || attempt.statusCode < 200 || attempt.statusCode >= 300)) {
        throw new Error(`response attempt lacks a submitted successful HTTP response for ${item.observationId}`);
      }
      if (attempt.outcome === "rejected" && (!attempt.submitted || attempt.statusCode === null || (attempt.statusCode >= 200 && attempt.statusCode < 300))) {
        throw new Error(`rejected attempt lacks a submitted non-success HTTP status for ${item.observationId}`);
      }
      if (attempt.outcome === "unknown" && !attempt.submitted) throw new Error(`unknown provider outcome was not marked submitted for ${item.observationId}`);
      if (attempt.outcome === "unknown" && !attempt.usageReconciled) {
        // Keep the run parseable so the report can show this hard gate as failed.
      }
    }
    if (item.score && item.score.rubricSha256 !== parsed.rubricSha256) {
      throw new Error(`model run item rubric SHA differs from its run header for ${item.observationId}`);
    }
    if (item.score && !item.attempts.some((attempt) => attempt.submitted && attempt.outcome === "response")) {
      throw new Error(`scored item has no submitted successful provider response for ${item.observationId}`);
    }
  }
  const actualRequests = parsed.items.reduce((total, item) => total + item.attempts.filter((attempt) => attempt.submitted).length, 0);
  if (parsed.requestCount !== undefined && parsed.requestCount !== actualRequests) throw new Error("request count does not match the per-item attempt ledger");
  return parsed;
}

function analyzeAgentFinal(input: { labels: Extract<LabelSet, { schemaVersion: 3 }>; labelsSha256: string; run: ModelRun }): Record<string, any> {
  const { labels, labelsSha256, run } = input;
  const budget = labels.evaluationBudget;
  if (!budget) throw new Error("final analysis requires a frozen evaluation budget");
  if (run.labelsSha256 !== labelsSha256) throw new Error("model run label digest does not match the exact label artifact");
  if (run.studyId !== labels.studyId) throw new Error("model run study ID differs from the frozen label set");
  if (run.sampleManifestSha256 !== labels.sampleManifestSha256) throw new Error("model run sample manifest digest differs from labels");
  if (run.rubricSha256 !== labels.rubricSha256 || run.rubricSha256 !== RUBRIC_SHA) throw new Error("model run rubric digest differs from the frozen label set");
  if (run.codeRevision !== labels.analysisCodeRevision || run.sourceTreeDirty) throw new Error("model run code identity differs from the clean frozen analysis revision");
  if (Date.parse(run.startedAt) < Date.parse(labels.frozenAt) || Date.parse(run.startedAt) !== Date.parse(labels.agentLabelProtocol.jevOutputsOpenedAt)) throw new Error("model run start does not match the blinded freeze chronology");

  const expectedIds = new Set(labels.items.map((item) => item.observationId));
  const byRunId = new Map(run.items.map((item) => [item.observationId, item]));
  const missingIds = [...expectedIds].filter((id) => !byRunId.has(id));
  const unexpectedIds = [...byRunId.keys()].filter((id) => !expectedIds.has(id));
  const inputDigests = new Map(labels.items.map((item) => [item.observationId, item.jevInputSha256]));
  for (const runItem of run.items) {
    if (runItem.attempts.some((attempt) => attempt.payloadSha256 !== inputDigests.get(runItem.observationId))) {
      throw new Error(`Jev request payload digest differs from the frozen input for ${runItem.observationId}`);
    }
  }
  const resolved = labels.items.map((item) => ({ item, labels: resolveAgentLabels(item), run: byRunId.get(item.observationId) ?? null }));
  const scored = resolved.filter((row) => row.run?.score !== null && row.run !== null);
  const scoreColumn = <T extends string | boolean>(key: "sentiment" | "eventType" | "about" | "investorRelevant", isText: boolean) => {
    const rows = resolved.filter((row) => row.labels[key] !== null);
    if (isText) {
      const classes = key === "sentiment" ? SENTIMENT_CLASSES : EVENT_CLASSES;
      const result = scoreClassification({
        name: key === "sentiment" ? "sentiment" : "eventType",
        labels: rows.map((row) => String(row.labels[key])),
        predictions: rows.map((row) => row.run?.score ? String(row.run.score[key as "sentiment" | "eventType"]) : null),
        clusters: rows.map((row) => row.item.cik),
        classes,
        seed: Number.parseInt(sha256Json({ labelsSha256, runId: run.runId, key }).slice(0, 8), 16),
      });
      return { rows, metrics: result.metrics, intervals: result.intervals, clusterCount: result.clusterSupport, classes };
    }
    const cutoffs = rows.map((row) => key === "about" ? INCLUSION_CUTOFFS.about.standard : INCLUSION_CUTOFFS.investorRelevant.standard);
    return {
      rows,
      metrics: boundaryMetrics(rows.map((row) => row.labels[key] as boolean), rows.map((row) => row.run?.score?.[key as "about" | "investorRelevant"] ?? null), cutoffs),
      clusterCount: new Set(rows.map((row) => row.item.cik)).size,
    };
  };
  const sentiment = scoreColumn("sentiment", true);
  const eventType = scoreColumn("eventType", true);
  const about = scoreColumn("about", false);
  const investorRelevant = scoreColumn("investorRelevant", false);
  const classificationCheck = (metric: ClassificationMetrics, classes: readonly string[], requireAll: boolean) => {
    const missing = classes.filter((label) => metric.perClass[label]!.support === 0);
    const represented = classes.filter((label) => metric.perClass[label]!.support > 0);
    const failures = represented.filter((label) => {
      const row = metric.perClass[label]!;
      return row.precision === null || row.recall === null || row.precision < 0.7 || row.recall < 0.7;
    });
    const macroF1 = represented.length ? represented.reduce((sum, label) => sum + metric.perClass[label]!.f1!, 0) / represented.length : null;
    const status = failures.length || (requireAll && missing.length) || (macroF1 !== null && macroF1 < 0.8) ? "FAIL" : macroF1 === null ? "UNVERIFIED" : "PASS";
    return { status, macroF1, thresholds: { macroF1: 0.8, representedClassPrecision: 0.7, representedClassRecall: 0.7 }, representedClasses: represented, missingRequiredClasses: requireAll ? missing : [], untestedClasses: requireAll ? [] : missing, classFailures: failures };
  };
  const boundaryCheck = (metric: ReturnType<typeof boundaryMetrics>) => ({
    status: metric.support === 0 ? "UNVERIFIED" : metric.precision === null ? "UNVERIFIED" : metric.precision < 0.9 ? "FAIL" : "PASS",
    precision: metric.precision,
    positiveLabels: metric.support,
    threshold: 0.9,
  });
  const diagnosticChecks = {
    sentiment: classificationCheck(sentiment.metrics as ClassificationMetrics, SENTIMENT_CLASSES, true),
    eventType: classificationCheck(eventType.metrics as ClassificationMetrics, EVENT_CLASSES, false),
    aboutInclusionPrecision: boundaryCheck(about.metrics as ReturnType<typeof boundaryMetrics>),
    investorRelevantPrecision: boundaryCheck(investorRelevant.metrics as ReturnType<typeof boundaryMetrics>),
  };
  const referenceStatuses = Object.values(diagnosticChecks).map((check) => check.status);
  const unresolved = resolved.flatMap(({ item, labels: values }) => (["about", "investorRelevant", "sentiment", "eventType"] as const)
    .filter((key) => values[key] === null).map((field) => ({ observationId: item.observationId, field })));
  const agentReferenceAgreementStatus = referenceStatuses.includes("FAIL") ? "FAIL" : referenceStatuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
  const submitted = run.items.flatMap((item) => item.attempts).filter((attempt) => attempt.submitted);
  const missingUsage = submitted.filter((attempt) => attempt.inputTokens === null || attempt.outputTokens === null).length;
  const actualRequestCount = submitted.length;
  const pricesMatch = run.inputPricePerMTokUsd === budget.inputPricePerMTokUsd && run.outputPricePerMTokUsd === budget.outputPricePerMTokUsd;
  const estimatedCostUsd = pricesMatch && missingUsage === 0
    ? (submitted.reduce((sum, attempt) => sum + attempt.inputTokens! * budget.inputPricePerMTokUsd + attempt.outputTokens! * budget.outputPricePerMTokUsd, 0) / 1_000_000)
    : null;
  const unreconciledOutcomeCount = submitted.filter((attempt) => ["unknown", "transport_error"].includes(attempt.outcome) && !attempt.usageReconciled).length;
  const failedOutcomes = run.items.filter((item) => ["failed", "corrupt"].includes(item.terminalStatus));
  const unknownOutcomes = run.items.filter((item) => item.terminalStatus === "unknown");
  const resolvedModels = [...new Set(run.items.flatMap((item) => item.score ? [item.score.resolvedModel] : []))];
  const executionChecks = {
    exactFrozenDenominator: { status: missingIds.length || unexpectedIds.length || run.items.length !== labels.items.length ? "FAIL" : "PASS", missingIds, unexpectedIds, selectedCases: labels.items.length, runCases: run.items.length },
    terminalExecution: { status: failedOutcomes.length ? "FAIL" : unknownOutcomes.length ? "UNVERIFIED" : "PASS", failedCaseIds: failedOutcomes.map((item) => item.observationId), unknownCaseIds: unknownOutcomes.map((item) => item.observationId), offTargetIsValid: true },
    requestSafety: { status: unreconciledOutcomeCount ? "UNVERIFIED" : "PASS", unreconciledUnknownOrTransportOutcomes: unreconciledOutcomeCount },
    accountBudget: { status: actualRequestCount > budget.maxRequests || !pricesMatch ? "FAIL" : estimatedCostUsd === null ? "UNVERIFIED" : estimatedCostUsd > budget.maxEstimatedCostUsd ? "FAIL" : "PASS", actualRequestCount, maxRequests: budget.maxRequests, estimatedCostUsd, maxEstimatedCostUsd: budget.maxEstimatedCostUsd, missingUsage },
    resolvedModelProvenance: { status: resolvedModels.length === 1 ? "PASS" : "FAIL", resolvedModels, requestedModel: run.requestedModel },
    productSample: { status: labels.items.length >= 30 && new Set(labels.items.map((item) => item.companyId)).size >= 8 ? "PASS" : "FAIL", selectedCases: labels.items.length, minimumCases: 30, configuredCompanies: new Set(labels.items.map((item) => item.companyId)).size, minimumCompanies: 8 },
  };
  const executionStatuses = Object.values(executionChecks).map((check) => check.status);
  const provenanceExecutionStatus = executionStatuses.includes("FAIL") ? "FAIL" : executionStatuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
  const status = agentReferenceAgreementStatus === "FAIL" || provenanceExecutionStatus === "FAIL" ? "FAIL"
    : agentReferenceAgreementStatus === "UNVERIFIED" || provenanceExecutionStatus === "UNVERIFIED" ? "UNVERIFIED" : "PASS";
  const rawAgentAgreement = Object.fromEntries((["about", "investorRelevant", "sentiment", "eventType"] as const).map((key) => [key, agentColumnAgreement(
    labels.items.map((item) => item.reviews[0]!.labels[key]), labels.items.map((item) => item.reviews[1]!.labels[key]),
  )]));
  const perCase = labels.items.map((item) => {
    const runItem = byRunId.get(item.observationId);
    const reference = resolveAgentLabels(item);
    return { observationId: item.observationId, companyId: item.companyId, agentReviews: item.reviews, agentAdjudication: item.adjudication ?? null, resolvedReferenceFields: reference, runStatus: runItem?.terminalStatus ?? "missing", excludedFields: Object.keys(reference).filter((field) => reference[field as keyof typeof reference] === null) };
  });
  return {
    mode: "final-agent-agreement-evaluation",
    status,
    statusScope: "bounded product24 operational diagnostic; not statistical certification or human-ground-truth accuracy",
    releaseReadiness: "NOT_CLEARED_BY_THIS_REPORT; source rights, provider account terms, retention, billing, SEC User-Agent, and other release gates remain separate",
    evaluationProfile: labels.evaluationProfile,
    labelAuthority: "independent_subagents",
    humanGroundTruth: "NOT_PROVIDED",
    agentReferenceAgreementStatus,
    provenanceExecutionStatus,
    statisticalCertification: "UNVERIFIED",
    studyId: labels.studyId,
    runId: run.runId,
    source: labels.source,
    selectedCaseDenominator: labels.items.length,
    modelScoredCaseDenominator: scored.length,
    resolvedReferenceCaseDenominator: new Set(resolved.filter(({ labels: values }) => Object.values(values).some((value) => value !== null)).map(({ item }) => item.observationId)).size,
    unresolvedLabelFieldDenominator: unresolved.length,
    issuerCikClusterCount: new Set(labels.items.map((item) => item.cik)).size,
    configuredCompanySupport: new Set(labels.items.map((item) => item.companyId)).size,
    productCompanyUniverseSha256: productCompanyUniverseSha256,
    provenance: { labelsSha256, modelRunSha256: sha256Json(run), populationFrameSha256: labels.populationFrameSha256, sampleManifestSha256: labels.sampleManifestSha256, rubricSha256: labels.rubricSha256, codeRevision: run.codeRevision, requestedModel: run.requestedModel, resolvedModels, frozenAt: labels.frozenAt, runStartedAt: run.startedAt, collectorParserVersions: [...new Set(labels.items.flatMap((item) => [item.collectorVersion, item.parserVersion]))].sort() },
    agentLabelProtocol: { ...labels.agentLabelProtocol, reviewers: labels.reviewers },
    bootstrap: { method: "percentile cluster bootstrap with issuer CIK resampling", replicates: 2000, clusterKey: "CIK", intervalsAreDescriptive: true },
    agentAgreement: {
      rawAgentAgreement,
      sentiment: { metrics: sentiment.metrics, clusterBootstrap95: sentiment.intervals, selectedCases: labels.items.length, resolvedReferenceCases: sentiment.rows.length, modelScoredReferenceCases: sentiment.rows.filter((row) => row.run?.score !== null && row.run !== null).length },
      eventType: { metrics: eventType.metrics, clusterBootstrap95: eventType.intervals, selectedCases: labels.items.length, resolvedReferenceCases: eventType.rows.length, modelScoredReferenceCases: eventType.rows.filter((row) => row.run?.score !== null && row.run !== null).length },
      aboutInclusion: { ...about.metrics, selectedCases: labels.items.length, resolvedReferenceCases: about.rows.length, modelScoredReferenceCases: about.rows.filter((row) => row.run?.score !== null && row.run !== null).length },
      investorRelevantInclusion: { ...investorRelevant.metrics, selectedCases: labels.items.length, resolvedReferenceCases: investorRelevant.rows.length, modelScoredReferenceCases: investorRelevant.rows.filter((row) => row.run?.score !== null && row.run !== null).length },
      diagnosticChecks,
      excludedCases: perCase.filter((item) => item.runStatus === "missing" || ["failed", "corrupt", "unknown"].includes(item.runStatus)).map(({ observationId, runStatus }) => ({ observationId, reason: runStatus })),
      unresolvedLabels: unresolved,
      untestedEventTypes: diagnosticChecks.eventType.untestedClasses,
      perCase,
    },
    gates: { agentReferenceAgreement: { status: agentReferenceAgreementStatus, checks: diagnosticChecks }, provenanceExecution: { status: provenanceExecutionStatus, checks: executionChecks }, statisticalCertification: { status: "UNVERIFIED", reason: "the 24-company diagnostic has descriptive intervals but does not satisfy the legacy 30-issuer statistical certification profile" } },
    operations: { requestCount: actualRequestCount, attemptsMissingUsage: missingUsage, estimatedCostUsd, maxEstimatedCostUsd: budget.maxEstimatedCostUsd, maxRequests: budget.maxRequests, p50LatencyMs: quantile(submitted.map((attempt) => attempt.latencyMs), 0.5), p95LatencyMs: quantile(submitted.map((attempt) => attempt.latencyMs), 0.95) },
    limitations: ["Agent labels are an independent model reference and are not human ground truth.", "All frozen cases and per-field abstentions remain visible; unresolved fields are excluded only from that field's metric and remain in denominators.", "Issuer bootstrap intervals are descriptive and do not establish statistical certification or population generalization.", "Provider receipts, billing reconciliation, source rights, actual service identity, and SEC source correspondence still require independently bound supporting artifacts."],
  };
}

function sameLabels(left: ResolvedLabels, right: ResolvedLabels): boolean {
  return left.about === right.about
    && left.investorRelevant === right.investorRelevant
    && left.sentiment === right.sentiment
    && left.eventType === right.eventType;
}

function sameAgentLabels(left: z.infer<typeof agentLabelValuesSchema>, right: z.infer<typeof agentLabelValuesSchema>): boolean {
  return left.about === right.about
    && left.investorRelevant === right.investorRelevant
    && left.sentiment === right.sentiment
    && left.eventType === right.eventType;
}

function resolveLabels(item: z.infer<typeof labelItemSchema>): ResolvedLabels | null {
  if (sameLabels(item.reviews[0]!.labels, item.reviews[1]!.labels)) return item.reviews[0]!.labels;
  return item.adjudication?.labels ?? null;
}

function agreement<T>(left: readonly T[], right: readonly T[]): { exactCount: number; total: number; rate: number | null } {
  const total = Math.min(left.length, right.length);
  const exactCount = left.slice(0, total).reduce((count, value, index) => count + Number(value === right[index]), 0);
  return { exactCount, total, rate: total > 0 ? exactCount / total : null };
}

function prevalence<T extends string | boolean>(values: readonly T[], classes: readonly T[]): Record<string, { count: number; rate: number | null }> {
  return Object.fromEntries(classes.map((value) => {
    const count = values.filter((item) => item === value).length;
    return [String(value), { count, rate: values.length ? count / values.length : null }];
  }));
}

function resolveAgentLabels(item: z.infer<typeof agentLabelItemSchema>): z.infer<typeof agentLabelValuesSchema> {
  const first = item.reviews[0]!.labels;
  const second = item.reviews[1]!.labels;
  const resolved: Record<string, boolean | string | null> = {};
  for (const key of ["about", "investorRelevant", "sentiment", "eventType"] as const) {
    resolved[key] = first[key] !== null && first[key] === second[key]
      ? first[key]
      : item.adjudication?.labels[key] ?? null;
  }
  return resolved as z.infer<typeof agentLabelValuesSchema>;
}

function agentColumnAgreement<T>(left: readonly (T | null)[], right: readonly (T | null)[]) {
  const exactCount = left.reduce((count, value, index) => count + Number(value !== null && value === right[index]), 0);
  const resolvedPairCount = left.reduce((count, value, index) => count + Number(value !== null && right[index] !== null), 0);
  const unresolvedPairCount = left.length - resolvedPairCount;
  return { exactCount, selectedCases: left.length, resolvedPairCount, unresolvedPairCount, rate: resolvedPairCount ? exactCount / resolvedPairCount : null };
}

function analyzeAgentPilot(input: { labels: Extract<LabelSet, { schemaVersion: 3 }>; labelsSha256: string }): Record<string, unknown> {
  const { labels } = input;
  const columns = ["about", "investorRelevant", "sentiment", "eventType"] as const;
  const rawAgentAgreement = Object.fromEntries(columns.map((key) => [key, agentColumnAgreement(
    labels.items.map((item) => item.reviews[0]!.labels[key]),
    labels.items.map((item) => item.reviews[1]!.labels[key]),
  )]));
  const resolved = labels.items.map(resolveAgentLabels);
  const categories = {
    about: [false, true] as const,
    investorRelevant: [false, true] as const,
    sentiment: SENTIMENT_CLASSES,
    eventType: EVENT_CLASSES,
  };
  const prevalenceAfterAgentAdjudication = Object.fromEntries(columns.map((key) => [key, prevalence(
    resolved.map((item) => item[key]).filter((value): value is NonNullable<typeof value> => value !== null),
    categories[key] as never,
  )]));
  const unresolvedLabelFields = labels.items.flatMap((item) => columns.filter((key) => resolveAgentLabels(item)[key] === null).map((field) => ({ observationId: item.observationId, field })));
  return {
    mode: "agent-label-agreement-pilot",
    studyId: labels.studyId,
    source: labels.source,
    evaluationProfile: labels.evaluationProfile,
    labelAuthority: "independent_subagents",
    humanGroundTruth: "NOT_PROVIDED",
    statisticalCertification: "UNVERIFIED",
    itemCount: labels.items.length,
    issuerClusterCount: new Set(labels.items.map((item) => item.cik)).size,
    labelsSha256: input.labelsSha256,
    sampleManifestSha256: labels.sampleManifestSha256,
    rubricSha256: labels.rubricSha256,
    agentIds: labels.reviewers.slice(0, 2).map(({ id }) => id),
    rawAgentAgreement,
    prevalenceAfterAgentAdjudication,
    unresolvedLabelFields,
    resolution: "descriptive agreement between independent subagents only; labels are not human ground truth",
    blinding: { labelsFrozenAt: labels.agentLabelProtocol.frozenAt, jevOutputsOpenedAt: labels.agentLabelProtocol.jevOutputsOpenedAt },
    limitations: [
      "No Jev outputs were read or joined in label-only mode.",
      "Agent agreement does not establish classifier accuracy, calibration, source rights, account authorization, or investment performance.",
      "Agent independence, identity, model configuration, and blinding are recorded attestations; this tool cannot independently verify them.",
    ],
  };
}

export function analyzePilot(input: { labels: LabelSet; labelsSha256: string }): Record<string, unknown> {
  const { labels } = input;
  if (labels.schemaVersion === 3) return analyzeAgentPilot({ labels, labelsSha256: input.labelsSha256 });
  const primaryIds = labels.reviewers.slice(0, 2).map((reviewer) => reviewer.id);
  const first: Record<string, unknown[]> = { about: [], investorRelevant: [], sentiment: [], eventType: [] };
  const second: Record<string, unknown[]> = { about: [], investorRelevant: [], sentiment: [], eventType: [] };
  const resolved: ResolvedLabels[] = [];
  let unresolvedCount = 0;
  for (const item of labels.items) {
    const reviewA = item.reviews.find((review) => review.reviewerId === primaryIds[0])!;
    const reviewB = item.reviews.find((review) => review.reviewerId === primaryIds[1])!;
    for (const key of Object.keys(first) as Array<keyof ResolvedLabels>) {
      first[key]!.push(reviewA.labels[key]);
      second[key]!.push(reviewB.labels[key]);
    }
    const resolution = resolveLabels(item);
    if (resolution) resolved.push(resolution);
    else unresolvedCount += 1;
  }
  const issuerClusterCount = new Set(labels.items.map((item) => item.cik)).size;
  const exactAgreement: Record<string, ReturnType<typeof agreement>> = {};
  const adjudicatedPrevalence: Record<string, Record<string, { count: number; rate: number | null }>> = {};
  const categorical: Array<keyof ResolvedLabels> = ["about", "investorRelevant", "sentiment", "eventType"];
  for (const key of categorical) {
    exactAgreement[key] = agreement(first[key]!, second[key]!);
    const categories = key === "about" || key === "investorRelevant"
      ? [false, true]
      : key === "sentiment" ? SENTIMENT_CLASSES : EVENT_CLASSES;
    adjudicatedPrevalence[key] = prevalence(resolved.map((item) => item[key]), categories as never);
  }
  return {
    mode: "label-only-pilot",
    studyId: labels.studyId,
    source: "sec_edgar",
    evaluationProfile: labels.evaluationProfile,
    pathApplicability: { standard: "IN_SCOPE", strictIdentity: "OUT_OF_SCOPE" },
    itemCount: labels.items.length,
    issuerClusterCount,
    labelsSha256: input.labelsSha256,
    sampleManifestSha256: labels.sampleManifestSha256,
    rubricSha256: labels.rubricSha256,
    reviewerIds: primaryIds,
    agreement: exactAgreement,
    prevalenceAfterAdjudication: adjudicatedPrevalence,
    unresolvedDisagreementCount: unresolvedCount,
    resolution: "pilot descriptive only; human qualifications and blinding are attested, not independently verified by this tool",
    finalSamplePlanning: "observed prevalence and reviewer disagreement are supplied for planning; final sample size still requires an independently justified issuer design effect and an account-owner-approved request/cost ceiling before Jev output is opened",
    limitations: [
      "No Jev outputs were read or joined in label-only mode.",
      "This pilot does not establish classifier accuracy, calibration, source rights, account authorization, or investment performance.",
      "Prevalence excludes unresolved disagreements; both original reviewer labels remain in the input artifact.",
    ],
  };
}

function blankMatrix(classes: readonly string[]): Record<string, Record<string, number>> {
  return Object.fromEntries(classes.map((actual) => [
    actual,
    Object.fromEntries([...classes, "missing"].map((predicted) => [predicted, 0])),
  ]));
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function classificationMetrics(input: {
  labels: readonly string[];
  predictions: readonly (string | null)[];
  classes: readonly string[];
}): ClassificationMetrics {
  const { labels, predictions, classes } = input;
  if (labels.length !== predictions.length) throw new Error("labels and predictions must have identical lengths");
  if (new Set(classes).size !== classes.length || classes.length < 2) throw new Error("classes must be distinct and contain at least two values");
  if (labels.some((label) => !classes.includes(label))) throw new Error("labels contain a value outside the declared class set");
  if (predictions.some((prediction) => prediction !== null && !classes.includes(prediction))) throw new Error("predictions contain a value outside the declared class set");

  const matrix = blankMatrix(classes);
  let exactCount = 0;
  for (let index = 0; index < labels.length; index += 1) {
    const actual = labels[index]!;
    const predicted = predictions[index] ?? "missing";
    const row = matrix[actual]!;
    row[predicted] = row[predicted]! + 1;
    if (actual === predicted) exactCount += 1;
  }
  const perClass: Record<string, ClassMetric> = {};
  const f1Values: number[] = [];
  const labelCounts = new Map(classes.map((value) => [value, 0]));
  for (const actual of labels) labelCounts.set(actual, labelCounts.get(actual)! + 1);
  for (const name of classes) {
    const support = labelCounts.get(name)!;
    const predicted = labels.reduce((count, _actual, index) => count + Number(predictions[index] === name), 0);
    const truePositive = matrix[name]![name]!;
    const precision = predicted > 0 ? truePositive / predicted : support > 0 ? 0 : null;
    const recall = support > 0 ? truePositive / support : null;
    const f1Denominator = (2 * truePositive) + (predicted - truePositive) + (support - truePositive);
    const f1 = f1Denominator > 0 ? (2 * truePositive) / f1Denominator : 0;
    f1Values.push(f1);
    perClass[name] = { support, predicted, truePositive, precision, recall, f1 };
  }
  const majorityCount = Math.max(0, ...labelCounts.values());
  return {
    matrix,
    total: labels.length,
    exactCount,
    exactAgreement: divide(exactCount, labels.length),
    majorityBaseline: divide(majorityCount, labels.length),
    macroF1: f1Values.length === classes.length ? f1Values.reduce((sum, value) => sum + value, 0) / classes.length : null,
    perClass,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sorted[lowerIndex]!;
  const upperValue = sorted[upperIndex]!;
  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}

function percentileInterval(values: readonly number[], low = 0.025, high = 0.975): MetricInterval {
  const lower = quantile(values, low);
  const upper = quantile(values, high);
  if (lower === null || upper === null) return null;
  return { lower, upper, width: upper - lower };
}

function clusteredIntervals(input: {
  labels: readonly string[];
  predictions: readonly (string | null)[];
  clusters: readonly string[];
  classes: readonly string[];
  seed: number;
  replicates?: number;
}): {
  exactAgreement: MetricInterval;
  macroF1: MetricInterval;
  baselineImprovement: MetricInterval;
  perClass: Record<string, { precision: MetricInterval; recall: MetricInterval; f1: MetricInterval; clusterSupport: number; precisionValidReplicateFraction: number; recallValidReplicateFraction: number }>;
} {
  const { labels, predictions, clusters, classes } = input;
  if (labels.length !== clusters.length) throw new Error("cluster IDs must align with labels");
  const grouped = new Map<string, number[]>();
  clusters.forEach((cluster, index) => grouped.set(cluster, [...(grouped.get(cluster) ?? []), index]));
  const clusterIds = [...grouped.keys()].sort();
  const random = mulberry32(input.seed);
  const replicates = input.replicates ?? 2000;
  const values: { exactAgreement: number[]; macroF1: number[]; baselineImprovement: number[] } = { exactAgreement: [], macroF1: [], baselineImprovement: [] };
  const perClass: Record<string, { precision: number[]; recall: number[]; f1: number[]; precisionValidReplicates: number; recallValidReplicates: number }> = Object.fromEntries(classes.map((name) => [name, { precision: [], recall: [], f1: [], precisionValidReplicates: 0, recallValidReplicates: 0 }]));

  for (let iteration = 0; iteration < replicates; iteration += 1) {
    const sampledLabels: string[] = [];
    const sampledPredictions: Array<string | null> = [];
    for (let clusterDraw = 0; clusterDraw < clusterIds.length; clusterDraw += 1) {
      const clusterId = clusterIds[Math.floor(random() * clusterIds.length)]!;
      for (const index of grouped.get(clusterId)!) {
        sampledLabels.push(labels[index]!);
        sampledPredictions.push(predictions[index] ?? null);
      }
    }
    const metrics = classificationMetrics({ labels: sampledLabels, predictions: sampledPredictions, classes });
    if (metrics.exactAgreement !== null) values.exactAgreement.push(metrics.exactAgreement);
    if (metrics.macroF1 !== null) values.macroF1.push(metrics.macroF1);
    if (metrics.exactAgreement !== null && metrics.majorityBaseline !== null) {
      values.baselineImprovement.push(metrics.exactAgreement - metrics.majorityBaseline);
    }
    for (const name of classes) {
      const metric = metrics.perClass[name]!;
      if (metric.precision !== null) {
        perClass[name]!.precision.push(metric.precision);
        perClass[name]!.precisionValidReplicates += 1;
      }
      if (metric.recall !== null) {
        perClass[name]!.recall.push(metric.recall);
        perClass[name]!.recallValidReplicates += 1;
      }
      if (metric.f1 !== null) perClass[name]!.f1.push(metric.f1);
    }
  }

  return {
    exactAgreement: percentileInterval(values.exactAgreement),
    macroF1: percentileInterval(values.macroF1),
    baselineImprovement: percentileInterval(values.baselineImprovement),
    perClass: Object.fromEntries(classes.map((name) => [name, {
      precision: perClass[name]!.precisionValidReplicates / replicates >= 0.95 ? percentileInterval(perClass[name]!.precision) : null,
      recall: perClass[name]!.recallValidReplicates / replicates >= 0.95 ? percentileInterval(perClass[name]!.recall) : null,
      f1: percentileInterval(perClass[name]!.f1),
      clusterSupport: new Set(labels.flatMap((label, index) => label === name ? [clusters[index]!] : [])).size,
      precisionValidReplicateFraction: perClass[name]!.precisionValidReplicates / replicates,
      recallValidReplicateFraction: perClass[name]!.recallValidReplicates / replicates,
    }])),
  };
}

function gate(status: "PASS" | "FAIL" | "UNVERIFIED" | "NOT_APPLICABLE", reason: string, metrics?: unknown): Record<string, unknown> {
  return { status, reason, ...(metrics === undefined ? {} : { metrics }) };
}

function resolvedModelLabels(input: { labels: z.infer<typeof labelSetV2Schema>; run: ModelRun }) {
  const byObservation = new Map(input.run.items.map((item) => [item.observationId, item]));
  const rows = input.labels.items.map((labelItem) => {
    const resolution = resolveLabels(labelItem);
    return { labelItem, labels: resolution, model: byObservation.get(labelItem.observationId) ?? null };
  });
  return rows;
}

function scoreClassification(input: {
  name: "sentiment" | "eventType";
  labels: readonly string[];
  predictions: readonly (string | null)[];
  clusters: readonly string[];
  classes: readonly string[];
  seed: number;
}): { metrics: ClassificationMetrics; intervals: ReturnType<typeof clusteredIntervals>; clusterSupport: number } {
  return {
    metrics: classificationMetrics({ labels: input.labels, predictions: input.predictions, classes: input.classes }),
    intervals: clusteredIntervals({
      labels: input.labels,
      predictions: input.predictions,
      clusters: input.clusters,
      classes: input.classes,
      seed: input.seed,
    }),
    clusterSupport: new Set(input.clusters).size,
  };
}

function classificationGate(input: {
  result: ReturnType<typeof scoreClassification>;
  classes: readonly string[];
  precisionFloor: number;
  recallFloor: number;
  macroFloor: number;
  macroLowerFloor: number;
}): Record<string, unknown> {
  const { result, classes } = input;
  const missingClasses = classes.filter((name) => result.metrics.perClass[name]!.support === 0);
  const weakClusterClasses = classes.filter((name) => result.intervals.perClass[name]!.clusterSupport < 10);
  const widthFailures = classes.filter((name) => {
    const perClass = result.intervals.perClass[name]!;
    return perClass.precision === null || perClass.recall === null || perClass.precision.width > 0.2 || perClass.recall.width > 0.2;
  });
  const pointFailures = classes.filter((name) => {
    const metric = result.metrics.perClass[name]!;
    return metric.support > 0 && (metric.precision === null || metric.recall === null || metric.precision < input.precisionFloor || metric.recall < input.recallFloor);
  });
  const macro = result.metrics.macroF1;
  const macroLower = result.intervals.macroF1?.lower ?? null;
  const baselineLower = result.intervals.baselineImprovement?.lower ?? null;
  const unverified: string[] = [];
  if (result.clusterSupport < 30) unverified.push("fewer than 30 issuer clusters for cluster-aware inference");
  if (missingClasses.length) unverified.push(`unrepresented classes: ${missingClasses.join(", ")}`);
  if (weakClusterClasses.length) unverified.push(`fewer than 10 issuer clusters for classes: ${weakClusterClasses.join(", ")}`);
  if (widthFailures.length) unverified.push(`class precision/recall interval width exceeds 0.10 half-width target for: ${widthFailures.join(", ")}`);
  if (result.intervals.exactAgreement === null || result.intervals.exactAgreement.width > 0.1) unverified.push("overall agreement 95% interval is wider than the frozen 0.10 full-width target");
  if (macro === null || macroLower === null) unverified.push("macro-F1 interval could not be estimated");
  if (baselineLower === null) unverified.push("majority-baseline improvement interval could not be estimated");

  if (pointFailures.length || (macro !== null && macro < input.macroFloor) || (macroLower !== null && macroLower < input.macroLowerFloor) || (baselineLower !== null && baselineLower <= 0)) {
    return gate("FAIL", "one or more frozen classifier performance thresholds failed", {
      pointFailures,
      macroF1: macro,
      macroF1Lower95: macroLower,
      baselineImprovementLower95: baselineLower,
    });
  }
  if (unverified.length) return gate("UNVERIFIED", unverified.join("; "), { missingClasses, weakClusterClasses, widthFailures });
  return gate("PASS", "all frozen classifier thresholds and support/precision requirements passed");
}

function boundaryMetrics(labels: readonly boolean[], scores: readonly (number | null)[], cutoffs: readonly number[]) {
  if (labels.length !== scores.length || labels.length !== cutoffs.length) throw new Error("boundary labels, scores, and cutoffs must align");
  const predicted = scores.map((score, index) => score !== null && score >= cutoffs[index]!);
  const tp = labels.reduce((count, actual, index) => count + Number(actual && predicted[index]), 0);
  const fp = labels.reduce((count, actual, index) => count + Number(!actual && predicted[index]), 0);
  const fn = labels.reduce((count, actual, index) => count + Number(actual && !predicted[index]), 0);
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  const selected = predicted.filter(Boolean).length;
  const tn = labels.reduce((count, actual, index) => count + Number(!actual && !predicted[index]), 0);
  return {
    cutoffCounts: Object.fromEntries([...new Set(cutoffs)].sort((left, right) => left - right).map((cutoff) => [String(cutoff), cutoffs.filter((value) => value === cutoff).length])),
    support: positives,
    predictedPositive: selected,
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    trueNegative: tn,
    precision: divide(tp, selected),
    recall: divide(tp, positives),
    falseInclusionRate: divide(fp, negatives),
    falseExclusionRate: divide(fn, positives),
  };
}

function calibrationReport(rows: Array<{ label: string; cluster: string; score: ModelRun["items"][number]["score"] }>) {
  const usable = rows.filter((row) => row.score !== null);
  if (!usable.length) return { status: "UNVERIFIED", sampleCount: 0, issuerClusterCount: 0, classSupport: {}, multiclassBrierScore: null, reliability: [] };
  let brierTotal = 0;
  const bins = [
    { lower: 0, upper: 0.5 },
    { lower: 0.5, upper: 0.6 },
    { lower: 0.6, upper: 0.7 },
    { lower: 0.7, upper: 0.8 },
    { lower: 0.8, upper: 0.9 },
    { lower: 0.9, upper: 1.0000001 },
  ];
  const reliability = bins.map((bin) => ({ ...bin, count: 0, meanConfidence: null as number | null, accuracy: null as number | null }));
  for (const row of usable) {
    const score = row.score!;
    const probs = score.sentimentProbabilities;
    for (const value of SENTIMENT_CLASSES) {
      const target = Number(row.label === value);
      brierTotal += (probs[value] - target) ** 2;
    }
    const confidence = Math.max(probs.negative, probs.neutral, probs.positive);
    const predicted = SENTIMENT_CLASSES.reduce((best, value) => probs[value] > probs[best] ? value : best, "negative" as typeof SENTIMENT_CLASSES[number]);
    const bin = reliability.find((candidate) => confidence >= candidate.lower && confidence < candidate.upper)!;
    bin.count += 1;
    bin.meanConfidence = (bin.meanConfidence ?? 0) + confidence;
    bin.accuracy = (bin.accuracy ?? 0) + Number(predicted === row.label);
  }
  for (const bin of reliability) {
    if (bin.count) {
      bin.meanConfidence = bin.meanConfidence! / bin.count;
      bin.accuracy = bin.accuracy! / bin.count;
    }
  }
  const classSupport = prevalence(usable.map((row) => row.label), SENTIMENT_CLASSES);
  const issuerClusterCount = new Set(usable.map((row) => row.cluster)).size;
  const enoughSupport = usable.length >= 30 && issuerClusterCount >= 30 && SENTIMENT_CLASSES.every((label) => classSupport[label]!.count >= 10);
  return {
    status: enoughSupport ? "DESCRIPTIVE_ONLY" : "UNVERIFIED",
    sampleCount: usable.length,
    issuerClusterCount,
    classSupport,
    multiclassBrierScore: brierTotal / usable.length,
    brierDefinition: "mean per-item sum of squared errors over negative, neutral, and positive probabilities; range 0-2",
    reliability,
    limitation: "No calibration pass threshold was frozen; these descriptive statistics do not establish calibration.",
  };
}

export function analyzeFinal(input: { labels: LabelSet; labelsSha256: string; run: ModelRun }): Record<string, any> {
  if (input.labels.schemaVersion === 3) return analyzeAgentFinal({ labels: input.labels, labelsSha256: input.labelsSha256, run: input.run });
  const { labels, labelsSha256, run } = input;
  const evaluationBudget = labels.evaluationBudget;
  if (!evaluationBudget) throw new Error("final analysis requires a frozen evaluation budget");
  if (run.labelsSha256 !== labelsSha256) throw new Error("model run label digest does not match the exact label artifact");
  if (run.studyId !== labels.studyId) throw new Error("model run study ID differs from the frozen label set");
  if (run.sampleManifestSha256 !== labels.sampleManifestSha256) throw new Error("model run sample manifest digest differs from labels");
  if (run.rubricSha256 !== labels.rubricSha256 || run.rubricSha256 !== RUBRIC_SHA) throw new Error("model run rubric digest differs from the frozen label set");
  if (run.codeRevision !== labels.analysisCodeRevision) throw new Error("model run code revision differs from the frozen analysis code revision");
  if (run.sourceTreeDirty) throw new Error("model run was generated from a dirty source tree");
  if (Date.parse(run.startedAt) < Date.parse(labels.frozenAt)) throw new Error("model run began before the sample was frozen");

  const expectedIds = new Set(labels.items.map((item) => item.observationId));
  const actualIds = new Set(run.items.map((item) => item.observationId));
  const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
  const unexpectedIds = [...actualIds].filter((id) => !expectedIds.has(id));
  const expectedInputs = new Map(labels.items.map((item) => [item.observationId, item.jevInputSha256]));
  for (const runItem of run.items) {
    const expectedInputSha = expectedInputs.get(runItem.observationId);
    if (expectedInputSha && runItem.attempts.some((attempt) => attempt.payloadSha256 !== expectedInputSha)) {
      throw new Error(`Jev request payload digest differs from the frozen input for ${runItem.observationId}`);
    }
  }
  const rows = resolvedModelLabels({ labels, run });
  const unresolvedLabels = rows.filter((row) => row.labels === null).map((row) => row.labelItem.observationId);
  const usable = rows.filter((row): row is typeof row & { labels: ResolvedLabels; model: NonNullable<typeof row.model> } => row.labels !== null && row.model !== null);
  const seed = Number.parseInt(sha256Json({ labelsSha256, runId: run.runId }).slice(0, 8), 16);
  const clusters = usable.map((row) => row.labelItem.cik);
  const sentiment = scoreClassification({
    name: "sentiment",
    labels: usable.map((row) => row.labels.sentiment),
    predictions: usable.map((row) => row.model.score?.sentiment ?? null),
    clusters,
    classes: SENTIMENT_CLASSES,
    seed,
  });
  const eventType = scoreClassification({
    name: "eventType",
    labels: usable.map((row) => row.labels.eventType),
    predictions: usable.map((row) => row.model.score?.eventType ?? null),
    clusters,
    classes: EVENT_CLASSES,
    seed: seed ^ 0x9e3779b9,
  });
  const about = boundaryMetrics(
    usable.map((row) => row.labels.about),
    usable.map((row) => row.model.score?.about ?? null),
    usable.map((row) => row.labelItem.strictAbout ? INCLUSION_CUTOFFS.about.strictIdentity : INCLUSION_CUTOFFS.about.standard),
  );
  const investorRelevant = boundaryMetrics(
    usable.map((row) => row.labels.investorRelevant),
    usable.map((row) => row.model.score?.investorRelevant ?? null),
    usable.map((row) => row.labelItem.strictAbout ? INCLUSION_CUTOFFS.investorRelevant.strictIdentity : INCLUSION_CUTOFFS.investorRelevant.standard),
  );
  const identityBoundary = (key: "about" | "investorRelevant", strictAbout: boolean) => {
    const subset = usable.filter((row) => row.labelItem.strictAbout === strictAbout);
    const cutoff = key === "about"
      ? (strictAbout ? INCLUSION_CUTOFFS.about.strictIdentity : INCLUSION_CUTOFFS.about.standard)
      : (strictAbout ? INCLUSION_CUTOFFS.investorRelevant.strictIdentity : INCLUSION_CUTOFFS.investorRelevant.standard);
    const metric = boundaryMetrics(
      subset.map((row) => row.labels[key]),
      subset.map((row) => row.model.score?.[key] ?? null),
      subset.map(() => cutoff),
    );
    return {
      ...metric,
      itemCount: subset.length,
      issuerClusterCount: new Set(subset.map((row) => row.labelItem.cik)).size,
      positiveLabelIssuerClusterCount: new Set(subset.flatMap((row) => row.labels[key] ? [row.labelItem.cik] : [])).size,
    };
  };
  const strictIdentityNotApplicable = gate(
    "NOT_APPLICABLE",
    "issuer-scoped SEC observations always have strong company identity; this profile does not evaluate ambiguous-identity publisher inputs",
  );
  const aboutByIdentityPath = { standard: identityBoundary("about", false) };
  const investorRelevantByIdentityPath = { standard: identityBoundary("investorRelevant", false) };
  const attempts = run.items.flatMap((item) => item.attempts);
  const submittedAttempts = attempts.filter((attempt) => attempt.submitted);
  const unknownUnreconciled = run.items.flatMap((item) => item.attempts
    .filter((attempt) => attempt.submitted && ["unknown", "transport_error"].includes(attempt.outcome) && !attempt.usageReconciled)
    .map(() => item.observationId));
  const reportedInputTokens = submittedAttempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0);
  const reportedOutputTokens = submittedAttempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0);
  const attemptsMissingUsage = submittedAttempts.filter((attempt) => attempt.inputTokens === null || attempt.outputTokens === null).length;
  const hasApprovedRates = run.inputPricePerMTokUsd === evaluationBudget.inputPricePerMTokUsd
    && run.outputPricePerMTokUsd === evaluationBudget.outputPricePerMTokUsd;
  const estimatedCostUsd = hasApprovedRates && attemptsMissingUsage === 0
    ? (reportedInputTokens * evaluationBudget.inputPricePerMTokUsd + reportedOutputTokens * evaluationBudget.outputPricePerMTokUsd) / 1_000_000
    : null;
  const latencies = submittedAttempts.map((attempt) => attempt.latencyMs).sort((left, right) => left - right);
  const p50LatencyMs = quantile(latencies, 0.5);
  const p95LatencyMs = quantile(latencies, 0.95);
  const terminalFailureCount = run.items.filter((item) => ["failed", "corrupt", "unknown"].includes(item.terminalStatus)).length;
  const completionRate = divide(usable.length, labels.items.length);
  const terminalRecordRate = divide(run.items.length, labels.items.length);
  const allScoreModels = new Set(run.items.flatMap((item) => item.score ? [item.score.resolvedModel] : []));

  const sentimentGate = classificationGate({ result: sentiment, classes: SENTIMENT_CLASSES, precisionFloor: 0.7, recallFloor: 0.7, macroFloor: 0.8, macroLowerFloor: 0.7 });
  const eventTypeGate = classificationGate({ result: eventType, classes: EVENT_CLASSES, precisionFloor: 0.7, recallFloor: 0.7, macroFloor: 0.8, macroLowerFloor: 0.7 });
  const coverageGate = (clustersByClass: Record<string, { clusterSupport: number }>) => {
    const uncovered = EVENT_CLASSES.filter((name) => !eventType.metrics.perClass[name]!.support);
    return uncovered.length || Object.values(clustersByClass).some((value) => value.clusterSupport < 10)
      ? gate("UNVERIFIED", `event-type coverage lacks class or issuer-cluster support: ${uncovered.join(", ") || "fewer than 10 clusters"}`, { uncoveredClasses: uncovered })
      : gate("PASS", "all event types are represented with issuer-cluster support");
  };
  const boundaryGate = (name: string, metric: ReturnType<typeof identityBoundary>) => {
    if (metric.support < 10 || metric.positiveLabelIssuerClusterCount < 10) {
      return gate("UNVERIFIED", `${name} lacks 10 positive human labels across 10 issuer clusters`, metric);
    }
    if (metric.precision === null || metric.precision < 0.9) return gate("FAIL", `${name} precision is below the frozen 0.90 threshold`, metric);
    return gate("PASS", `${name} precision meets the frozen 0.90 point-estimate threshold`, metric);
  };
  const outcomesGate = missingIds.length || unexpectedIds.length || unresolvedLabels.length
    ? gate("FAIL", "run and frozen label sample do not have an exact resolved one-to-one join", { missingIds, unexpectedIds, unresolvedLabels })
    : terminalFailureCount > 0
      ? gate("FAIL", "one or more selected items did not produce a scored terminal result", { terminalFailureCount })
      : gate("PASS", "every frozen sample item has one terminal scored result");
  const requestSafetyGate = unknownUnreconciled.length
      ? gate("FAIL", "unknown provider outcomes lack provider-usage reconciliation", { observationIds: unknownUnreconciled })
      : gate("PASS", "no unknown provider outcome lacks provider-usage reconciliation; duplicate submitted requests are rejected during input validation");
  const actualRequestCount = submittedAttempts.length;
  const evaluationBudgetGate = actualRequestCount > evaluationBudget.maxRequests
    ? gate("FAIL", "submitted requests exceed the frozen approved request ceiling", { actualRequestCount, maxRequests: evaluationBudget.maxRequests })
    : !hasApprovedRates
      ? gate("FAIL", "run pricing differs from or omits the frozen approved unit rates", {
        expectedInputPricePerMTokUsd: evaluationBudget.inputPricePerMTokUsd,
        actualInputPricePerMTokUsd: run.inputPricePerMTokUsd ?? null,
        expectedOutputPricePerMTokUsd: evaluationBudget.outputPricePerMTokUsd,
        actualOutputPricePerMTokUsd: run.outputPricePerMTokUsd ?? null,
      })
      : attemptsMissingUsage > 0 || estimatedCostUsd === null
        ? gate("UNVERIFIED", "provider-reported usage is incomplete, so approved-cost-ceiling compliance cannot be verified", { attemptsMissingUsage })
        : estimatedCostUsd > evaluationBudget.maxEstimatedCostUsd
          ? gate("FAIL", "estimated provider cost exceeds the frozen approved cost ceiling", { estimatedCostUsd, maxEstimatedCostUsd: evaluationBudget.maxEstimatedCostUsd })
          : gate("PASS", "request count and usage-based cost estimate are within the frozen approved ceilings", {
            actualRequestCount,
            maxRequests: evaluationBudget.maxRequests,
            estimatedCostUsd,
            maxEstimatedCostUsd: evaluationBudget.maxEstimatedCostUsd,
          });
  const modelGate = allScoreModels.size !== 1
    ? gate("FAIL", "scored rows do not resolve to exactly one Jev model version", { resolvedModels: [...allScoreModels] })
    : gate("PASS", "all scored rows use the same exact Jev model version", { resolvedModel: [...allScoreModels][0] });
  const completionGate = missingIds.length || unexpectedIds.length || run.items.length !== labels.items.length
    ? gate("FAIL", "model-run denominator differs from the frozen sample", { expected: labels.items.length, actual: run.items.length, missingIds, unexpectedIds })
    : gate("PASS", "model run contains exactly the frozen item denominator");
  const boundaryGates = {
    aboutStandardPrecision: boundaryGate("about standard identity path", aboutByIdentityPath.standard),
    aboutStrictIdentityPrecision: strictIdentityNotApplicable,
    investorRelevantStandardPrecision: boundaryGate("investor_relevant standard identity path", investorRelevantByIdentityPath.standard),
    investorRelevantStrictIdentityPrecision: strictIdentityNotApplicable,
  };
  const unsampledStrata = labels.samplePlan.filter((stratum) => stratum.eligibleCount > 0 && stratum.sampleCount === 0);
  const samplingGate = unsampledStrata.length
    ? gate("FAIL", "the frozen selection omits one or more declared eligible filing-type/time strata", { unsampledStrata })
    : gate("PASS", "the frozen deterministic sample includes every declared eligible filing-type/time stratum");
  const gates = {
    exactSampleJoin: outcomesGate,
    completion: completionGate,
    requestSafety: requestSafetyGate,
    evaluationBudget: evaluationBudgetGate,
    modelProvenance: modelGate,
    sentimentQuality: sentimentGate,
    eventTypeQuality: eventTypeGate,
    eventTypeCoverage: coverageGate(eventType.intervals.perClass),
    samplingFrameCoverage: samplingGate,
    ...boundaryGates,
  };
  const gateStatuses = Object.values(gates)
    .map((value) => value.status as "PASS" | "FAIL" | "UNVERIFIED" | "NOT_APPLICABLE")
    .filter((status) => status !== "NOT_APPLICABLE");
  const status = gateStatuses.includes("FAIL") ? "FAIL" : gateStatuses.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
  return {
    mode: "final-classifier-evaluation",
    status,
    statusScope: "applicable SEC issuer-scoped classifier gates only; not cross-source quality or Sentiment Desk release approval",
    releaseReadiness: "NOT_CLEARED_BY_THIS_REPORT; source rights, TypeSafe account terms, retention, billing, SEC User-Agent, and other release gates remain separate",
    scope: "authorized public SEC EDGAR issuer-scoped filing cohort; only the standard inclusion path is evaluated; no ambiguous-identity publisher or social source is evaluated",
    evaluationProfile: labels.evaluationProfile,
    pathApplicability: { standard: "IN_SCOPE", strictIdentity: "OUT_OF_SCOPE" },
    studyId: labels.studyId,
    runId: run.runId,
    source: labels.source,
    frozenDenominator: labels.items.length,
    completedScoredDenominator: usable.length,
    issuerClusterCount: new Set(labels.items.map((item) => item.cik)).size,
    provenance: {
      labelsSha256,
      modelRunSha256: sha256Json(run),
      populationFrameSha256: labels.populationFrameSha256,
      sampleManifestSha256: labels.sampleManifestSha256,
      rubricSha256: run.rubricSha256,
      collectorParserVersions: [...new Set(labels.items.flatMap((item) => [item.collectorVersion, item.parserVersion]))].sort(),
      codeRevision: run.codeRevision,
      sourceTreeDirty: run.sourceTreeDirty,
      requestedModel: run.requestedModel,
      resolvedModels: [...allScoreModels],
      frozenAt: labels.frozenAt,
      runStartedAt: run.startedAt,
    },
    bootstrap: { method: "percentile cluster bootstrap with issuer CIK resampling", replicates: 2000, seed: `0x${seed.toString(16).padStart(8, "0")}`, clusterKey: "CIK" },
    productionInclusionCutoffs: INCLUSION_CUTOFFS,
    sampling: {
      samplingWindowStart: labels.samplingWindowStart,
      samplingWindowEnd: labels.samplingWindowEnd,
      populationFrameCount: labels.populationFrame.length,
      sampleSeed: labels.sampleSeed,
      strata: labels.samplePlan.map((stratum) => {
        const selectedRows = labels.items.filter((item) => item.filingType === stratum.filingType && acceptanceQuarter(item.acceptedAt) === stratum.acceptanceQuarter);
        const statusCounts = Object.fromEntries(["scored", "off_target", "failed", "corrupt", "unknown", "missing"].map((status) => [
          status,
          selectedRows.filter((labelItem) => {
            const runItem = run.items.find((item) => item.observationId === labelItem.observationId);
            return (runItem?.terminalStatus ?? "missing") === status;
          }).length,
        ]));
        return { ...stratum, statusCounts };
      }),
    },
    perCaseOutcomes: run.items.map((item) => ({
      observationId: item.observationId,
      terminalStatus: item.terminalStatus,
      scoreSaved: item.score !== null,
      submittedRequestCount: item.attempts.filter((attempt) => attempt.submitted).length,
      unknownOutcomeCount: item.attempts.filter((attempt) => attempt.submitted && attempt.outcome === "unknown").length,
      allSubmittedUsageReconciled: item.attempts.filter((attempt) => attempt.submitted).every((attempt) => attempt.usageReconciled),
    })),
    gates,
    sentiment: { metrics: sentiment.metrics, clusterBootstrap95: sentiment.intervals },
    eventType: { metrics: eventType.metrics, clusterBootstrap95: eventType.intervals },
    inclusionBoundaries: {
      about: { overall: about, standard: aboutByIdentityPath.standard, strictIdentity: strictIdentityNotApplicable },
      investorRelevant: { overall: investorRelevant, standard: investorRelevantByIdentityPath.standard, strictIdentity: strictIdentityNotApplicable },
    },
    calibration: calibrationReport(usable.map((row) => ({ label: row.labels.sentiment, cluster: row.labelItem.cik, score: row.model.score }))),
    operations: {
      requestCount: submittedAttempts.length,
      attemptCount: attempts.length,
      terminalFailureCount,
      unknownOutcomeCount: attempts.filter((attempt) => attempt.outcome === "unknown").length,
      providerUsageUnreconciledCount: attempts.filter((attempt) => attempt.submitted && !attempt.usageReconciled).length,
      reportedInputTokens,
      reportedOutputTokens,
      attemptsMissingUsage,
      estimatedCostUsd,
      approvedBudget: {
        maxRequests: evaluationBudget.maxRequests,
        maxEstimatedCostUsd: evaluationBudget.maxEstimatedCostUsd,
        inputPricePerMTokUsd: evaluationBudget.inputPricePerMTokUsd,
        outputPricePerMTokUsd: evaluationBudget.outputPricePerMTokUsd,
        accountOwnerApprovalAttested: evaluationBudget.accountOwnerApproval.attested,
        approvalRecordSha256: evaluationBudget.accountOwnerApproval.approvalRecordSha256,
      },
      costStatus: estimatedCostUsd === null ? "UNVERIFIED; approved unit rates or provider-reported usage are incomplete" : "estimate only; not an invoice or confirmation of provider billing",
      p50LatencyMs,
      p95LatencyMs,
      completionRate,
      terminalRecordRate,
    },
    limitations: [
      "Human expertise, independence, source access, and blinding are roster attestations; this tool cannot independently verify them.",
      "The model-run JSON and provider-reported usage are caller-supplied evidence. Its digest makes the analyzed artifact identifiable but does not authenticate a TypeSafe receipt or independently verify the submitted score/token counts.",
      "The population frame and per-stratum counts are committed as provenance digests; this local tool verifies the supplied frame and deterministic selection but cannot prove that the external source corpus was complete.",
      "SEC URLs and content/request digests are provenance attestations; the offline tool does not fetch EDGAR or prove a digest-to-source-text correspondence.",
      "Results apply only to this frozen SEC EDGAR sample, this exact rubric, and the recorded Jev model; they do not establish performance on other feeds, market impact, alpha, or investment returns.",
      "Cluster bootstrap resamples issuers, not arbitrary rows. At least 30 issuer clusters overall and 10 per class are required before the corresponding inference is considered verified.",
      "The SEC issuer-scoped profile evaluates standard inclusion precision only. Strict-identity precision remains not applicable here and unverified for any other source profile.",
      "Calibration metrics are descriptive only because a calibration pass threshold was not frozen; sparse support remains unverified.",
      "Account-owner budget approval is recorded as a local attestation and digest; this tool cannot independently verify the underlying approval record or provider invoice.",
      "This offline report does not clear SEC User-Agent, provider-account terms, telemetry, retention, source-rights, or historical billing approval gates.",
    ],
  };
}
