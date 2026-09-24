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
 * Retries: 4 attempts, exponential backoff, only on 429, 5xx, and transport
 * failures. Other 4xx is a request problem and fails immediately. A response
 * without a valid answers map fails closed: it never becomes a score.
 */

const choiceAnswerSchema = z
  .object({
    choice: z.string().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();

const noulAnswerSchema = z.object({ noul: z.number().min(0).max(1) }).passthrough();

export const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JudgeOutcome {
  answers: Record<string, unknown>;
  model?: string;
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

const ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;

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
    let lastError: unknown;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });

        if (res.status === 429 || res.status >= 500) {
          lastError = new JevError(`TypeSafe responded HTTP ${res.status}`, res.status, true);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new JevError(
            `TypeSafe responded HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
            res.status,
            false,
          );
        }

        const parsed = jevResponseSchema.parse(await res.json());
        if (Object.keys(parsed.answers).length === 0) {
          throw new JevError("TypeSafe response has no answers", res.status, false);
        }
        return {
          answers: parsed.answers,
          model: parsed.model,
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof JevError && !err.retryable) throw err;
        // Schema failures and non-JSON bodies are contract violations, not transient.
        if (err instanceof z.ZodError) {
          throw new JevError(`TypeSafe response failed contract validation: ${err.message}`, undefined, false);
        }
        if (err instanceof SyntaxError) {
          throw new JevError("TypeSafe response was not valid JSON", undefined, false);
        }
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new JevError("TypeSafe call failed after retries", undefined, true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
