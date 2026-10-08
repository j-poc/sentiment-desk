import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeLunaFinal,
  analyzeLunaPilot,
  parseLunaLabelSet,
  parseLunaModelRun,
  sha256Bytes,
  type LunaClassifierContract,
  type LunaLabelSetV2,
} from "./luna-label-evaluation.js";

type OpenAIClassifierModule = {
  OPENAI_MODEL: string;
  OPENAI_SERVICE_TIER: "default";
  OPENAI_PROMPT_VERSION: string;
  OPENAI_SCHEMA_VERSION: string;
  OPENAI_PROMPT_SHA256: string;
  OPENAI_SCHEMA_SHA256: string;
  OPENAI_PROFILE_SHA256: string;
  OPENAI_PRICING: { inputPerMillionUsd: number; cachedInputPerMillionUsd: number; cacheWritePerMillionUsd: number; outputPerMillionUsd: number };
  prepareOpenAIRequest(input: LunaLabelSetV2["items"][number]["input"], model?: string): ReturnType<LunaClassifierContract["prepareRequest"]>;
  estimateOpenAICostUsd(inputTokens: number, cachedInputTokens: number | null, cacheWriteInputTokens: number | null, outputTokens: number, modelReturned: string | null, serviceTier: string | null): number | null;
};

function argumentsFrom(argv: string[]): { labelsPath: string; runPath?: string; outputPath?: string; acceptPilotUnverified: boolean } {
  const values = new Map<string, string>();
  let acceptPilotUnverified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("Usage: npx tsx scripts/evaluate-luna-labels.ts --labels <local-json> [--run <local-json>] [--out <report-json>]");
      console.log("       Add --accept-pilot-unverified only when a validated pilot diagnostic is expected to remain UNVERIFIED.");
      console.log("This offline command validates the frozen categorical Luna profile and saved run; it makes no network or model calls.");
      process.exit(0);
    }
    if (key === "--accept-pilot-unverified") {
      if (acceptPilotUnverified) throw new Error("--accept-pilot-unverified may be supplied only once");
      acceptPilotUnverified = true;
      continue;
    }
    if (!["--labels", "--run", "--out"].includes(key ?? "")) throw new Error(`unsupported argument: ${key ?? "<missing>"}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a path`);
    if (values.has(key!)) throw new Error(`${key} may be supplied only once`);
    values.set(key!, value);
    index += 1;
  }
  const labelsPath = values.get("--labels");
  if (!labelsPath) throw new Error("--labels is required");
  return { labelsPath, runPath: values.get("--run"), outputPath: values.get("--out"), acceptPilotUnverified };
}

export function evaluatorExitCode(report: { mode?: unknown; status?: unknown }, acceptPilotUnverified: boolean): 0 | 2 {
  if (acceptPilotUnverified) return report.mode === "luna-agent-reference-pilot" && report.status === "UNVERIFIED" ? 0 : 2;
  return report.status === "FAIL" || report.status === "UNVERIFIED" ? 2 : 0;
}

function readJson(filePath: string): { bytes: Buffer; value: unknown } {
  const bytes = readFileSync(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
}

export function verifyFrozenLunaCode(labels: LunaLabelSetV2, cwd = process.cwd()): void {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  if (revision !== labels.analysisCodeRevision) throw new Error("current HEAD differs from the code revision frozen with Luna labels");
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim();
  if (trackedChanges) throw new Error("tracked source tree is dirty; frozen Luna evaluation must run from a clean checkout");
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }).split("\n")
    .filter((file) => /^(server|shared|scripts|tests|web\/src)\//.test(file) || ["package.json", "tsconfig.json"].includes(file));
  if (untracked.length) throw new Error("untracked executable or test source exists; frozen Luna evaluation code must be committed first");
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["scripts/evaluate-luna-labels.ts", "scripts/run-luna-label-evaluation.ts", "scripts/luna-label-evaluation.ts", "server/openai-classifier.ts", "server/pipeline.ts", "server/rubric.ts", "shared/categorical-disposition.ts", "config/companies.json"];
  for (const relative of sources) {
    const sourceFile = path.resolve(sourceRoot, relative); const frozenFile = path.resolve(cwd, relative);
    if (!frozenFile.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error("frozen Luna source path escapes its checkout");
    const sourceStat = lstatSync(sourceFile); const frozenStat = lstatSync(frozenFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !frozenStat.isFile() || frozenStat.isSymbolicLink() || !readFileSync(sourceFile).equals(readFileSync(frozenFile))) throw new Error(`frozen Luna evaluation source differs from loaded source: ${relative}`);
    const treeEntry = execFileSync("git", ["--no-replace-objects", "ls-tree", revision, "--", relative], { cwd, encoding: "utf8" });
    if (!/^(100644|100755) blob [0-9a-f]+\t/.test(treeEntry)) throw new Error(`frozen Luna evaluation source is absent from code revision: ${relative}`);
    const committedBytes = execFileSync("git", ["--no-replace-objects", "show", `${revision}:${relative}`], { cwd });
    if (!committedBytes.equals(readFileSync(frozenFile))) throw new Error(`frozen Luna evaluation source differs from committed code revision: ${relative}`);
  }
}

function writeReportIdempotently(outputPath: string, output: string): "written" | "identical" {
  try {
    writeFileSync(outputPath, output, { flag: "wx" });
    return "written";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const stat = lstatSync(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("existing report path is not a regular file");
    if (!readFileSync(outputPath).equals(Buffer.from(output, "utf8"))) throw new Error("existing report differs from recomputed Luna evaluation; refusing to overwrite");
    return "identical";
  }
}

async function loadedClassifier(): Promise<LunaClassifierContract> {
  const moduleUrl = new URL("../server/openai-classifier.js", import.meta.url).href;
  const classifier = await import(moduleUrl) as OpenAIClassifierModule;
  return {
    model: classifier.OPENAI_MODEL,
    serviceTier: classifier.OPENAI_SERVICE_TIER,
    profileSha256: classifier.OPENAI_PROFILE_SHA256,
    promptVersion: classifier.OPENAI_PROMPT_VERSION,
    schemaVersion: classifier.OPENAI_SCHEMA_VERSION,
    promptSha256: classifier.OPENAI_PROMPT_SHA256,
    schemaSha256: classifier.OPENAI_SCHEMA_SHA256,
    pricing: classifier.OPENAI_PRICING,
    prepareRequest: (input, model) => classifier.prepareOpenAIRequest(input, model),
    estimateCost: (inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, modelReturned, serviceTier) => classifier.estimateOpenAICostUsd(inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, modelReturned, serviceTier),
  };
}

export async function evaluateLunaFiles(args: { labelsPath: string; runPath?: string; outputPath?: string; classifier: LunaClassifierContract; cwd?: string }): Promise<Record<string, unknown>> {
  const labelsFilePath = path.resolve(args.labelsPath);
  const labelArtifact = readJson(labelsFilePath);
  const labels = parseLunaLabelSet(labelArtifact.value, args.classifier);
  verifyFrozenLunaCode(labels, args.cwd ?? process.cwd());
  const labelsSha256 = sha256Bytes(labelArtifact.bytes);
  let runSha256: string | null = null;
  let report: Record<string, unknown>;
  if (args.runPath) {
    if (labels.stage !== "final") throw new Error("--run is permitted only for labels frozen as stage=final");
    const runFile = readJson(path.resolve(args.runPath));
    const run = parseLunaModelRun(runFile.value, labels, args.classifier);
    runSha256 = sha256Bytes(runFile.bytes);
    report = analyzeLunaFinal({ labels, labelsSha256, run });
  } else if (labels.stage === "pilot") {
    report = analyzeLunaPilot(labels);
  } else {
    report = analyzeLunaFinal({ labels, labelsSha256, run: null });
  }
  report.provenance = {
    labelsSha256,
    runSha256,
    codeRevision: labels.analysisCodeRevision,
    requestedModel: labels.requestedModel,
    requestedServiceTier: labels.requestedServiceTier,
    promptVersion: labels.promptVersion,
    promptSha256: labels.promptSha256,
    schemaVersion: labels.schemaVersionName,
    schemaSha256: labels.schemaSha256,
    profileSha256: labels.profileSha256,
    frozenAt: labels.frozenAt,
    modelOutputsOpenedAt: labels.agentLabelProtocol.lunaOutputsOpenedAt,
    configuredPriceSchedule: args.classifier.pricing,
  };
  if (args.outputPath) {
    const outputPath = path.resolve(args.outputPath);
    if (outputPath === labelsFilePath || outputPath === (args.runPath ? path.resolve(args.runPath) : "")) throw new Error("Luna report output must not overwrite a frozen input artifact");
    const output = `${JSON.stringify(report, null, 2)}\n`;
    const status = writeReportIdempotently(outputPath, output);
    return { result: status === "written" ? "REPORT_WRITTEN" : "REPORT_ALREADY_IDENTICAL", mode: report.mode, status: report.status, outputPath };
  }
  return report;
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const classifier = await loadedClassifier();
  const report = await evaluateLunaFiles({ ...args, classifier });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(output);
  process.exitCode = evaluatorExitCode(report, args.acceptPilotUnverified);
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "invalid Luna evaluation input";
    console.error(JSON.stringify({ result: "INVALID_OR_UNVERIFIED_INPUT", message }));
    process.exitCode = 2;
  });
}
