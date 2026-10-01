import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * Wire contract with TypeSafe AI's System One, matching the Go adapter in
 * newsjack (apps/cli/cmd/newsjack/coarse_filter.go):
 *
 *   POST {base}/v1/systemone
 *   Authorization: Bearer <key>
 *   { "model": "jev-latest", "state": {...}, "questions": {...} }
 *
 *   -> { "model": "...", "answers": { <key>: {choice?, probabilities?,
 *        confidence?} | {noul} }, "usage": { "input_tokens", "output_tokens" } }
 *
 * TypeSafe returns the resolved versioned model ID for aliases such as
 * `jev-latest`. Preserve that response ID as score provenance while keeping
 * exact matching for explicitly pinned model IDs.
 *
 * A single request is sent per persisted pipeline attempt. Explicit 429 and
 * documented 529 overload rejections may be retried by the persisted queue;
 * other 5xx and transport errors have unknown execution outcomes and are
 * never automatically resubmitted. Other 4xx responses and invalid bodies
 * fail closed.
 */

const probabilitySchema = z.number().finite().min(0).max(1);

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), probabilitySchema),
  confidence: probabilitySchema,
}).passthrough();

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: probabilitySchema,
}).passthrough();

const answerSchema = z.discriminatedUnion("type", [choiceAnswerSchema, noulAnswerSchema]);
const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const aliasModels = new Set(["jev-latest", "jev-preview"]);
const resolvedJevModelPattern = /^jev-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) {
    const delayMs = Number(header) * 1_000;
    return Number.isSafeInteger(delayMs) ? delayMs : undefined;
  }
  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt)) return undefined;
  const delayMs = Math.max(0, retryAt - now);
  return Number.isSafeInteger(delayMs) ? delayMs : undefined;
}

function responseModelMatches(requested: string, returned: string): boolean {
  if (aliasModels.has(requested)) return resolvedJevModelPattern.test(returned);
  return returned === requested;
}

export const jevResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema).refine((answers) => Object.keys(answers).length > 0),
  usage: z.object({
    input_tokens: tokenCountSchema,
    output_tokens: tokenCountSchema,
  }),
});

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly outcomeUnknown = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JudgeOutcome {
  answers: Record<string, unknown>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  httpStatus: number;
}

export interface PreparedJevRequest {
  readonly body: string;
  readonly payloadSha256: string;
  readonly requestBytes: number;
  readonly requestedModel: string;
  readonly rubricSha256: string;
}

/** Serialize once so the budget, durable attempt, and HTTP request bind the same UTF-8 bytes. */
export function prepareJevRequest(
  model: string,
  state: unknown,
  questions: unknown,
  rubricSha256 = createHash("sha256").update(JSON.stringify(questions)).digest("hex"),
): PreparedJevRequest {
  const actualRubricSha256 = createHash("sha256").update(JSON.stringify(questions)).digest("hex");
  if (rubricSha256 !== actualRubricSha256) throw new Error("Prepared Jev rubric digest does not match the submitted questions");
  const body = JSON.stringify({ model, state, questions });
  const bytes = Buffer.from(body, "utf8");
  return Object.freeze({
    body,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    requestBytes: bytes.byteLength,
    requestedModel: model,
    rubricSha256,
  });
}

export function validateChoiceAnswer(raw: unknown) {
  return choiceAnswerSchema.parse(raw);
}

export function validateNoulAnswer(raw: unknown) {
  return noulAnswerSchema.parse(raw);
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class JevClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JevClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.opts.apiKey.length > 0;
  }

  get model(): string {
    return this.opts.model;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  costFor(inputTokens: number): number {
    return (inputTokens / 1_000_000) * 0.042;
  }

  async judge(state: unknown, questions: unknown): Promise<JudgeOutcome> {
    return this.judgePrepared(prepareJevRequest(this.opts.model, state, questions));
  }

  async judgePrepared(request: PreparedJevRequest): Promise<JudgeOutcome> {
    if (!this.configured) throw new JevError("TypeSafe API key is not configured", undefined, false);
    const bodyBytes = Buffer.from(request.body, "utf8");
    if (request.requestedModel !== this.opts.model) throw new Error("Prepared Jev request model differs from the configured model");
    if (request.requestBytes !== bodyBytes.byteLength || request.payloadSha256 !== createHash("sha256").update(bodyBytes).digest("hex")) {
      throw new Error("Prepared Jev request digest or byte count does not match its exact body");
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
        },
        body: request.body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new JevError(
        "TypeSafe request failed before a response was received",
        undefined,
        false,
        true,
      );
    }

    if (res.status === 429 || res.status === 529) {
      throw new JevError(
        `TypeSafe rejected the request with HTTP ${res.status}`,
        res.status,
        true,
        false,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    if (res.status >= 500) {
      throw new JevError(`TypeSafe responded HTTP ${res.status}; request outcome is unknown`, res.status, false, true);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new JevError(`TypeSafe responded HTTP ${res.status}`, res.status, false);
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new JevError("TypeSafe response was not valid JSON; request outcome is unknown", res.status, false, true);
    }
    const parsed = jevResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new JevError(
        "TypeSafe response failed contract validation; request outcome is unknown",
        res.status,
        false,
        true,
      );
    }
    if (!responseModelMatches(this.opts.model, parsed.data.model)) {
      throw new JevError(
        `TypeSafe response model mismatch: expected ${this.opts.model}, received ${parsed.data.model}; request outcome is unknown`,
        res.status,
        false,
        true,
      );
    }
    return {
      answers: parsed.data.answers,
      model: parsed.data.model,
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
      latencyMs: Date.now() - started,
      httpStatus: res.status,
    };
  }
}
