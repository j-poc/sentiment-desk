import { createHash } from "node:crypto";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import {
  OPENAI_MODEL,
  prepareOpenAIRequest,
  type PreparedOpenAIRequest,
} from "./openai-classifier.js";

const API_ROOT = "https://api.openai.com/v1";
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export const CHATGPT_PLAN_PROFILE_VERSION = "chatgpt-plan-responses/1";

export type PlanTokenProvider = {
  getAccessToken(): Promise<string | null>;
  /** Stable ChatGPT account subject, used only to scope the in-memory catalog cache. */
  getAccountId(): Promise<string | null>;
};

export type PlanResponsesUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ChatGPTPlanFailureKind =
  | "usage_limit"
  | "account_not_eligible"
  | "authorization"
  | "unsupported_capability"
  | "unsupported_route"
  | "temporary_unavailable"
  | "provider_rejected"
  | "unknown";

export type PlanResponsesEnvelope = {
  provider: "chatgpt_plan";
  profileVersion: typeof CHATGPT_PLAN_PROFILE_VERSION;
  profileSha256: string;
  responseId: string;
  modelRequested: typeof OPENAI_MODEL;
  modelReturned: typeof OPENAI_MODEL;
  serviceTier: string | null;
  estimatedCostUsd: null;
  usage: PlanResponsesUsage;
  /** SHA-256 of the exact SSE data payload carrying response.completed. */
  responseSha256: string;
  /** Exact UTF-8 data payload from the response.completed SSE event. */
  responsePayload: string;
  response: Record<string, unknown>;
  httpStatus: number;
  latencyMs: number;
};

export class ChatGPTPlanResponsesError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly outcomeUnknown: boolean,
    readonly status: number | null = null,
    requestDispatched = false,
    readonly providerCode: string | null = null,
    readonly parameter: string | null = null,
    readonly requestId: string | null = null,
    readonly retryAfterMs: number | null = null,
    readonly failureKind: ChatGPTPlanFailureKind | null = null,
  ) {
    super(message);
    this.name = "ChatGPTPlanResponsesError";
    this.requestDispatched = requestDispatched;
  }
  requestDispatched: boolean;
}

const MAX_PROVIDER_ERROR_BYTES = 8 * 1024;
const MAX_PROVIDER_RETRY_DELAY_MS = 5 * 60_000;
const SAFE_PROVIDER_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const SAFE_PROVIDER_PARAM = /^[A-Za-z0-9][A-Za-z0-9_.\[\]-]{0,99}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;

type ProviderErrorDetails = {
  hasErrorEnvelope: boolean;
  providerCode: string | null;
  parameter: string | null;
  requestId: string | null;
  failureKind: ChatGPTPlanFailureKind;
  message: string;
  retryAfterMs: number | null;
};

function safeProviderField(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function classifyProviderFailure(status: number | null, code: string | null): ChatGPTPlanFailureKind {
  if (code === "subscription_sharing_usage_limit_exceeded") return "usage_limit";
  if (code === "subscription_sharing_user_not_eligible") return "account_not_eligible";
  if (code === "subscription_sharing_unsupported_capability") return "unsupported_capability";
  if (code === "subscription_sharing_route_not_supported") return "unsupported_route";
  if (code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable" || status === 503 || status === 529) return "temporary_unavailable";
  if (code === "subscription_sharing_invalid_user" || status === 401 || status === 403) return "authorization";
  if (status === 429) return "usage_limit";
  if (status !== null && status >= 500) return "temporary_unavailable";
  if (status !== null) return "provider_rejected";
  return "unknown";
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  let delay: number;
  if (/^\d+$/u.test(raw)) delay = Number(raw) * 1_000;
  else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    delay = Math.max(0, at - now);
  }
  return Number.isFinite(delay) ? Math.min(MAX_PROVIDER_RETRY_DELAY_MS, Math.max(0, delay)) : null;
}

export function chatGPTPlanFailureMessage(kind: ChatGPTPlanFailureKind, status: number | null, code: string | null): string {
  switch (kind) {
    case "usage_limit": return "The ChatGPT plan rejected classification because of a usage limit. New plan requests are paused; check ChatGPT Settings → Usage, then verify access to resume.";
    case "account_not_eligible": return "This ChatGPT account is not eligible for plan use in Sentiment Desk. New plan requests are paused until you review the account.";
    case "authorization": return "ChatGPT plan authorization was rejected. New plan requests are paused; review the connection before resuming.";
    case "unsupported_capability": return "ChatGPT rejected a plan request capability. New plan requests are paused so the request can be reviewed.";
    case "unsupported_route": return "The ChatGPT plan route is not available for this account. New plan requests are paused; API-key billing is never used.";
    case "temporary_unavailable": return "ChatGPT is temporarily unavailable. New plan requests are paused and will retry after a bounded delay.";
    case "provider_rejected": return `ChatGPT rejected the plan request${status === null ? "" : ` (HTTP ${status})`}${code ? ` (${code})` : ""}. New plan requests are paused for review.`;
    case "unknown": return "The ChatGPT plan request failed without a recognized response. New plan requests are paused for review.";
  }
}

async function providerErrorDetails(response: Response, now = Date.now()): Promise<ProviderErrorDetails> {
  const requestIdFromHeader = safeProviderField(
    response.headers.get("x-request-id") ?? response.headers.get("request-id"), SAFE_REQUEST_ID,
  );
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"), now);
  let payload: unknown = null;
  const length = response.headers.get("content-length");
  if (!length || !/^\d+$/u.test(length) || Number(length) <= MAX_PROVIDER_ERROR_BYTES) {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PROVIDER_ERROR_BYTES) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
        }
      } catch {
        await reader.cancel().catch(() => undefined);
      } finally { reader.releaseLock(); }
      if (size <= MAX_PROVIDER_ERROR_BYTES) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
        catch { /* Raw error text is intentionally discarded. */ }
      }
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  return providerErrorDetailsFromPayload(payload, response.status, requestIdFromHeader, retryAfterMs);
}

function providerErrorDetailsFromPayload(
  payload: unknown,
  status: number | null,
  requestIdFromHeader: string | null = null,
  retryAfterMs: number | null = null,
): ProviderErrorDetails {
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const response = isRecord(envelope.response) ? envelope.response : null;
  const errorEnvelope = isRecord(envelope.error) ? envelope.error
    : response && isRecord(response.error) ? response.error : null;
  const hasErrorEnvelope = envelope.error !== undefined && envelope.error !== null
    || response?.error !== undefined && response.error !== null;
  const nested = errorEnvelope ?? envelope;
  const providerCode = safeProviderField(nested.code, SAFE_PROVIDER_CODE);
  const parameter = safeProviderField(nested.param, SAFE_PROVIDER_PARAM);
  const requestId = requestIdFromHeader ?? safeProviderField(envelope.request_id ?? nested.request_id, SAFE_REQUEST_ID);
  const failureKind = classifyProviderFailure(status, providerCode);
  return {
    hasErrorEnvelope,
    providerCode, parameter, requestId, failureKind,
    message: chatGPTPlanFailureMessage(failureKind, status, providerCode), retryAfterMs,
  };
}

function providerFailureError(details: ProviderErrorDetails, status: number | null, requestDispatched: boolean): ChatGPTPlanResponsesError {
  return new ChatGPTPlanResponsesError(
    details.message, details.failureKind === "temporary_unavailable",
    requestDispatched && (status === null || status >= 500), status, requestDispatched,
    details.providerCode, details.parameter, details.requestId, details.retryAfterMs, details.failureKind,
  );
}

export function chatGPTPlanFailureNeedsPause(kind: ChatGPTPlanFailureKind): boolean {
  return kind !== "temporary_unavailable";
}

export type ChatGPTPlanResponsesOptions = {
  tokenProvider: PlanTokenProvider;
  onProviderFailure?: (error: ChatGPTPlanResponsesError) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxStreamBytes?: number;
};

type PreparedPlanRequest = {
  body: string;
  payloadSha256: string;
  profileSha256: string;
};

/** A fully serialized, non-classification Responses request prepared by a trusted local profile. */
export type PreparedChatGPTPlanStructuredRequest = Readonly<{
  requestedModel: typeof OPENAI_MODEL;
  body: string;
  requestBytes: number;
  payloadSha256: string;
  profileSha256: string;
}>;

const SAFE_STRUCTURED_KEYS = new Set(["model", "instructions", "input", "text", "store", "stream"]);
const SHA256_RE = /^[a-f0-9]{64}$/u;

function validateStructuredRequest(request: PreparedChatGPTPlanStructuredRequest, maxRequestBytes: number): void {
  if (!request || request.requestedModel !== OPENAI_MODEL || typeof request.body !== "string" ||
      !Number.isSafeInteger(request.requestBytes) || request.requestBytes <= 0 ||
      !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0 || maxRequestBytes > 260_000 ||
      request.requestBytes > maxRequestBytes || !SHA256_RE.test(request.payloadSha256) || !SHA256_RE.test(request.profileSha256)) {
    throw new ChatGPTPlanResponsesError("Prepared structured request failed local profile validation.", false, false);
  }
  const bytes = Buffer.from(request.body, "utf8");
  if (bytes.byteLength !== request.requestBytes || sha256(bytes) !== request.payloadSha256) {
    throw new ChatGPTPlanResponsesError("Prepared structured request failed local integrity validation.", false, false);
  }
  let body: unknown;
  try { body = JSON.parse(request.body) as unknown; }
  catch { throw new ChatGPTPlanResponsesError("Prepared structured request is invalid JSON.", false, false); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ChatGPTPlanResponsesError("Prepared structured request has an invalid shape.", false, false);
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SAFE_STRUCTURED_KEYS.has(key)) || record.model !== OPENAI_MODEL ||
      record.store !== false || record.stream !== true || typeof record.instructions !== "string" ||
      !record.instructions.trim() || !Array.isArray(record.input) || record.input.length < 1 ||
      !record.text || typeof record.text !== "object" || Array.isArray(record.text)) {
    throw new ChatGPTPlanResponsesError("Prepared structured request contains unsupported or incomplete fields.", false, false);
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Convert the current canonical classifier request to the documented
 * ChatGPT-plan Responses shape. Canonical API-only fields are deliberately
 * removed instead of being forwarded or silently reinterpreted.
 */
export function prepareChatGPTPlanRequest(request: PreparedOpenAIRequest): PreparedPlanRequest {
  const requestBytes = Buffer.from(request.body, "utf8");
  if (requestBytes.byteLength !== request.requestBytes || sha256(requestBytes) !== request.payloadSha256 ||
      request.requestedModel !== OPENAI_MODEL) {
    throw new ChatGPTPlanResponsesError("Prepared classification request does not match the canonical Luna request.", false, false);
  }
  let canonical: Record<string, unknown>;
  try { canonical = JSON.parse(request.body) as Record<string, unknown>; }
  catch { throw new ChatGPTPlanResponsesError("Prepared classification request is invalid JSON.", false, false); }
  const input = canonical.input;
  if (!Array.isArray(input) || input.length !== 2 ||
      !input.every((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).role === "string" &&
        typeof (item as Record<string, unknown>).content === "string") ||
      (input[0] as Record<string, unknown>).role !== "system" ||
      (input[1] as Record<string, unknown>).role !== "user" ||
      !canonical.text || typeof canonical.text !== "object") {
    throw new ChatGPTPlanResponsesError("Prepared classification request is missing its canonical prompt, input, or schema.", false, false);
  }
  let canonicalInput: unknown;
  try { canonicalInput = JSON.parse((input[1] as { content: string }).content) as unknown; }
  catch { throw new ChatGPTPlanResponsesError("Prepared classification request has invalid source input.", false, false); }
  if (!canonicalInput || typeof canonicalInput !== "object") {
    throw new ChatGPTPlanResponsesError("Prepared classification request has invalid source input.", false, false);
  }
  const verified = prepareOpenAIRequest(canonicalInput as Parameters<typeof prepareOpenAIRequest>[0], OPENAI_MODEL);
  if (verified.body !== request.body || verified.promptSha256 !== request.promptSha256 || verified.schemaSha256 !== request.schemaSha256 ||
      verified.profileSha256 !== request.profileSha256 || verified.requestBytes !== request.requestBytes || verified.payloadSha256 !== request.payloadSha256 ||
      verified.requestedServiceTier !== request.requestedServiceTier || verified.maxOutputTokens !== request.maxOutputTokens) {
    throw new ChatGPTPlanResponsesError("Prepared classification request does not match the canonical prompt and schema profile.", false, false);
  }
  const bodyObject = {
    model: OPENAI_MODEL,
    instructions: (input[0] as Record<string, string>).content,
    input: [{ role: "user", content: (input[1] as Record<string, string>).content }],
    store: false,
    stream: true,
    text: canonical.text,
  };
  const body = JSON.stringify(bodyObject);
  const profileSha256 = sha256(JSON.stringify({
    version: CHATGPT_PLAN_PROFILE_VERSION,
    canonicalPromptSha256: request.promptSha256,
    schemaSha256: request.schemaSha256,
    model: OPENAI_MODEL,
    store: false,
    stream: true,
    tools: [],
    outputLimit: "provider-account-policy",
    pricing: null,
    serviceTier: null,
  }));
  return { body, payloadSha256: sha256(Buffer.from(body, "utf8")), profileSha256 };
}

function validUsage(value: unknown): PlanResponsesUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens = usage.total_tokens;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!valid(inputTokens) || !valid(outputTokens) || !valid(totalTokens) || totalTokens !== inputTokens + outputTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

type SseEvent = { event: string; data: string };

/** Bounded UTF-8/SSE reader; event bytes are preserved for terminal provenance. */
async function* readSse(response: Response, maxBytes: number, signal: AbortSignal): AsyncGenerator<SseEvent> {
  if (!response.body) throw new ChatGPTPlanResponsesError("ChatGPT response stream was empty.", false, true, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let totalBytes = 0;
  let eventName = "message";
  let dataLines: string[] = [];
  const emit = (): SseEvent | null => {
    if (!dataLines.length) { eventName = "message"; return null; }
    const result = { event: eventName, data: dataLines.join("\n") };
    eventName = "message"; dataLines = [];
    return result;
  };
  const processLine = (line: string): SseEvent | null => {
    if (line === "") return emit();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
    return null;
  };
  try {
    while (true) {
      if (signal.aborted) throw new ChatGPTPlanResponsesError("ChatGPT response was cancelled or timed out.", false, true, response.status);
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ChatGPTPlanResponsesError("ChatGPT response exceeded the bounded stream size; provider usage may need reconciliation.", false, true, response.status);
      }
      // Keep raw event lines while decoding line framing across arbitrary chunks.
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const event = processLine(line);
        if (event) yield event;
      }
    }
    pending += decoder.decode();
    if (pending.length || dataLines.length) {
      throw new ChatGPTPlanResponsesError("ChatGPT response stream ended inside an SSE event.", false, true, response.status);
    }
  } catch (error) {
    if (error instanceof ChatGPTPlanResponsesError) throw error;
    throw new ChatGPTPlanResponsesError("ChatGPT response stream was malformed or interrupted.", false, true, response.status);
  } finally {
    reader.releaseLock();
  }
}

function jsonEvent(event: SseEvent): Record<string, unknown> | null {
  if (event.data === "[DONE]") return null;
  let value: unknown;
  try { value = JSON.parse(event.data) as unknown; }
  catch { throw new ChatGPTPlanResponsesError("ChatGPT emitted malformed stream data; outcome is unknown.", false, true); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatGPTPlanResponsesError("ChatGPT emitted an invalid stream event; outcome is unknown.", false, true);
  }
  return value as Record<string, unknown>;
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ChatGPTPlanResponsesError("ChatGPT model catalog exceeded its size limit.", false, false, response.status);
  }
  if (!response.body) throw new ChatGPTPlanResponsesError("ChatGPT model catalog response is empty.", false, false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ChatGPTPlanResponsesError("ChatGPT model catalog exceeded its size limit.", false, false, response.status);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ChatGPTPlanResponsesError("ChatGPT model catalog was invalid JSON.", false, false, response.status); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type PlanCatalogEntry = { slug: string; visibility: string };
type ApiCatalogEntry = { id: string };

function isPlanCatalogEntry(value: unknown): value is PlanCatalogEntry {
  return isRecord(value) && typeof value.slug === "string" && typeof value.visibility === "string";
}

function isApiCatalogEntry(value: unknown): value is ApiCatalogEntry {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function availableModelsFromCatalog(value: unknown): Set<string> | null {
  if (!isRecord(value)) return null;
  const planModels = value.models;
  if (Array.isArray(planModels) && planModels.every(isPlanCatalogEntry)) {
    return new Set(planModels.filter((item) => item.visibility === "list").map((item) => item.slug));
  }
  const apiModels = value.data;
  if (Array.isArray(apiModels) && apiModels.every(isApiCatalogEntry)) {
    return new Set(apiModels.map((item) => item.id));
  }
  return null;
}

export class ChatGPTPlanResponses {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly catalog = new Map<string, { expiresAt: number; models: Set<string> }>();

  constructor(private readonly options: ChatGPTPlanResponsesOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async requestTokenAndAccount(): Promise<{ token: string; accountId: string }> {
    let token: string | null;
    let accountId: string | null;
    try { [token, accountId] = await Promise.all([this.options.tokenProvider.getAccessToken(), this.options.tokenProvider.getAccountId()]); }
    catch { throw new ChatGPTPlanResponsesError("ChatGPT account authorization is unavailable.", false, false); }
    if (!token || !accountId) throw new ChatGPTPlanResponsesError("Connect the authorized ChatGPT account before classifying.", false, false);
    return { token, accountId };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "error" });
    } catch (error) {
      if (error instanceof ExternalRequestPausedError && error.dispatchedRequests === 0) {
        throw new ChatGPTPlanResponsesError("ChatGPT request was paused before dispatch.", false, false, null, false);
      }
      const postMayHaveReachedProvider = init.method?.toUpperCase() === "POST";
      throw new ChatGPTPlanResponsesError(
        "ChatGPT request failed before a confirmed response; outcome may be unknown.",
        postMayHaveReachedProvider,
        postMayHaveReachedProvider,
        null,
        postMayHaveReachedProvider,
        null, null, null, null,
        postMayHaveReachedProvider ? "temporary_unavailable" : null,
      );
    }
  }

  private async requireModel(token: string, accountId: string, signal: AbortSignal): Promise<boolean> {
    const cached = this.catalog.get(accountId);
    if (cached && cached.expiresAt > this.now()) {
      return cached.models.has(OPENAI_MODEL);
    }
    this.catalog.delete(accountId);
    const response = await this.fetchWithTimeout(`${API_ROOT}/models`, {
      method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw providerFailureError(await providerErrorDetails(response, this.now()), response.status, false);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      throw new ChatGPTPlanResponsesError("ChatGPT model catalog returned an unexpected content type.", false, false, response.status);
    }
    const raw = await readBoundedJson(response, MAX_CATALOG_BYTES);
    const availableModels = availableModelsFromCatalog(raw);
    if (!availableModels) {
      throw new ChatGPTPlanResponsesError("ChatGPT model catalog did not contain a valid model list.", false, false, response.status);
    }
    this.catalog.set(accountId, { expiresAt: this.now() + MODEL_CACHE_TTL_MS, models: availableModels });
    return availableModels.has(OPENAI_MODEL);
  }

  /** Check model access for the connected account without creating a response or reporting balance. */
  async checkModelAccess(): Promise<{ modelAvailable: boolean }> {
    const { token, accountId } = await this.requestTokenAndAccount();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const modelAvailable = await this.requireModel(token, accountId, controller.signal);
      return { modelAvailable };
    } catch (error) {
      this.reportProviderFailure(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private reportProviderFailure(error: unknown): void {
    if (!(error instanceof ChatGPTPlanResponsesError) || error.failureKind === null) return;
    try { this.options.onProviderFailure?.(error); }
    catch { /* Preserve the provider failure if local pause reporting is unavailable. */ }
  }

  async classifyPrepared(request: PreparedOpenAIRequest, signal?: AbortSignal, onBeforeDispatch?: () => boolean): Promise<PlanResponsesEnvelope> {
    const prepared = prepareChatGPTPlanRequest(request);
    const requestBytes = Buffer.byteLength(prepared.body, "utf8");
    return this.requestStructured({
      requestedModel: OPENAI_MODEL,
      body: prepared.body,
      requestBytes,
      payloadSha256: prepared.payloadSha256,
      profileSha256: prepared.profileSha256,
    }, this.options.maxRequestBytes ?? MAX_REQUEST_BYTES, signal, onBeforeDispatch);
  }

  /** Send a trusted, prebuilt structured request through the same plan-only bounded transport. */
  async requestStructured(
    request: PreparedChatGPTPlanStructuredRequest,
    maxRequestBytes: number,
    signal?: AbortSignal,
    onBeforeDispatch?: () => boolean,
  ): Promise<PlanResponsesEnvelope> {
    validateStructuredRequest(request, maxRequestBytes);
    const started = this.now();
    const { token, accountId } = await this.requestTokenAndAccount();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) relayAbort();
      else signal.addEventListener("abort", relayAbort, { once: true });
    }
    let requestDispatched = false;
    try {
    if (!await this.requireModel(token, accountId, controller.signal)) {
      throw new ChatGPTPlanResponsesError("GPT-6 Luna is not available for the connected ChatGPT account.", false, false);
    }
    if (onBeforeDispatch) {
      let proceed: boolean;
      try { proceed = onBeforeDispatch(); }
      catch { throw new ChatGPTPlanResponsesError("Structured request pre-dispatch check failed; no request was sent.", false, false); }
      if (!proceed) throw new ChatGPTPlanResponsesError("Structured request was stopped before dispatch.", false, false);
    }
    const response = await this.fetchWithTimeout(`${API_ROOT}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
      body: request.body,
      signal: controller.signal,
    });
    // A response confirms the request crossed the dispatch boundary. If the
    // local external-request gate throws inside fetchImpl, fetchWithTimeout
    // marks that known-unsent outcome explicitly and the catch below preserves it.
    requestDispatched = true;
    if (!response.ok) {
      throw providerFailureError(await providerErrorDetails(response, this.now()), response.status, true);
    }
    if (!(response.headers.get("content-type")?.toLowerCase().includes("text/event-stream"))) {
      const details = await providerErrorDetails(response, this.now());
      if (details.hasErrorEnvelope) throw providerFailureError(details, response.status, true);
      throw new ChatGPTPlanResponsesError("ChatGPT plan did not return a streaming Responses result.", false, true, response.status);
    }
    let terminal: Record<string, unknown> | null = null;
    let terminalDigest: string | null = null;
    let terminalData: string | null = null;
    for await (const event of readSse(response, this.options.maxStreamBytes ?? MAX_STREAM_BYTES, controller.signal)) {
      if (event.data === "[DONE]") {
        if (!terminal) throw new ChatGPTPlanResponsesError("ChatGPT stream ended before a completed response.", false, true, response.status);
        continue;
      }
      const payload = jsonEvent(event);
      if (!payload) continue;
      const type = typeof payload.type === "string" ? payload.type : event.event;
      if (terminal) throw new ChatGPTPlanResponsesError("ChatGPT emitted data after its terminal completion event.", false, true, response.status);
      if (type === "response.failed" || type === "response.incomplete" || type === "error") {
        const requestId = safeProviderField(response.headers.get("x-request-id") ?? response.headers.get("request-id"), SAFE_REQUEST_ID);
        const details = providerErrorDetailsFromPayload(payload, response.status, requestId);
        throw providerFailureError(details, response.status, true);
      }
      if (type === "response.completed") {
        const candidate = payload.response;
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          throw new ChatGPTPlanResponsesError("ChatGPT completion event did not contain a response object.", false, true, response.status);
        }
        terminal = candidate as Record<string, unknown>;
        terminalDigest = sha256(event.data);
        terminalData = event.data;
      }
    }
    if (!terminal || !terminalDigest || terminalData === null) throw new ChatGPTPlanResponsesError("ChatGPT stream closed without response.completed; no result was saved.", false, true, response.status);
    if (Buffer.byteLength(terminalData, "utf8") > 65_536) throw new ChatGPTPlanResponsesError("ChatGPT completion payload exceeds the bounded evaluation receipt size.", false, true, response.status);
    const id = terminal.id;
    const model = terminal.model;
    const status = terminal.status;
    const usage = validUsage(terminal.usage);
    if (status !== "completed" || typeof id !== "string" || !id || model !== OPENAI_MODEL || !usage || !Array.isArray(terminal.output)) {
      throw new ChatGPTPlanResponsesError("Completed ChatGPT response failed model, status, usage, or output validation.", false, true, response.status);
    }
    const serviceTier = typeof terminal.service_tier === "string" ? terminal.service_tier : null;
    return {
      provider: "chatgpt_plan",
      profileVersion: CHATGPT_PLAN_PROFILE_VERSION,
      profileSha256: request.profileSha256,
      responseId: id,
      modelRequested: OPENAI_MODEL,
      modelReturned: OPENAI_MODEL,
      serviceTier,
      estimatedCostUsd: null,
      usage,
      responseSha256: terminalDigest,
      responsePayload: terminalData,
      response: terminal,
      httpStatus: response.status,
      latencyMs: Math.max(0, this.now() - started),
    };
    } catch (error) {
      if (error instanceof ChatGPTPlanResponsesError) {
        error.requestDispatched = error.requestDispatched || requestDispatched;
        this.reportProviderFailure(error);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", relayAbort);
    }
  }
}
