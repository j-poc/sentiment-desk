import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeFinal, parseLabelSet, parseModelRun, sampleManifestSha256 } from "../scripts/jev-label-evaluation.js";
import { MANIFEST_PATH, REVIEW_RECORD_PATH, buildApprovalSubject, digestEvidence, validateManifest } from "../scripts/verify-jev-real-source-evidence.js";
import { wellSupportedFinalStudy } from "./helpers/jev-real-source-fixture.js";

const PREFIX = ".engineering-evidence/real-source/";
const tempRoots: string[] = [];
const evidenceTypes: Record<string, string[]> = {
  provider_authenticity_usage: ["provider_request_result_receipts", "provider_usage_billing_reconciliation", "unknown_outcomes_reconciliation"],
  sec_source_correspondence: ["sec_filing_receipt_version_timestamp", "permitted_source_excerpt", "exact_jev_payload_digest_chain", "collector_parser_versions"],
  typesafe_account_and_spend: ["typesafe_account_terms_and_use", "telemetry_retention", "approved_prices_limits_refill", "numeric_spend_ceiling", "usage_billing_rejected_request_reconciliation", "sec_contact", "source_rights_matrix"],
  independent_human_labels: ["label_set_a", "label_set_b", "reviewer_qualification_independence", "blind_freeze_chronology", "adjudication_or_not_needed"],
};
const agentEvidenceTypes = {
  provider_authenticity_usage: evidenceTypes.provider_authenticity_usage,
  sec_source_correspondence: evidenceTypes.sec_source_correspondence,
  typesafe_account_and_spend: evidenceTypes.typesafe_account_and_spend,
  independent_agent_labels: ["agent_label_set_a", "agent_label_set_b", "agent_identity_and_model_configuration", "reviewer_independence", "blind_freeze_chronology", "agent_adjudication_or_not_needed"],
};
function root(): string { const value = mkdtempSync(path.join(os.tmpdir(), "jev-real-evidence-test-")); tempRoots.push(value); return value; }
function sha(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function saveJson(dir: string, rel: string, value: unknown): { path: string; sha256: string } {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const absolute = path.join(dir, rel); mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, bytes);
  return { path: rel, sha256: sha(bytes) };
}
function saveReview(dir: string, pkg: { manifest: any; review: any }) {
  const ref = saveJson(dir, REVIEW_RECORD_PATH, pkg.review);
  pkg.manifest.independentReview.artifact.sha256 = ref.sha256;
  saveJson(dir, MANIFEST_PATH, pkg.manifest);
}
function rebindEvaluation(dir: string, pkg: any) {
  const labelValue = JSON.parse(readFileSync(path.join(dir, pkg.manifest.run.frozenLabelsArtifact.path), "utf8"));
  const labelsRef = saveJson(dir, pkg.manifest.run.frozenLabelsArtifact.path, labelValue);
  const runValue = JSON.parse(readFileSync(path.join(dir, pkg.manifest.run.modelRunArtifact.path), "utf8"));
  runValue.labelsSha256 = labelsRef.sha256; runValue.codeRevision = labelValue.analysisCodeRevision;
  const runRef = saveJson(dir, pkg.manifest.run.modelRunArtifact.path, runValue);
  const labels = parseLabelSet(labelValue); const run = parseModelRun(runValue);
  const report = analyzeFinal({ labels, labelsSha256: labelsRef.sha256, run });
  const reportRef = saveJson(dir, pkg.manifest.run.evaluationReportArtifact.path, report);
  Object.assign(pkg.manifest.run, { labelsSha256: labelsRef.sha256, runSha256: runRef.sha256, reportSha256: reportRef.sha256, codeRevisionSha256: sha(labels.analysisCodeRevision) });
  Object.assign(pkg.manifest.run.frozenLabelsArtifact, labelsRef);
  Object.assign(pkg.manifest.run.modelRunArtifact, runRef);
  Object.assign(pkg.manifest.run.evaluationReportArtifact, reportRef);
  const support = [pkg.manifest.run.frozenLabelsArtifact, pkg.manifest.run.modelRunArtifact, pkg.manifest.run.evaluationReportArtifact, pkg.manifest.run.populationFrameArtifact, pkg.manifest.run.sampleProvenanceArtifact,
    ...Object.values(pkg.manifest.groups).flatMap((group: any) => group.artifacts), pkg.manifest.humanLabels.freezeChronologyArtifact];
  if (pkg.manifest.humanLabels.adjudication.status === "performed") support.push(pkg.manifest.humanLabels.adjudication.artifact);
  pkg.review.approvalSubject = buildApprovalSubject(pkg.manifest, labels, run, report, labelsRef.sha256, runRef.sha256, reportRef.sha256, support);
  saveReview(dir, pkg);
}
function initializeSyntheticCheckout(dir: string) {
  execFileSync("git", ["init", "-q", dir]);
  for (const relative of ["scripts/evaluate-jev-labels.ts", "scripts/jev-label-evaluation.ts", "scripts/verify-jev-real-source-evidence.ts", "server/rubric.ts", "config/companies.json"]) {
    const source = path.join(process.cwd(), relative); const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true }); cpSync(source, target);
  }
  writeFileSync(path.join(dir, ".gitignore"), ".engineering-evidence/\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Synthetic Evidence Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "synthetic validator fixture"]);
}
function commitSyntheticCheckout(dir: string, message: string) {
  execFileSync("git", ["-C", dir, "add", "scripts/evaluate-jev-labels.ts"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Synthetic Evidence Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", message]);
}
function createPackage(dir: string, agentMode = false) {
  initializeSyntheticCheckout(dir);
  const revision = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const study = wellSupportedFinalStudy(revision);
  const agentIds = ["agent-a", "agent-b"];
  const configuredCompanyIds = agentMode ? (JSON.parse(readFileSync(path.join(process.cwd(), "config/companies.json"), "utf8")) as { companies: Array<{ id: string }> }).companies.map(({ id }) => id).sort() : [];
  const companyIds = configuredCompanyIds.slice(0, 8);
  const productUniverseSha256 = agentMode ? sha(JSON.stringify(configuredCompanyIds)) : undefined;
  const labelArtifact = agentMode ? {
    ...study.labelArtifact,
    schemaVersion: 3 as const,
    evaluationProfile: "sec_edgar_product24_diagnostic_v1" as const,
    productCompanyUniverseSha256: productUniverseSha256,
    reviewers: agentIds.map((id) => ({ id, kind: "independent_subagent" as const, agentThreadId: `thread-${id}`, configuredModel: "gpt-6-luna", resolvedModel: null, modelResolutionEvidence: null, independenceAttested: true as const, blindedToJevOutputsAttested: true as const })),
    agentLabelProtocol: { version: "independent-subagents-blinded-v1" as const, frozenAt: study.labelArtifact.frozenAt, jevOutputsOpenedAt: study.run.startedAt },
    populationFrame: study.labelArtifact.populationFrame.map((item, index) => ({ ...item, companyId: companyIds[index % companyIds.length]! })),
    items: study.labelArtifact.items.map((item, index) => ({ ...item, companyId: companyIds[index % companyIds.length]!, reviews: item.reviews.map((review, index) => ({ ...review, reviewerId: agentIds[index]! })) })),
  } : study.labelArtifact;
  if (agentMode) {
    (labelArtifact as any).populationFrameSha256 = sampleManifestSha256(labelArtifact.populationFrame);
    (labelArtifact as any).sampleManifestSha256 = sampleManifestSha256(labelArtifact.items);
  }
  const labelBytes = Buffer.from(`${JSON.stringify(labelArtifact, null, 2)}\n`);
  const runValue = { ...study.run, labelsSha256: sha(labelBytes), sampleManifestSha256: labelArtifact.sampleManifestSha256 };
  const runBytes = Buffer.from(`${JSON.stringify(runValue, null, 2)}\n`);
  const labels = parseLabelSet(JSON.parse(labelBytes.toString("utf8")));
  const run = parseModelRun(JSON.parse(runBytes.toString("utf8")));
  const report = analyzeFinal({ labels, labelsSha256: sha(labelBytes), run });
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const [labelsRef, runRef, reportRef] = [
    saveJson(dir, `${PREFIX}jev-independent-real-source-labels.json`, labelArtifact),
    saveJson(dir, `${PREFIX}jev-independent-real-source-run.json`, runValue),
    saveJson(dir, `${PREFIX}jev-independent-real-source-report.json`, report),
  ];
  const populationFrameArtifact = saveJson(dir, `${PREFIX}population-frame.json`, labelArtifact.populationFrame);
  const sampleProvenanceArtifact = saveJson(dir, `${PREFIX}sample-provenance.json`, labelArtifact.items.map(({ reviews: _reviews, ...row }) => row));
  const reviewerId = "independent-reviewer-c";
  function artifact(type: string, author = "source-author") {
    const ref = saveJson(dir, `${PREFIX}${type}.json`, { synthetic: type });
    return { ...ref, evidenceType: type, authoredBy: author, reviewedBy: reviewerId };
  }
  const selectedEvidenceTypes = agentMode ? agentEvidenceTypes : evidenceTypes;
  const groups = Object.fromEntries(Object.entries(selectedEvidenceTypes).map(([group, types]) => [group, { status: "provided", artifacts: (types ?? []).map((type) => artifact(type, type === "label_set_a" ? "reviewer-a" : type === "label_set_b" ? "reviewer-b" : type === "agent_label_set_a" ? "agent-a" : type === "agent_label_set_b" ? "agent-b" : "source-author")) }])) as Record<string, any>;
  if (agentMode) groups.independent_human_labels = { status: "missing", reason: "historical human rows remain quarantined and unreconciled" };
  const runArtifacts = {
    status: "provided", studyId: labels.studyId, runId: run.runId, resolvedJevModel: report.provenance.resolvedModels[0], rubricSha256: labels.rubricSha256,
    codeRevisionSha256: sha(labels.analysisCodeRevision), labelsSha256: labelsRef.sha256, runSha256: runRef.sha256, reportSha256: reportRef.sha256,
    populationSha256: labels.populationFrameSha256, sampleSha256: labels.sampleManifestSha256,
    frozenLabelsArtifact: { ...labelsRef, evidenceType: "frozen_labels", authoredBy: agentMode ? "agent-a" : "reviewer-a", reviewedBy: reviewerId },
    modelRunArtifact: { ...runRef, evidenceType: "model_run", authoredBy: "source-author", reviewedBy: reviewerId },
    evaluationReportArtifact: { ...reportRef, evidenceType: "evaluation_report", authoredBy: "source-author", reviewedBy: reviewerId },
    populationFrameArtifact: { ...populationFrameArtifact, evidenceType: "population_frame", authoredBy: "source-author", reviewedBy: reviewerId },
    sampleProvenanceArtifact: { ...sampleProvenanceArtifact, evidenceType: "sample_provenance", authoredBy: "source-author", reviewedBy: reviewerId },
  };
  const freezeChronologyArtifact = agentMode ? (() => {
    const ref = saveJson(dir, `${PREFIX}agent-freeze-chronology.json`, { frozenAt: labelArtifact.frozenAt, jevOutputsOpenedAt: (labelArtifact as any).agentLabelProtocol.jevOutputsOpenedAt });
    return { ...ref, evidenceType: "blind_freeze_chronology", authoredBy: "source-author", reviewedBy: reviewerId };
  })() : undefined;
  const manifest: any = {
    schemaVersion: 1, status: "verified", run: runArtifacts, groups,
    humanLabels: agentMode ? { status: "missing", reason: "historical human rows remain quarantined and unreconciled" } : { status: "provided", labelSetA: { reviewerId: "reviewer-a", qualifiedHumanAttested: true }, labelSetB: { reviewerId: "reviewer-b", qualifiedHumanAttested: true }, freezeChronologyArtifact: artifact("freeze-chronology"), adjudication: { status: "not_needed", reason: "Synthetic fixture has no disagreement." } },
    ...(agentMode ? { agentLabels: { status: "provided", reviewers: labelArtifact.reviewers.map(({ id, kind, agentThreadId, configuredModel, resolvedModel, modelResolutionEvidence }: any) => ({ id, kind, agentThreadId, configuredModel, resolvedModel, modelResolutionEvidence })), freezeChronologyArtifact, adjudication: { status: "not_needed", reason: "Synthetic agent labels have no disagreement." } } } : {}),
    independentReview: { status: "resolved", reviewerId, verdict: "approved", artifact: null },
  };
  const allArtifacts = [runArtifacts.frozenLabelsArtifact, runArtifacts.modelRunArtifact, runArtifacts.evaluationReportArtifact, runArtifacts.populationFrameArtifact, runArtifacts.sampleProvenanceArtifact,
    ...Object.values(groups).flatMap((group: any) => group.status === "provided" ? group.artifacts : []), agentMode ? freezeChronologyArtifact : manifest.humanLabels.freezeChronologyArtifact];
  manifest.independentReview.artifact = { ...saveJson(dir, REVIEW_RECORD_PATH, {}), evidenceType: "independent_review_record", authoredBy: reviewerId, reviewedBy: reviewerId };
  // Excluding the review record avoids a circular hash.
  const subject = buildApprovalSubject(manifest, labels, run, report, labelsRef.sha256, runRef.sha256, sha(reportBytes), allArtifacts);
  const checks = Object.fromEntries(Object.entries(selectedEvidenceTypes).map(([group, types]) => [group, Object.fromEntries((types ?? []).map((type) => [type, true]))]));
  const review = {
    schemaVersion: 1, reviewerId, verdict: "approved", approvalSubject: subject,
    groupDigests: Object.fromEntries(Object.entries(groups).filter(([group]) => !agentMode || group !== "independent_human_labels").map(([group, value]) => [group, digestEvidence(value)])),
    groupVerdicts: Object.fromEntries(Object.keys(groups).filter((group) => !agentMode || group !== "independent_human_labels").map((group) => [group, "approved"])), evidenceTypeChecks: checks,
  };
  const reviewRef = saveJson(dir, REVIEW_RECORD_PATH, review);
  manifest.independentReview.artifact = { ...reviewRef, evidenceType: "independent_review_record", authoredBy: reviewerId, reviewedBy: reviewerId };
  saveJson(dir, MANIFEST_PATH, manifest);
  saveJson(dir, "engineering-contract.json", { checks: [{ id: "real-source-jev-evaluation", command: ["npm", "run", "evaluate:jev-labels", "--", "--labels", `${PREFIX}jev-independent-real-source-labels.json`, "--run", `${PREFIX}jev-independent-real-source-run.json`, "--out", `${PREFIX}jev-independent-real-source-report.json`] }] });
  return { manifest, review, labelsRef, runRef, reportRef };
}
let template: { dir: string; pkg: ReturnType<typeof createPackage> } | undefined;
beforeAll(() => {
  const templateDir = mkdtempSync(path.join(os.tmpdir(), "jev-real-evidence-template-"));
  try {
    template = { dir: templateDir, pkg: createPackage(templateDir) };
  } catch (error) {
    rmSync(templateDir, { recursive: true, force: true });
    throw error;
  }
}, 60_000);
function makePackage(dir: string) {
  if (!template) throw new Error("evidence test template was not initialized");
  cpSync(template.dir, dir, { recursive: true });
  return JSON.parse(JSON.stringify(template.pkg));
}
afterEach(async () => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Let the worker receive reporting acknowledgements between synchronous checks.
  await new Promise<void>((resolve) => setImmediate(resolve));
});
afterAll(() => { if (template) rmSync(template.dir, { recursive: true, force: true }); });

describe("real-source evidence package validator", () => {
  it("runs the CLI validation when its checkout path contains spaces", () => {
    const dir = path.join(root(), "checkout with spaces");
    for (const relative of ["scripts/verify-jev-real-source-evidence.ts", "scripts/evaluate-jev-labels.ts", "scripts/jev-label-evaluation.ts", "server/rubric.ts", "config/companies.json"]) {
      const target = path.join(dir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.resolve(relative), target);
    }
    symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "dir");
    const result = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.join(dir, "scripts/verify-jev-real-source-evidence.ts")], { cwd: dir, encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: "BLOCKED", issues: ["manifest missing or does not match strict schema"] });
  });

  it("requires a manifest and all four evidence groups", () => {
    const result = validateManifest(root());
    expect(result.result).toBe("BLOCKED"); expect(result.missingGroups).toHaveLength(4);
  });
  it("accepts a complete synthetic typed package in an isolated clean Git checkout", () => {
    const dir = root(); const pkg = makePackage(dir);
    expect(pkg.manifest.run.populationFrameArtifact.sha256).not.toBe(pkg.manifest.run.populationSha256);
    expect(pkg.manifest.run.sampleProvenanceArtifact.sha256).not.toBe(pkg.manifest.run.sampleSha256);
    const result = validateManifest(dir);
    expect(result).toMatchObject({ result: "PASS", missingGroups: [], issues: [] });
  });
  it("accepts a scoped product24 agent package while leaving historical human reconciliation explicitly missing", () => {
    const dir = root();
    const pkg = createPackage(dir, true);
    const result = validateManifest(dir);
    expect(pkg.manifest.humanLabels).toMatchObject({ status: "missing", reason: expect.stringContaining("quarantined") });
    expect(pkg.manifest.agentLabels.status).toBe("provided");
    expect(result).toMatchObject({ result: "PASS", missingGroups: [], issues: [] });
  });
  it("rejects duplicate contract flags", () => {
    const dir = root(); makePackage(dir);
    const contract = JSON.parse(readFileSync(path.join(dir, "engineering-contract.json"), "utf8"));
    contract.checks[0].command.push("--labels", `${PREFIX}jev-independent-real-source-labels.json`);
    writeFileSync(path.join(dir, "engineering-contract.json"), JSON.stringify(contract));
    expect(validateManifest(dir).issues).toContain("engineering contract does not declare one valid real-source evaluator command");
  });
  it("rejects contract paths that disagree with the declared run artifacts", () => {
    const pathDir = root(); const pathPkg = makePackage(pathDir);
    const wrong = JSON.parse(readFileSync(path.join(pathDir, "engineering-contract.json"), "utf8"));
    wrong.checks[0].command[5] = `${PREFIX}alternate-labels.json`;
    writeFileSync(path.join(pathDir, "engineering-contract.json"), JSON.stringify(wrong));
    expect(validateManifest(pathDir).issues).toContain("manifest run artifact paths do not match the fixed contract evaluator arguments");
    expect(pathPkg.manifest.run.frozenLabelsArtifact.path).toBe(`${PREFIX}jev-independent-real-source-labels.json`);
  });
  it("rejects input/output path aliases", () => {
    const aliasDir = root(); makePackage(aliasDir);
    const alias = JSON.parse(readFileSync(path.join(aliasDir, "engineering-contract.json"), "utf8"));
    alias.checks[0].command[9] = `${PREFIX}jev-independent-real-source-labels.json`;
    writeFileSync(path.join(aliasDir, "engineering-contract.json"), JSON.stringify(alias));
    expect(validateManifest(aliasDir).issues).toContain("engineering contract does not declare one valid real-source evaluator command");
  });
  it("rejects a reviewer record with an invalid schema", () => {
    const malformedDir = root(); const malformed = makePackage(malformedDir);
    delete malformed.review.groupDigests; saveReview(malformedDir, malformed);
    expect(validateManifest(malformedDir).issues.some((issue) => issue.startsWith("reviewer record is malformed or incomplete"))).toBe(true);
  });
  it("rejects a negative independent reviewer verdict", () => {
    const dir = root(); const pkg = makePackage(dir);
    pkg.review.verdict = "rejected"; saveReview(dir, pkg);
    expect(validateManifest(dir).issues).toContain("independent reviewer approval is not resolved and approved");
  });
  it("rejects changes to an artifact author after approval", () => {
    const dir = root(); const pkg = makePackage(dir);
    pkg.manifest.run.modelRunArtifact.authoredBy = "changed-author";
    saveJson(dir, MANIFEST_PATH, pkg.manifest);
    expect(validateManifest(dir).issues).toContain("review approval subject differs from current evidence package");
  });
  it("rejects a rejected evidence-group verdict", () => {
    const typesDir = root(); const types = makePackage(typesDir);
    types.review.groupVerdicts.provider_authenticity_usage = "rejected"; saveReview(typesDir, types);
    expect(validateManifest(typesDir).issues).toContain("review record contains rejected or unconfirmed evidence checks");
  });
  it("requires every evidence type to be explicitly confirmed", () => {
    const typesDir = root(); const types = makePackage(typesDir);
    delete types.review.evidenceTypeChecks.provider_authenticity_usage.unknown_outcomes_reconciliation; saveReview(typesDir, types);
    expect(validateManifest(typesDir).issues.some((issue) => issue.startsWith("reviewer record is malformed or incomplete"))).toBe(true);
  });
  it("rejects review group digests that do not match the package", () => {
    const digestDir = root(); const digestPkg = makePackage(digestDir);
    digestPkg.review.groupDigests.provider_authenticity_usage = "0".repeat(64); saveReview(digestDir, digestPkg);
    expect(validateManifest(digestDir).issues).toContain("review group digests differ from current evidence package");
  });
  it("allows reviewer authorship of their own review record but rejects reviewer identity conflicts", () => {
    const dir = root(); const pkg = makePackage(dir);
    expect(pkg.manifest.independentReview.artifact.authoredBy).toBe(pkg.manifest.independentReview.reviewerId);
    expect(validateManifest(dir)).toMatchObject({ result: "PASS", issues: [] });
    pkg.manifest.independentReview.reviewerId = "reviewer-a"; saveJson(dir, MANIFEST_PATH, pkg.manifest);
    expect(validateManifest(dir).issues).toContain("reviewer ID does not match reviewer-record authorship");
  });
  function addSyntheticAdjudication(dir: string, pkg: any) {
    const labels = JSON.parse(readFileSync(path.join(dir, pkg.labelsRef.path), "utf8"));
    labels.reviewers.push({ id: "adjudicator-c", qualifiedHumanAttested: true });
    const item = labels.items[0];
    item.reviews[1].labels.sentiment = item.reviews[0].labels.sentiment === "positive" ? "negative" : "positive";
    item.adjudication = { reviewerId: "adjudicator-c", labels: item.reviews[0].labels, rationale: "Adjudication follows the cited filing evidence." };
    saveJson(dir, pkg.labelsRef.path, labels);
    const adjudications = [{ observationId: item.observationId, ...item.adjudication }];
    const adjudicationRef = saveJson(dir, `${PREFIX}adjudications.json`, adjudications);
    pkg.manifest.humanLabels.adjudication = { status: "performed", artifact: { ...adjudicationRef, evidenceType: "adjudication_record", authoredBy: "source-author", reviewedBy: "independent-reviewer-c" } };
    rebindEvaluation(dir, pkg);
  }
  it("accepts a performed adjudication that matches frozen disagreements", () => {
    const dir = root(); const pkg = makePackage(dir);
    addSyntheticAdjudication(dir, pkg);
    expect(validateManifest(dir)).toMatchObject({ result: "PASS", issues: [] });
  });
  it("rejects an adjudication record whose content differs from frozen labels", () => {
    const dir = root(); const pkg = makePackage(dir);
    addSyntheticAdjudication(dir, pkg);
    const artifact = pkg.manifest.humanLabels.adjudication.artifact;
    const changed = saveJson(dir, artifact.path, []);
    artifact.sha256 = changed.sha256;
    const subjectArtifact = pkg.review.approvalSubject.artifacts.find((item: any) => item.path === artifact.path);
    subjectArtifact.sha256 = changed.sha256;
    saveReview(dir, pkg);
    expect(validateManifest(dir).issues).toContain("adjudication artifact does not match adjudications in the frozen labels");
  });
  it("excludes the third adjudicator from independent reviewer eligibility", () => {
    const dir = root(); const pkg = makePackage(dir);
    addSyntheticAdjudication(dir, pkg);
    pkg.manifest.independentReview.reviewerId = "adjudicator-c";
    pkg.manifest.independentReview.artifact.authoredBy = "adjudicator-c";
    pkg.review.reviewerId = "adjudicator-c";
    saveReview(dir, pkg);
    expect(validateManifest(dir).issues).toContain("independent reviewer must differ from every label reviewer and supporting artifact author");
  });
  it("rejects adjudication marked performed when frozen labels have no disagreements", () => {
    const mismatchDir = root(); const mismatch = makePackage(mismatchDir);
    const emptyAdjudications = saveJson(mismatchDir, `${PREFIX}empty-adjudications.json`, []);
    mismatch.manifest.humanLabels.adjudication = { status: "performed", artifact: { ...emptyAdjudications, evidenceType: "adjudication_record", authoredBy: "source-author", reviewedBy: "independent-reviewer-c" } };
    saveJson(mismatchDir, MANIFEST_PATH, mismatch.manifest);
    expect(validateManifest(mismatchDir).issues).toContain("manifest adjudication status conflicts with frozen labels that need no adjudication");
  });
  it("requires adjudication when frozen labels contain a disagreement", () => {
    const dir = root(); const pkg = makePackage(dir);
    addSyntheticAdjudication(dir, pkg);
    pkg.manifest.humanLabels.adjudication = { status: "not_needed", reason: "Fixture claim" };
    rebindEvaluation(dir, pkg);
    expect(validateManifest(dir).issues).toContain("manifest adjudication status omits adjudications required by frozen labels");
  });
  it("rejects conflicting duplicate evidence references", () => {
    const dir = root(); const pkg = makePackage(dir);
    const original = pkg.manifest.groups.provider_authenticity_usage.artifacts[0];
    pkg.manifest.groups.sec_source_correspondence.artifacts.push({ ...original, authoredBy: "conflicting-author" });
    saveJson(dir, MANIFEST_PATH, pkg.manifest);
    expect(validateManifest(dir).issues).toContain("conflicting duplicate supporting artifact references");
  });
  it("rejects report bytes that differ from recomputed output", () => {
    const dir = root(); const pkg = makePackage(dir);
    const changedReport = Buffer.from("{}\n"); writeFileSync(path.join(dir, pkg.reportRef.path), changedReport);
    pkg.manifest.run.reportSha256 = sha(changedReport); pkg.manifest.run.evaluationReportArtifact.sha256 = sha(changedReport);
    pkg.review.approvalSubject.run.reportSha256 = sha(changedReport);
    const reportRef = pkg.review.approvalSubject.artifacts.find((artifact: any) => artifact.path === pkg.reportRef.path); reportRef.sha256 = sha(changedReport);
    saveReview(dir, pkg);
    expect(validateManifest(dir).issues).toContain("saved report bytes differ from recomputed offline evaluator output");
  });
  it("rejects an evaluation whose recomputed status is not PASS", () => {
    const failedDir = root(); const failed = makePackage(failedDir);
    const labelsValue = JSON.parse(readFileSync(path.join(failedDir, failed.labelsRef.path), "utf8"));
    const runValue = JSON.parse(readFileSync(path.join(failedDir, failed.runRef.path), "utf8"));
    runValue.items[0].terminalStatus = "failed"; runValue.items[0].score = null; runValue.items[0].attempts = [];
    runValue.requestCount -= 1;
    const labels = parseLabelSet(labelsValue); const modelRun = parseModelRun(runValue);
    const labelsSha = sha(readFileSync(path.join(failedDir, failed.labelsRef.path)));
    const report = analyzeFinal({ labels, labelsSha256: labelsSha, run: modelRun });
    expect(report.status).not.toBe("PASS");
    const runRef = saveJson(failedDir, failed.runRef.path, runValue); const failedReportRef = saveJson(failedDir, failed.reportRef.path, report);
    failed.manifest.run.runSha256 = runRef.sha256; failed.manifest.run.modelRunArtifact.sha256 = runRef.sha256;
    failed.manifest.run.reportSha256 = failedReportRef.sha256; failed.manifest.run.evaluationReportArtifact.sha256 = failedReportRef.sha256;
    failed.review.approvalSubject.run.runSha256 = runRef.sha256; failed.review.approvalSubject.run.reportSha256 = failedReportRef.sha256;
    failed.review.approvalSubject.artifacts.find((artifact: any) => artifact.path === failed.runRef.path).sha256 = runRef.sha256;
    failed.review.approvalSubject.artifacts.find((artifact: any) => artifact.path === failed.reportRef.path).sha256 = failedReportRef.sha256;
    saveReview(failedDir, failed);
    expect(report.status).not.toBe("PASS");
    expect(validateManifest(failedDir).issues).toContain("offline evaluator report does not match the frozen label-authority status");
  });
  it("rejects labels frozen against a different Git revision", () => {
    const identityDir = root(); const identityPkg = makePackage(identityDir);
    const changedLabels = JSON.parse(readFileSync(path.join(identityDir, identityPkg.labelsRef.path), "utf8"));
    changedLabels.analysisCodeRevision = "f".repeat(40); saveJson(identityDir, identityPkg.labelsRef.path, changedLabels);
    rebindEvaluation(identityDir, identityPkg);
    expect(validateManifest(identityDir).issues).toContain("current HEAD differs from the code revision frozen with the labels");
  });
  it("rejects source bytes that differ from the loaded evaluator even at the claimed HEAD", () => {
    const sourceDir = root(); const sourcePkg = makePackage(sourceDir);
    const evaluatorPath = path.join(sourceDir, "scripts/evaluate-jev-labels.ts");
    writeFileSync(evaluatorPath, `${readFileSync(evaluatorPath, "utf8")}\n// altered committed fixture source\n`);
    commitSyntheticCheckout(sourceDir, "alter copied evaluator source");
    const sourceLabels = JSON.parse(readFileSync(path.join(sourceDir, sourcePkg.labelsRef.path), "utf8"));
    sourceLabels.analysisCodeRevision = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    saveJson(sourceDir, sourcePkg.labelsRef.path, sourceLabels); rebindEvaluation(sourceDir, sourcePkg);
    expect(execFileSync("git", ["-C", sourceDir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" })).toBe("");
    expect(validateManifest(sourceDir).issues).toEqual(["frozen evaluator source differs from the loaded source: scripts/evaluate-jev-labels.ts"]);
  });
  it("rejects ignored evaluator sources absent from the frozen Git revision", () => {
    const dir = root(); const pkg = makePackage(dir);
    const relative = "scripts/jev-label-evaluation.ts";
    execFileSync("git", ["-C", dir, "rm", "--cached", relative]);
    writeFileSync(path.join(dir, ".gitignore"), `.engineering-evidence/\n${relative}\n`);
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=Synthetic Evidence Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "omit ignored evaluator source"]);
    const labels = JSON.parse(readFileSync(path.join(dir, pkg.labelsRef.path), "utf8"));
    labels.analysisCodeRevision = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    saveJson(dir, pkg.labelsRef.path, labels); rebindEvaluation(dir, pkg);
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" })).toBe("");
    expect(readFileSync(path.join(dir, relative)).equals(readFileSync(path.resolve(relative)))).toBe(true);
    expect(validateManifest(dir).issues).toEqual([`frozen evaluator source is absent from the code revision: ${relative}`]);
  });
  it("rejects artifact path traversal", () => {
    const dir = root(); const pkg = makePackage(dir);
    pkg.manifest.groups.provider_authenticity_usage.artifacts[0].path = `${PREFIX}../../escape.json`;
    saveJson(dir, MANIFEST_PATH, pkg.manifest);
    expect(validateManifest(dir).issues).toContain("evidence path is outside the permitted normalized directory");
  });
  it("rejects artifact symlinks", () => {
    const linkDir = root(); const linked = makePackage(linkDir); const target = path.join(linkDir, "outside.json"); writeFileSync(target, "{}")
    const linkPath = path.join(linkDir, `${PREFIX}linked.json`); symlinkSync(target, linkPath);
    linked.manifest.groups.provider_authenticity_usage.artifacts[0].path = `${PREFIX}linked.json`; saveJson(linkDir, MANIFEST_PATH, linked.manifest);
    expect(validateManifest(linkDir).issues).toContain("evidence file is missing, symlinked, oversized, or not a root-contained regular file");
  });
  it("rejects oversized artifact files", () => {
    const largeDir = root(); const large = makePackage(largeDir); const largeFile = path.join(largeDir, large.manifest.groups.provider_authenticity_usage.artifacts[0].path); writeFileSync(largeFile, Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(validateManifest(largeDir).issues).toContain("evidence file is missing, symlinked, oversized, or not a root-contained regular file");
  });
  it("CLI --out writes a report when the output is absent", () => {
    const dir = root(); const pkg = makePackage(dir); const outputRel = pkg.reportRef.path;
    const outputFile = path.join(dir, outputRel); unlinkSync(outputFile);
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs"); const evaluator = path.resolve("scripts/evaluate-jev-labels.ts");
    const argv = [tsx, evaluator, "--labels", pkg.manifest.run.frozenLabelsArtifact.path, "--run", pkg.manifest.run.modelRunArtifact.path, "--out", outputRel];
    const first = execFileSync(process.execPath, argv, { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(first).result).toBe("REPORT_WRITTEN");
  });
  it("CLI --out accepts an existing byte-identical report", () => {
    const dir = root(); const pkg = makePackage(dir); const outputRel = pkg.reportRef.path;
    const outputFile = path.join(dir, outputRel);
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs"); const evaluator = path.resolve("scripts/evaluate-jev-labels.ts");
    const argv = [tsx, evaluator, "--labels", pkg.manifest.run.frozenLabelsArtifact.path, "--run", pkg.manifest.run.modelRunArtifact.path, "--out", outputRel];
    const saved = readFileSync(outputFile);
    const second = execFileSync(process.execPath, argv, { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(second).result).toBe("REPORT_ALREADY_IDENTICAL");
    expect(readFileSync(outputFile).equals(saved)).toBe(true);
  });
  it("CLI --out refuses to replace a different report", () => {
    const dir = root(); const pkg = makePackage(dir); const outputRel = pkg.reportRef.path;
    const outputFile = path.join(dir, outputRel);
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs"); const evaluator = path.resolve("scripts/evaluate-jev-labels.ts");
    const argv = [tsx, evaluator, "--labels", pkg.manifest.run.frozenLabelsArtifact.path, "--run", pkg.manifest.run.modelRunArtifact.path, "--out", outputRel];
    writeFileSync(outputFile, "different bytes\n");
    let failure: unknown;
    try { execFileSync(process.execPath, argv, { cwd: dir, encoding: "utf8" }); } catch (error) { failure = error; }
    expect(failure).toBeTruthy();
    expect(readFileSync(outputFile).toString("utf8")).toBe("different bytes\n");
  });
});
