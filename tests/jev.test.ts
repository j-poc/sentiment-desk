import { describe, expect, it, vi } from "vitest";
import { JevClient, JevError } from "../server/jev.js";
import { RUBRIC, RUBRIC_SHA } from "../server/rubric.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWith(fetchImpl: typeof fetch, model = "jev-latest"): JevClient {
  return new JevClient({
    apiKey: "test-key",
    baseUrl: "https://api.test",
    model,
    timeoutMs: 1_000,
    fetchImpl,
  });
}

const okBody = {
  model: "jev-1.13.0",
  answers: {
    sentiment: { type: "choice", choice: "neutral", probabilities: { negative: 0.2, neutral: 0.6, positive: 0.2 }, confidence: 0.7 },
    about: { type: "noul", noul: 0.9 },
    material: { type: "noul", noul: 0.5 },
    novel: { type: "noul", noul: 0.5 },
    credible: { type: "noul", noul: 0.8 },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
};

describe("JevClient", () => {
  it("posts model, state, and questions with bearer auth to /v1/systemone", async () => {
    const seen: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    const impl = (async (_input: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({
        url: String(_input),
        auth: headers.authorization ?? "",
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const out = await clientWith(impl).judge({ hello: 1 }, RUBRIC);

    expect(seen.length).toBe(1);
    expect(seen[0]?.url).toBe("https://api.test/v1/systemone");
    expect(seen[0]?.auth).toBe("Bearer test-key");
    expect(seen[0]?.body.model).toBe("jev-latest");
    expect(seen[0]?.body.state).toEqual({ hello: 1 });
    const questions = seen[0]?.body.questions as Record<string, { type: string }>;
    expect(questions["sentiment"]?.type).toBe("choice");
    expect(questions["about"]?.type).toBe("noul");
    expect(out.model).toBe("jev-1.13.0");
    expect(out.inputTokens).toBe(123);
    expect(out.answers.about).toEqual({ type: "noul", noul: 0.9 });
  });

  it.each(["jev-latest", "jev-preview"])("accepts a versioned response for the %s alias", async (alias) => {
    const impl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: alias });
      return jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const outcome = await clientWith(impl, alias).judge({}, RUBRIC);

    expect(outcome.model).toBe("jev-1.13.0");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact versioned model response", async () => {
    const impl = vi.fn(async () => jsonResponse(okBody)) as unknown as typeof fetch;

    const outcome = await clientWith(impl, "jev-1.13.0").judge({}, RUBRIC);

    expect(outcome.model).toBe("jev-1.13.0");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 529])("returns explicit HTTP %s rejection for persisted retry without resubmitting in the client", async (status) => {
    const impl = vi.fn(async () => jsonResponse({ error: "overloaded" }, status)) as unknown as typeof fetch;
    const client = clientWith(impl);
    const error = await client.judge({}, RUBRIC).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).status).toBe(status);
    expect((error as JevError).retryable).toBe(true);
    expect((error as JevError).outcomeUnknown).toBe(false);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit 5xx or ambiguous transport failures", async () => {
    const serverError = vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)) as unknown as typeof fetch;
    const serverFailure = await clientWith(serverError).judge({}, RUBRIC).catch((value: unknown) => value);
    expect(serverFailure).toBeInstanceOf(JevError);
    expect((serverFailure as JevError).retryable).toBe(false);
    expect((serverFailure as JevError).outcomeUnknown).toBe(true);
    expect(serverError).toHaveBeenCalledTimes(1);

    const transport = vi.fn(async () => { throw new Error("socket timeout"); }) as unknown as typeof fetch;
    const transportFailure = await clientWith(transport).judge({}, RUBRIC).catch((value: unknown) => value);
    expect(transportFailure).toBeInstanceOf(JevError);
    expect((transportFailure as JevError).outcomeUnknown).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-429 4xx and fails closed on empty answers", async () => {
    const impl = vi.fn(async () => jsonResponse("unauthorized", 401)) as unknown as typeof fetch;
    await expect(clientWith(impl).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
    expect(impl).toHaveBeenCalledTimes(1);

    const empty = vi.fn(async () => jsonResponse({ answers: {} })) as unknown as typeof fetch;
    await expect(clientWith(empty).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing required response fields or invalid token usage", async () => {
    const missingUsage = (async () => jsonResponse({ model: "jev-latest", answers: { sentiment: { type: "choice", choice: "neutral", probabilities: { negative: 0.2, neutral: 0.6, positive: 0.2 }, confidence: 0.7 } } })) as unknown as typeof fetch;
    await expect(clientWith(missingUsage).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);

    const fractionalUsage = (async () => jsonResponse({ ...okBody, usage: { input_tokens: 1.5, output_tokens: 0 } })) as unknown as typeof fetch;
    await expect(clientWith(fractionalUsage).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);

    const negativeUsage = (async () => jsonResponse({ ...okBody, usage: { input_tokens: -1, output_tokens: 0 } })) as unknown as typeof fetch;
    await expect(clientWith(negativeUsage).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);

    const notJson = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(clientWith(notJson).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
  });

  it.each([
    { configured: "jev-latest", returned: "jev-latest" },
    { configured: "jev-latest", returned: "jev-preview" },
    { configured: "jev-latest", returned: "jev-fallback" },
    { configured: "jev-latest", returned: "jev-1.13.0-beta" },
    { configured: "jev-latest", returned: "jev-not-a-version" },
    { configured: "jev-1.12.0", returned: "jev-1.13.0" },
  ])("rejects unexpected response model $returned for configured $configured without retrying", async ({ configured, returned }) => {
    const impl = vi.fn(async () => jsonResponse({ ...okBody, model: returned })) as unknown as typeof fetch;
    const error = await clientWith(impl, configured).judge({}, RUBRIC).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).retryable).toBe(false);
    expect((error as JevError).outcomeUnknown).toBe(true);
    expect((error as Error).message).toContain("model mismatch");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("refuses to call without a key", async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const client = new JevClient({
      apiKey: "",
      baseUrl: "https://api.test",
      model: "jev-latest",
      timeoutMs: 100,
      fetchImpl: impl,
    });
    await expect(client.judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("rubric", () => {
  it("has the five fixed questions with stable hash", () => {
    expect(Object.keys(RUBRIC).sort()).toEqual([
      "about",
      "credible",
      "event_type",
      "investor_relevant",
      "magnitude",
      "material",
      "novel",
      "sentiment",
      "surprise",
      "takeaway",
    ]);
    const sentimentQ = RUBRIC["sentiment"];
    expect(sentimentQ?.type).toBe("choice");
    if (sentimentQ && sentimentQ.type === "choice") {
      expect(Object.keys(sentimentQ.criteria).sort()).toEqual(["negative", "neutral", "positive"]);
    }
    expect(RUBRIC_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});
