import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MAX_PRIVATE_EVIDENCE_REQUEST_BYTES,
  CHATGPT_PLAN_USAGE_URL,
  privateEvidenceAnalysisRecordSchema,
  privateEvidenceInputSchema,
  type PrivateEvidenceAnalysisRecord,
  type PrivateEvidenceItem,
} from "../shared/private-evidence.js";
import { isWellFormedUnicode } from "../shared/well-formed-unicode.js";
import {
  PRIVATE_EVIDENCE_ANALYSIS_MODEL,
  PRIVATE_EVIDENCE_ANALYSIS_PROMPT,
  PRIVATE_EVIDENCE_ANALYSIS_PROMPT_VERSION,
  PRIVATE_EVIDENCE_ANALYSIS_SCHEMA_VERSION,
  PRIVATE_EVIDENCE_ANALYSIS_PROFILE_VERSION,
  privateEvidenceAnalysisOutputSchema,
  type PrivateEvidenceAnalysisInput,
  PrivateEvidenceAnalysisError,
} from "./private-evidence-analysis.js";
import {
  ChatGPTPlanResponses,
  ChatGPTPlanResponsesError,
  type PreparedChatGPTPlanStructuredRequest,
} from "./chatgpt-plan-responses.js";

const MAX_PLAN_REQUEST_BYTES = Math.min(MAX_PRIVATE_EVIDENCE_REQUEST_BYTES, 260_000);
const API_URL = "https://api.openai.com/v1/responses";
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/u);
const companySchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(160),
  ticker: z.string().trim().min(1).max(24),
  sector: z.string().trim().min(1).max(120),
}).strict();
const selectedEvidenceSchema = z.object({
  id: z.string().uuid(), companyId: identifier,
  title: privateEvidenceInputSchema.innerType().shape.title,
  sourceLabel: privateEvidenceInputSchema.innerType().shape.sourceLabel,
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  content: privateEvidenceInputSchema.innerType().shape.content,
  sha256: digestSchema,
  byteLength: z.number().int().positive(),
}).strict().superRefine((item, context) => {
  if (hash(item.content) !== item.sha256 || Buffer.byteLength(item.content, "utf8") !== item.byteLength) {
    context.addIssue({ code: "custom", message: "source_integrity_mismatch" });
  }
  if (!privateEvidenceInputSchema.safeParse({ title: item.title, sourceLabel: item.sourceLabel, asOfDate: item.asOfDate, content: item.content }).success) {
    context.addIssue({ code: "custom", message: "source_invalid" });
  }
});
const payloadSchema = z.object({ company: companySchema, evidence: selectedEvidenceSchema }).strict().superRefine((value, context) => {
  if (value.company.id !== value.evidence.companyId) context.addIssue({ code: "custom", message: "entity_mismatch" });
});
type Payload = z.infer<typeof payloadSchema>;

export const CHATGPT_PLAN_PRIVATE_EVIDENCE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentiment", "summary", "evidence", "uncertainties", "nextQuestion"],
  properties: {
    sentiment: { type: "string", enum: ["positive", "neutral", "negative", "unclear"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["quote", "explanation"], properties: { quote: { type: "string" }, explanation: { type: "string" } } } },
    uncertainties: { type: "array", items: { type: "string" } },
    nextQuestion: { type: "string" },
  },
} as const;

const schemaSha256 = hash(JSON.stringify(CHATGPT_PLAN_PRIVATE_EVIDENCE_OUTPUT_SCHEMA));
const promptSha256 = hash(PRIVATE_EVIDENCE_ANALYSIS_PROMPT);
const profileVersion = `${PRIVATE_EVIDENCE_ANALYSIS_PROFILE_VERSION}-chatgpt-plan`;

export const CHATGPT_PLAN_PRIVATE_EVIDENCE_DATA_CONTROLS = Object.freeze({
  route: "chatgpt_plan" as const,
  endpoint: API_URL,
  responseObjectStorageRequested: false as const,
  retention: "unknown" as const,
  trainingUse: "unknown" as const,
  remainingPlanAllowance: null,
  usageUrl: CHATGPT_PLAN_USAGE_URL,
  dataControlsUrl: "https://help.openai.com/en/articles/7730893-data-usage-for-openai-models",
  disclosure: "Only after you confirm this individual note, its text and public-issuer identity are sent to OpenAI through the connected ChatGPT plan. The request asks for response-object storage to be disabled. This app cannot observe your account's data controls, retention terms, or remaining plan allowance; review OpenAI account settings before sending. The result stays in the local private-note store and is excluded from public sentiment charts and scores.",
});

export type PreparedChatGPTPlanPrivateEvidenceRequest = Readonly<{
  request: PreparedChatGPTPlanStructuredRequest;
  companyId: string;
  evidenceId: string;
  evidenceSha256: string;
  entitySha256: string;
  sourceSha256: string;
}>;

function buildPayload(input: PrivateEvidenceAnalysisInput): Payload {
  const parsed = payloadSchema.safeParse({
    company: {
      id: input.company.id,
      name: input.company.name,
      ticker: input.company.ticker,
      sector: input.company.sector,
    },
    evidence: {
      id: input.evidence.id,
      companyId: input.evidence.companyId,
      title: input.evidence.title,
      sourceLabel: input.evidence.sourceLabel,
      asOfDate: input.evidence.asOfDate,
      content: input.evidence.content,
      sha256: input.evidence.sha256,
      byteLength: input.evidence.byteLength,
    },
  });
  if (!parsed.success) throw new PrivateEvidenceAnalysisError("invalid_request", "Selected private note failed local validation.");
  return parsed.data;
}

/** Canonical plan request for one explicitly selected note; no batch path exists. */
export function prepareChatGPTPlanPrivateEvidenceRequest(input: PrivateEvidenceAnalysisInput): PreparedChatGPTPlanPrivateEvidenceRequest {
  const payload = buildPayload(input);
  const body = JSON.stringify({
    model: PRIVATE_EVIDENCE_ANALYSIS_MODEL,
    instructions: PRIVATE_EVIDENCE_ANALYSIS_PROMPT,
    input: [{ role: "user", content: JSON.stringify(payload) }],
    store: false,
    stream: true,
    text: { format: { type: "json_schema", name: "private_evidence_analyst_read_v1", strict: true, schema: CHATGPT_PLAN_PRIVATE_EVIDENCE_OUTPUT_SCHEMA } },
  });
  const requestBytes = Buffer.byteLength(body, "utf8");
  if (requestBytes > MAX_PLAN_REQUEST_BYTES) {
    throw new PrivateEvidenceAnalysisError("invalid_request", "Selected private note exceeds the bounded plan request size.");
  }
  const requestProfileSha256 = hash(JSON.stringify({
    version: profileVersion,
    promptSha256,
    schemaSha256,
    model: PRIVATE_EVIDENCE_ANALYSIS_MODEL,
    store: false,
    stream: true,
    tools: [],
    outputLimit: "provider-account-policy",
    retention: null,
    trainingUse: null,
    serviceTier: null,
    pricing: null,
  }));
  return Object.freeze({
    request: Object.freeze({
      requestedModel: PRIVATE_EVIDENCE_ANALYSIS_MODEL,
      body,
      requestBytes,
      payloadSha256: hash(Buffer.from(body, "utf8")),
      profileSha256: requestProfileSha256,
    }),
    companyId: payload.company.id,
    evidenceId: payload.evidence.id,
    evidenceSha256: payload.evidence.sha256,
    entitySha256: hash(JSON.stringify(payload.company)),
    sourceSha256: hash(JSON.stringify({ title: payload.evidence.title, sourceLabel: payload.evidence.sourceLabel, asOfDate: payload.evidence.asOfDate })),
  });
}

const responseOutputSchema = z.array(z.object({
  type: z.literal("message"), role: z.literal("assistant"), status: z.literal("completed"),
  content: z.array(z.union([
    z.object({ type: z.literal("output_text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough(),
  ])).length(1),
}).passthrough()).length(1);

export class ChatGPTPlanPrivateEvidenceAnalyzer {
  constructor(private readonly transport: ChatGPTPlanResponses, private readonly now: () => number = Date.now) {}
  get configured(): boolean { return true; }
  get model(): string { return PRIVATE_EVIDENCE_ANALYSIS_MODEL; }

  async analyze(input: PrivateEvidenceAnalysisInput): Promise<PrivateEvidenceAnalysisRecord> {
    const prepared = prepareChatGPTPlanPrivateEvidenceRequest(input);
    return this.analyzePrepared(prepared);
  }

  async analyzePrepared(prepared: PreparedChatGPTPlanPrivateEvidenceRequest, onBeforeDispatch?: () => boolean): Promise<PrivateEvidenceAnalysisRecord> {
    const payload = validatePrepared(prepared);
    const started = this.now();
    let envelope;
    try {
      envelope = await this.transport.requestStructured(prepared.request, MAX_PLAN_REQUEST_BYTES, undefined, onBeforeDispatch);
    } catch (error) {
      if (error instanceof ChatGPTPlanResponsesError) {
        throw new PrivateEvidenceAnalysisError(
          error.requestDispatched ? "provider_outcome_unknown" : "not_configured",
          error.requestDispatched ? "ChatGPT plan private-note analysis did not produce a confirmed result." : "ChatGPT plan is not ready for private-note analysis.",
          { status: error.status, outcomeUnknown: error.outcomeUnknown, latencyMs: Math.max(0, this.now() - started) },
        );
      }
      throw new PrivateEvidenceAnalysisError("transport_unknown", "ChatGPT plan private-note analysis did not produce a confirmed result.", {
        outcomeUnknown: true, latencyMs: Math.max(0, this.now() - started),
      });
    }

    const fail = (category: "invalid_response" | "refused" | "ungrounded_output"): never => {
      throw new PrivateEvidenceAnalysisError(category, "ChatGPT plan private-note result failed local validation.", {
        status: envelope.httpStatus,
        outcomeUnknown: false,
        responseId: envelope.responseId,
        responseSha256: envelope.responseSha256,
        modelReturned: envelope.modelReturned,
        serviceTier: envelope.serviceTier,
        latencyMs: Math.max(0, this.now() - started),
      });
    };
    if (envelope.httpStatus !== 200 || envelope.modelRequested !== PRIVATE_EVIDENCE_ANALYSIS_MODEL ||
        envelope.modelReturned !== PRIVATE_EVIDENCE_ANALYSIS_MODEL || envelope.estimatedCostUsd !== null ||
        !digestSchema.safeParse(envelope.responseSha256).success || envelope.profileSha256 !== prepared.request.profileSha256) fail("invalid_response");

    const raw = responseOutputSchema.safeParse(envelope.response.output);
    if (!raw.success) return fail("invalid_response");
    const part = raw.data[0]?.content[0];
    if (!part) return fail("invalid_response");
    if (part.type === "refusal") return fail("refused");
    let decoded: unknown;
    try { decoded = JSON.parse(part.text); } catch { return fail("invalid_response"); }
    const analysis = privateEvidenceAnalysisOutputSchema.safeParse(decoded);
    if (!analysis.success || [analysis.data.summary, analysis.data.nextQuestion, ...analysis.data.uncertainties,
      ...analysis.data.evidence.flatMap((entry) => [entry.quote, entry.explanation])].some((text) => !isWellFormedUnicode(text) || text.includes("\u0000"))) {
      return fail("invalid_response");
    }
    if (analysis.data.evidence.some((entry) => !payload.evidence.content.includes(entry.quote))) return fail("ungrounded_output");

    const usage = envelope.usage;
    const record = {
      accountingRoute: "chatgpt_plan" as const,
      companyId: prepared.companyId,
      evidenceId: prepared.evidenceId,
      evidenceSha256: prepared.evidenceSha256,
      entitySha256: prepared.entitySha256,
      sourceSha256: prepared.sourceSha256,
      payloadSha256: prepared.request.payloadSha256,
      requestBytes: prepared.request.requestBytes,
      modelRequested: PRIVATE_EVIDENCE_ANALYSIS_MODEL,
      modelReturned: envelope.modelReturned,
      serviceTierRequested: null,
      serviceTier: envelope.serviceTier,
      promptVersion: PRIVATE_EVIDENCE_ANALYSIS_PROMPT_VERSION,
      promptSha256,
      schemaVersion: PRIVATE_EVIDENCE_ANALYSIS_SCHEMA_VERSION,
      schemaSha256,
      profileVersion,
      profileSha256: envelope.profileSha256,
      responseId: envelope.responseId,
      responseSha256: envelope.responseSha256,
      usage: { inputTokens: usage.inputTokens, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: usage.outputTokens,
        reasoningTokens: null, totalTokens: usage.totalTokens, estimatedCostUsd: null },
      analysis: analysis.data,
      latencyMs: Math.max(0, envelope.latencyMs),
      httpStatus: 200 as const,
      dataControls: {
        ...CHATGPT_PLAN_PRIVATE_EVIDENCE_DATA_CONTROLS,
      },
    };
    return privateEvidenceAnalysisRecordSchema.parse(record);
  }
}

function validatePrepared(prepared: PreparedChatGPTPlanPrivateEvidenceRequest): Payload {
  try {
    const request = prepared.request;
    const parsedBody: unknown = JSON.parse(request.body);
    const body = z.object({
      model: z.literal(PRIVATE_EVIDENCE_ANALYSIS_MODEL),
      instructions: z.literal(PRIVATE_EVIDENCE_ANALYSIS_PROMPT),
      input: z.tuple([z.object({ role: z.literal("user"), content: z.string() }).strict()]),
      store: z.literal(false), stream: z.literal(true), text: z.unknown(),
    }).strict().parse(parsedBody);
    const payload = payloadSchema.parse(JSON.parse(body.input[0].content));
    const evidence = payload.evidence;
    const input: PrivateEvidenceAnalysisInput = {
      company: payload.company,
      evidence: { ...evidence, fileName: null, importedAt: 0 },
    };
    const canonical = prepareChatGPTPlanPrivateEvidenceRequest(input);
    if (canonical.request.body !== request.body || canonical.request.requestBytes !== request.requestBytes ||
        canonical.request.payloadSha256 !== request.payloadSha256 || canonical.request.profileSha256 !== request.profileSha256 ||
        canonical.companyId !== prepared.companyId || canonical.evidenceId !== prepared.evidenceId ||
        canonical.evidenceSha256 !== prepared.evidenceSha256 || canonical.entitySha256 !== prepared.entitySha256 ||
        canonical.sourceSha256 !== prepared.sourceSha256) throw new Error("mismatch");
    return payload;
  } catch {
    throw new PrivateEvidenceAnalysisError("invalid_request", "Prepared private analysis request failed local integrity validation.");
  }
}
