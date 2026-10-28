import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  privateEvidenceAnalysisRecordSchema,
  type PrivateEvidenceItem,
} from "../shared/private-evidence.js";
import { ChatGPTPlanResponses } from "../server/chatgpt-plan-responses.js";
import {
  ChatGPTPlanPrivateEvidenceAnalyzer,
  prepareChatGPTPlanPrivateEvidenceRequest,
} from "../server/chatgpt-plan-private-evidence.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const content = "The public company reported that orders grew 18% year over year.";
const evidence: PrivateEvidenceItem = {
  id: "59e4a687-4a76-4c2f-8d4a-42c75bde108c", companyId: "public-co", title: "Quarterly channel note",
  sourceLabel: "Analyst interview notes", fileName: "private-notes.txt", asOfDate: "2026-09-30", importedAt: 1_791_000_000_000,
  content, sha256: sha256(content), byteLength: Buffer.byteLength(content),
};
const company = { id: "public-co", name: "Public Company, Inc.", ticker: "PUB", sector: "Industrials" };
const analysis = {
  sentiment: "positive", summary: "The note reports year-over-year order growth.",
  evidence: [{ quote: "orders grew 18% year over year", explanation: "It reports a specific operating trend." }],
  uncertainties: ["The note does not describe the sample or calculation method."],
  nextQuestion: "Does the reported growth appear in the next public filing?",
};

function responseObject(output: unknown = analysis, usage = { input_tokens: 120, output_tokens: 60, total_tokens: 180 }) {
  return {
    id: "resp_plan_private_test", model: "gpt-6-luna", status: "completed", service_tier: undefined,
    usage,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  };
}

function fixtureFetch(output?: unknown, options: { throwWithContent?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ models: [{ slug: "gpt-6-luna", visibility: "list", display_name: "GPT-6 Luna" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    if (options.throwWithContent && url.endsWith("/responses")) throw new Error(content);
    const receipt = responseObject(output);
    const data = JSON.stringify({ type: "response.completed", response: receipt });
    return new Response(`event: response.completed\ndata: ${data}\n\n`, {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function analyzer(fetchImpl: typeof fetch) {
  const transport = new ChatGPTPlanResponses({
    tokenProvider: { getAccessToken: async () => "fixture-token", getAccountId: async () => "fixture-account" },
    fetchImpl,
  });
  return new ChatGPTPlanPrivateEvidenceAnalyzer(transport);
}

describe("explicit selected private note analysis through the ChatGPT plan", () => {
  it("prepares the exact bounded UTF-8 request and persists only observable plan provenance", async () => {
    const prepared = prepareChatGPTPlanPrivateEvidenceRequest({ company, evidence });
    expect(prepared.request.requestBytes).toBe(Buffer.byteLength(prepared.request.body, "utf8"));
    expect(prepared.request.payloadSha256).toBe(sha256(Buffer.from(prepared.request.body, "utf8")));
    expect(prepared.request.requestedModel).toBe("gpt-6-luna");
    expect(prepared.entitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(prepared.request)).toBe(true);
    const body = JSON.parse(prepared.request.body);
    expect(body).toMatchObject({ model: "gpt-6-luna", store: false, stream: true });
    expect(body).not.toHaveProperty("service_tier");
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(body).not.toHaveProperty("max_output_tokens");
    const sentPayload = JSON.parse(body.input[0].content);
    expect(sentPayload.evidence).toMatchObject({ id: evidence.id, content, sha256: evidence.sha256 });
    expect(prepared.request.body).not.toContain(evidence.fileName);

    const fixture = fixtureFetch();
    const result = await analyzer(fixture.fetchImpl).analyzePrepared(prepared);
    expect(fixture.calls.map((call) => call.url)).toEqual([
      "https://api.openai.com/v1/models", "https://api.openai.com/v1/responses",
    ]);
    expect(fixture.calls[1]?.init?.body).toBe(prepared.request.body);
    expect(privateEvidenceAnalysisRecordSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      accountingRoute: "chatgpt_plan", companyId: company.id, evidenceId: evidence.id,
      evidenceSha256: evidence.sha256, payloadSha256: prepared.request.payloadSha256,
      requestBytes: prepared.request.requestBytes, modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna",
      serviceTierRequested: null, serviceTier: null, entitySha256: prepared.entitySha256, sourceSha256: prepared.sourceSha256,
      responseId: "resp_plan_private_test", responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180, estimatedCostUsd: null,
        cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null },
      dataControls: { responseObjectStorageRequested: false, retention: "unknown", trainingUse: "unknown", remainingPlanAllowance: null },
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("body");
  });

  it("rejects a modified prepared body before any request and does not leak note contents", async () => {
    const prepared = prepareChatGPTPlanPrivateEvidenceRequest({ company, evidence });
    const fixture = fixtureFetch();
    const bad = { ...prepared, request: { ...prepared.request, body: prepared.request.body.replace(content, "tampered") } };
    await expect(analyzer(fixture.fetchImpl).analyzePrepared(bad)).rejects.toMatchObject({ category: "invalid_request" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects invented exact quotes and strips provider error detail that could echo private note text", async () => {
    const madeUp = { ...analysis, evidence: [{ quote: "orders grew 99% year over year", explanation: "unsupported" }] };
    await expect(analyzer(fixtureFetch(madeUp).fetchImpl).analyze({ company, evidence }))
      .rejects.toMatchObject({ category: "ungrounded_output" });
    const leaking = fixtureFetch(undefined, { throwWithContent: true });
    await expect(analyzer(leaking.fetchImpl).analyze({ company, evidence })).rejects.toThrow("did not produce a confirmed result");
    try { await analyzer(leaking.fetchImpl).analyze({ company, evidence }); } catch (error) {
      expect(String(error)).not.toContain(content);
    }
  });

  it("rejects issuer mismatch and preserves the legacy API-key record shape", async () => {
    expect(() => prepareChatGPTPlanPrivateEvidenceRequest({ company, evidence: { ...evidence, companyId: "other" } }))
      .toThrow("Selected private note failed local validation");
    const legacy = {
      companyId: "public-co", evidenceId: evidence.id, evidenceSha256: evidence.sha256, payloadSha256: "a".repeat(64), requestBytes: 900,
      modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna", serviceTierRequested: "default", serviceTier: "default",
      promptVersion: "legacy", promptSha256: "b".repeat(64), schemaVersion: "legacy", schemaSha256: "c".repeat(64),
      profileVersion: "legacy", profileSha256: "d".repeat(64), responseId: "resp_legacy", responseSha256: "e".repeat(64),
      usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15, estimatedCostUsd: 0.0001 },
      analysis, latencyMs: 10, httpStatus: 200,
      dataControls: { endpoint: "https://api.openai.com/v1/responses", responseObjectStorage: false, promptCacheMode: "explicit_no_breakpoints",
        promptCacheWritesRequested: false, defaultAbuseMonitoringRetentionDays: 30, organizationRetentionPolicy: "unverified", disclosure: "legacy",
        documentationUrl: "https://developers.openai.com/api/docs/guides/your-data", promptCachingDocumentationUrl: "https://developers.openai.com/api/docs/guides/prompt-caching" },
    };
    expect(privateEvidenceAnalysisRecordSchema.safeParse(legacy).success).toBe(true);
  });
});
