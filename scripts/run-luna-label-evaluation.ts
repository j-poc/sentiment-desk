import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENAI_MODEL, OPENAI_PROFILE_SHA256, OPENAI_PROMPT_SHA256, OPENAI_PROMPT_VERSION,
  OPENAI_SCHEMA_SHA256, OPENAI_SCHEMA_VERSION, OPENAI_SERVICE_TIER,
  prepareOpenAIRequest, validateCategoricalOutput,
  OpenAIClassifierError,
} from "../server/openai-classifier.js";
import { ChatGPTPlanAuth } from "../server/chatgpt-plan-auth.js";
import { ChatGPTPlanCredentialVault } from "../server/chatgpt-plan-credential-vault.js";
import { ChatGPTPlanResponses, ChatGPTPlanResponsesError, type PlanResponsesEnvelope } from "../server/chatgpt-plan-responses.js";
import {
  parseLunaLabelSet, sha256Bytes,
  type LunaClassifierContract, type LunaLabelSetV2, type LunaModelRunV2,
} from "./luna-label-evaluation.js";
import { verifyFrozenLunaCode } from "./evaluate-luna-labels.js";
import { deriveCategoricalDisposition } from "../shared/categorical-disposition.js";
import { boundedNonNegativeInt, parseExplicitBoolean, parseExternalRequestsEnabled, parseExternalSourceCollectors } from "../server/config.js";
import { intersectClassifierSourceAllowlist } from "../server/collector-policy.js";

function classifierContract(): LunaClassifierContract {
  return {
    model: OPENAI_MODEL, serviceTier: OPENAI_SERVICE_TIER,
    profileSha256: OPENAI_PROFILE_SHA256, promptVersion: OPENAI_PROMPT_VERSION,
    schemaVersion: OPENAI_SCHEMA_VERSION, promptSha256: OPENAI_PROMPT_SHA256,
    schemaSha256: OPENAI_SCHEMA_SHA256,
    prepareRequest: (input, model) => prepareOpenAIRequest(input, model),
  };
}

function fileExistsWithoutFollowingLinks(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
}

function failureOutcome(error: unknown): "refused" | "incomplete" | "invalid_output" | "rejected" | "unknown" {
  if (error instanceof OpenAIClassifierError) {
    if (error.outcomeUnknown || error.status === null || error.status >= 500) return "unknown";
    if (error.status === 429 && error.retryable) return "rejected";
    if (/refused/i.test(error.message)) return "refused";
    if (/not completed/i.test(error.message)) return "incomplete";
    if (/classification|structured|supporting excerpt|evidence sufficient/i.test(error.message)) return "invalid_output";
    return "rejected";
  }
  if (error instanceof ChatGPTPlanResponsesError) {
    if (error.outcomeUnknown || error.requestDispatched) return "unknown";
    return "rejected";
  }
  if (error instanceof Error) {
    if (/refused/i.test(error.message)) return "refused";
    if (/not completed/i.test(error.message)) return "incomplete";
    if (/classification|structured|supporting excerpt|evidence sufficient/i.test(error.message)) return "invalid_output";
  }
  return "unknown";
}

function errorReceipt(error: unknown): { status: number | null; responseId: string | null; responseSha256: string | null; model: string | null; serviceTier: string | null; latencyMs: number | null; requestDispatched: boolean } {
  if (error instanceof OpenAIClassifierError) return { status: error.status, responseId: error.responseId, responseSha256: error.responseSha256, model: error.returnedModel, serviceTier: error.serviceTier, latencyMs: error.latencyMs, requestDispatched: error.requestDispatched };
  if (error instanceof ChatGPTPlanResponsesError) return { status: error.status, responseId: null, responseSha256: null, model: null, serviceTier: null, latencyMs: null, requestDispatched: error.requestDispatched };
  return { status: null, responseId: null, responseSha256: null, model: null, serviceTier: null, latencyMs: null, requestDispatched: false };
}

export interface LunaPlanReservationInput { utcDay: string; requestBytes: number; maxRequests: number; maxRequestBytes: number }
export type LunaPlanReservation = { reserved: true; id: string } | { reserved: false; reason: string };

export interface LunaRunOptions {
  labelsPath: string;
  outputPath: string;
  env: Record<string, string | undefined>;
  responses: Pick<ChatGPTPlanResponses, "classifyPrepared">;
  reserveRequest: (input: LunaPlanReservationInput) => LunaPlanReservation;
  markDispatched: (reservationId: string) => boolean;
  finishRequest: (reservationId: string, status: "completed" | "rejected" | "unknown" | "not_sent") => boolean;
  cwd?: string;
  now?: () => Date;
  /** Test seam for strict parsing. */
  parseLabels?: (value: unknown, contract: LunaClassifierContract) => LunaLabelSetV2;
  /** Test seam for frozen source verification. */
  assertFrozenCode?: (labels: LunaLabelSetV2, cwd: string) => void;
}

/** Executes the frozen final cohort once, sequentially, through the ChatGPT-plan subscription route. */
export async function runLunaLabelEvaluation(options: LunaRunOptions): Promise<LunaModelRunV2> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const labelsPath = path.resolve(options.labelsPath);
  const outputPath = path.resolve(options.outputPath);
  const privateEvidenceRoot = path.resolve(cwd, ".engineering-evidence");
  const privateRunDirectory = path.resolve(cwd, ".engineering-evidence/luna-real-source");
  if (path.dirname(outputPath) !== privateRunDirectory) throw new Error("Luna response artifacts must be written directly inside the private luna-real-source evidence directory");
  for (const directory of [privateEvidenceRoot, privateRunDirectory]) {
    const evidenceDirectory = lstatSync(directory);
    if (!evidenceDirectory.isDirectory() || evidenceDirectory.isSymbolicLink()) throw new Error("Luna evidence directories must be real directories, not symlinks");
  }
  if (outputPath === labelsPath) throw new Error("Luna run output must not overwrite the frozen labels");
  if (fileExistsWithoutFollowingLinks(outputPath)) throw new Error("Luna run output already exists; refusing to overwrite");

  const labelBytes = readFileSync(labelsPath);
  const contract = classifierContract();
  const labels = (options.parseLabels ?? parseLunaLabelSet)(JSON.parse(labelBytes.toString("utf8")) as unknown, contract);
  if (labels.stage !== "final") throw new Error("Luna requests are disabled until blinded labels are frozen as stage=final");
  const budget = labels.evaluationBudget;
  if (!budget) throw new Error("final labels lack frozen subscription-use request/byte controls");
  if (labels.items.length > budget.maxRequests) throw new Error("frozen request ceiling does not cover the selected Luna cohort");

  const env = options.env;
  if (!parseExternalRequestsEnabled(env.EXTERNAL_REQUESTS_ENABLED)) throw new Error("EXTERNAL_REQUESTS_ENABLED is not true; no request was sent");
  if (!parseExplicitBoolean(env.OPENAI_ACCOUNT_USE_APPROVED)) throw new Error("OPENAI_ACCOUNT_USE_APPROVED is not true; no request was sent");
  const allowedCollectors = intersectClassifierSourceAllowlist(
    parseExternalSourceCollectors(env.OPENAI_ALLOWED_COLLECTORS),
    parseExternalSourceCollectors(env.EXTERNAL_SOURCE_COLLECTORS),
    parseExternalSourceCollectors(env.SOURCE_RIGHTS_APPROVED_COLLECTORS),
  );
  for (const item of labels.items) {
    const collector = parseExternalSourceCollectors(item.collector).values().next().value;
    if (!collector || !allowedCollectors.has(collector)) throw new Error(`collector ${item.collector} is not in the intersection of OpenAI, external-source, and source-rights allowlists; no request was sent`);
  }
  const maxRequests = Math.min(env.CHATGPT_PLAN_MAX_REQUESTS_PER_DAY === undefined ? 24 : boundedNonNegativeInt(env.CHATGPT_PLAN_MAX_REQUESTS_PER_DAY, 100), budget.maxRequests);
  const maxRequestBytes = Math.min(env.CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY === undefined ? 260_000 : boundedNonNegativeInt(env.CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY, 400_000), budget.maxRequestBytes);
  if (maxRequests <= 0 || maxRequestBytes <= 0) throw new Error("positive finite ChatGPT-plan daily request and byte caps are required; no request was sent");

  const prepared = labels.items.map((item) => {
    const request = prepareOpenAIRequest(item.input, labels.requestedModel);
    if (request.payloadSha256 !== item.requestBinding.payloadSha256 || request.requestBytes !== item.requestBinding.requestBytes) throw new Error(`case ${item.observationId} request no longer matches its frozen binding`);
    if (request.requestBytes > maxRequestBytes) throw new Error(`case ${item.observationId} exceeds the frozen or configured request byte ceiling; no request was sent`);
    return request;
  });

  (options.assertFrozenCode ?? verifyFrozenLunaCode)(labels, cwd);
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const rows: LunaModelRunV2["items"] = labels.items.map((item) => ({ observationId: item.observationId, requestPayloadSha256: item.requestBinding.payloadSha256, terminalStatus: "not_attempted", attempts: [] }));
  let requestCount = 0;
  const run: LunaModelRunV2 = {
    schemaVersion: 2, provider: "chatgpt_plan", studyId: labels.studyId,
    runId: `luna-${startedAt.replaceAll(/[^0-9TZ]/g, "-")}-${randomUUID()}`,
    labelsSha256: sha256Bytes(labelBytes), sampleManifestSha256: labels.sampleManifestSha256,
    evaluationProfile: labels.evaluationProfile, profileSha256: labels.profileSha256,
    analysisCodeRevision: labels.analysisCodeRevision, sourceTreeDirty: false, startedAt, requestCount,
    requestedModel: labels.requestedModel, maxRequests: budget.maxRequests, maxRequestBytes: budget.maxRequestBytes,
    estimatedCostUsd: null, providerAllowance: null,
    items: rows,
  };
  const serializeRun = () => `${JSON.stringify(run, null, 2)}\n`;
  const persist = (exclusive = false) => {
    const content = serializeRun();
    if (exclusive) { writeFileSync(outputPath, content, { flag: "wx", mode: 0o600 }); return; }
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    const fd = openSync(temporaryPath, "wx", 0o600);
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
    catch (error) { closeSync(fd); unlinkSync(temporaryPath); throw error; }
    closeSync(fd);
    try { renameSync(temporaryPath, outputPath); }
    catch (error) { unlinkSync(temporaryPath); throw error; }
  };
  persist(true);

  for (let index = 0; index < labels.items.length; index += 1) {
    const label = labels.items[index]!;
    const row = rows[index]!;
    const request = prepared[index]!;
    const reservationState: { value: LunaPlanReservation | null } = { value: null };
    let dispatched = false;
    let response: PlanResponsesEnvelope | null = null;
    const attempt = {
      attemptNumber: 1 as const, outcome: "unknown" as const, submitted: false, requestPayloadSha256: row.requestPayloadSha256,
      httpStatus: null, responseId: null, responseSha256: null, responsePayload: null,
      modelReturned: null, serviceTier: null, latencyMs: null, classification: null, usage: null,
    };
    try {
      response = await options.responses.classifyPrepared(request, undefined, () => {
        const reservation = options.reserveRequest({
          utcDay: startedAt.slice(0, 10), requestBytes: request.requestBytes, maxRequests, maxRequestBytes,
        });
        reservationState.value = reservation;
        if (!reservation.reserved) return false;
        dispatched = options.markDispatched(reservation.id);
        return dispatched;
      });
      const reservation = reservationState.value;
      if (!reservation?.reserved) throw new Error("plan request returned without a shared local reservation");
      attempt.submitted = true;
      const validated = validateCategoricalOutput(response.response, request);
      const classification = { ...validated, disposition: deriveCategoricalDisposition(validated, false) };
      Object.assign(attempt, {
        outcome: "completed", httpStatus: response.httpStatus, responseId: response.responseId,
        responseSha256: response.responseSha256, responsePayload: response.responsePayload,
        modelReturned: response.modelReturned, serviceTier: response.serviceTier, latencyMs: response.latencyMs,
        classification,
        usage: { inputTokens: response.usage.inputTokens, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: response.usage.outputTokens, reasoningTokens: null, totalTokens: response.usage.totalTokens, estimatedCostUsd: null },
      });
      row.terminalStatus = "completed";
      if (!options.finishRequest(reservation.id, "completed")) throw new Error("shared ChatGPT-plan evaluation ledger did not finalize; outcome requires reconciliation");
    } catch (error) {
      const receipt = errorReceipt(error);
      const outcome = failureOutcome(error);
      const reservation = reservationState.value;
      const planDispatched = dispatched || receipt.requestDispatched || response !== null;
      if (reservation?.reserved) {
        if (planDispatched) { requestCount += 1; attempt.submitted = true; }
        options.finishRequest(reservation.id, planDispatched ? outcome === "unknown" ? "unknown" : "rejected" : "not_sent");
      }
      Object.assign(attempt, {
        outcome: planDispatched ? outcome : "not_sent",
        httpStatus: response?.httpStatus ?? receipt.status, responseId: response?.responseId ?? receipt.responseId,
        responseSha256: response?.responseSha256 ?? receipt.responseSha256, responsePayload: response?.responsePayload ?? null,
        modelReturned: response?.modelReturned ?? receipt.model, serviceTier: response?.serviceTier ?? receipt.serviceTier,
        latencyMs: response?.latencyMs ?? receipt.latencyMs,
        classification: null, usage: null,
      });
      row.terminalStatus = attempt.outcome;
      row.attempts.push(attempt);
      run.requestCount = requestCount;
      persist();
      break;
    }
    attempt.submitted = true;
    row.attempts.push(attempt);
    requestCount += 1;
    run.requestCount = requestCount;
    persist();
  }
  return run;
}

function argumentsFrom(argv: string[]): { labelsPath: string; outputPath: string } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: npx tsx scripts/run-luna-label-evaluation.ts --labels <frozen-final-labels.json> --out <new-run.json>");
      console.log("Uses the connected ChatGPT plan; sends sequential requests under local daily request/byte caps, with no retries.");
      process.exit(0);
    }
    if ((flag !== "--labels" && flag !== "--out") || args.has(flag)) throw new Error(`unsupported or duplicate argument: ${flag ?? "<missing>"}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
    args.set(flag, value);
  }
  const labelsPath = args.get("--labels"); const outputPath = args.get("--out");
  if (!labelsPath || !outputPath) throw new Error("--labels and --out are required");
  return { labelsPath, outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = argumentsFrom(process.argv.slice(2));
    const [{ config }, { Desk }] = await Promise.all([import("../server/config.js"), import("../server/db.js")]);
    const db = new Desk(config.dbPath, config.storage);
    const auth = new ChatGPTPlanAuth({ path: path.join(path.dirname(path.resolve(config.dbPath)), "chatgpt-plan.credentials.enc"), vault: new ChatGPTPlanCredentialVault(path.join(path.dirname(path.resolve(config.dbPath)), "chatgpt-plan.credentials.enc")) });
    const responses = new ChatGPTPlanResponses({ tokenProvider: auth, maxRequestBytes: 16_384 });
    try {
      await runLunaLabelEvaluation({
        ...args, env: process.env, responses,
        reserveRequest: (input) => db.reserveChatGPTPlanEvaluationRequest(input),
        markDispatched: (id) => db.markChatGPTPlanEvaluationDispatched(id),
        finishRequest: (id, status) => db.finishChatGPTPlanEvaluationRequest(id, status),
      });
    } finally { db.close(); }
    process.stdout.write(JSON.stringify({ result: "RUN_ARTIFACT_WRITTEN", outputPath: args.outputPath, providerCost: "unknown", providerAllowance: "unknown" }) + "\n");
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") : "Luna evaluation runner failed";
    console.error(JSON.stringify({ result: "RUN_NOT_COMPLETED", message }));
    process.exitCode = 2;
  }
}
