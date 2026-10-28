import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { prepareOpenAIRequest, OPENAI_MODEL } from "../server/openai-classifier.js";
import {
  ChatGPTPlanResponses,
  ChatGPTPlanResponsesError,
  prepareChatGPTPlanRequest,
} from "../server/chatgpt-plan-responses.js";

const canonical = () => prepareOpenAIRequest({
  company: { name: "Acme Public Co", ticker: "ACME", sector: "Technology" },
  source: { collector: "google_news", publisher: "Acme News", title: "Acme launches product", excerpt: "The company launched a new product today." },
});
const completed = (overrides: Record<string, unknown> = {}) => ({
  id: "resp_plan_123", status: "completed", model: OPENAI_MODEL,
  output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
  usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
  ...overrides,
});
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(type.startsWith("response.") ? { response: data } : data as object) })}\n\n`;
const sse = (...frames: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const value of frames) controller.enqueue(new TextEncoder().encode(value)); controller.close(); },
}), { headers: { "content-type": "text/event-stream" } });
const model = (slug: string, visibility = "list") => ({ slug, visibility, display_name: slug });
const catalog = () => Response.json({ models: [model(OPENAI_MODEL), model("gpt-6-other")] });
function client(postResponse: Response | (() => Response), options: { accountId?: string | null; catalogResponse?: Response; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/models")) return options.catalogResponse ?? catalog();
    return typeof postResponse === "function" ? postResponse() : postResponse;
  }) as typeof fetch;
  return {
    fetchImpl,
    api: new ChatGPTPlanResponses({
      tokenProvider: { getAccessToken: async () => "opaque-test-token", getAccountId: async () => options.accountId ?? "acct-1" },
      fetchImpl,
    }),
  };
}

describe("ChatGPT plan Responses transport", () => {
  it("recognizes the documented OpenAI model-list response shape", async () => {
    const standardCatalog = Response.json({
      object: "list",
      data: [{ id: OPENAI_MODEL, object: "model", created: 1_790_000_000, owned_by: "openai" }],
    });
    const { api } = client(sse(frame("response.completed", completed())), { catalogResponse: standardCatalog });

    await expect(api.checkModelAccess()).resolves.toEqual({ modelAvailable: true });
  });

  it("accepts a full account catalog larger than the old 64 KiB cap", async () => {
    const expandedCatalog = Response.json({
      models: [{ ...model(OPENAI_MODEL), display_name: "Luna " + "x".repeat(70_000) }],
    });
    const { api } = client(sse(frame("response.completed", completed())), { catalogResponse: expandedCatalog });

    await expect(api.checkModelAccess()).resolves.toEqual({ modelAvailable: true });
  });

  it("preserves a safe provider code when a dispatched response is JSON instead of SSE", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return catalog();
      return Response.json({ error: { code: "subscription_sharing_unsupported_capability" } });
    }) as typeof fetch;
    const api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl });

    await expect(api.classifyPrepared(canonical())).rejects.toMatchObject({
      status: 200,
      providerCode: "subscription_sharing_unsupported_capability",
      failureKind: "unsupported_capability",
      outcomeUnknown: false,
      requestDispatched: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retains unknown outcome when a successful non-streaming response has no error envelope", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return catalog();
      return Response.json({ status: "completed", output: [] });
    }) as typeof fetch;
    const api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl });

    await expect(api.classifyPrepared(canonical())).rejects.toMatchObject({
      message: expect.stringMatching(/streaming Responses result/i),
      status: 200,
      outcomeUnknown: true,
      requestDispatched: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("transforms the canonical request into the plan contract and binds a distinct profile", () => {
    const source = canonical();
    const plan = prepareChatGPTPlanRequest(source);
    const body = JSON.parse(plan.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: OPENAI_MODEL, store: false, stream: true });
    expect(body.instructions).toBe(JSON.parse(source.body).input[0].content);
    expect(body.input).toEqual([{ role: "user", content: JSON.parse(source.body).input[1].content }]);
    expect(body).not.toHaveProperty("service_tier");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("tools");
    expect(plan.profileSha256).not.toBe(source.profileSha256);
  });

  it("accepts fragmented SSE and returns only a validated completed envelope with honest plan accounting", async () => {
    const message = frame("response.completed", completed({ service_tier: "priority" }));
    const bytes = new TextEncoder().encode(message);
    const fragmented = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4)); controller.enqueue(bytes.slice(4, 37));
        controller.enqueue(bytes.slice(37)); controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const { api } = client(fragmented);
    const result = await api.classifyPrepared(canonical());
    expect(result).toMatchObject({ provider: "chatgpt_plan", responseId: "resp_plan_123", modelReturned: OPENAI_MODEL,
      serviceTier: "priority", estimatedCostUsd: null, usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 } });
    expect(result.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.responseSha256).toBe(createHash("sha256").update(result.responsePayload).digest("hex"));
    expect(JSON.parse(result.responsePayload)).toMatchObject({ type: "response.completed", response: result.response });
    expect(result.response).toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("runs the local reservation hook after model verification and before exactly one POST", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) { order.push("models"); return catalog(); }
      order.push("post"); return sse(frame("response.completed", completed()));
    }) as typeof fetch;
    const { api } = client(sse(frame("response.completed", completed())), { fetchImpl });
    const hook = vi.fn(() => { order.push("reserve"); return true; });
    await api.classifyPrepared(canonical(), undefined, hook);
    expect(order).toEqual(["models", "reserve", "post"]);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("keeps a denied local reservation before the Responses POST", async () => {
    let modelCount = 0; let postCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) { modelCount += 1; return catalog(); }
      postCount += 1; return sse(frame("response.completed", completed()));
    }) as typeof fetch;
    const { api } = client(sse(frame("response.completed", completed())), { fetchImpl });
    const hook = vi.fn(() => false);
    await expect(api.classifyPrepared(canonical(), undefined, hook)).rejects.toMatchObject({ requestDispatched: false, outcomeUnknown: false });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(modelCount).toBe(1);
    expect(postCount).toBe(0);
  });

  it.each([
    ["no terminal event", sse("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n")],
    ["failed after delta", sse("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n", frame("response.failed", { status: "failed" }))],
    ["malformed JSON", sse("event: response.completed\ndata: {bad json}\n\n")],
    ["truncated terminal frame", sse(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed() })}`)],
    ["incomplete terminal", sse(frame("response.incomplete", { ...completed(), status: "incomplete" }))],
    ["duplicate terminal", sse(frame("response.completed", completed()), frame("response.completed", completed()))],
  ])("rejects %s without yielding a result", async (_label, response) => {
    const { api } = client(response as Response);
    await expect(api.classifyPrepared(canonical())).rejects.toMatchObject({ requestDispatched: true });
  });

  it("treats a transport failure after beginning the POST as an unknown dispatched outcome", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return catalog();
      throw new Error("socket closed before fetch returned");
    }) as typeof fetch;
    const { api } = client(sse(frame("response.completed", completed())), { fetchImpl });

    await expect(api.classifyPrepared(canonical())).rejects.toMatchObject({
      requestDispatched: true,
      outcomeUnknown: true,
    });
  });

  it("rejects mismatched model, missing usage, invalid token totals, and incomplete response fields", async () => {
    const bad = [
      completed({ model: "gpt-6-other" }),
      completed({ usage: undefined }),
      completed({ usage: { input_tokens: 3, output_tokens: 4, total_tokens: 9 } }),
      completed({ output: undefined }),
    ];
    for (const payload of bad) {
      const { api } = client(sse(frame("response.completed", payload)));
      await expect(api.classifyPrepared(canonical())).rejects.toBeInstanceOf(ChatGPTPlanResponsesError);
    }
  });

  it("rejects oversized streams and aborts a stalled stream within the configured timeout", async () => {
    const tooLarge = sse(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(300) })}\n\n`);
    const oversized = client(tooLarge);
    oversized.api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl: oversized.fetchImpl, maxStreamBytes: 80 });
    await expect(oversized.api.classifyPrepared(canonical())).rejects.toThrow(/size/i);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return catalog();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const timed = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl, timeoutMs: 20 });
    await expect(timed.classifyPrepared(canonical())).rejects.toThrow(/completed|timed out|interrupted/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors caller cancellation while a response stream is still open", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return catalog();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl });
    const cancellation = new AbortController();
    const operation = api.classifyPrepared(canonical(), cancellation.signal);
    setTimeout(() => cancellation.abort(), 10);
    await expect(operation).rejects.toBeInstanceOf(ChatGPTPlanResponsesError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches model lists per account, rejects unavailable models, and never retries or redirects", async () => {
    let now = 100;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(input).endsWith("/models")) return Response.json({ models: [model(OPENAI_MODEL)] });
      return sse(frame("response.completed", completed()));
    }) as typeof fetch;
    const api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct-A" }, fetchImpl, now: () => now });
    await api.classifyPrepared(canonical());
    await api.classifyPrepared(canonical());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    now += 5 * 60_000 + 1;
    await api.classifyPrepared(canonical());
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    let accountId = "acct-shared-A";
    const perAccountFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return Response.json({ models: [model(accountId.endsWith("A") ? OPENAI_MODEL : "gpt-6-other")] });
      return sse(frame("response.completed", completed()));
    }) as typeof fetch;
    const perAccount = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => accountId }, fetchImpl: perAccountFetch });
    await perAccount.classifyPrepared(canonical());
    accountId = "acct-shared-B";
    await expect(perAccount.classifyPrepared(canonical())).rejects.toThrow(/not available/i);
    expect(perAccountFetch).toHaveBeenCalledTimes(3);

    const unavailable = client(sse(frame("response.completed", completed())), { accountId: "acct-B", catalogResponse: Response.json({ models: [model("gpt-6-other")] }) });
    await expect(unavailable.api.classifyPrepared(canonical())).rejects.toThrow(/not available/i);
    expect(unavailable.fetchImpl).toHaveBeenCalledTimes(1);

    const rejectedFetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;
    const noRetry = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl: rejectedFetch });
    await expect(noRetry.classifyPrepared(canonical())).rejects.toBeInstanceOf(ChatGPTPlanResponsesError);
    expect(rejectedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects missing account tokens and invalid catalog responses before inference", async () => {
    const noToken = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => null, getAccountId: async () => "acct" }, fetchImpl: vi.fn() as typeof fetch });
    await expect(noToken.classifyPrepared(canonical())).rejects.toThrow(/connect/i);
    const badCatalog = client(sse(frame("response.completed", completed())), { catalogResponse: Response.json({ models: "not-a-list" }) });
    await expect(badCatalog.api.classifyPrepared(canonical())).rejects.toMatchObject({ message: expect.stringMatching(/catalog/i), requestDispatched: false });
    expect(badCatalog.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("checks exact account model availability without creating a classification response", async () => {
    const fetchImpl = vi.fn(async () => catalog()) as typeof fetch;
    const api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl });
    await expect(api.checkModelAccess()).resolves.toEqual({ modelAvailable: true });
    await expect(api.checkModelAccess()).resolves.toEqual({ modelAvailable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({ method: "GET" }));
  });

  it("uses the official ChatGPT-plan model shape and ignores non-listable Luna slugs", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ models: [model(OPENAI_MODEL, "hidden")] })) as typeof fetch;
    const api = new ChatGPTPlanResponses({ tokenProvider: { getAccessToken: async () => "token", getAccountId: async () => "acct" }, fetchImpl });
    await expect(api.checkModelAccess()).resolves.toEqual({ modelAvailable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
