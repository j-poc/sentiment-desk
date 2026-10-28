import { createHash, randomUUID } from "node:crypto";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import {
  boundClassificationInput,
  CATEGORICAL_JSON_SCHEMA,
  OPENAI_MODEL,
  OPENAI_PROMPT,
  OPENAI_PROMPT_SHA256,
  OPENAI_SCHEMA_SHA256,
  OPENAI_SCHEMA_VERSION,
  OPENAI_PROMPT_VERSION,
  OpenAIClassifier,
  prepareOpenAIRequest,
  validateCategoricalPayload,
  type OpenAIClassificationInput,
  type OpenAIClassifierResult,
} from "./openai-classifier.js";

export const GEMINI_MODEL = "gemini-3.8-flash";
export const MODEL_PROVIDER_SCHEMA_VERSION = "categorical-investor-source/1";
export const MODEL_PROVIDER_PROMPT_VERSION = "investor-news-classification/1";
export const MODEL_PROVIDER_PROMPT_SHA256 = OPENAI_PROMPT_SHA256;
export const MODEL_PROVIDER_SCHEMA_SHA256 = OPENAI_SCHEMA_SHA256;
export const MODEL_PROVIDER_MAX_REQUEST_BYTES = 96 * 1024;
export const MODEL_PROVIDER_MAX_RESPONSE_BYTES = 64 * 1024;
export const MODEL_PROVIDER_MAX_OUTPUT_TOKENS = 700;
export const MODEL_PROVIDER_TIMEOUT_MS = 30_000;
export const MODEL_PROVIDER_DAILY_REQUEST_LIMIT = 5;
export const MODEL_PROVIDER_DAILY_VERIFICATION_LIMIT = 5;
export const MODEL_PROVIDER_DAILY_REQUEST_BYTE_LIMIT = 500_000;
export const MODEL_PROVIDER_DAILY_COST_LIMIT_USD = 0.10;

export type BYOKProvider = "openai" | "google_gemini";

export interface PreparedProviderRequest {
  body: string;
  payloadSha256: string;
  requestBytes: number;
  requestedModel: string;
  promptVersion: string;
  promptSha256: string;
  schemaVersion: string;
  schemaSha256: string;
  maxOutputTokens: number;
  costReservationUsd: number;
}

export interface ProviderClassificationResult {
  provider: BYOKProvider;
  request: PreparedProviderRequest;
  modelReturned: string;
  classification: OpenAIClassifierResult["classification"];
  responseId: string | null;
  responseSha256: string;
  inputTokens: number;
  /** Generated-token usage, including Gemini thought tokens when reported by the provider. */
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  httpStatus: number;
  /** Exact OpenAI receipt fields; absent for providers outside the Luna chart. */
  categoricalReceipt?: {
    profileSha256: string;
    serviceTierRequested: "default";
    serviceTier: string | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number;
  };
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly outcomeUnknown: boolean,
    readonly requestDispatched: boolean,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

function sha256(value: string | Uint8Array): string {
  const digest = createHash("sha256");
  if (typeof value === "string") digest.update(value, "utf8");
  else digest.update(value);
  return digest.digest("hex");
}

export function sourceIdentityDigest(input: OpenAIClassificationInput & { sourceId: string; retrievedAt: number; sourceUrl: string }): string {
  return sha256(JSON.stringify({
    sourceId: input.sourceId,
    company: input.company,
    collector: input.source.collector,
    publisher: input.source.publisher,
    title: input.source.title,
    excerpt: input.source.excerpt,
    sourceUrl: input.sourceUrl,
    retrievedAt: input.retrievedAt,
  }));
}

function costUpperBound(provider: BYOKProvider, requestBytes: number): number {
  const inputTokensUpperBound = requestBytes;
  const outputTokensUpperBound = MODEL_PROVIDER_MAX_OUTPUT_TOKENS;
  if (provider === "openai") {
    // GPT-6 Luna is $0.10 input / $0.50 output per million tokens; reserve
    // cache-write input at its higher $0.125 rate to keep the ceiling safe.
    return inputTokensUpperBound * 0.125 / 1_000_000 + outputTokensUpperBound * 0.5 / 1_000_000;
  }
  // Reserve Google's current Standard paid rate even for a free-tier key.
  // The call has no grounding/tools, so this bounds only text-token usage.
  return inputTokensUpperBound * 0.75 / 1_000_000 + outputTokensUpperBound * 3.75 / 1_000_000;
}

export function prepareModelProviderRequest(
  provider: BYOKProvider,
  rawInput: OpenAIClassificationInput,
): PreparedProviderRequest {
  const input = boundClassificationInput(rawInput);
  let body: string;
  const model = provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL;
  if (provider === "openai") {
    const prepared = prepareOpenAIRequest(input, model);
    return Object.freeze({
      body: prepared.body,
      payloadSha256: prepared.payloadSha256,
      requestBytes: prepared.requestBytes,
      requestedModel: model,
      promptVersion: OPENAI_PROMPT_VERSION,
      promptSha256: OPENAI_PROMPT_SHA256,
      schemaVersion: OPENAI_SCHEMA_VERSION,
      schemaSha256: OPENAI_SCHEMA_SHA256,
      maxOutputTokens: prepared.maxOutputTokens,
      costReservationUsd: costUpperBound(provider, prepared.requestBytes),
    });
  }

  body = JSON.stringify({
    systemInstruction: { parts: [{ text: OPENAI_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: MODEL_PROVIDER_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingLevel: "low" },
      responseFormat: { text: { mimeType: "application/json", schema: CATEGORICAL_JSON_SCHEMA } },
    },
  });
  const requestBytes = Buffer.byteLength(body, "utf8");
  if (requestBytes < 1 || requestBytes > MODEL_PROVIDER_MAX_REQUEST_BYTES) {
    throw new Error("Prepared Gemini request is outside the supported byte limit.");
  }
  return Object.freeze({
    body,
    payloadSha256: sha256(body),
    requestBytes,
    requestedModel: model,
    promptVersion: MODEL_PROVIDER_PROMPT_VERSION,
    promptSha256: MODEL_PROVIDER_PROMPT_SHA256,
    schemaVersion: MODEL_PROVIDER_SCHEMA_VERSION,
    schemaSha256: MODEL_PROVIDER_SCHEMA_SHA256,
    maxOutputTokens: MODEL_PROVIDER_MAX_OUTPUT_TOKENS,
    costReservationUsd: costUpperBound(provider, requestBytes),
  });
}

async function readJsonBounded(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; value: unknown }> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("oversized");
  }
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("oversized");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  return { bytes, value };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class ModelProviderClassifier {
  constructor(private readonly options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {}

  private get fetchImpl(): typeof fetch { return this.options.fetchImpl ?? fetch; }

  async verify(provider: BYOKProvider, apiKey: string): Promise<{ model: string; available: boolean }> {
    if (!apiKey || Buffer.byteLength(apiKey, "utf8") > 8 * 1024) throw new ModelProviderError("Save a provider key before verifying it.", null, false, false);
    const url = provider === "openai" ? "https://api.openai.com/v1/models" : "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: provider === "openai"
          ? { authorization: `Bearer ${apiKey}`, accept: "application/json" }
          : { "x-goog-api-key": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? MODEL_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof ExternalRequestPausedError) throw error;
      throw new ModelProviderError("The provider could not be reached to verify this key.", null, false, false);
    }
    let parsed: { value: unknown };
    try { parsed = await readJsonBounded(response, MODEL_PROVIDER_MAX_RESPONSE_BYTES); }
    catch { throw new ModelProviderError("The provider returned an unreadable model catalog.", response.status, false, false); }
    if (!response.ok) throw new ModelProviderError("The provider rejected this key or the model catalog request.", response.status, false, false);
    const body = object(parsed.value);
    let available = false;
    if (provider === "openai") {
      available = Array.isArray(body?.data) && body.data.some((item) => object(item)?.id === OPENAI_MODEL);
    } else {
      available = Array.isArray(body?.models) && body.models.some((item) => {
        const name = object(item)?.name;
        return name === `models/${GEMINI_MODEL}`;
      });
    }
    return { model: provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL, available };
  }

  async classify(provider: BYOKProvider, apiKey: string, input: OpenAIClassificationInput): Promise<ProviderClassificationResult> {
    const request = prepareModelProviderRequest(provider, input);
    if (provider === "openai") {
      try {
        const prepared = prepareOpenAIRequest(input, OPENAI_MODEL);
        const result = await new OpenAIClassifier({ apiKey, model: OPENAI_MODEL, timeoutMs: this.options.timeoutMs ?? MODEL_PROVIDER_TIMEOUT_MS, fetchImpl: this.fetchImpl }).classifyPrepared(prepared);
        return {
          provider, request, modelReturned: result.modelReturned,
          classification: result.classification, responseId: result.responseId,
          responseSha256: result.responseSha256, inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens, estimatedCostUsd: result.usage.estimatedCostUsd ?? request.costReservationUsd,
          latencyMs: result.latencyMs, httpStatus: result.httpStatus,
          categoricalReceipt: {
            profileSha256: prepared.profileSha256,
            serviceTierRequested: prepared.requestedServiceTier,
            serviceTier: result.serviceTier,
            cachedInputTokens: result.usage.cachedInputTokens,
            cacheWriteInputTokens: result.usage.cacheWriteInputTokens,
            reasoningTokens: result.usage.reasoningTokens,
            totalTokens: result.usage.totalTokens,
          },
        };
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        const status = typeof error === "object" && error && "status" in error && typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status : null;
        const unknown = typeof error === "object" && error && "outcomeUnknown" in error && typeof (error as { outcomeUnknown?: unknown }).outcomeUnknown === "boolean"
          ? (error as { outcomeUnknown: boolean }).outcomeUnknown : false;
        const dispatched = typeof error === "object" && error && "requestDispatched" in error && typeof (error as { requestDispatched?: unknown }).requestDispatched === "boolean"
          ? (error as { requestDispatched: boolean }).requestDispatched : false;
        throw new ModelProviderError("OpenAI did not return a validated classification.", status, unknown, dispatched);
      }
    }

    if (request.requestBytes > MODEL_PROVIDER_MAX_REQUEST_BYTES) throw new Error("Prepared Gemini request exceeds its byte limit.");
    const inputBounded = boundClassificationInput(input);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: request.body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? MODEL_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof ExternalRequestPausedError) {
        throw new ModelProviderError("External requests are paused; the provider request was not sent.", null, false, false);
      }
      throw new ModelProviderError("Gemini request outcome is unknown; check provider usage before retrying.", null, true, true);
    }
    let read: { bytes: Uint8Array; value: unknown };
    try { read = await readJsonBounded(response, MODEL_PROVIDER_MAX_RESPONSE_BYTES); }
    catch {
      throw new ModelProviderError("Gemini response was unreadable; provider usage must be checked before retrying.", response.status, true, true);
    }
    const responseSha256 = sha256(read.bytes);
    const body = object(read.value);
    if (response.status === 429) throw new ModelProviderError("Gemini quota or rate limit was reached.", response.status, false, true);
    if (response.status >= 500) throw new ModelProviderError("Gemini request outcome is unknown; check provider usage before retrying.", response.status, true, true);
    if (!response.ok) throw new ModelProviderError("Gemini rejected this request.", response.status, false, true);
    const candidate = object(Array.isArray(body?.candidates) ? body.candidates[0] : null);
    const content = object(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const outputText = parts.map(object).filter(part => part?.thought !== true)
      .map(part => part?.text).find((text): text is string => typeof text === "string") ?? null;
    const returnedModel = typeof body?.modelVersion === "string" ? body.modelVersion : null;
    const usage = object(body?.usageMetadata);
    const inputTokens = nonNegativeInt(usage?.promptTokenCount);
    const candidateTokens = nonNegativeInt(usage?.candidatesTokenCount);
    const thoughtTokens = nonNegativeInt(usage?.thoughtsTokenCount ?? 0);
    const outputTokens = candidateTokens == null || thoughtTokens == null ? null : candidateTokens + thoughtTokens;
    const totalTokens = nonNegativeInt(usage?.totalTokenCount);
    if (!outputText || candidate?.finishReason !== "STOP" || !returnedModel || returnedModel !== GEMINI_MODEL
      || inputTokens == null || outputTokens == null || candidateTokens == null || thoughtTokens == null
      || totalTokens !== inputTokens + candidateTokens + thoughtTokens
      || inputTokens > request.requestBytes || outputTokens > request.maxOutputTokens) {
      throw new ModelProviderError("Gemini response was incomplete or failed model and usage validation; check provider usage before retrying.", response.status, true, true);
    }
    let output: unknown;
    try { output = JSON.parse(outputText) as unknown; }
    catch { throw new ModelProviderError("Gemini returned invalid JSON; check provider usage before retrying.", response.status, true, true); }
    let classification: OpenAIClassifierResult["classification"];
    try { classification = validateCategoricalPayload(output, inputBounded); }
    catch { throw new ModelProviderError("Gemini response failed the source-grounded classification checks.", response.status, false, true); }
    const estimatedCostUsd = inputTokens * 0.75 / 1_000_000 + outputTokens * 3.75 / 1_000_000;
    return {
      provider, request, modelReturned: returnedModel, classification,
      responseId: typeof body?.responseId === "string" ? body.responseId : null,
      responseSha256, inputTokens, outputTokens, estimatedCostUsd,
      latencyMs: Date.now() - startedAt, httpStatus: response.status,
    };
  }
}

export interface ProviderAttemptReceipt {
  id: string;
  attemptNumber: number;
  dispatchIntentAt: number | null;
  outcome: "completed" | "rejected" | "not_sent" | "unknown";
  completedAt: number;
  httpStatus: number | null;
  modelReturned: string | null;
  responseId: string | null;
  responseSha256: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  errorCategory: string | null;
}

export function newProviderAttemptId(): string { return randomUUID(); }
