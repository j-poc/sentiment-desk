import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { analyzeFinal, parseLabelSet, parseModelRun, sampleManifestSha256, sha256Bytes, type LabelSet, type ModelRun } from "./jev-label-evaluation.js";
import { isDirectScriptInvocation, verifyFrozenCode } from "./evaluate-jev-labels.js";

export const MANIFEST_PATH = "project-record/4-log/jev-real-source-evidence-manifest.json";
export const REVIEW_RECORD_PATH = ".engineering-evidence/real-source/jev-independent-real-source-review.json";
const EVIDENCE_PREFIX = ".engineering-evidence/real-source/";
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_CONTROL_BYTES = 2 * 1024 * 1024;
const GROUPS = ["provider_authenticity_usage", "sec_source_correspondence", "typesafe_account_and_spend", "independent_human_labels"] as const;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z.object({
  path: z.string().min(1), sha256: digestSchema, evidenceType: z.string().min(1), authoredBy: z.string().min(1), reviewedBy: z.string().min(1),
}).strict();
const groupEvidenceTypes = {
  provider_authenticity_usage: ["provider_request_result_receipts", "provider_usage_billing_reconciliation", "unknown_outcomes_reconciliation"],
  sec_source_correspondence: ["sec_filing_receipt_version_timestamp", "permitted_source_excerpt", "exact_jev_payload_digest_chain", "collector_parser_versions"],
  typesafe_account_and_spend: ["typesafe_account_terms_and_use", "telemetry_retention", "approved_prices_limits_refill", "numeric_spend_ceiling", "usage_billing_rejected_request_reconciliation", "sec_contact", "source_rights_matrix"],
  independent_human_labels: ["label_set_a", "label_set_b", "reviewer_qualification_independence", "blind_freeze_chronology", "adjudication_or_not_needed"],
  independent_agent_labels: ["agent_label_set_a", "agent_label_set_b", "agent_identity_and_model_configuration", "reviewer_independence", "blind_freeze_chronology", "agent_adjudication_or_not_needed"],
} as const;
const agentLabelsSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing"), reason: z.string().min(1) }).strict(),
  z.object({
    status: z.literal("provided"),
    reviewers: z.array(z.object({ id: z.string().min(1), kind: z.literal("independent_subagent"), agentThreadId: z.string().min(1), configuredModel: z.string().min(1), resolvedModel: z.string().min(1).nullable(), modelResolutionEvidence: digestSchema.nullable() }).strict()).min(2).max(3),
    freezeChronologyArtifact: artifactSchema,
    adjudication: z.discriminatedUnion("status", [
      z.object({ status: z.literal("performed"), artifact: artifactSchema }).strict(),
      z.object({ status: z.literal("not_needed"), reason: z.string().min(1) }).strict(),
    ]),
  }).strict(),
]);
const missingOrProvidedGroup = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("provided"), artifacts: z.array(artifactSchema).min(1) }).strict(),
]);
const runSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing"), reason: z.string().min(1) }).strict(),
  z.object({
    status: z.literal("provided"), studyId: z.string().min(1), runId: z.string().min(1), resolvedJevModel: z.string().min(1), rubricSha256: digestSchema, codeRevisionSha256: digestSchema,
    labelsSha256: digestSchema, runSha256: digestSchema, reportSha256: digestSchema, populationSha256: digestSchema, sampleSha256: digestSchema,
    frozenLabelsArtifact: artifactSchema, modelRunArtifact: artifactSchema, evaluationReportArtifact: artifactSchema, populationFrameArtifact: artifactSchema, sampleProvenanceArtifact: artifactSchema,
  }).strict(),
]);
const humanLabelsSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing"), reason: z.string().min(1) }).strict(),
  z.object({
    status: z.literal("provided"),
    labelSetA: z.object({ reviewerId: z.string().min(1), qualifiedHumanAttested: z.literal(true) }).strict(),
    labelSetB: z.object({ reviewerId: z.string().min(1), qualifiedHumanAttested: z.literal(true) }).strict(),
    freezeChronologyArtifact: artifactSchema,
    adjudication: z.discriminatedUnion("status", [
      z.object({ status: z.literal("performed"), artifact: artifactSchema }).strict(),
      z.object({ status: z.literal("not_needed"), reason: z.string().min(1) }).strict(),
    ]),
  }).strict(),
]);
const independentReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unresolved"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("resolved"), reviewerId: z.string().min(1), verdict: z.enum(["approved", "rejected"]), artifact: artifactSchema }).strict(),
]);
const manifestSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["blocked", "verified"]), run: runSchema,
  groups: z.object({ provider_authenticity_usage: missingOrProvidedGroup, sec_source_correspondence: missingOrProvidedGroup, typesafe_account_and_spend: missingOrProvidedGroup, independent_human_labels: missingOrProvidedGroup, independent_agent_labels: missingOrProvidedGroup.optional() }).strict(),
  humanLabels: humanLabelsSchema, independentReview: independentReviewSchema,
  agentLabels: agentLabelsSchema.optional(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Artifact = z.infer<typeof artifactSchema>;

const requiredChecksSchema = z.object({
  provider_authenticity_usage: z.object({ provider_request_result_receipts: z.literal(true), provider_usage_billing_reconciliation: z.literal(true), unknown_outcomes_reconciliation: z.literal(true) }).strict(),
  sec_source_correspondence: z.object({ sec_filing_receipt_version_timestamp: z.literal(true), permitted_source_excerpt: z.literal(true), exact_jev_payload_digest_chain: z.literal(true), collector_parser_versions: z.literal(true) }).strict(),
  typesafe_account_and_spend: z.object({ typesafe_account_terms_and_use: z.literal(true), telemetry_retention: z.literal(true), approved_prices_limits_refill: z.literal(true), numeric_spend_ceiling: z.literal(true), usage_billing_rejected_request_reconciliation: z.literal(true), sec_contact: z.literal(true), source_rights_matrix: z.literal(true) }).strict(),
  independent_human_labels: z.object({ label_set_a: z.literal(true), label_set_b: z.literal(true), reviewer_qualification_independence: z.literal(true), blind_freeze_chronology: z.literal(true), adjudication_or_not_needed: z.literal(true) }).strict().optional(),
  independent_agent_labels: z.object({ agent_label_set_a: z.literal(true), agent_label_set_b: z.literal(true), agent_identity_and_model_configuration: z.literal(true), reviewer_independence: z.literal(true), blind_freeze_chronology: z.literal(true), agent_adjudication_or_not_needed: z.literal(true) }).strict().optional(),
}).strict();
const reviewRecordSchema = z.object({
  schemaVersion: z.literal(1), reviewerId: z.string().min(1), verdict: z.enum(["approved", "rejected"]),
  approvalSubject: z.object({
    run: z.object({ studyId: z.string().min(1), runId: z.string().min(1), labelsSha256: digestSchema, runSha256: digestSchema, reportSha256: digestSchema, populationFrameSha256: digestSchema, sampleManifestSha256: digestSchema, rubricSha256: digestSchema, codeRevisionSha256: z.string().min(1), requestedModel: z.string().min(1), resolvedModel: z.string().min(1).nullable() }).strict(),
    groups: z.record(z.string(), z.unknown()),
    artifacts: z.array(z.object({ path: z.string().min(1), evidenceType: z.string().min(1), sha256: digestSchema, authoredBy: z.string().min(1), reviewedBy: z.string().min(1) }).strict()),
    humanLabels: z.record(z.string(), z.unknown()).optional(),
    labelAuthority: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  groupDigests: z.object({ provider_authenticity_usage: digestSchema, sec_source_correspondence: digestSchema, typesafe_account_and_spend: digestSchema, independent_human_labels: digestSchema.optional(), independent_agent_labels: digestSchema.optional() }).strict(),
  groupVerdicts: z.object({ provider_authenticity_usage: z.enum(["approved", "rejected"]), sec_source_correspondence: z.enum(["approved", "rejected"]), typesafe_account_and_spend: z.enum(["approved", "rejected"]), independent_human_labels: z.enum(["approved", "rejected"]).optional(), independent_agent_labels: z.enum(["approved", "rejected"]).optional() }).strict(),
  evidenceTypeChecks: requiredChecksSchema,
}).strict();
type ReviewRecord = z.infer<typeof reviewRecordSchema>;

function readBoundedRegularFile(filePath: string, maxBytes: number): Buffer {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("file is not a bounded regular file");
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (total <= maxBytes) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error("file grew beyond the permitted size");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } finally { closeSync(fd); }
}

export interface ValidationSummary {
  result: "BLOCKED" | "PASS";
  manifest: string;
  missingGroups: Array<{ group: string; reason: string }>;
  issues: string[];
  limitation: string;
}

export function canonicalizeEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvidence).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeEvidence(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function digestEvidence(value: unknown): string { return hash(canonicalizeEvidence(value)); }
function safeRelative(value: string): boolean {
  return value.startsWith(EVIDENCE_PREFIX) && !path.isAbsolute(value) && !value.includes("\\") && !value.split("/").some((part) => !part || part === "." || part === "..");
}
function readManifest(root: string): Buffer {
  const relative = MANIFEST_PATH;
  const canonicalRoot = realpathSync(root);
  const absolute = path.resolve(canonicalRoot, relative);
  if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("invalid manifest path");
  let cursor = canonicalRoot;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("manifest symlink");
    if (cursor !== absolute && !stat.isDirectory()) throw new Error("manifest parent");
    if (cursor === absolute && (!stat.isFile() || stat.size > MAX_CONTROL_BYTES)) throw new Error("manifest size or type");
  }
  if (realpathSync(absolute) !== absolute) throw new Error("manifest path alias");
  return readBoundedRegularFile(absolute, MAX_CONTROL_BYTES);
}
function readBounded(root: string, relative: string, issues: string[], maxBytes = MAX_ARTIFACT_BYTES): Buffer | undefined {
  if (!safeRelative(relative)) { issues.push("evidence path is outside the permitted normalized directory"); return; }
  try {
    const canonicalRoot = realpathSync(root);
    const absolute = path.resolve(canonicalRoot, relative);
    if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("escape");
    let cursor = canonicalRoot;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error("symlink");
      if (cursor !== absolute && !stat.isDirectory()) throw new Error("parent");
      if (cursor === absolute && (!stat.isFile() || stat.size > maxBytes)) throw new Error("file type or size");
    }
    if (realpathSync(absolute) !== absolute) throw new Error("non-canonical");
    return readBoundedRegularFile(absolute, maxBytes);
  } catch {
    issues.push("evidence file is missing, symlinked, oversized, or not a root-contained regular file");
    return;
  }
}
function readArtifact(root: string, artifact: Artifact, issues: string[], cache: Map<string, Buffer>): Buffer | undefined {
  const existing = cache.get(artifact.path);
  if (existing) {
    if (sha256Bytes(existing) !== artifact.sha256) issues.push("artifact digest mismatch");
    return existing;
  }
  const bytes = readBounded(root, artifact.path, issues);
  if (bytes) {
    cache.set(artifact.path, bytes);
    if (sha256Bytes(bytes) !== artifact.sha256) issues.push("artifact digest mismatch");
  }
  return bytes;
}
function contractEvaluationPaths(root: string, issues: string[]): { labels: string; run: string; out: string } | undefined {
  try {
    const contractPath = path.join(realpathSync(root), "engineering-contract.json");
    const contractStat = lstatSync(contractPath);
    if (!contractStat.isFile() || contractStat.isSymbolicLink() || contractStat.size > MAX_CONTROL_BYTES || realpathSync(contractPath) !== contractPath) throw new Error("contract");
    const contract = JSON.parse(readBoundedRegularFile(contractPath, MAX_CONTROL_BYTES).toString("utf8")) as { checks?: Array<{ id?: string; command?: string[] }> };
    const check = contract.checks?.filter((item) => item.id === "real-source-jev-evaluation");
    if (check?.length !== 1) throw new Error("check");
    const argv = check[0]!.command ?? [];
    if (argv[0] !== "npm" || argv[1] !== "run" || argv[2] !== "evaluate:jev-labels" || argv[3] !== "--") throw new Error("command");
    const args = new Map<string, string>();
    for (let i = 4; i < argv.length; i += 2) {
      const key = argv[i]; const value = argv[i + 1];
      if (!(["--labels", "--run", "--out"] as string[]).includes(key ?? "") || !value || args.has(key!)) throw new Error("args");
      args.set(key!, value);
    }
    const labels = args.get("--labels"); const run = args.get("--run"); const out = args.get("--out");
    if (!labels || !run || !out || new Set([labels, run, out]).size !== 3 || [...args.values()].some((file) => !safeRelative(file) || path.posix.normalize(file) !== file)) throw new Error("paths");
    return { labels, run, out };
  } catch {
    issues.push("engineering contract does not declare one valid real-source evaluator command");
    return;
  }
}
function suppliedArtifacts(manifest: Manifest): Artifact[] {
  const artifacts: Artifact[] = [];
  if (manifest.run.status === "provided") artifacts.push(manifest.run.frozenLabelsArtifact, manifest.run.modelRunArtifact, manifest.run.evaluationReportArtifact, manifest.run.populationFrameArtifact, manifest.run.sampleProvenanceArtifact);
  for (const group of Object.values(manifest.groups)) if (group.status === "provided") artifacts.push(...group.artifacts);
  if (manifest.humanLabels.status === "provided") {
    artifacts.push(manifest.humanLabels.freezeChronologyArtifact);
    if (manifest.humanLabels.adjudication.status === "performed") artifacts.push(manifest.humanLabels.adjudication.artifact);
  }
  if (manifest.agentLabels?.status === "provided") {
    artifacts.push(manifest.agentLabels.freezeChronologyArtifact);
    if (manifest.agentLabels.adjudication.status === "performed") artifacts.push(manifest.agentLabels.adjudication.artifact);
  }
  return artifacts;
}
function activeGroups(manifest: Manifest): string[] {
  return manifest.agentLabels?.status === "provided"
    ? [...GROUPS.filter((group) => group !== "independent_human_labels"), "independent_agent_labels"]
    : [...GROUPS];
}
function allChecksTrue(review: ReviewRecord, groups: readonly string[]): boolean {
  return groups.every((group) => review.groupVerdicts[group as keyof ReviewRecord["groupVerdicts"]] === "approved") && review.verdict === "approved" &&
    groups.every((group) => Object.values(review.evidenceTypeChecks[group as keyof ReviewRecord["evidenceTypeChecks"]] ?? {}).every(Boolean));
}
export function buildApprovalSubject(manifest: Manifest, labels: LabelSet, run: ModelRun, report: Record<string, any>, labelsHash: string, runHash: string, reportHash: string, support: Artifact[]): Record<string, unknown> {
  if (manifest.run.status !== "provided" || (manifest.humanLabels.status !== "provided" && manifest.agentLabels?.status !== "provided")) throw new Error("verified evidence subject is incomplete");
  const groups = Object.fromEntries(activeGroups(manifest).map((name) => [name, manifest.groups[name as keyof Manifest["groups"]]]));
  return {
    run: {
      studyId: labels.studyId, runId: run.runId, labelsSha256: labelsHash, runSha256: runHash, reportSha256: reportHash,
      populationFrameSha256: labels.populationFrameSha256, sampleManifestSha256: labels.sampleManifestSha256,
      rubricSha256: labels.rubricSha256, codeRevisionSha256: labels.analysisCodeRevision, requestedModel: run.requestedModel,
      resolvedModel: report.provenance?.resolvedModels?.length === 1 ? report.provenance.resolvedModels[0] : null,
    },
    groups,
    artifacts: support.map(({ path: ref, evidenceType, sha256, authoredBy, reviewedBy }) => ({ path: ref, evidenceType, sha256, authoredBy, reviewedBy })).sort((a, b) => a.path.localeCompare(b.path)),
    labelAuthority: labels.schemaVersion === 3 ? {
      kind: "independent_subagents",
      reviewers: manifest.agentLabels?.status === "provided" ? manifest.agentLabels.reviewers : [],
      frozenAt: labels.frozenAt,
      jevOutputsOpenedAt: labels.agentLabelProtocol.jevOutputsOpenedAt,
      historicalHumanReconciliation: manifest.humanLabels.status === "missing" ? manifest.humanLabels.reason : "provided separately",
      adjudication: manifest.agentLabels?.status === "provided" ? manifest.agentLabels.adjudication : null,
    } : manifest.humanLabels.status === "provided" ? {
      kind: "qualified_human_reviewers",
      labelSetA: { reviewerId: manifest.humanLabels.labelSetA.reviewerId, qualifiedHumanAttested: manifest.humanLabels.labelSetA.qualifiedHumanAttested },
      labelSetB: { reviewerId: manifest.humanLabels.labelSetB.reviewerId, qualifiedHumanAttested: manifest.humanLabels.labelSetB.qualifiedHumanAttested },
      frozenAt: labels.frozenAt, samplingWindowStart: labels.samplingWindowStart, samplingWindowEnd: labels.samplingWindowEnd,
      adjudication: manifest.humanLabels.adjudication,
    } : { kind: "qualified_human_reviewers", status: "missing", reason: manifest.humanLabels.reason },
  };
}

export function validateManifest(root: string): ValidationSummary {
  const issues: string[] = [];
  const missingGroups: ValidationSummary["missingGroups"] = [];
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(readManifest(root).toString("utf8")));
  } catch {
    return { result: "BLOCKED", manifest: MANIFEST_PATH, missingGroups: GROUPS.map((group) => ({ group, reason: "manifest missing or invalid" })), issues: ["manifest missing or does not match strict schema"], limitation: LIMITATION };
  }

  const requiredGroups = activeGroups(manifest);
  for (const name of requiredGroups) {
    const group = manifest.groups[name as keyof Manifest["groups"]];
    if (!group) { missingGroups.push({ group: name, reason: "agent label evidence group missing" }); continue; }
    if (group.status === "missing") missingGroups.push({ group: name, reason: group.reason });
    else {
      const types = new Set(group.artifacts.map((artifact) => artifact.evidenceType));
      const absent = groupEvidenceTypes[name as keyof typeof groupEvidenceTypes].filter((type) => !types.has(type));
      if (absent.length) issues.push(`evidence group ${name} lacks required evidence types`);
    }
  }
  if (manifest.run.status === "missing") issues.push(`run bindings missing: ${manifest.run.reason}`);
  if (manifest.humanLabels.status === "missing" && manifest.agentLabels?.status !== "provided") issues.push(`human labels missing: ${manifest.humanLabels.reason}`);
  if (manifest.agentLabels?.status === "missing" && manifest.humanLabels.status !== "provided") issues.push(`independent agent labels missing: ${manifest.agentLabels.reason}`);
  if (manifest.independentReview.status === "unresolved") issues.push(`independent evidence review unresolved: ${manifest.independentReview.reason}`);
  if (manifest.status === "verified" && (manifest.run.status !== "provided" || (manifest.humanLabels.status !== "provided" && manifest.agentLabels?.status !== "provided") || missingGroups.length)) issues.push("verified status requires complete run, an explicit label authority, and all current evidence groups");

  const support = suppliedArtifacts(manifest);
  const supportPaths = support.map((artifact) => artifact.path);
  const refs = new Map<string, string>();
  for (const artifact of support) {
    const binding = canonicalizeEvidence(artifact);
    if (refs.has(artifact.path) && refs.get(artifact.path) !== binding) issues.push("conflicting duplicate supporting artifact references");
    refs.set(artifact.path, binding);
  }
  for (const artifact of support) {
    if (artifact.authoredBy === artifact.reviewedBy) issues.push("supporting artifact lacks independent review attribution");
    if (manifest.independentReview.status === "resolved" && artifact.authoredBy === manifest.independentReview.reviewerId) issues.push("independent reviewer authored supporting evidence");
  }
  const cache = new Map<string, Buffer>();
  for (const artifact of support) readArtifact(root, artifact, issues, cache);

  const reviewArtifact = manifest.independentReview.status === "resolved" ? manifest.independentReview.artifact : undefined;
  let parsedReview: ReviewRecord | undefined;
  if (reviewArtifact) {
    if (reviewArtifact.path !== REVIEW_RECORD_PATH) issues.push("review artifact does not use the fixed reviewer-record path");
    if (manifest.independentReview.status === "resolved" && reviewArtifact.authoredBy !== manifest.independentReview.reviewerId) issues.push("reviewer ID does not match reviewer-record authorship");
    if (supportPaths.includes(reviewArtifact.path)) issues.push("duplicate reviewer-record reference");
    const bytes = readArtifact(root, reviewArtifact, issues, cache);
    if (bytes) {
      try { parsedReview = reviewRecordSchema.parse(JSON.parse(bytes.toString("utf8"))); }
      catch (error) { issues.push(`reviewer record is malformed or incomplete: ${error instanceof Error ? error.message.slice(0, 500) : "invalid schema"}`); }
    }
  }

  const paths = contractEvaluationPaths(root, issues);
  if (!manifest.run || manifest.run.status !== "provided" || (manifest.humanLabels.status !== "provided" && manifest.agentLabels?.status !== "provided") || missingGroups.length || !parsedReview || !paths || issues.length) {
    return { result: "BLOCKED", manifest: MANIFEST_PATH, missingGroups, issues, limitation: LIMITATION };
  }
  const referenced = [manifest.run.frozenLabelsArtifact, manifest.run.modelRunArtifact, manifest.run.evaluationReportArtifact, manifest.run.populationFrameArtifact, manifest.run.sampleProvenanceArtifact];
  const [labelsArtifact, modelRunArtifact, reportArtifact] = referenced;
  if (labelsArtifact!.path !== paths.labels || modelRunArtifact!.path !== paths.run || reportArtifact!.path !== paths.out || paths.labels !== `${EVIDENCE_PREFIX}jev-independent-real-source-labels.json` || paths.run !== `${EVIDENCE_PREFIX}jev-independent-real-source-run.json` || paths.out !== `${EVIDENCE_PREFIX}jev-independent-real-source-report.json`) issues.push("manifest run artifact paths do not match the fixed contract evaluator arguments");
  if (manifest.independentReview.status !== "resolved" || manifest.independentReview.verdict !== "approved" || parsedReview.verdict !== "approved" || parsedReview.reviewerId !== manifest.independentReview.reviewerId) issues.push("independent reviewer approval is not resolved and approved");
  if (issues.length) return { result: "BLOCKED", manifest: MANIFEST_PATH, missingGroups, issues, limitation: LIMITATION };

  try {
    const readInput = (artifact: Artifact): { bytes: Buffer; value: unknown } => {
      const bytes = cache.get(artifact.path);
      if (!bytes) throw new Error("required evaluator input was not hash-verified");
      return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
    };
    const labelsFile = readInput(labelsArtifact!); const runFile = readInput(modelRunArtifact!);
    const labels = parseLabelSet(labelsFile.value); const modelRun = parseModelRun(runFile.value);
    try { verifyFrozenCode(labels, root, ["scripts/verify-jev-real-source-evidence.ts"]); }
    catch (error) {
      issues.push(error instanceof Error ? error.message : "frozen evaluator source identity could not be verified");
      return { result: "BLOCKED", manifest: MANIFEST_PATH, missingGroups, issues, limitation: LIMITATION };
    }
    const labelsSha256 = sha256Bytes(labelsFile.bytes); const runSha256 = sha256Bytes(runFile.bytes);
    const computed = analyzeFinal({ labels, labelsSha256, run: modelRun });
    const expectedReport = Buffer.from(`${JSON.stringify(computed, null, 2)}\n`, "utf8");
    const actualReport = cache.get(reportArtifact!.path);
    if (labels.schemaVersion === 3
      ? (computed.humanGroundTruth !== "NOT_PROVIDED" || computed.statisticalCertification !== "UNVERIFIED" ||
        (labels.evaluationProfile === "sec_edgar_product24_diagnostic_v1" && (computed.status !== "PASS" || computed.agentReferenceAgreementStatus !== "PASS" || computed.provenanceExecutionStatus !== "PASS")))
      : computed.status !== "PASS") issues.push("offline evaluator report does not match the frozen label-authority status");
    if (!actualReport || !actualReport.equals(expectedReport)) issues.push("saved report bytes differ from recomputed offline evaluator output");
    if (labelsSha256 !== manifest.run.labelsSha256 || runSha256 !== manifest.run.runSha256 || !actualReport || sha256Bytes(actualReport) !== manifest.run.reportSha256) issues.push("run input or report digest differs from manifest bindings");
    const resolvedModels = (computed.provenance as { resolvedModels?: string[] }).resolvedModels ?? [];
    const populationValue = readInput(manifest.run.populationFrameArtifact).value;
    const sampleValue = readInput(manifest.run.sampleProvenanceArtifact).value;
    const populationDigest = Array.isArray(populationValue) ? sampleManifestSha256(populationValue as Parameters<typeof sampleManifestSha256>[0]) : "";
    const sampleDigest = Array.isArray(sampleValue) ? sampleManifestSha256(sampleValue as Parameters<typeof sampleManifestSha256>[0]) : "";
    if (labels.studyId !== manifest.run.studyId || modelRun.runId !== manifest.run.runId || resolvedModels.length !== 1 || resolvedModels[0] !== manifest.run.resolvedJevModel || computed.provenance?.rubricSha256 !== manifest.run.rubricSha256 || hash(labels.analysisCodeRevision) !== manifest.run.codeRevisionSha256 || labels.populationFrameSha256 !== manifest.run.populationSha256 || labels.sampleManifestSha256 !== manifest.run.sampleSha256 || populationDigest !== labels.populationFrameSha256 || sampleDigest !== labels.sampleManifestSha256) issues.push("derived run identity, model, rubric, code, population, or sample binding differs from manifest");
    if (labels.schemaVersion === 3) {
      if (manifest.agentLabels?.status !== "provided" || canonicalizeEvidence(manifest.agentLabels.reviewers) !== canonicalizeEvidence(labels.reviewers.map(({ id, kind, agentThreadId, configuredModel, resolvedModel, modelResolutionEvidence }) => ({ id, kind, agentThreadId, configuredModel, resolvedModel, modelResolutionEvidence })))) {
        issues.push("agent label declarations differ from the frozen agent roster");
      }
      if (manifest.agentLabels?.status === "provided") {
        const chronology = cache.get(manifest.agentLabels.freezeChronologyArtifact.path);
        try {
          const declared = chronology ? JSON.parse(chronology.toString("utf8")) as Record<string, unknown> : undefined;
          if (declared?.frozenAt !== labels.agentLabelProtocol.frozenAt || declared?.jevOutputsOpenedAt !== labels.agentLabelProtocol.jevOutputsOpenedAt || Date.parse(String(declared?.jevOutputsOpenedAt)) < Date.parse(String(declared?.frozenAt))) issues.push("agent blind-freeze chronology does not match frozen labels");
        } catch { issues.push("agent blind-freeze chronology artifact is not valid JSON"); }
      }
    } else if (manifest.humanLabels.status !== "provided" || manifest.humanLabels.labelSetA.reviewerId !== labels.reviewers[0]?.id || manifest.humanLabels.labelSetB.reviewerId !== labels.reviewers[1]?.id) {
      issues.push("human label declarations differ from the frozen label roster");
    }
    if (manifest.independentReview.status === "resolved" && [...labels.reviewers.map((reviewer) => reviewer.id), ...support.map((artifact) => artifact.authoredBy)].includes(manifest.independentReview.reviewerId)) issues.push("independent reviewer must differ from every label reviewer and supporting artifact author");
    const actualAdjudications = labels.items.flatMap((item) => item.adjudication ? [{ observationId: item.observationId, ...item.adjudication }] : []);
    const adjudicationDeclaration = labels.schemaVersion === 3 ? manifest.agentLabels?.status === "provided" ? manifest.agentLabels.adjudication : undefined : manifest.humanLabels.status === "provided" ? manifest.humanLabels.adjudication : undefined;
    if (!adjudicationDeclaration) issues.push("label-authority adjudication declaration is missing");
    else if (actualAdjudications.length === 0 && adjudicationDeclaration.status !== "not_needed") issues.push("manifest adjudication status conflicts with frozen labels that need no adjudication");
    else if (actualAdjudications.length > 0 && adjudicationDeclaration.status !== "performed") issues.push("manifest adjudication status omits adjudications required by frozen labels");
    if (adjudicationDeclaration?.status === "performed") {
      const adjudicationBytes = cache.get(adjudicationDeclaration.artifact.path);
      try {
        const declared = adjudicationBytes ? JSON.parse(adjudicationBytes.toString("utf8")) as unknown : undefined;
        if (canonicalizeEvidence(declared) !== canonicalizeEvidence(actualAdjudications)) issues.push("adjudication artifact does not match adjudications in the frozen labels");
      } catch { issues.push("adjudication artifact is not valid JSON"); }
    }
    const subject = buildApprovalSubject(manifest, labels, modelRun, computed, labelsSha256, runSha256, sha256Bytes(expectedReport), support);
    const expectedGroupDigests = Object.fromEntries(requiredGroups.map((group) => [group, digestEvidence(manifest.groups[group as keyof Manifest["groups"]])]));
    if (canonicalizeEvidence(parsedReview.approvalSubject) !== canonicalizeEvidence(subject)) issues.push("review approval subject differs from current evidence package");
    if (canonicalizeEvidence(parsedReview.groupDigests) !== canonicalizeEvidence(expectedGroupDigests)) issues.push("review group digests differ from current evidence package");
    if (!allChecksTrue(parsedReview, requiredGroups)) issues.push("review record contains rejected or unconfirmed evidence checks");
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : "unknown evaluator failure";
    issues.push(`offline evaluator inputs failed strict parsing or recomputation: ${detail}`);
  }

  return { result: manifest.status === "verified" && issues.length === 0 ? "PASS" : "BLOCKED", manifest: MANIFEST_PATH, missingGroups, issues, limitation: LIMITATION };
}

const LIMITATION = "A structural pass does not itself establish legal or account approval, provider authenticity, permitted source rights, or human or agent identity.";
if (isDirectScriptInvocation(import.meta.url)) {
  const summary = validateManifest(process.cwd());
  console.log(JSON.stringify(summary));
  if (summary.result !== "PASS") process.exitCode = 2;
}
