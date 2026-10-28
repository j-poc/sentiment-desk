import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_MODEL } from "../server/openai-classifier.js";
import { ExternalRequestPausedError } from "../server/external-request-gate.js";
import {
  ChatGPTPlanResponses,
  ChatGPTPlanResponsesError,
  type PreparedChatGPTPlanStructuredRequest,
} from "../server/chatgpt-plan-responses.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request = (overrides: Partial<PreparedChatGPTPlanStructuredRequest> = {}): PreparedChatGPTPlanStructuredRequest => {
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    instructions: "Analyze only the selected note.",
    input: [{ role: "user", content: "A test note with no real user data." }],
    store: false,
    stream: true,
    text: { format: { type: "json_schema", name: "note_analysis", strict: true, schema: { type: "object" } } },
  });
  return { requestedModel: OPENAI_MODEL, body, requestBytes: Buffer.byteLength(body), payloadSha256: hash(body), profileSha256: "a".repeat(64), ...overrides };
};
const completed = (overrides: Record<string, unknown> = {}) => ({
  id: "resp_structured_1", status: "completed", model: OPENAI_MODEL,
  output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
  usage: { input_tokens: 31, output_tokens: 9, total_tokens: 40 },
  ...overrides,
});
const event = (type: string, response: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const stream = (payload: string) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); },
}), { headers: { "content-type": "text/event-stream" } });
const model = (slug: string, visibility = "list") => ({ slug, visibility, display_name: slug });
const catalog = () => Response.json({ models: [model(OPENAI_MODEL)] });
function harness(response: Response) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ url, init });
    return url.endsWith("/models") ? catalog() : response;
  }) as typeof fetch;
  const api = new ChatGPTPlanResponses({
    tokenProvider: { getAccessToken: async () => "test-only-token", getAccountId: async () => "protocol-test-account" },
    fetchImpl,
  });
  return { api, sent, fetchImpl };
}

describe("ChatGPT-plan generic structured request", () => {
  it("sends the exact validated model request and records only the completed usage receipt", async () => {
    const prepared = request();
    const { api, sent } = harness(stream(event("response.completed", completed())));
    const receipt = await api.requestStructured(prepared, 260_000);
    const post = sent.find(({ url }) => url.endsWith("/responses"));
    expect(post).toBeDefined();
    expect(post?.init.redirect).toBe("error");
    expect(post?.init.body).toBe(prepared.body);
    expect(JSON.parse(String(post?.init.body))).not.toHaveProperty("service_tier");
    expect(JSON.parse(String(post?.init.body))).not.toHaveProperty("pricing");
    expect(receipt).toMatchObject({ provider: "chatgpt_plan", responseId: "resp_structured_1", modelReturned: OPENAI_MODEL,
      profileSha256: prepared.profileSha256, estimatedCostUsd: null, usage: { inputTokens: 31, outputTokens: 9, totalTokens: 40 } });
    expect(receipt.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an oversized request locally before account or network access", async () => {
    const { api, fetchImpl } = harness(stream(event("response.completed", completed())));
    const prepared = request();
    await expect(api.requestStructured(prepared, prepared.requestBytes - 1)).rejects.toMatchObject({ requestDispatched: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(api.requestStructured(prepared, 260_001)).rejects.toBeInstanceOf(ChatGPTPlanResponsesError);
  });

  it("rejects a wrong model, body/hash mismatch, and API-only request fields before dispatch", async () => {
    const { api, fetchImpl } = harness(stream(event("response.completed", completed())));
    await expect(api.requestStructured(request({ requestedModel: "gpt-6-other" as typeof OPENAI_MODEL }), 260_000))
      .rejects.toMatchObject({ requestDispatched: false });
    const prepared = request();
    await expect(api.requestStructured({ ...prepared, payloadSha256: "b".repeat(64) }, 260_000))
      .rejects.toMatchObject({ requestDispatched: false });
    const body = JSON.stringify({ ...JSON.parse(prepared.body), service_tier: "default" });
    await expect(api.requestStructured({ ...prepared, body, requestBytes: Buffer.byteLength(body), payloadSha256: hash(body) }, 260_000))
      .rejects.toMatchObject({ requestDispatched: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unavailable exact model access before posting the private request", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ models: [model("gpt-6-other")] })) as typeof fetch;
    const api = new ChatGPTPlanResponses({
      tokenProvider: { getAccessToken: async () => "test-only-token", getAccountId: async () => "protocol-test-account" }, fetchImpl,
    });
    await expect(api.requestStructured(request(), 260_000)).rejects.toThrow(/not available/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("runs the synchronous pre-dispatch hook once immediately before the Responses POST", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      order.push(url.endsWith("/models") ? "models" : "responses");
      return url.endsWith("/models") ? catalog() : stream(event("response.completed", completed()));
    }) as typeof fetch;
    const api = new ChatGPTPlanResponses({
      tokenProvider: { getAccessToken: async () => "test-only-token", getAccountId: async () => "protocol-test-account" }, fetchImpl,
    });
    const hook = vi.fn(() => { order.push("hook"); return true; });
    await api.requestStructured(request(), 260_000, undefined, hook);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["models", "hook", "responses"]);
  });

  it("does not run the hook on token or model preflight failure and treats a veto as known-unsent", async () => {
    const hook = vi.fn(() => true);
    const noToken = new ChatGPTPlanResponses({
      tokenProvider: { getAccessToken: async () => null, getAccountId: async () => "protocol-test-account" }, fetchImpl: vi.fn() as typeof fetch,
    });
    await expect(noToken.requestStructured(request(), 260_000, undefined, hook)).rejects.toMatchObject({ requestDispatched: false });
    expect(hook).not.toHaveBeenCalled();

    const unavailableFetch = vi.fn(async () => Response.json({ models: [model("gpt-6-other")] })) as typeof fetch;
    const unavailable = new ChatGPTPlanResponses({
      tokenProvider: { getAccessToken: async () => "test-only-token", getAccountId: async () => "protocol-test-account" }, fetchImpl: unavailableFetch,
    });
    await expect(unavailable.requestStructured(request(), 260_000, undefined, hook)).rejects.toMatchObject({ requestDispatched: false });
    expect(hook).not.toHaveBeenCalled();
    expect(unavailableFetch).toHaveBeenCalledTimes(1);

    const { api, fetchImpl } = harness(stream(event("response.completed", completed())));
    const veto = vi.fn(() => false);
    await expect(api.requestStructured(request(), 260_000, undefined, veto)).rejects.toMatchObject({ requestDispatched: false });
    expect(veto).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Model catalog only; no Responses POST.
  });

  it("preserves known-unsent state when the final storage admission gate blocks the Responses POST", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return catalog();
      throw new ExternalRequestPausedError(0);
    }) as typeof fetch;
    const api = new ChatGPTPlanResponses({
      tokenProvider: { getAccessToken: async () => "test-only-token", getAccountId: async () => "protocol-test-account" },
      fetchImpl,
    });
    const preDispatch = vi.fn(() => true);
    await expect(api.requestStructured(request(), 260_000, undefined, preDispatch)).rejects.toMatchObject({
      requestDispatched: false, outcomeUnknown: false,
    });
    expect(preDispatch).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects failed or malformed completion streams without echoing request content", async () => {
    const privateSentinel = "TEST_PRIVATE_SENTINEL_72d6";
    const prepared = request({ body: JSON.stringify({
      model: OPENAI_MODEL, instructions: "Analyze selected evidence.", input: [{ role: "user", content: privateSentinel }],
      store: false, stream: true, text: { format: { type: "json_schema", name: "x", strict: true, schema: { type: "object" } } },
    }) });
    // Recompute valid serialized bytes and digest for this protocol-only case.
    const validPrepared = { ...prepared, requestBytes: Buffer.byteLength(prepared.body), payloadSha256: hash(prepared.body) };
    const failurePayloads = [
      stream(event("response.incomplete", { ...completed(), status: "incomplete" })),
      stream("event: response.completed\ndata: {broken}\n\n"),
      new Response("{}", { headers: { "content-type": "application/json" } }),
    ];
    for (const response of failurePayloads) {
      const { api } = harness(response);
      try {
        await api.requestStructured(validPrepared, 260_000);
        throw new Error("expected request to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ChatGPTPlanResponsesError);
        expect((error as Error).message).not.toContain(privateSentinel);
      }
    }
  });
});
