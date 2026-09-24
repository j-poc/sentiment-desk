import { describe, expect, it, vi } from "vitest";
import { JevClient, JevError } from "../server/jev.js";
import { RUBRIC, RUBRIC_SHA } from "../server/rubric.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWith(fetchImpl: typeof fetch): JevClient {
  return new JevClient({
    apiKey: "test-key",
    baseUrl: "https://api.test",
    model: "jev-latest",
    timeoutMs: 1_000,
    fetchImpl,
  });
}

const okBody = {
  model: "jev-latest",
  answers: {
    sentiment: { choice: "neutral", probabilities: { negative: 0.2, neutral: 0.6, positive: 0.2 }, confidence: 0.7 },
    about: { noul: 0.9 },
    material: { noul: 0.5 },
    novel: { noul: 0.5 },
    credible: { noul: 0.8 },
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
    expect(out.inputTokens).toBe(123);
    expect(out.answers.about).toEqual({ noul: 0.9 });
  });

  it("retries once on 429 then succeeds", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: "slow down" }, 429) : jsonResponse(okBody);
    }) as unknown as typeof fetch;

    const out = await clientWith(impl).judge({}, RUBRIC);
    expect(calls).toBe(2);
    expect(out.answers.sentiment).toBeTruthy();
  });

  it("does not retry on non-429 4xx and fails closed on empty answers", async () => {
    const impl = vi.fn(async () => jsonResponse("unauthorized", 401)) as unknown as typeof fetch;
    await expect(clientWith(impl).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
    expect(impl).toHaveBeenCalledTimes(1);

    const empty = vi.fn(async () => jsonResponse({ answers: {} })) as unknown as typeof fetch;
    await expect(clientWith(empty).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("fails closed on contract-violating responses", async () => {
    const bad = (async () => jsonResponse({ answers: { sentiment: { choice: "neutral" } } })) as unknown as typeof fetch;
    // Valid HTTP, but usage missing is tolerated; answers present -> ok.
    const out = await clientWith(bad).judge({}, RUBRIC);
    expect(out.inputTokens).toBe(0);

    const notJson = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(clientWith(notJson).judge({}, RUBRIC)).rejects.toBeInstanceOf(JevError);
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
      "magnitude",
      "material",
      "novel",
      "sentiment",
      "surprise",
    ]);
    const sentimentQ = RUBRIC["sentiment"];
    expect(sentimentQ?.type).toBe("choice");
    if (sentimentQ && sentimentQ.type === "choice") {
      expect(Object.keys(sentimentQ.criteria).sort()).toEqual(["negative", "neutral", "positive"]);
    }
    expect(RUBRIC_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});
