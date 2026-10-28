import { describe, expect, it, vi } from "vitest";
import {
  GEMINI_MODEL,
  ModelProviderClassifier,
  ModelProviderError,
  prepareModelProviderRequest,
} from "../server/model-provider-classifier.js";
import { ExternalRequestPausedError } from "../server/external-request-gate.js";
import type { OpenAIClassificationInput } from "../server/openai-classifier.js";

const input: OpenAIClassificationInput = {
  company: { name: "Acme Incorporated", ticker: "ACME", sector: "Technology" },
  source: {
    collector: "google_news_rss",
    publisher: "Reuters",
    title: "Acme wins an industrial contract",
    excerpt: "Acme said the contract will add production capacity.",
  },
};

function geminiResponse(overrides: Record<string, unknown> = {}) {
  const classification = {
    sentiment: "positive",
    event_type: "corporate_action",
    takeaway: "product_win",
    about: true,
    material: true,
    investor_relevant: true,
    evidence_sufficient: true,
    summary: "Acme won an industrial contract.",
    supporting_excerpt: "Acme wins an industrial contract",
  };
  return {
    modelVersion: GEMINI_MODEL,
    responseId: "gemini-test-response",
    candidates: [{
      content: { role: "model", parts: [{ text: JSON.stringify(classification) }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
    ...overrides,
  };
}

describe("user-provided model classifier", () => {
  it("sends one bounded structured Gemini request and validates its source quote", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(geminiResponse()), { status: 200 });
    }) as typeof fetch;
    const classifier = new ModelProviderClassifier({ fetchImpl, timeoutMs: 1_000 });
    const result = await classifier.classify("google_gemini", "test-gemini-key", input);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
    expect(calls[0]?.url).not.toContain("test-gemini-key");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({ "x-goog-api-key": "test-gemini-key", "content-type": "application/json" });
    const request = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(JSON.stringify(request)).not.toContain("test-gemini-key");
    expect(request.generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: 700,
      responseFormat: { text: { mimeType: "application/json" } },
    });
    expect(result.classification).toMatchObject({
      sentiment: "positive",
      supportingExcerpt: input.source.title,
      evidenceSufficient: true,
    });
    expect(result).toMatchObject({
      provider: "google_gemini",
      modelReturned: GEMINI_MODEL,
      inputTokens: 100,
      outputTokens: 30,
      httpStatus: 200,
    });
    expect(result.request.requestBytes).toBe(Buffer.byteLength(result.request.body, "utf8"));
  });

  it("verifies Gemini model access with a body-free catalog request and key header", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
      models: [{ name: `models/${GEMINI_MODEL}` }],
    }), { status: 200 })) as unknown as typeof fetch;
    const classifier = new ModelProviderClassifier({ fetchImpl, timeoutMs: 1_000 });

    await expect(classifier.verify("google_gemini", "test-gemini-key")).resolves.toEqual({ model: GEMINI_MODEL, available: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com/v1beta/models");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ "x-goog-api-key": "test-gemini-key" });
  });

  it("treats a final-boundary pause as not sent rather than unknown provider usage", async () => {
    const classifier = new ModelProviderClassifier({ fetchImpl: (async () => { throw new ExternalRequestPausedError(); }) as typeof fetch });

    await expect(classifier.classify("google_gemini", "test-gemini-key", input))
      .rejects.toMatchObject({ name: "ModelProviderError", outcomeUnknown: false, requestDispatched: false });
  });

  it("does not retry malformed, source-unsupported, or ambiguous provider outcomes", async () => {
    let calls = 0;
    const malformed = geminiResponse({ candidates: [{
      content: { role: "model", parts: [{ text: JSON.stringify({ ...JSON.parse(JSON.stringify(geminiResponse().candidates[0]?.content.parts[0]?.text)), supporting_excerpt: "invented wording" }) }] },
      finishReason: "STOP",
    }] });
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify(malformed), { status: 200 });
    }) as typeof fetch;
    const classifier = new ModelProviderClassifier({ fetchImpl, timeoutMs: 1_000 });

    await expect(classifier.classify("google_gemini", "test-gemini-key", input))
      .rejects.toMatchObject({ name: "ModelProviderError", outcomeUnknown: false, requestDispatched: true });
    expect(calls).toBe(1);

    const unavailableFetch = (async () => { throw new Error("connection lost"); }) as typeof fetch;
    await expect(new ModelProviderClassifier({ fetchImpl: unavailableFetch, timeoutMs: 1_000 }).classify("google_gemini", "test-gemini-key", input))
      .rejects.toBeInstanceOf(ModelProviderError);
    await expect(new ModelProviderClassifier({ fetchImpl: unavailableFetch, timeoutMs: 1_000 }).classify("google_gemini", "test-gemini-key", input))
      .rejects.toMatchObject({ outcomeUnknown: true, requestDispatched: true });
  });

  it("keeps the OpenAI Luna profile fixed when using a user-provided key", () => {
    const prepared = prepareModelProviderRequest("openai", input);
    expect(prepared.requestedModel).toBe("gpt-6-luna");
    expect(prepared.body).toContain('"store":false');
  });
});
