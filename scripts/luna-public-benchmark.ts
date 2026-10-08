import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** Offline, sentiment-only scorer. It never loads or transmits benchmark text. */
const FINENTITY_DATASET_SHA256 = "3208667de69383120b0380aebeaabe360669eda72269c33e1c8b09d63df55463";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sentiment = z.enum(["negative", "neutral", "positive"]);
const classes = ["negative", "neutral", "positive"] as const;
const classifierProfileSchema = z.object({
  artifactSha256: digest,
  requestedModel: z.literal("gpt-6-luna"),
  promptSha256: digest,
  schemaSha256: digest,
  profileSha256: digest,
}).strict();
const rightsSchema = z.object({
  attested: z.literal(true),
  artifactSha256: digest,
  benchmark: z.literal("FinEntity"),
  datasetSha256: z.literal(FINENTITY_DATASET_SHA256),
  permittedUses: z.array(z.enum(["provider_transmission", "local_scoring", "retention"])).min(3),
  provider: z.literal("OpenAI"),
}).strict().superRefine((value, context) => {
  for (const use of ["provider_transmission", "local_scoring", "retention"] as const) {
    if (!value.permittedUses.includes(use)) context.addIssue({ code: "custom", path: ["permittedUses"], message: `missing ${use} permission` });
  }
});
const rowSchema = z.object({
  rowId: z.string().trim().min(1).max(200),
  paragraphId: z.string().trim().min(1).max(200),
  targetId: z.string().trim().min(1).max(200),
  entityId: z.string().trim().min(1).max(200),
  referenceSentiment: sentiment,
  /** Digest of the exact prepared provider request; source text is not retained here. */
  requestSha256: digest,
  /** Binds the request digest to this precise paragraph/target/entity and profile. */
  inputBindingSha256: digest,
}).strict();
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
}).strict();
const predictionSchema = z.object({
  rowId: z.string().trim().min(1).max(200),
  paragraphId: z.string().trim().min(1).max(200),
  targetId: z.string().trim().min(1).max(200),
  entityId: z.string().trim().min(1).max(200),
  status: z.enum(["completed", "abstained", "failed", "invalid"]),
  sentiment: z.unknown(),
  requestSha256: digest,
  responseSha256: digest,
  usage: usageSchema,
}).strict();
const runSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  artifactSha256: digest,
  startedAt: z.string().datetime({ offset: true }),
  persistedAt: z.string().datetime({ offset: true }),
  provider: z.literal("OpenAI"),
  requestedModel: z.string().trim().min(1).max(200),
  modelReturned: z.string().trim().min(1).max(200),
  promptSha256: digest,
  schemaSha256: digest,
  profileSha256: digest,
  datasetRowsSha256: digest,
  rightsArtifactSha256: digest,
  classifierProfileArtifactSha256: digest,
  items: z.array(predictionSchema),
}).strict();

export type LunaPublicBenchmarkInput = {
  rights: unknown;
  rows: unknown;
  rowsArtifactSha256: unknown;
  classifierProfile: unknown;
  predictionRun: unknown;
  bootstrapReplicates?: number;
};

type Row = z.infer<typeof rowSchema>;
type Prediction = z.infer<typeof predictionSchema>;
type Run = z.infer<typeof runSchema>;
type Rights = z.infer<typeof rightsSchema>;
type Profile = z.infer<typeof classifierProfileSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function withoutDigest<T extends { artifactSha256: string }>(artifact: T): Omit<T, "artifactSha256"> {
  const { artifactSha256: _discard, ...payload } = artifact;
  return payload;
}

function bindingDigest(row: Row, profile: Profile): string {
  return sha256CanonicalJson({
    benchmark: "FinEntity",
    rowId: row.rowId,
    paragraphId: row.paragraphId,
    targetId: row.targetId,
    entityId: row.entityId,
    referenceSentiment: row.referenceSentiment,
    requestSha256: row.requestSha256,
    requestedModel: profile.requestedModel,
    promptSha256: profile.promptSha256,
    schemaSha256: profile.schemaSha256,
    profileSha256: profile.profileSha256,
    classifierProfileArtifactSha256: profile.artifactSha256,
  });
}

export function lunaPublicBenchmarkInputBindingSha256(rowValue: unknown, profileValue: unknown): string {
  const row = rowSchema.parse(rowValue);
  const profile = classifierProfileSchema.parse(profileValue);
  return bindingDigest(row, profile);
}

export type LunaPublicBenchmarkVerification = { ok: boolean; issues: string[]; digests?: Record<string, string> };

/** Verifies canonical file payload digests without network, text access, or secret lookup. */
export function verifyLunaPublicBenchmarkArtifacts(input: LunaPublicBenchmarkInput): LunaPublicBenchmarkVerification {
  const issues: string[] = [];
  const rightsResult = rightsSchema.safeParse(input.rights);
  const profileResult = classifierProfileSchema.safeParse(input.classifierProfile);
  const rowsResult = z.array(rowSchema).min(1).safeParse(input.rows);
  const runResult = runSchema.safeParse(input.predictionRun);
  if (!rightsResult.success) issues.push("rights artifact schema or benchmark-specific permission fields are invalid");
  if (!profileResult.success) issues.push("frozen classifier profile is absent or invalid");
  if (!rowsResult.success) issues.push("eligible paragraph-target row artifact is absent or invalid");
  if (!runResult.success) issues.push("persisted prediction run artifact is absent or invalid");
  const rowsSha = typeof input.rowsArtifactSha256 === "string" && digest.safeParse(input.rowsArtifactSha256).success ? input.rowsArtifactSha256 : null;
  if (rowsSha === null) issues.push("eligible row artifact digest is absent or invalid");
  if (!rightsResult.success || !profileResult.success || !rowsResult.success || !runResult.success || rowsSha === null) return { ok: false, issues };

  const rights = rightsResult.data; const profile = profileResult.data; const rows = rowsResult.data; const run = runResult.data;
  const calculatedRightsSha = sha256CanonicalJson(withoutDigest(rights));
  const calculatedProfileSha = sha256CanonicalJson(withoutDigest(profile));
  const calculatedRowsSha = sha256CanonicalJson(rows);
  const calculatedRunSha = sha256CanonicalJson(withoutDigest(run));
  if (calculatedRightsSha !== rights.artifactSha256) issues.push("rights artifact SHA-256 does not match its canonical payload");
  if (calculatedProfileSha !== profile.artifactSha256) issues.push("classifier profile SHA-256 does not match its canonical payload");
  if (calculatedRowsSha !== rowsSha) issues.push("eligible row artifact SHA-256 does not match its canonical payload");
  if (calculatedRunSha !== run.artifactSha256) issues.push("prediction run SHA-256 does not match its canonical payload");
  if (run.datasetRowsSha256 !== rowsSha) issues.push("run identity does not bind the exact eligible row artifact");
  if (run.rightsArtifactSha256 !== rights.artifactSha256) issues.push("run identity does not bind the rights artifact");
  if (run.classifierProfileArtifactSha256 !== profile.artifactSha256) issues.push("run identity does not bind the frozen classifier profile artifact");
  if (run.requestedModel !== profile.requestedModel || run.promptSha256 !== profile.promptSha256 || run.schemaSha256 !== profile.schemaSha256 || run.profileSha256 !== profile.profileSha256) issues.push("run identity differs from the frozen model, prompt, schema, or profile");
  if (run.modelReturned !== "gpt-6-luna") issues.push("provider returned model is not gpt-6-luna");
  if (Date.parse(run.startedAt) > Date.parse(run.persistedAt)) issues.push("run persistence timestamp precedes the run start");

  const rowIds = new Set<string>(); const paragraphTargets = new Set<string>();
  for (const row of rows) {
    if (rowIds.has(row.rowId)) issues.push(`duplicate row ID: ${row.rowId}`);
    rowIds.add(row.rowId);
    const pair = `${row.paragraphId}\0${row.targetId}`;
    if (paragraphTargets.has(pair)) issues.push(`duplicate paragraph-target unit: ${row.paragraphId}/${row.targetId}`);
    paragraphTargets.add(pair);
    if (row.inputBindingSha256 !== bindingDigest(row, profile)) issues.push(`request binding digest mismatch: ${row.rowId}`);
  }
  const predictionIds = new Set<string>(); const byId = new Map(rows.map((row) => [row.rowId, row]));
  for (const prediction of run.items) {
    if (predictionIds.has(prediction.rowId)) issues.push(`duplicate prediction row ID: ${prediction.rowId}`);
    predictionIds.add(prediction.rowId);
    const row = byId.get(prediction.rowId);
    if (!row || row.paragraphId !== prediction.paragraphId || row.targetId !== prediction.targetId || row.entityId !== prediction.entityId || row.requestSha256 !== prediction.requestSha256) issues.push(`prediction row/request binding mismatch: ${prediction.rowId}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    digests: { rights: calculatedRightsSha, eligibleRows: calculatedRowsSha, classifierProfile: calculatedProfileSha, predictionRun: calculatedRunSha },
  };
}

function metrics(rows: Array<{ reference: typeof classes[number]; prediction: typeof classes[number] | null }>) {
  const confusion = Object.fromEntries(classes.map((actual) => [actual,
    Object.fromEntries([...classes, "abstain"].map((predicted) => [predicted, 0])),
  ])) as Record<string, Record<string, number>>;
  const slices = Object.fromEntries(classes.map((label) => {
    const support = rows.filter((row) => row.reference === label).length;
    const predicted = rows.filter((row) => row.prediction === label).length;
    const truePositive = rows.filter((row) => row.reference === label && row.prediction === label).length;
    const precision = predicted ? truePositive / predicted : null;
    const recall = support ? truePositive / support : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return [label, { support, predicted, truePositive, precision, recall, f1 }];
  }));
  for (const row of rows) confusion[row.reference]![row.prediction ?? "abstain"]! += 1;
  const scored = rows.filter((row) => row.prediction !== null);
  const correct = scored.filter((row) => row.reference === row.prediction).length;
  const errorInclusiveF1 = classes.map((label) => {
    const support = rows.filter((row) => row.reference === label).length;
    const predicted = rows.filter((row) => row.prediction === label).length;
    const truePositive = rows.filter((row) => row.reference === label && row.prediction === label).length;
    const precision = predicted ? truePositive / predicted : 0;
    const recall = support ? truePositive / support : 0;
    return precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  });
  return {
    confusion,
    classSlices: slices,
    coverage: rows.length ? scored.length / rows.length : null,
    accuracyIncludingAbstentionsAsErrors: rows.length ? correct / rows.length : null,
    selectiveAccuracy: scored.length ? correct / scored.length : null,
    macroF1IncludingAbstentionsAsErrors: errorInclusiveF1.reduce((sum, value) => sum + value, 0) / classes.length,
    denominators: { selected: rows.length, scored: scored.length, abstainedOrMissingOrFailedOrInvalid: rows.length - scored.length },
  };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? null;
}

function clusterIntervals(rows: Array<{ paragraphId: string; reference: typeof classes[number]; prediction: typeof classes[number] | null }>, replicates: number) {
  const clusters = new Map<string, typeof rows>();
  for (const row of rows) clusters.set(row.paragraphId, [...(clusters.get(row.paragraphId) ?? []), row]);
  if (clusters.size < 2 || rows.length === 0) return { clusterCount: clusters.size, replicates: 0, coverage95: null, accuracyIncludingAbstentions95: null, macroF195: null };
  const groups = [...clusters.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, values]) => values);
  let state = Number.parseInt(sha256CanonicalJson(rows.map((row) => `${row.paragraphId}\0${row.reference}\0${row.prediction ?? "?"}`).sort()).slice(0, 8), 16) >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const coverage: number[] = []; const accuracy: number[] = []; const macroF1: number[] = [];
  for (let iteration = 0; iteration < replicates; iteration += 1) {
    const sample: typeof rows = [];
    for (let index = 0; index < groups.length; index += 1) sample.push(...groups[Math.floor(random() * groups.length)]!);
    const result = metrics(sample);
    if (result.coverage !== null) coverage.push(result.coverage);
    if (result.accuracyIncludingAbstentionsAsErrors !== null) accuracy.push(result.accuracyIncludingAbstentionsAsErrors);
    macroF1.push(result.macroF1IncludingAbstentionsAsErrors);
  }
  coverage.sort((a, b) => a - b); accuracy.sort((a, b) => a - b); macroF1.sort((a, b) => a - b);
  return { clusterCount: groups.length, replicates, coverage95: [quantile(coverage, 0.025), quantile(coverage, 0.975)], accuracyIncludingAbstentions95: [quantile(accuracy, 0.025), quantile(accuracy, 0.975)], macroF195: [quantile(macroF1, 0.025), quantile(macroF1, 0.975)] };
}

function limitations(): string[] {
  return [
    "This is a sentiment-only adaptation; it does not evaluate event type or citation entailment.",
    "It does not establish full Sentiment Desk readiness, investment value, or human-ground-truth accuracy.",
    "Protected workflow cases still own source grounding, citation support, entity, period, unit, numeric correctness, justified abstention, and answer completeness.",
    "The aggregate FinEntity preflight excludes conflicting paragraph-target labels and invalid-offset paragraphs; this scorer accepts only an operator-supplied eligible cohort and cannot reconstruct those exclusions without the underlying text.",
    "Input request digests bind paragraph/target/entity metadata and the frozen profile; without the rights-cleared text, the evaluator cannot independently recompute a digest from original request bytes.",
  ];
}

/** Deterministic and offline. Even complete sentiment-only runs remain UNVERIFIED, never quality PASS. */
export function evaluateLunaPublicBenchmark(input: LunaPublicBenchmarkInput | null | undefined): Record<string, unknown> {
  if (!input) return { mode: "luna-public-finance-benchmark-sentiment-only", status: "BLOCKED", blockers: ["rights, eligible rows, frozen classifier profile, and persisted run are required"], limitations: limitations() };
  const verification = verifyLunaPublicBenchmarkArtifacts(input);
  if (!verification.ok) return { mode: "luna-public-finance-benchmark-sentiment-only", status: "BLOCKED", blockers: verification.issues, verifiedArtifactDigests: verification.digests ?? null, limitations: limitations() };
  const rights = rightsSchema.parse(input.rights); const profile = classifierProfileSchema.parse(input.classifierProfile);
  const rows = z.array(rowSchema).parse(input.rows); const run: Run = runSchema.parse(input.predictionRun);
  const replicates = input.bootstrapReplicates ?? 1000;
  if (!Number.isSafeInteger(replicates) || replicates < 100 || replicates > 10000) return { mode: "luna-public-finance-benchmark-sentiment-only", status: "BLOCKED", blockers: ["cluster bootstrap replicates must be an integer from 100 through 10000"], limitations: limitations() };
  const predictions = new Map(run.items.map((prediction) => [prediction.rowId, prediction]));
  const pairs = rows.map((row) => {
    const prediction = predictions.get(row.rowId);
    const valid = prediction?.status === "completed" && classes.includes(prediction.sentiment as typeof classes[number]);
    return { row, prediction, valid, predicted: valid ? prediction!.sentiment as typeof classes[number] : null };
  });
  const scored = pairs.map(({ row, predicted }) => ({ paragraphId: row.paragraphId, reference: row.referenceSentiment, prediction: predicted }));
  const counts = {
    selected: rows.length,
    missing: pairs.filter(({ prediction }) => prediction === undefined).length,
    failed: pairs.filter(({ prediction }) => prediction?.status === "failed").length,
    invalid: pairs.filter(({ prediction }) => prediction?.status === "invalid" || (prediction?.status === "completed" && !classes.includes(prediction.sentiment as typeof classes[number]))).length,
    abstained: pairs.filter(({ prediction }) => prediction?.status === "abstained").length,
    scored: pairs.filter(({ valid }) => valid).length,
  };
  return {
    mode: "luna-public-finance-benchmark-sentiment-only",
    status: "UNVERIFIED",
    benchmark: "FinEntity",
    datasetSha256: rights.datasetSha256,
    rowsArtifactSha256: verification.digests!.eligibleRows,
    rightsArtifactSha256: verification.digests!.rights,
    classifierProfile: profile,
    run: { runId: run.runId, artifactSha256: verification.digests!.predictionRun, startedAt: run.startedAt, persistedAt: run.persistedAt, provider: run.provider, requestedModel: run.requestedModel, modelReturned: run.modelReturned },
    cohort: { selectedRows: rows.length, paragraphCount: new Set(rows.map(({ paragraphId }) => paragraphId)).size, targetCount: new Set(rows.map(({ targetId }) => targetId)).size, scoredRows: counts.scored },
    sentiment: metrics(scored),
    denominators: counts,
    uncertainty: clusterIntervals(scored, replicates),
    evidence: { providerCallsMadeByEvaluator: 0, usage: { inputTokens: run.items.reduce((sum, item) => sum + item.usage.inputTokens, 0), outputTokens: run.items.reduce((sum, item) => sum + item.usage.outputTokens, 0), costUsd: run.items.reduce((sum, item) => sum + item.usage.costUsd, 0), latencyMsTotal: run.items.reduce((sum, item) => sum + item.usage.latencyMs, 0), rowsWithProviderEvidence: run.items.length } },
    qualityPassAllowed: false,
    limitations: limitations(),
  };
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const allowed = new Set(["--rights", "--rows", "--profile", "--run", "--out"]);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("Usage: npx tsx scripts/luna-public-benchmark.ts --rights <rights.json> --rows <eligible-rows.json> --profile <frozen-profile.json> --run <persisted-run.json> --out <report.json>");
      console.log("Offline only. Valid complete sentiment diagnostics remain UNVERIFIED (exit 2); missing or invalid evidence exits 1.");
      process.exit(0);
    }
    if (!key || !allowed.has(key)) throw new Error(`unsupported argument: ${key ?? "<missing>"}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || parsed[key]) throw new Error(`${key} requires one unique path`);
    parsed[key] = value;
    index += 1;
  }
  if (!parsed["--out"]) throw new Error("--out is required to write the evaluation report");
  return parsed;
}

function readEvidenceJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function writeCliReport(outputPath: string, report: unknown): void {
  const absolutePath = path.resolve(outputPath);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  try {
    writeFileSync(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("existing report path is not a regular nonsymlink file; choose a new versioned --out path");
    if (!readFileSync(absolutePath).equals(bytes)) throw new Error("existing report differs from recomputed evaluation; choose a new versioned --out path");
  }
}

/** Native offline CLI: reads exactly four evidence JSON files and creates a new report file. */
export function runLunaPublicBenchmarkCli(argv: string[]): 0 | 1 | 2 {
  let args: Record<string, string> | null = null;
  try {
    args = parseCliArgs(argv);
    const missingArguments = ["--rights", "--rows", "--profile", "--run"].filter((key) => !args![key]);
    if (missingArguments.length) throw new Error(`required evidence arguments are missing: ${missingArguments.join(", ")}`);
    const inputFiles = [args["--rights"]!, args["--rows"]!, args["--profile"]!, args["--run"]!].map((file) => path.resolve(file));
    const missing = inputFiles.filter((file) => !existsSync(file));
    if (missing.length) throw new Error(`required evidence file is missing: ${missing.join(", ")}`);
    const rights = readEvidenceJson(inputFiles[0]!);
    const rowsArtifact = readEvidenceJson(inputFiles[1]!);
    const profile = readEvidenceJson(inputFiles[2]!);
    const run = readEvidenceJson(inputFiles[3]!);
    if (!rowsArtifact || typeof rowsArtifact !== "object" || !Array.isArray((rowsArtifact as { rows?: unknown }).rows) || typeof (rowsArtifact as { artifactSha256?: unknown }).artifactSha256 !== "string") {
      throw new Error("eligible rows file must contain rows and its canonical artifactSha256");
    }
    const rowsEnvelope = rowsArtifact as { rows: unknown[]; artifactSha256: string };
    const report = evaluateLunaPublicBenchmark({ rights, rows: rowsEnvelope.rows, rowsArtifactSha256: rowsEnvelope.artifactSha256, classifierProfile: profile, predictionRun: run });
    writeCliReport(args["--out"]!, report);
    return report.status === "UNVERIFIED" ? 2 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid or unavailable evidence";
    console.error(JSON.stringify({ mode: "luna-public-finance-benchmark-sentiment-only", status: "BLOCKED", blockers: [message] }));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runLunaPublicBenchmarkCli(process.argv.slice(2));
}
