import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenAIClassifier, OpenAIClassifierError, OPENAI_MODEL, OPENAI_PRICING,
  OPENAI_PROFILE_SHA256, OPENAI_PROMPT_SHA256, OPENAI_PROMPT_VERSION,
  OPENAI_SCHEMA_SHA256, OPENAI_SCHEMA_VERSION, OPENAI_SERVICE_TIER,
  estimateOpenAICostUsd, prepareOpenAIRequest,
} from "../server/openai-classifier.js";
import {
  parseLunaLabelSet, sha256Bytes,
  type LunaClassifierContract, type LunaLabelSetV2, type LunaModelRunV2,
} from "./luna-label-evaluation.js";
import { verifyFrozenLunaCode } from "./evaluate-luna-labels.js";
import { deriveCategoricalDisposition } from "../shared/categorical-disposition.js";
import { boundedNonNegativeInt, boundedUsdMicros, parseExplicitBoolean, parseExternalRequestsEnabled, parseExternalSourceCollectors } from "../server/config.js";
import { intersectClassifierSourceAllowlist } from "../server/collector-policy.js";

const MAX_CAPTURE_BYTES = 65_536;

function classifierContract(): LunaClassifierContract {
  return {
    model: OPENAI_MODEL, serviceTier: OPENAI_SERVICE_TIER,
    profileSha256: OPENAI_PROFILE_SHA256, promptVersion: OPENAI_PROMPT_VERSION,
    schemaVersion: OPENAI_SCHEMA_VERSION, promptSha256: OPENAI_PROMPT_SHA256,
    schemaSha256: OPENAI_SCHEMA_SHA256, pricing: OPENAI_PRICING,
    prepareRequest: (input, model) => prepareOpenAIRequest(input, model),
    estimateCost: estimateOpenAICostUsd,
  };
}

function fileExistsWithoutFollowingLinks(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
}

function failureOutcome(error: unknown): "refused" | "incomplete" | "invalid_output" | "rejected" | "unknown" {
  if (!(error instanceof OpenAIClassifierError)) return "unknown";
  if (error.outcomeUnknown || error.status === null || error.status >= 500) return "unknown";
  if (error.status === 429 && error.retryable) return "rejected";
  if (/refused/i.test(error.message)) return "refused";
  if (/not completed/i.test(error.message)) return "incomplete";
  if (/classification|structured|supporting excerpt|evidence sufficient/i.test(error.message)) return "invalid_output";
  return "rejected";
}

function errorReceipt(error: unknown): { status: number | null; responseId: string | null; responseSha256: string | null; model: string | null; serviceTier: string | null; latencyMs: number | null } {
  if (!(error instanceof OpenAIClassifierError)) return { status: null, responseId: null, responseSha256: null, model: null, serviceTier: null, latencyMs: null };
  return { status: error.status, responseId: error.responseId, responseSha256: error.responseSha256, model: error.returnedModel, serviceTier: error.serviceTier, latencyMs: error.latencyMs };
}

export interface LunaRunOptions {
  labelsPath: string;
  outputPath: string;
  apiKey: string;
  env: Record<string, string | undefined>;
  reserveBudget: (input: { utcDay: string; requests: number; requestBytes: number; costMicros: number; maxRequests: number; maxRequestBytes: number; maxDailyCostMicros: number }) => { reserved: true } | { reserved: false; reason: string };
  cwd?: string;
  /** Injected only by unit tests. The CLI never accepts a custom fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test seam only. Production uses the frozen Git/source verification. */
  assertFrozenCode?: (labels: LunaLabelSetV2, cwd: string) => void;
  /** Test seam for small constructed cases; production always uses strict parsing. */
  parseLabels?: (value: unknown, contract: LunaClassifierContract) => LunaLabelSetV2;
  now?: () => Date;
}

/** Executes the frozen final cohort once, sequentially, with no retry path. */
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
  if (!budget || !Number.isFinite(budget.maxRequests) || !Number.isFinite(budget.maxEstimatedCostUsd)) throw new Error("final labels lack finite, pre-frozen request and USD controls");
  if (labels.items.length > budget.maxRequests) throw new Error("frozen request ceiling does not cover the selected Luna cohort");
  if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is not configured; no request was sent");

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
  const maxRequests = boundedNonNegativeInt(env.OPENAI_MAX_REQUESTS_PER_DAY, 100);
  const maxRequestBytes = boundedNonNegativeInt(env.OPENAI_MAX_REQUEST_BYTES_PER_DAY, 400_000);
  const maxDailyCostMicros = boundedUsdMicros(env.OPENAI_MAX_DAILY_COST_USD, 100);
  if (maxRequests <= 0 || maxRequestBytes <= 0 || maxDailyCostMicros <= 0) throw new Error("positive finite OpenAI daily request, byte, and USD caps are required; no request was sent");
  if (labels.items.length > maxRequests) throw new Error("frozen cohort exceeds OPENAI_MAX_REQUESTS_PER_DAY; no request was sent");

  const prepared = labels.items.map((item) => {
    const request = prepareOpenAIRequest(item.input, labels.requestedModel);
    if (request.payloadSha256 !== item.requestBinding.payloadSha256 || request.requestBytes !== item.requestBinding.requestBytes) throw new Error(`case ${item.observationId} request no longer matches its frozen binding`);
    return request;
  });
  const conservativeInputRate = Math.max(budget.inputPerMillionUsd, budget.cacheWritePerMillionUsd);
  const worstCaseUsd = prepared.reduce((total, request) => total + (
    request.requestBytes * conservativeInputRate + request.maxOutputTokens * budget.outputPerMillionUsd
  ) / 1_000_000, 0);
  if (!Number.isFinite(worstCaseUsd) || worstCaseUsd > budget.maxEstimatedCostUsd || worstCaseUsd > budget.openAIAccountReadback.availableBudgetUsd) {
    throw new Error(`conservative worst-case cost $${worstCaseUsd.toFixed(8)} exceeds the frozen USD ceiling; no request was sent`);
  }

  (options.assertFrozenCode ?? verifyFrozenLunaCode)(labels, cwd);
  const responseCapture: { bytes: Buffer | null } = { bytes: null };
  const capturedResponse = (): Buffer | null => responseCapture.bytes;
  const classifier = new OpenAIClassifier({ apiKey: options.apiKey.trim(), model: labels.requestedModel, fetchImpl: options.fetchImpl, onResponseBytes: (_status, bytes) => {
    if (bytes.byteLength <= MAX_CAPTURE_BYTES) responseCapture.bytes = Buffer.from(bytes);
  } });
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const rows: LunaModelRunV2["items"] = labels.items.map((item) => ({ observationId: item.observationId, requestPayloadSha256: item.requestBinding.payloadSha256, terminalStatus: "not_attempted", attempts: [] }));
  let requestCount = 0;
  const run: LunaModelRunV2 = {
    schemaVersion: 2, studyId: labels.studyId,
    runId: `luna-${startedAt.replaceAll(/[^0-9TZ]/g, "-")}-${randomUUID()}`,
    labelsSha256: sha256Bytes(labelBytes), sampleManifestSha256: labels.sampleManifestSha256,
    evaluationProfile: labels.evaluationProfile, profileSha256: labels.profileSha256,
    analysisCodeRevision: labels.analysisCodeRevision, sourceTreeDirty: false, startedAt, requestCount,
    requestedModel: labels.requestedModel, maxRequests: budget.maxRequests, maxEstimatedCostUsd: budget.maxEstimatedCostUsd,
    inputPerMillionUsd: budget.inputPerMillionUsd, cachedInputPerMillionUsd: budget.cachedInputPerMillionUsd,
    cacheWritePerMillionUsd: budget.cacheWritePerMillionUsd, outputPerMillionUsd: budget.outputPerMillionUsd,
    items: rows,
  };
  const serializeRun = () => `${JSON.stringify(run, null, 2)}\n`;
  const persist = (exclusive = false) => {
    const content = serializeRun();
    if (exclusive) {
      // Reserve the final name before dispatch. An interrupted create cannot
      // be mistaken for a completed run; no model request occurs until this
      // exclusive write returns successfully.
      writeFileSync(outputPath, content, { flag: "wx", mode: 0o600 });
      return;
    }
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    const fd = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(temporaryPath);
      throw error;
    }
    closeSync(fd);
    try { renameSync(temporaryPath, outputPath); }
    catch (error) { unlinkSync(temporaryPath); throw error; }
  };
  // Persist a private artifact before reserving budget or dispatching. If the
  // daily reservation is refused, the artifact truthfully records that every
  // case remains unattempted and the reservation was not consumed.
  persist(true);
  const reservation = options.reserveBudget({
    utcDay: startedAt.slice(0, 10),
    requests: labels.items.length,
    requestBytes: prepared.reduce((total, request) => total + request.requestBytes, 0),
    costMicros: Math.ceil(worstCaseUsd * 1_000_000),
    maxRequests, maxRequestBytes, maxDailyCostMicros,
  });
  if (!reservation.reserved) throw new Error(`shared OpenAI daily budget reservation failed closed (${reservation.reason}); no request was sent`);

  let captured: Buffer | null = null;

  for (let index = 0; index < labels.items.length; index += 1) {
    const label = labels.items[index]!;
    const row = rows[index]!;
    responseCapture.bytes = null;
    requestCount += 1;
    const attempt = {
      attemptNumber: 1 as const, outcome: "unknown" as const, submitted: true, requestPayloadSha256: row.requestPayloadSha256,
      httpStatus: null, responseId: null, responseSha256: null, responsePayload: null,
      modelReturned: null, serviceTier: null, latencyMs: null, classification: null, usage: null,
    };
    row.attempts.push(attempt);
    row.terminalStatus = "unknown";
    run.requestCount = requestCount;
    persist();
    try {
      const result = await classifier.classifyPrepared(prepared[index]!);
      const classification = {
        ...result.classification,
        // The frozen cohort does not include the pipeline's scoped/alias
        // identity evidence. Do not use the model's own `about` judgment to
        // grant strong identity; complete cases stay review-required and the
        // evaluator reports this missing evidence as UNVERIFIED.
        disposition: deriveCategoricalDisposition(result.classification, false),
      };
      const captured = capturedResponse();
      const responsePayload = captured ? new TextDecoder("utf-8", { fatal: true }).decode(captured) : null;
      Object.assign(attempt, {
        outcome: "completed",
        httpStatus: result.httpStatus, responseId: result.responseId, responseSha256: result.responseSha256,
        responsePayload, modelReturned: result.modelReturned, serviceTier: result.serviceTier,
        latencyMs: result.latencyMs, classification, usage: { ...result.usage, estimatedCostUsd: result.usage.estimatedCostUsd },
      });
      row.terminalStatus = "completed";
      run.requestCount = requestCount;
      persist();
    } catch (error) {
      const receipt = errorReceipt(error);
      const outcome = failureOutcome(error);
      const captured = capturedResponse();
      const rawPayload = captured && captured.byteLength <= MAX_CAPTURE_BYTES ? (() => { try { return new TextDecoder("utf-8", { fatal: true }).decode(captured); } catch { return null; } })() : null;
      Object.assign(attempt, {
        outcome,
        httpStatus: receipt.status, responseId: receipt.responseId,
        responseSha256: receipt.responseSha256 ?? (captured ? sha256Bytes(captured) : null),
        responsePayload: rawPayload, modelReturned: receipt.model, serviceTier: receipt.serviceTier,
        latencyMs: receipt.latencyMs, classification: null, usage: error instanceof OpenAIClassifierError && error.usage ? { ...error.usage, estimatedCostUsd: null } : null,
      });
      row.terminalStatus = outcome;
      run.requestCount = requestCount;
      persist();
      break;
    }
  }
  return run;
}

function argumentsFrom(argv: string[]): { labelsPath: string; outputPath: string } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: OPENAI_API_KEY=... npx tsx scripts/run-luna-label-evaluation.ts --labels <frozen-final-labels.json> --out <new-run.json>");
      console.log("Performs one sequential Luna request per frozen case, with no automatic retries. Requires a frozen finite budget and a new output path.");
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
    try {
      await runLunaLabelEvaluation({
        ...args, apiKey: config.openai.apiKey, env: process.env,
        reserveBudget: (input) => db.reserveOpenAIEvaluationBudget(input),
      });
    } finally { db.close(); }
    process.stdout.write(JSON.stringify({ result: "RUN_ARTIFACT_WRITTEN", outputPath: args.outputPath }) + "\n");
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") : "Luna evaluation runner failed";
    console.error(JSON.stringify({ result: "RUN_NOT_COMPLETED", message }));
    process.exitCode = 2;
  }
}
