import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_MODEL, OPENAI_PROFILE_SHA256, OPENAI_PROMPT_SHA256, OPENAI_PROMPT_VERSION, OPENAI_SCHEMA_SHA256, OPENAI_SCHEMA_VERSION, OPENAI_SERVICE_TIER, prepareOpenAIRequest } from "../server/openai-classifier.js";
import { ChatGPTPlanResponsesError, type PlanResponsesEnvelope } from "../server/chatgpt-plan-responses.js";
import type { LunaClassifierContract, LunaLabelSetV2 } from "../scripts/luna-label-evaluation.js";
import { runLunaLabelEvaluation } from "../scripts/run-luna-label-evaluation.js";

// These temporary fixtures test runner mechanics only. They are not real-source, frozen-label, or model-quality evidence.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "luna-runner-test-")); dirs.push(dir);
  const evidenceDir = path.join(dir, ".engineering-evidence", "luna-real-source"); mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const labelsPath = path.join(dir, "labels.json"); const outputPath = path.join(evidenceDir, "run.json");
  const input = { company: { name: "Example Public Corp", ticker: "EXM", sector: "Technology" }, source: { collector: "sec_edgar", publisher: "SEC EDGAR", title: "Example filed an update", excerpt: "The filing reports the new product launch." } };
  const prepared = prepareOpenAIRequest(input);
  const labels = {
    stage: "final", studyId: "test-study", sampleManifestSha256: digest("manifest"), evaluationProfile: "sec_edgar_luna_product24_diagnostic_v1",
    profileSha256: OPENAI_PROFILE_SHA256, analysisCodeRevision: "a".repeat(40), requestedModel: OPENAI_MODEL,
    requestedServiceTier: OPENAI_SERVICE_TIER, promptVersion: OPENAI_PROMPT_VERSION, schemaVersionName: OPENAI_SCHEMA_VERSION,
    evaluationBudget: { maxRequests: 1, maxRequestBytes: 16_384, accountOwnerApproval: { attested: true, approvedAt: "2026-10-01T00:00:00Z", approvalRecordSha256: digest("approval") } },
    items: [{ observationId: "case-1", collector: "sec_edgar", requestBinding: { requestedModel: OPENAI_MODEL, requestedServiceTier: "default", payloadSha256: prepared.payloadSha256, requestBytes: prepared.requestBytes, promptSha256: OPENAI_PROMPT_SHA256, schemaSha256: OPENAI_SCHEMA_SHA256, profileSha256: OPENAI_PROFILE_SHA256 }, input }],
  } as unknown as LunaLabelSetV2;
  writeFileSync(labelsPath, JSON.stringify({ testOnly: true }));
  const parseLabels = (() => labels) as (value: unknown, contract: LunaClassifierContract) => LunaLabelSetV2;
  const env = { EXTERNAL_REQUESTS_ENABLED: "true", OPENAI_ACCOUNT_USE_APPROVED: "true", OPENAI_ALLOWED_COLLECTORS: "sec_edgar", EXTERNAL_SOURCE_COLLECTORS: "sec_edgar", SOURCE_RIGHTS_APPROVED_COLLECTORS: "sec_edgar", CHATGPT_PLAN_MAX_REQUESTS_PER_DAY: "10", CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY: "400000", OPENAI_API_KEY: "must-not-be-read" };
  const reserveRequest = vi.fn(() => ({ reserved: true as const, id: "reservation-1" }));
  const markDispatched = vi.fn(() => true);
  const finishRequest = vi.fn(() => true);
  const options = { labelsPath, outputPath, env, reserveRequest, markDispatched, finishRequest, parseLabels, assertFrozenCode: () => undefined, now: () => new Date("2026-10-08T12:00:00Z"), cwd: dir };
  return { ...options, labels, outputPath, labelsPath };
}

function planEnvelope(): PlanResponsesEnvelope {
  const classification = { sentiment: "positive", event_type: "product", takeaway: "product_win", about: true, material: false, investor_relevant: true, evidence_sufficient: true, summary: "The filing reports a product launch.", supporting_excerpt: "new product launch" };
  const response = { id: "resp-test", model: OPENAI_MODEL, service_tier: "default", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(classification) }] }], usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const responsePayload = JSON.stringify(response);
  return { provider: "chatgpt_plan", profileVersion: "chatgpt-plan-responses/1", profileSha256: digest("profile"), responseId: "resp-test", modelRequested: OPENAI_MODEL, modelReturned: OPENAI_MODEL, serviceTier: "default", estimatedCostUsd: null, usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 }, responseSha256: digest(responsePayload), responsePayload, response, httpStatus: 200, latencyMs: 10 };
}

describe("bounded real Luna evaluation runner on ChatGPT plan", () => {
  it("writes one completed run with exact hash-bound plan response bytes and unknown subscription cost", async () => {
    const fixture = setup(); const classifyPrepared = vi.fn(async (_request, _signal, beforeDispatch) => { expect(beforeDispatch?.()).toBe(true); return planEnvelope(); });
    const run = await runLunaLabelEvaluation({ ...fixture, responses: { classifyPrepared } });
    const saved = JSON.parse(readFileSync(fixture.outputPath, "utf8"));
    expect(classifyPrepared).toHaveBeenCalledTimes(1);
    expect(fixture.reserveRequest).toHaveBeenCalledWith(expect.objectContaining({ utcDay: "2026-10-08", maxRequests: 1 }));
    expect(fixture.finishRequest).toHaveBeenCalledWith("reservation-1", "completed");
    expect(run.requestCount).toBe(1);
    expect(saved.estimatedCostUsd).toBeNull();
    expect(saved.providerAllowance).toBeNull();
    expect(saved.items[0].attempts[0].responsePayload).toBe(planEnvelope().responsePayload);
    expect(saved.items[0].attempts[0].responseSha256).toBe(digest(saved.items[0].attempts[0].responsePayload));
    expect(saved.items[0].attempts[0].classification.disposition).toBe("review_required");
    expect(statSync(fixture.outputPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(saved)).not.toContain("must-not-be-read");
  });

  it("does not reserve or call the plan when external requests, source rights, or local caps deny", async () => {
    const cases = [
      [{ EXTERNAL_REQUESTS_ENABLED: "false" }, "EXTERNAL_REQUESTS_ENABLED"],
      [{ OPENAI_ACCOUNT_USE_APPROVED: "false" }, "OPENAI_ACCOUNT_USE_APPROVED"],
      [{ OPENAI_ALLOWED_COLLECTORS: "" }, "intersection"],
      [{ SOURCE_RIGHTS_APPROVED_COLLECTORS: "" }, "intersection"],
      [{ CHATGPT_PLAN_MAX_REQUESTS_PER_DAY: "0" }, "positive finite"],
      [{ CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY: "0" }, "positive finite"],
    ] as const;
    for (const [patch, message] of cases) {
      const fixture = setup(); const classifyPrepared = vi.fn();
      await expect(runLunaLabelEvaluation({ ...fixture, env: { ...fixture.env, ...patch }, responses: { classifyPrepared } })).rejects.toThrow(message);
      expect(fixture.reserveRequest).not.toHaveBeenCalled(); expect(classifyPrepared).not.toHaveBeenCalled();
    }
  });

  it("does not reserve when a prepared real-source request exceeds the frozen byte ceiling", async () => {
    const fixture = setup(); fixture.labels.evaluationBudget!.maxRequestBytes = 1;
    const classifyPrepared = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, responses: { classifyPrepared } })).rejects.toThrow("byte ceiling");
    expect(fixture.reserveRequest).not.toHaveBeenCalled(); expect(classifyPrepared).not.toHaveBeenCalled();
  });

  it("fails closed when plan authorization is missing and never reads an API key", async () => {
    const fixture = setup(); const classifyPrepared = vi.fn(async () => { throw new ChatGPTPlanResponsesError("Connect the authorized ChatGPT account before classifying.", false, false); });
    const run = await runLunaLabelEvaluation({ ...fixture, responses: { classifyPrepared } });
    expect(classifyPrepared).toHaveBeenCalledTimes(1);
    expect(fixture.reserveRequest).not.toHaveBeenCalled();
    expect(run.items[0]?.terminalStatus).toBe("not_sent");
    expect(run.items[0]?.attempts[0]?.submitted).toBe(false);
  });

  it("respects a shared reservation refusal without submitting and records not_sent", async () => {
    const fixture = setup(); fixture.reserveRequest.mockReturnValue({ reserved: false, reason: "exhausted" } as never);
    const classifyPrepared = vi.fn(async (_request, _signal, beforeDispatch) => { expect(beforeDispatch?.()).toBe(false); throw new ChatGPTPlanResponsesError("Structured request was stopped before dispatch.", false, false); });
    const run = await runLunaLabelEvaluation({ ...fixture, responses: { classifyPrepared } });
    expect(fixture.finishRequest).not.toHaveBeenCalled(); expect(fixture.markDispatched).not.toHaveBeenCalled();
    expect(run.items[0]?.terminalStatus).toBe("not_sent"); expect(run.requestCount).toBe(0);
  });

  it("preserves unknown dispatched outcomes and does not retry", async () => {
    const fixture = setup(); const classifyPrepared = vi.fn(async (_request, _signal, beforeDispatch) => { beforeDispatch?.(); throw new ChatGPTPlanResponsesError("ChatGPT request failed before a confirmed response; outcome may be unknown.", false, true, null, true); });
    const run = await runLunaLabelEvaluation({ ...fixture, responses: { classifyPrepared } });
    expect(classifyPrepared).toHaveBeenCalledTimes(1);
    expect(fixture.finishRequest).toHaveBeenCalledWith("reservation-1", "unknown");
    expect(run.requestCount).toBe(1); expect(run.items[0]?.terminalStatus).toBe("unknown");
  });

  it("refuses an existing artifact and preserves frozen-code verification", async () => {
    const fixture = setup(); writeFileSync(fixture.outputPath, "preserve"); const classifyPrepared = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, responses: { classifyPrepared } })).rejects.toThrow("already exists");
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("preserve"); expect(classifyPrepared).not.toHaveBeenCalled();
  });
});
