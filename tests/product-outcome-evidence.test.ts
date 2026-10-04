import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check_product_outcome_evidence.py");
const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fixtureBytes = Buffer.from("metadata-only fixture artifact; contains no company or market data");
const fixtureArtifact = { path: ".engineering-evidence/outcomes/artifact.txt", sha256: createHash("sha256").update(fixtureBytes).digest("hex") };
const attemptBytes = Buffer.from(JSON.stringify({ schema_version: 1, attempt_id: "attempt-fixture-1", attempted_at: "2026-01-06T00:00:00Z", outcome: "no_response" }));
const attemptArtifact = { path: ".engineering-evidence/outcomes/attempt.json", sha256: createHash("sha256").update(attemptBytes).digest("hex") };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function refsIn(value: unknown): Array<{ path: string; sha256: string }> {
  const refs = new Map<string, { path: string; sha256: string }>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item !== null && typeof item === "object") {
      const object = item as Record<string, unknown>;
      if (typeof object.path === "string" && typeof object.sha256 === "string") refs.set(`${object.path}\0${object.sha256}`, { path: object.path, sha256: object.sha256 });
      Object.values(object).forEach(visit);
    }
  };
  visit(value);
  return [...refs.values()].sort((a, b) => a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256));
}

function writeEvidence(reportName: string, kind: string, ledger: Record<string, unknown>, reportExtras: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-outcome-metadata-"));
  tempDirs.push(directory);
  const evidenceDir = join(directory, ".engineering-evidence", "outcomes");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "artifact.txt"), fixtureBytes);
  writeFileSync(join(evidenceDir, "attempt.json"), attemptBytes);
  const bundlePath = join(evidenceDir, "ledger.json");
  const bundle = Buffer.from(JSON.stringify(ledger));
  writeFileSync(bundlePath, bundle);
  const workpaperA = Buffer.from("metadata-only reviewer A fixture; not a real review");
  const workpaperB = Buffer.from("metadata-only reviewer B fixture; not a real review");
  writeFileSync(join(evidenceDir, "reviewer-a.txt"), workpaperA);
  writeFileSync(join(evidenceDir, "reviewer-b.txt"), workpaperB);
  const authenticityPath = join(evidenceDir, "authenticity-review.json");
  const authenticity = Buffer.from(JSON.stringify({
    schema_version: 1,
    status: "PASS",
    ledger_sha256: createHash("sha256").update(bundle).digest("hex"),
    artifact_manifest_sha256: createHash("sha256").update(canonical(refsIn(ledger))).digest("hex"),
    reviewed_scopes: ["source_rights", "source_and_claim_truth", "reviewer_independence", "participant_eligibility", "recordings", "prospectivity"],
    reviewers: [
      { reviewer_key: "independent-reviewer-a", independent: true, fresh_context: true, review_artifact: { path: ".engineering-evidence/outcomes/reviewer-a.txt", sha256: createHash("sha256").update(workpaperA).digest("hex") } },
      { reviewer_key: "independent-reviewer-b", independent: true, fresh_context: true, review_artifact: { path: ".engineering-evidence/outcomes/reviewer-b.txt", sha256: createHash("sha256").update(workpaperB).digest("hex") } },
    ],
    limitations: ["cannot prove subagent execution", "cannot independently authenticate source truth"],
  }));
  writeFileSync(authenticityPath, authenticity);
  const reportPath = join(evidenceDir, reportName);
  writeFileSync(reportPath, JSON.stringify({
    schema_version: 1,
    kind,
    evidence_bundle: ".engineering-evidence/outcomes/ledger.json",
    evidence_bundle_sha256: createHash("sha256").update(bundle).digest("hex"),
    authenticity_review_artifact: { path: ".engineering-evidence/outcomes/authenticity-review.json", sha256: createHash("sha256").update(authenticity).digest("hex") },
    ...reportExtras,
  }));
  return reportPath;
}

function run(kind: string, reportPath: string, structuralOnly = false) {
  const workspace = reportPath.split("/.engineering-evidence/")[0]!;
  const relativeReportPath = reportPath.slice(workspace.length + 1);
  const args = [script, kind, relativeReportPath];
  if (structuralOnly) args.push("--structural-only");
  const result = spawnSync("python3", args, { cwd: workspace, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function origin(n: number) {
  return { origin_id: `origin-${n}`, source_ref: `source://public/item/${n}`, observed_at: "2026-01-04T00:00:00Z", artifact: fixtureArtifact };
}

function signal(n: number) {
  return { signal_id: `signal-${n}`, qualified: true, point_in_time_origins: [origin(n * 2), origin(n * 2 + 1)], next_check: "Check next filing and product availability" };
}

function noSignalEvidence() {
  return {
    searched_scope: ["product forums", "issuer filings"],
    window_start: "2026-01-02T00:00:00Z",
    window_end: "2026-01-09T00:00:00Z",
    expected_sources: ["forums", "filings"],
    checked_sources: [
      { source_id: "forums", status: "complete", checked_at: "2026-01-04T00:00:00Z", artifact: fixtureArtifact },
      { source_id: "filings", status: "complete", checked_at: "2026-01-04T00:00:00Z", artifact: fixtureArtifact },
    ],
    coverage_fraction: 1,
    freshness_as_of: "2026-01-04T00:00:00Z",
    gaps: [],
    uncertainty: "No qualifying signal found within complete declared coverage; out-of-scope sources may contain information.",
    next_check: "Recheck after next filing",
    coverage_artifact: fixtureArtifact,
  };
}

function masterLedger(): Record<string, unknown> {
  const tasks = Array.from({ length: 30 }, (_, i) => {
    const issuer = `issuer-${Math.floor(i / 2)}`;
    const clusterNumber = Math.floor(i / 2);
    const outcome = i % 2 === 0 && clusterNumber < 10 ? "desk"
      : i % 2 === 0 && clusterNumber < 12 ? "alphasense" : "tie";
    return {
      task_id: `task-${i}`,
      issuer_id: issuer,
      sector: `sector-${clusterNumber % 6}`,
      event_id: `event-${clusterNumber}`,
      registered_at: "2026-01-01T00:00:00Z",
      window_start: "2026-01-02T00:00:00Z",
      window_end: "2026-01-09T00:00:00Z",
      cutoff_at: "2026-01-10T00:00:00Z",
      desk_output_generated_at: "2026-01-05T00:00:00Z",
      alphasense_output_generated_at: "2026-01-05T00:00:00Z",
      desk_output_artifact: fixtureArtifact,
      alphasense_output_artifact: fixtureArtifact,
      desk_output_status: "supported_signals",
      alphasense_output_status: "supported_signals",
      desk_signals: [signal(i * 4)],
      alphasense_signals: [signal(i * 4 + 2)],
      reviews: {
        reviewer_a: { reviewer_key: `reviewer-a-${i}`, candidate_blinded: true, independent: true, outcome, supported_desk_signal_ids: outcome === "desk" ? [`signal-${i * 4}`] : [], supported_alphasense_signal_ids: outcome === "alphasense" ? [`signal-${i * 4 + 2}`] : [], artifact: fixtureArtifact },
        reviewer_b: { reviewer_key: `reviewer-b-${i}`, candidate_blinded: true, independent: true, outcome, supported_desk_signal_ids: outcome === "desk" ? [`signal-${i * 4}`] : [], supported_alphasense_signal_ids: outcome === "alphasense" ? [`signal-${i * 4 + 2}`] : [], artifact: fixtureArtifact },
        adjudicator: { reviewer_key: `adjudicator-${i}`, outcome, supported_desk_signal_ids: outcome === "desk" ? [`signal-${i * 4}`] : [], supported_alphasense_signal_ids: outcome === "alphasense" ? [`signal-${i * 4 + 2}`] : [], artifact: fixtureArtifact },
      },
      claims: {
        desk: [{ claim_id: `d-${i}`, material_error: false }],
        alphasense: [{ claim_id: `a-${i}`, material_error: false }],
      },
    };
  });
  return {
    schema_version: 1,
    kind: "master-eval",
    criteria_frozen_before_outputs: true,
    criteria_sha256: "a".repeat(64),
    criteria_frozen_at: "2026-01-04T00:00:00Z",
    evaluation_cutoff_at: "2026-01-11T00:00:00Z",
    review_panel: { candidate_identity_blinded: true, fresh_contexts: true, model_ids: ["reviewer-model-a", "reviewer-model-b"] },
    time_dependence_links: [],
    cluster_independence_review: {
      independence_justified: true,
      exchangeability_justified: true,
      reviewer_key: "independent-statistical-reviewer",
      evidence_ref: "metadata://cluster-independence-review",
    },
    tasks,
  };
}

function investorLedger(): Record<string, unknown> {
  const participants = Array.from({ length: 10 }, (_, index) => ({
    participant_key_sha256: createHash("sha256").update(`participant-${index}`).digest("hex"),
    audience: index < 5 ? "serious_individual" : "professional_analyst",
    eligible: true,
    eligibility_evidence_ref: `eligibility://review/${index}`,
    session_recording_ref: `recording://session/${index}`,
    eligibility_evidence_artifact: fixtureArtifact,
    session_recording_artifact: fixtureArtifact,
    tasks: ["discover_without_ticker", "research_worthiness", "followed_company_change"].map((task) => ({
      task,
      completed: true,
      source_checked_result: true,
      source_checked_evidence_ref: `evidence://${index}/${task}`,
      source_checked_evidence_artifact: fixtureArtifact,
      time_to_source_checked_result_seconds: 420,
      user_reported_factual_corrections: 0,
      critical_source_entity_or_time_errors: 0,
    })),
  }));
  return { schema_version: 1, kind: "investor-workflows", uncoached: true, cohort_eligibility_reviewed: true, participants };
}

describe("external outcome evidence gate", () => {
  it("blocks when the required report is absent", () => {
    const path = writeEvidence("master-eval.json", "master-eval", masterLedger());
    rmSync(path);
    const result = run("master-eval", path);
    expect(result.status).toBe(1);
    expect(result.output).toContain("BLOCKED: outcome report is missing");
  });

  it("accepts a structurally complete metadata-only paired-task ledger", () => {
    const ledger = masterLedger();
    const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", ledger), true);
    expect(result.status).toBe(0);
    expect(result.output).toContain("STRUCTURAL_STATUS=PASS THRESHOLD_STATUS=PASS");
    expect(result.output).toContain("AUTHENTICITY_STATUS=UNVERIFIED");
    expect(result.output).toContain("MODE=STRUCTURAL_ONLY");
  });

  it("never accepts self-authored metadata-only review artifacts as authentic by default", () => {
    const path = writeEvidence("master-eval.json", "master-eval", masterLedger());
    const result = run("master-eval", path);
    expect(result.status).toBe(1);
    expect(result.output).toContain("AUTHENTICITY_STATUS=UNVERIFIED");
    expect(result.output).toContain("BLOCKED: independent authenticity evidence");
  });

  it("marks an incomplete preregistered task sample unverified rather than a measured failure", () => {
    const ledger = masterLedger();
    (ledger.tasks as unknown[]).pop();
    const result = run("master-eval", writeEvidence("incomplete-sample.json", "master-eval", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("UNVERIFIED: exactly 30 preregistered paired task rows are required; received 29");
  });

  it("accepts a complete no-signal row with zero claims in diagnostic mode", () => {
    const ledger = masterLedger();
    const row = (ledger.tasks as Array<Record<string, unknown>>)[29]!;
    row.desk_signals = [];
    row.desk_output_status = "no_signal";
    row.desk_no_signal_evidence = noSignalEvidence();
    (row.claims as Record<string, unknown>).desk = [];
    const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", ledger), true);
    expect(result.status).toBe(0);
    expect(result.output).toContain("AUTHENTICITY_STATUS=UNVERIFIED");
    expect(result.output).toContain("MODE=STRUCTURAL_ONLY");
  });

  it("rejects blank or missing responses mislabeled as no-signal outputs", () => {
    const ledger = masterLedger();
    const row = (ledger.tasks as Array<Record<string, unknown>>)[29]!;
    row.desk_signals = [];
    row.desk_output_status = "no_signal";
    row.desk_no_signal_evidence = { searched_scope: [], coverage_fraction: 0 };
    (row.claims as Record<string, unknown>).desk = [];
    const blank = run("master-eval", writeEvidence("blank.json", "master-eval", ledger), true);
    expect(blank.status).toBe(1);
    expect(blank.output).toContain("searched_scope must be explicit");

    row.desk_output_status = "missing";
    row.desk_no_signal_evidence = undefined;
    row.desk_output_generated_at = undefined;
    row.desk_output_artifact = undefined;
    row.desk_attempt_at = "2026-01-06T00:00:00Z";
    row.desk_attempt_artifact = attemptArtifact;
    const missing = run("master-eval", writeEvidence("missing.json", "master-eval", ledger), true);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("must be non_evaluable");
  });

  it("keeps a missing output in the fixed task and error denominators and removes it from wins", () => {
    const ledger = masterLedger();
    const row = (ledger.tasks as Array<Record<string, unknown>>)[0]!;
    row.desk_output_status = "missing";
    row.desk_signals = [];
    row.desk_output_generated_at = undefined;
    row.desk_output_artifact = undefined;
    row.desk_attempt_at = "2026-01-06T00:00:00Z";
    row.desk_attempt_artifact = attemptArtifact;
    (row.claims as Record<string, unknown>).desk = [];
    const reviews = row.reviews as Record<string, Record<string, unknown>>;
    for (const review of Object.values(reviews)) {
      review.outcome = "non_evaluable";
      review.supported_desk_signal_ids = [];
    }
    const result = run("master-eval", writeEvidence("missing-output.json", "master-eval", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("completed_paired_tasks=29");
    expect(result.output).toContain("desk=supported_signals:29,no_signal:0,missing:1");
    expect(result.output).toContain("registered_tasks=30");
    expect(result.output).toContain("task_errors=1/30:0/30");
    expect(result.output).toContain("BLOCKED: 30 completed paired tasks are required");
    expect(result.output).toContain("only 29/30 were evaluable");
  });

  it("counts a well-formed unsupported response as an error and rejects signal claims attached to it", () => {
    const ledger = masterLedger();
    const row = (ledger.tasks as Array<Record<string, unknown>>)[29]!;
    row.desk_output_status = "unsupported";
    row.desk_signals = [];
    (row.claims as Record<string, unknown>).desk = [];
    const reviews = row.reviews as Record<string, Record<string, unknown>>;
    for (const review of Object.values(reviews)) {
      review.outcome = "non_evaluable";
      review.supported_desk_signal_ids = [];
    }
    const unsupported = run("master-eval", writeEvidence("unsupported.json", "master-eval", ledger), true);
    expect(unsupported.status).toBe(1);
    expect(unsupported.output).toContain("desk=supported_signals:29,no_signal:0,missing:0,invalid:0,unsupported:1");
    expect(unsupported.output).toContain("task_errors=1/30:0/30");

    (row.claims as Record<string, Array<{ claim_id: string; material_error: boolean }>>).desk = [
      { claim_id: "unsupported-assertion", material_error: true },
    ];
    const claimLedger = run("master-eval", writeEvidence("unsupported-claim-ledger.json", "master-eval", ledger), true);
    expect(claimLedger.output).toContain("material_claim_errors=1/30:0/30");

    row.desk_signals = [signal(999)];
    const malformed = run("master-eval", writeEvidence("malformed.json", "master-eval", ledger), true);
    expect(malformed.status).toBe(1);
    expect(malformed.output).toContain("unsupported output cannot contain signal claims");
  });

  it("fails the overall claim-rate gate when a product has no claims across the cohort", () => {
    const ledger = masterLedger();
    for (const row of ledger.tasks as Array<Record<string, unknown>>) {
      row.alphasense_signals = [];
      row.alphasense_output_status = "no_signal";
      row.alphasense_no_signal_evidence = noSignalEvidence();
      (row.claims as Record<string, unknown>).alphasense = [];
      const reviews = row.reviews as Record<string, Record<string, unknown>>;
      if (reviews.adjudicator!.outcome === "alphasense") {
        for (const review of Object.values(reviews)) review.outcome = "tie";
      }
    }
    const result = run("master-eval", writeEvidence("zero-claims.json", "master-eval", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("both products must have material claims assessed");
  });

  it("rejects an arbitrary bundle even when a report invents passing aggregates", () => {
    const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", { run: "metadata only" }, {
      status: "PASS", completed_paired_tasks: 30, desk_wins: 30, exact_p_value: 0,
    }));
    expect(result.status).toBe(1);
    expect(result.output).toContain("self-declared aggregate outcome assertions are forbidden");
  });

  it("rejects fabricated or modified source/output/reviewer artifact references", () => {
    const path = writeEvidence("master-eval.json", "master-eval", masterLedger());
    const artifactPath = join(path.split("/.engineering-evidence/")[0]!, ".engineering-evidence/outcomes/artifact.txt");
    writeFileSync(artifactPath, "altered evidence");
    const result = run("master-eval", path);
    expect(result.status).toBe(1);
    expect(result.output).toContain("artifact digest does not match");
  });

  it("keeps authentication UNVERIFIED when the separate review does not bind the exact ledger", () => {
    const path = writeEvidence("master-eval.json", "master-eval", masterLedger());
    const root = path.split("/.engineering-evidence/")[0]!;
    const reviewPath = join(root, ".engineering-evidence/outcomes/authenticity-review.json");
    const review = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
    review.ledger_sha256 = "0".repeat(64);
    writeFileSync(reviewPath, JSON.stringify(review));
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    envelope.authenticity_review_artifact = {
      path: ".engineering-evidence/outcomes/authenticity-review.json",
      sha256: createHash("sha256").update(readFileSync(reviewPath)).digest("hex"),
    };
    writeFileSync(path, JSON.stringify(envelope));
    const result = run("master-eval", path);
    expect(result.status).toBe(1);
    expect(result.output).toContain("AUTHENTICITY_STATUS=UNVERIFIED");
    expect(result.output).toContain("bound to a different ledger");
  });

  it("rejects negative, nonfinite and out-of-range supplied p values", () => {
    for (const value of [-0.01, 1.01, Number.NaN]) {
      const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", masterLedger(), { exact_p_value: value }));
      expect(result.status).toBe(1);
      expect(result.output).toContain("self-declared aggregate outcome assertions are forbidden");
    }
  });

  it("recomputes the conservative paired cluster test and rejects duplicated issuer misclustering", () => {
    const ledger = masterLedger();
    const tasks = ledger.tasks as Array<Record<string, unknown>>;
    tasks[2]!.issuer_id = tasks[0]!.issuer_id;
    const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", ledger));
    expect(result.status).toBe(1);
    expect(result.output).toContain("at most two tasks");
  });

  it("joins shared-event bridges before recomputing the cluster sign test", () => {
    const ledger = masterLedger();
    const tasks = ledger.tasks as Array<Record<string, unknown>>;
    for (let index = 0; index < 20; index += 2) tasks[index]!.event_id = "shared-event-bridge";
    const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("issuer/event-cluster effect direction is not positive");
  });

  it("recomputes the exact two-sided paired sign test instead of trusting reported p-values", () => {
    const ledger = masterLedger();
    const row = (ledger.tasks as Array<Record<string, unknown>>)[24]!;
    const reviews = row.reviews as Record<string, Record<string, unknown>>;
    for (const reviewer of Object.values(reviews)) {
      reviewer.outcome = "alphasense";
      reviewer.supported_alphasense_signal_ids = ["signal-98"];
    }
    const result = run("master-eval", writeEvidence("master-eval.json", "master-eval", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("recomputed exact paired sign test is not significant");
  });

  it("rejects an AlphaSense win without symmetric reviewer and adjudicator signal citations", () => {
    const ledger = masterLedger();
    const row = (ledger.tasks as Array<Record<string, unknown>>)[20]!;
    const reviews = row.reviews as Record<string, Record<string, unknown>>;
    for (const reviewer of Object.values(reviews)) reviewer.supported_alphasense_signal_ids = [];
    const result = run("master-eval", writeEvidence("uncited-alphasense-win.json", "master-eval", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("reviewer A alphasense outcome must cite unique qualifying alphasense signals");
  });

  it("rejects invalid chronology, overlong task windows and unqualified Desk wins", () => {
    const cases: Array<[string, (ledger: Record<string, unknown>) => void, string]> = [
      ["chronology", (ledger) => { (ledger.tasks as Array<Record<string, unknown>>)[0]!.registered_at = "2026-01-03T00:00:00Z"; }, "chronology is invalid"],
      ["window", (ledger) => { (ledger.tasks as Array<Record<string, unknown>>)[0]!.window_end = "2026-01-10T00:00:00Z"; }, "exactly seven days"],
      ["qualification", (ledger) => { const row = (ledger.tasks as Array<Record<string, unknown>>)[0]!; row.desk_signals = [{ signal_id: "signal-x", qualified: false, point_in_time_origins: [origin(1), origin(2)], next_check: "check" }]; }, "qualification is missing"],
      ["post-output freeze", (ledger) => { ledger.criteria_frozen_at = "2026-01-06T00:00:00Z"; }, "frozen before both product outputs"],
      ["unsupported win", (ledger) => { const row = (ledger.tasks as Array<Record<string, unknown>>)[0]!; (row.reviews as Record<string, Record<string, unknown>>).reviewer_a!.outcome = "tie"; (row.reviews as Record<string, Record<string, unknown>>).reviewer_b!.outcome = "tie"; }, "lacks an overlapping reviewer-supported signal"],
      ["zero-signal win", (ledger) => { const row = (ledger.tasks as Array<Record<string, unknown>>)[0]!; row.desk_signals = []; }, "desk supported_signals output contains no signals"],
      ["missing claims denominator", (ledger) => { const row = (ledger.tasks as Array<Record<string, unknown>>)[0]!; (row.claims as Record<string, unknown>).desk = []; }, "desk supported_signals output needs claims"],
    ];
    for (const [name, mutate, expected] of cases) {
      const ledger = masterLedger(); mutate(ledger);
      const result = run("master-eval", writeEvidence(`${name}.json`, "master-eval", ledger));
      expect(result.status).toBe(1);
      expect(result.output).toContain(expected);
    }
  });

  it("accepts complete per-participant/per-task metadata and rejects excess corrections on one completed task", () => {
    const path = writeEvidence("investor-workflows.json", "investor-workflows", investorLedger());
    expect(run("investor-workflows", path, true).output).toContain("AUTHENTICITY_STATUS=UNVERIFIED");
    const report = JSON.parse(readFileSync(join(path), "utf8")) as { evidence_bundle: string };
    const ledgerPath = join(path.split("/.engineering-evidence/")[0]!, report.evidence_bundle);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { participants: Array<{ tasks: Array<Record<string, unknown>> }> };
    ledger.participants[0]!.tasks[0]!.user_reported_factual_corrections = 2;
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    envelope.evidence_bundle_sha256 = createHash("sha256").update(readFileSync(ledgerPath)).digest("hex");
    writeFileSync(path, JSON.stringify(envelope));
    const rejected = run("investor-workflows", path, true);
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain("more than one factual correction");
  });

  it("marks an underfilled intended-user cohort unverified rather than a measured failure", () => {
    const ledger = investorLedger();
    (ledger.participants as unknown[]).pop();
    const result = run("investor-workflows", writeEvidence("underfilled-cohort.json", "investor-workflows", ledger), true);
    expect(result.status).toBe(1);
    expect(result.output).toContain("UNVERIFIED: at least five eligible participants from each audience are required");
  });

  it("rejects an omitted frozen workflow task", () => {
    const ledger = investorLedger();
    const participants = ledger.participants as Array<{ tasks: unknown[] }>;
    participants[0]!.tasks.pop();
    const result = run("investor-workflows", writeEvidence("investor-workflows.json", "investor-workflows", ledger));
    expect(result.status).toBe(1);
    expect(result.output).toContain("all three workflows");
  });
});
