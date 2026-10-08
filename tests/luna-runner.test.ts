import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_MODEL, OPENAI_PROFILE_SHA256, OPENAI_PROMPT_SHA256, OPENAI_PROMPT_VERSION,
  OPENAI_SCHEMA_SHA256, OPENAI_SCHEMA_VERSION, OPENAI_SERVICE_TIER, prepareOpenAIRequest,
} from "../server/openai-classifier.js";
import type { LunaClassifierContract, LunaLabelSetV2 } from "../scripts/luna-label-evaluation.js";
import { runLunaLabelEvaluation } from "../scripts/run-luna-label-evaluation.js";

// These constructed cases and fake provider responses test only runner control
// flow. They are not real-source, frozen-label, API, or model-quality evidence.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function setup(maxCost = 1) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "luna-runner-test-")); dirs.push(dir);
  const evidenceDir = path.join(dir, ".engineering-evidence", "luna-real-source"); mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const labelsPath = path.join(dir, "labels.json"); const outputPath = path.join(evidenceDir, "run.json");
  const input = { company: { name: "Example Corp", ticker: "EXM", sector: "Technology" }, source: { collector: "sec_edgar", publisher: "SEC EDGAR", title: "Example filed an update", excerpt: "The filing reports the new product launch." } };
  const prepared = prepareOpenAIRequest(input);
  const frozen = {
    requestBinding: { requestedModel: OPENAI_MODEL, requestedServiceTier: "default", payloadSha256: prepared.payloadSha256, requestBytes: prepared.requestBytes, promptSha256: OPENAI_PROMPT_SHA256, schemaSha256: OPENAI_SCHEMA_SHA256, profileSha256: OPENAI_PROFILE_SHA256 },
    input,
  };
  const labels = {
    stage: "final", studyId: "test-study", sampleManifestSha256: digest("manifest"), evaluationProfile: "sec_edgar_luna_product24_diagnostic_v1",
    profileSha256: OPENAI_PROFILE_SHA256, analysisCodeRevision: "a".repeat(40), requestedModel: OPENAI_MODEL,
    requestedServiceTier: OPENAI_SERVICE_TIER, promptVersion: OPENAI_PROMPT_VERSION, schemaVersionName: OPENAI_SCHEMA_VERSION,
    evaluationBudget: { maxRequests: 1, maxEstimatedCostUsd: maxCost, inputPerMillionUsd: 0.1, cachedInputPerMillionUsd: 0.01, cacheWritePerMillionUsd: 0.125, outputPerMillionUsd: 0.5, openAIAccountReadback: { availableBudgetUsd: maxCost } },
    items: [{ observationId: "case-1", collector: "sec_edgar", ...frozen }],
  } as unknown as LunaLabelSetV2;
  writeFileSync(labelsPath, JSON.stringify({ testOnly: true }));
  const parseLabels = (() => labels) as (value: unknown, contract: LunaClassifierContract) => LunaLabelSetV2;
  const env = {
    EXTERNAL_REQUESTS_ENABLED: "true",
    OPENAI_ACCOUNT_USE_APPROVED: "true",
    OPENAI_ALLOWED_COLLECTORS: "sec_edgar",
    EXTERNAL_SOURCE_COLLECTORS: "sec_edgar",
    SOURCE_RIGHTS_APPROVED_COLLECTORS: "sec_edgar",
    OPENAI_MAX_REQUESTS_PER_DAY: "10",
    OPENAI_MAX_REQUEST_BYTES_PER_DAY: "400000",
    OPENAI_MAX_DAILY_COST_USD: "100",
  };
  const reserveBudget = vi.fn(() => ({ reserved: true as const }));
  const options = { labelsPath, outputPath, apiKey: "test-key", env, reserveBudget, fetchImpl: undefined, parseLabels, assertFrozenCode: () => undefined, cwd: dir };
  return { ...options, labels, outputPath, labelsPath };
}

function fakeResponse(body: unknown, status = 200): Response {
  const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return new Response(bytes, { status, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) } });
}

function providerResponse() {
  const classification = { sentiment: "positive", event_type: "product", takeaway: "product_win", about: true, material: false, investor_relevant: true, evidence_sufficient: true, summary: "The filing reports a product launch.", supporting_excerpt: "new product launch" };
  return { id: "resp-test", model: OPENAI_MODEL, service_tier: "default", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(classification) }] }], usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}

describe("bounded real Luna evaluation runner", () => {
  it("writes one completed sequential fake-fetch run with exact bounded response bytes", async () => {
    const fixture = setup(); const fetch = vi.fn(async () => fakeResponse(providerResponse()));
    const run = await runLunaLabelEvaluation({ ...fixture, fetchImpl: fetch as unknown as typeof globalThis.fetch, now: () => new Date("2026-10-08T12:00:00Z") });
    const saved = JSON.parse(readFileSync(fixture.outputPath, "utf8"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(run.requestCount).toBe(1);
    expect(saved.items[0].attempts[0].responsePayload).toBe(Buffer.from(JSON.stringify(providerResponse())).toString("utf8"));
    expect(saved.items[0].attempts[0].responseSha256).toBe(digest(saved.items[0].attempts[0].responsePayload));
    expect(saved.items[0].attempts[0].classification.disposition).toBe("review_required");
    expect(statSync(fixture.outputPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(saved)).not.toContain("test-key");
  });

  it("fails before a request when the API key is missing", async () => {
    const fixture = setup(); const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, apiKey: "", fetchImpl: fetch as unknown as typeof globalThis.fetch })).rejects.toThrow("no request was sent");
    expect(fixture.reserveBudget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["external requests are disabled", { EXTERNAL_REQUESTS_ENABLED: "false" }, "EXTERNAL_REQUESTS_ENABLED"],
    ["the account owner has not approved use", { OPENAI_ACCOUNT_USE_APPROVED: "false" }, "OPENAI_ACCOUNT_USE_APPROVED"],
    ["the model collector is not allowlisted", { OPENAI_ALLOWED_COLLECTORS: "" }, "intersection"],
    ["source rights are not attested", { SOURCE_RIGHTS_APPROVED_COLLECTORS: "" }, "intersection"],
    ["the daily request cap is zero", { OPENAI_MAX_REQUESTS_PER_DAY: "0" }, "positive finite OpenAI daily"],
  ] as const)("does not reserve or send when %s", async (_name, envPatch, expectedError) => {
    const fixture = setup(); const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({
      ...fixture, env: { ...fixture.env, ...envPatch }, fetchImpl: fetch as unknown as typeof globalThis.fetch,
    })).rejects.toThrow(expectedError);
    expect(fixture.reserveBudget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies frozen code before creating an artifact or reserving account budget", async () => {
    const fixture = setup(); const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({
      ...fixture, assertFrozenCode: () => { throw new Error("dirty frozen code"); }, fetchImpl: fetch as unknown as typeof globalThis.fetch,
    })).rejects.toThrow("dirty frozen code");
    expect(fixture.reserveBudget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains an accurate not-attempted artifact when the shared daily budget is exhausted", async () => {
    const fixture = setup(); const fetch = vi.fn();
    fixture.reserveBudget.mockReturnValue({ reserved: false, reason: "exhausted" } as never);
    await expect(runLunaLabelEvaluation({ ...fixture, fetchImpl: fetch as unknown as typeof globalThis.fetch })).rejects.toThrow("exhausted");
    const saved = JSON.parse(readFileSync(fixture.outputPath, "utf8"));
    expect(fixture.reserveBudget).toHaveBeenCalledWith(expect.objectContaining({ requests: 1, maxRequests: 10 }));
    expect(saved.requestCount).toBe(0);
    expect(saved.items[0].terminalStatus).toBe("not_attempted");
    expect(saved.items[0].attempts).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails before a request when labels are still pilot", async () => {
    const fixture = setup(); fixture.labels.stage = "pilot" as never; const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, fetchImpl: fetch as unknown as typeof globalThis.fetch })).rejects.toThrow("stage=final");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails before a request when conservative spend exceeds the frozen ceiling", async () => {
    const fixture = setup(0.00000001); const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, fetchImpl: fetch as unknown as typeof globalThis.fetch })).rejects.toThrow("no request was sent");
    expect(fixture.reserveBudget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies an existing artifact before a request", async () => {
    const fixture = setup(); writeFileSync(fixture.outputPath, "preserve"); const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, fetchImpl: fetch as unknown as typeof globalThis.fetch })).rejects.toThrow("already exists");
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("preserve");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to write raw provider responses outside the private evaluation directory", async () => {
    const fixture = setup(); const fetch = vi.fn();
    await expect(runLunaLabelEvaluation({ ...fixture, outputPath: path.join(path.dirname(fixture.labelsPath), "outside-run.json"), fetchImpl: fetch as unknown as typeof globalThis.fetch }))
      .rejects.toThrow("private luna-real-source evidence directory");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records malformed provider response as unknown and makes no retry", async () => {
    const fixture = setup(); const fetch = vi.fn(async () => fakeResponse("not-json"));
    const run = await runLunaLabelEvaluation({ ...fixture, fetchImpl: fetch as unknown as typeof globalThis.fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(run.items[0]?.terminalStatus).toBe("unknown");
    expect(run.items[0]?.attempts[0]?.responsePayload).toBe("not-json");
    expect(run.items[0]?.attempts[0]?.responseSha256).toBe(digest("not-json"));
  });
});
