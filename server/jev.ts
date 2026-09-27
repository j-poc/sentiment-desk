import { z } from "zod";

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
    if (!this.configured) throw new JevError("TypeSafe API key is not configured", undefined, false);

    const body = JSON.stringify({ model: this.opts.model, state, questions });
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new JevError(
        `TypeSafe request failed before a response was received: ${err instanceof Error ? err.message : String(err)}`,
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
      const text = await res.text().catch(() => "");
      throw new JevError(
        `TypeSafe responded HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        res.status,
        false,
      );
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
        `TypeSafe response failed contract validation; request outcome is unknown: ${parsed.error.message}`,
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
    };
  }
}
