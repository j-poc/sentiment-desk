import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessConfiguredFeedHealth,
  assessGoldenProviderAuthorization,
  bindNativeCheckFailures,
  GOLDEN_CASES,
  GOLDEN_VERSION,
  gradeGoldenCase,
  goldenReady,
  loadJourneyReviewEvidence,
  requiredGoldenCriteria,
  type GoldenObservation,
} from "../scripts/investor-golden-cases.js";

const workspace = process.cwd();
const evidenceRoot = path.join(workspace, ".engineering-evidence/investor-golden/journeys");
const tempDirs: string[] = [];
const fingerprint = "a".repeat(64);
const servedUiBuildFingerprint = "c".repeat(64);
const reviewers = ["agent-investor-1", "agent-investor-2"];

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function routeScreenshot(seed: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixel = Buffer.from([0, seed & 0xff, (seed * 7) & 0xff, (seed * 13) & 0xff, 0xff]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixel)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function artifact(dir: string, name: string, bytes: Buffer | string) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return { path: name, sha256: createHash("sha256").update(body).digest("hex") };
}

interface PackageOptions {
  omitCriterion?: string;
  secondReviewer?: boolean;
  wrongFingerprint?: boolean;
  wrongSuiteVersion?: boolean;
  routeUrl?: string;
  overrideStatus?: "PASS" | "FAIL" | "BLOCKED" | "UNVERIFIED";
  missingRun?: boolean;
  duplicateRun?: boolean;
  mismatchReviewerRun?: boolean;
  mismatchSnapshot?: boolean;
  mismatchPrestate?: boolean;
  reviewerDisagreement?: boolean;
  missingRouteServedFingerprint?: boolean;
  mismatchRouteServedFingerprint?: boolean;
  missingReviewerServedFingerprint?: boolean;
  mismatchReviewerServedFingerprint?: boolean;
  mismatchManifestServedFingerprint?: boolean;
}

function packageEvidence(options: PackageOptions = {}) {
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(evidenceRoot), 0o700);
  chmodSync(evidenceRoot, 0o700);
  const dir = mkdtempSync(path.join(evidenceRoot, "test-" + randomUUID() + "-"));
  chmodSync(dir, 0o700);
  tempDirs.push(dir);

  const suiteRunId = "suite-run-" + randomUUID();
  const appFingerprint = options.wrongFingerprint ? "b".repeat(64) : fingerprint;
  const suiteVersion = options.wrongSuiteVersion ? "investor-workflows-old" : GOLDEN_VERSION;
  const runs: Array<Record<string, unknown>> = [];
  let index = 0;

  for (const scenario of GOLDEN_CASES) {
    for (const variant of scenario.variants) {
      const runId = "subrun-" + scenario.id + "-" + variant.id + "-" + randomUUID();
      const screenshot = artifact(dir, "route-" + index + ".png", routeScreenshot(index + 1));
      const prestate = artifact(dir, "prestate-" + index + ".txt", "prestate for " + scenario.id + "/" + variant.id);
      const sourceSnapshot = artifact(dir, "source-snapshot-" + index + ".txt", "real-source-snapshot:" + scenario.id + "/" + variant.id);
      const criteria = variant.required
        .filter((criterion) => !(options.omitCriterion === scenario.id + "/" + variant.id + ":" + criterion))
        .map((criterion, criterionIndex) => ({
          criterion,
          status: options.overrideStatus ?? "PASS",
          reason: "Both independent reviewers examined this variant's route and saved-state evidence.",
          evidence: [artifact(dir, "evidence-" + index + "-" + criterionIndex + ".txt", "evidence for " + scenario.id + "/" + variant.id + "/" + criterion)],
        }));
      runs.push({
        caseId: scenario.id,
        variantId: variant.id,
        runId,
        appFingerprint,
        route: {
          id: "local",
          url: options.routeUrl ?? "http://127.0.0.1:8798/",
          ...(options.missingRouteServedFingerprint && index === 0 ? {} : {
            servedUiBuildFingerprint: options.mismatchRouteServedFingerprint && index === 0
              ? "d".repeat(64)
              : servedUiBuildFingerprint,
          }),
          screenshot,
        },
        prestate: { description: "Observed real prestate for " + scenario.id + "/" + variant.id, evidence: [prestate] },
        sourceSnapshot,
        sourceSnapshotSha256: sourceSnapshot.sha256,
        observations: criteria,
      });
      index++;
    }
  }

  if (options.missingRun) runs.pop();
  if (options.duplicateRun) runs.push({ ...runs[0]!, observations: [...runs[0]!.observations as unknown[]] });

  const reviewerRows = reviewers.slice(0, options.secondReviewer === false ? 1 : 2).map((reviewerId, reviewerIndex) => {
    const reportRuns = runs.map((run, runIndex) => {
      const route = run.route as { id: string; url: string; servedUiBuildFingerprint?: string; screenshot: { sha256: string } };
      const prestate = run.prestate as { evidence: Array<{ sha256: string }> };
      const reportObservations = (run.observations as Array<{
        criterion: string;
        status: string;
        evidence: Array<{ sha256: string }>;
      }>).map((observation, observationIndex) => ({
        criterion: observation.criterion,
        status: options.reviewerDisagreement && reviewerIndex === 1 && runIndex === 0 && observationIndex === 0
          ? observation.status === "PASS" ? "FAIL" : "PASS"
          : observation.status,
        reason: "Independent reviewer " + reviewerId + " checked this run.",
        evidenceSha256: observation.evidence.map((ref) => ref.sha256),
      }));
      return {
        runId: options.mismatchReviewerRun && reviewerIndex === 0 && runIndex === 0 ? "missing-subrun-id" : run.runId,
        caseId: run.caseId,
        variantId: run.variantId,
        appFingerprint,
        routeId: route.id,
        ...(options.missingReviewerServedFingerprint && reviewerIndex === 0 && runIndex === 0 ? {} : {
          servedUiBuildFingerprint: options.mismatchReviewerServedFingerprint && reviewerIndex === 0 && runIndex === 0
            ? "d".repeat(64)
            : route.servedUiBuildFingerprint,
        }),
        routeUrl: route.url,
        routeCaptureSha256: route.screenshot.sha256,
        sourceSnapshotSha256: options.mismatchSnapshot && reviewerIndex === 0 && runIndex === 0
          ? "f".repeat(64)
          : run.sourceSnapshotSha256,
        prestateDescriptionSha256: createHash("sha256").update(
          options.mismatchPrestate && reviewerIndex === 0 && runIndex === 0
            ? "changed after review"
            : (run.prestate as { description: string }).description,
        ).digest("hex"),
        prestateEvidenceSha256: prestate.evidence.map((ref) => ref.sha256),
        observations: reportObservations,
      };
    });
    const report = artifact(dir, "review-" + reviewerIndex + ".json", JSON.stringify({
      schemaVersion: 3,
      kind: "codex_subagent_review",
      reviewerId,
      suiteVersion,
      suiteRunId,
      appFingerprint,
      servedUiBuildFingerprint: options.mismatchManifestServedFingerprint && reviewerIndex === 0
        ? "d".repeat(64)
        : servedUiBuildFingerprint,
      runs: reportRuns,
    }));
    return { kind: "codex_subagent", id: reviewerId, report };
  });

  const manifest = {
    schemaVersion: 3,
    suiteVersion,
    runId: suiteRunId,
    appFingerprint,
    servedUiBuildFingerprint: options.mismatchManifestServedFingerprint ? "d".repeat(64) : servedUiBuildFingerprint,
    reviewers: reviewerRows,
    runs,
  };
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  return { dir, manifestPath, manifest };
}

function loadPassedPackage(options: PackageOptions = {}) {
  const { manifestPath } = packageEvidence(options);
  return loadJourneyReviewEvidence(manifestPath, fingerprint, "local", servedUiBuildFingerprint);
}

function loadEvidence(manifestPath: string, route: "cloud" | "local" = "local", expectedServedUiFingerprint = servedUiBuildFingerprint) {
  return loadJourneyReviewEvidence(manifestPath, fingerprint, route, expectedServedUiFingerprint);
}

function gradeAll(journey: ReturnType<typeof loadJourneyReviewEvidence>) {
  return GOLDEN_CASES.map((scenario) => gradeGoldenCase(scenario, journey.observations.get(scenario.id) ?? []));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("golden investor readiness decision", () => {
  it("keeps scripted labels and unbound journey records unverified", () => {
    const scenario = GOLDEN_CASES[2]!;
    const fabricated: GoldenObservation[] = requiredGoldenCriteria(scenario).map(({ variantId, criterion }) => ({
      variantId, criterion, runId: "forged-run", status: "PASS", reason: "Scripted label.", evidence: ["journey-journal"], kind: "user_journey",
    }));
    expect(gradeGoldenCase(scenario, fabricated).status).toBe("UNVERIFIED");
    expect(gradeGoldenCase(scenario, fabricated.map((item) => ({ ...item, kind: "fixture" }))).status).toBe("UNVERIFIED");
  });

  it("cannot certify investor acceptance from complete file-based reviewer PASS claims", () => {
    const journey = loadPassedPackage();
    const results = gradeAll(journey);
    const requiredRunCount = GOLDEN_CASES.reduce((sum, scenario) => sum + scenario.variants.length, 0);
    expect(journey.routes).toHaveLength(requiredRunCount);
    expect(new Set(journey.routes.map((route) => route.runId)).size).toBe(requiredRunCount);
    expect(journey.servedUiBuildFingerprint).toBe(servedUiBuildFingerprint);
    expect(journey.routes.every((route) => route.servedUiBuildFingerprint === servedUiBuildFingerprint)).toBe(true);
    for (const scenario of GOLDEN_CASES) {
      const rows = journey.observations.get(scenario.id)!;
      for (const variant of scenario.variants) {
        const variantRows = rows.filter((row) => row.variantId === variant.id);
        expect(new Set(variantRows.map((row) => row.runId)).size).toBe(1);
        expect(variantRows.map((row) => row.criterion).sort()).toEqual([...variant.required].sort());
      }
    }
    expect(results.every((item) => item.status === "UNVERIFIED")).toBe(true);
    expect(results.every((item) => item.observations.every((observation) => observation.status === "UNVERIFIED"))).toBe(true);
    expect(goldenReady(results, journey, new Map(), [
      { id: "native-route", status: "PASS", reason: "Selected route checked.", evidence: null },
    ])).toBe(false);
    const callerSuppliedPasses = results.map((item) => ({ ...item, status: "PASS" as const }));
    expect(goldenReady(callerSuppliedPasses, journey, new Map(), [
      { id: "native-route", status: "PASS", reason: "Selected route checked.", evidence: null },
    ])).toBe(false);
    expect(goldenReady(results, { ...journey })).toBe(false);
    expect(goldenReady(results.slice(1), journey)).toBe(false);
    expect(goldenReady([...results.slice(1), results[1]!], journey)).toBe(false);
  });

  it("keeps readiness false when any required real variant is blocked or unverified", () => {
    for (const status of ["FAIL", "BLOCKED", "UNVERIFIED"] as const) {
      const journey = loadPassedPackage({ overrideStatus: status });
      const results = gradeAll(journey);
      expect(results.every((item) => item.status === status)).toBe(true);
      expect(goldenReady(results, journey)).toBe(false);
    }
  });

  it("requires every route capture and each reviewer subrun to match the observed served UI build", () => {
    const missingRoute = packageEvidence({ missingRouteServedFingerprint: true });
    expect(() => loadEvidence(missingRoute.manifestPath)).toThrow("journey_evidence_served_ui_build_mismatch");

    const wrongRoute = packageEvidence({ mismatchRouteServedFingerprint: true });
    expect(() => loadEvidence(wrongRoute.manifestPath)).toThrow("journey_evidence_served_ui_build_mismatch");

    const missingReviewer = packageEvidence({ missingReviewerServedFingerprint: true });
    expect(() => loadEvidence(missingReviewer.manifestPath)).toThrow("journey_evidence_subagent_report_run_mismatch");

    const wrongReviewer = packageEvidence({ mismatchReviewerServedFingerprint: true });
    expect(() => loadEvidence(wrongReviewer.manifestPath)).toThrow("journey_evidence_subagent_report_run_mismatch");

    const wrongSuite = packageEvidence();
    expect(() => loadEvidence(wrongSuite.manifestPath, "local", "e".repeat(64))).toThrow("journey_evidence_manifest_version_or_build_mismatch");

    const wrongManifest = packageEvidence({ mismatchManifestServedFingerprint: true });
    expect(() => loadEvidence(wrongManifest.manifestPath)).toThrow("journey_evidence_manifest_version_or_build_mismatch");

    const wrongExpectedFingerprint = packageEvidence();
    expect(() => loadEvidence(wrongExpectedFingerprint.manifestPath, "local", "not-a-sha256"))
      .toThrow("journey_evidence_expected_served_ui_build_fingerprint_invalid");
  });

  it("does not preserve Ready if loaded served-build evidence is altered after validation", () => {
    const changedBundle = loadPassedPackage();
    const changedBundleResults = gradeAll(changedBundle);
    changedBundle.servedUiBuildFingerprint = "d".repeat(64);
    expect(goldenReady(changedBundleResults, changedBundle)).toBe(false);

    const changedRoute = loadPassedPackage();
    const changedRouteResults = gradeAll(changedRoute);
    changedRoute.routes[0]!.servedUiBuildFingerprint = "d".repeat(64);
    expect(goldenReady(changedRouteResults, changedRoute)).toBe(false);
  });

  it("fails closed on missing and duplicate case-variant runs", () => {
    const missing = packageEvidence({ missingRun: true });
    expect(() => loadEvidence(missing.manifestPath)).toThrow("journey_evidence_variant_run_missing");

    const duplicate = packageEvidence({ duplicateRun: true });
    expect(() => loadEvidence(duplicate.manifestPath)).toThrow("journey_evidence_variant_run_duplicate_or_unknown");
  });

  it("does not accept a subrun with no observed prestate or real-source snapshot", () => {
    const noPrestate = packageEvidence();
    (noPrestate.manifest.runs[0]!.prestate as { evidence: unknown[] }).evidence = [];
    writeFileSync(noPrestate.manifestPath, JSON.stringify(noPrestate.manifest), { mode: 0o600 });
    expect(() => loadEvidence(noPrestate.manifestPath)).toThrow("journey_evidence_prestate_invalid");

    const noSnapshot = packageEvidence();
    noSnapshot.manifest.runs[0]!.sourceSnapshotSha256 = "f".repeat(64);
    writeFileSync(noSnapshot.manifestPath, JSON.stringify(noSnapshot.manifest), { mode: 0o600 });
    expect(() => loadEvidence(noSnapshot.manifestPath)).toThrow("journey_evidence_source_snapshot_invalid");
  });

  it("rejects a screenshot signature or a route capture reused across subruns", () => {
    const packageWithInvalidImage = packageEvidence();
    const run = packageWithInvalidImage.manifest.runs[0]!;
    (run.route as { screenshot: { path: string; sha256: string } }).screenshot = artifact(
      packageWithInvalidImage.dir,
      "fake-image.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    writeFileSync(packageWithInvalidImage.manifestPath, JSON.stringify(packageWithInvalidImage.manifest), { mode: 0o600 });
    expect(() => loadEvidence(packageWithInvalidImage.manifestPath)).toThrow("journey_evidence_route_capture_must_be_image");

    const reused = packageEvidence();
    const firstScreenshot = (reused.manifest.runs[0]!.route as { screenshot: unknown }).screenshot;
    (reused.manifest.runs[1]!.route as { screenshot: unknown }).screenshot = firstScreenshot;
    writeFileSync(reused.manifestPath, JSON.stringify(reused.manifest), { mode: 0o600 });
    expect(() => loadEvidence(reused.manifestPath)).toThrow("journey_evidence_route_capture_reused");
  });

  it("fails closed on incomplete criteria and mismatched subrun/reviewer evidence", () => {
    const firstScenario = GOLDEN_CASES[0]!;
    const firstVariant = firstScenario.variants[0]!;
    const firstCriterion = firstVariant.required[0]!;
    const incomplete = packageEvidence({ omitCriterion: firstScenario.id + "/" + firstVariant.id + ":" + firstCriterion });
    expect(() => loadEvidence(incomplete.manifestPath)).toThrow("journey_evidence_variant_criteria_incomplete");

    const wrongRun = packageEvidence({ mismatchReviewerRun: true });
    expect(() => loadEvidence(wrongRun.manifestPath)).toThrow("journey_evidence_subagent_report_run_mismatch");

    const wrongSnapshot = packageEvidence({ mismatchSnapshot: true });
    expect(() => loadEvidence(wrongSnapshot.manifestPath)).toThrow("journey_evidence_subagent_report_run_mismatch");

    const wrongPrestate = packageEvidence({ mismatchPrestate: true });
    expect(() => loadEvidence(wrongPrestate.manifestPath)).toThrow("journey_evidence_subagent_report_run_mismatch");

    const disagreed = packageEvidence({ reviewerDisagreement: true });
    expect(() => loadEvidence(disagreed.manifestPath)).toThrow("journey_evidence_independent_review_disagreement");
  });

  it("fails closed on changed artifacts, wrong suite/build, missing reviewer and wrong route", () => {
    const changed = packageEvidence();
    const firstArtifact = path.join(changed.dir, changed.manifest.reviewers[0]!.report.path);
    writeFileSync(firstArtifact, "tampered after manifest creation", { mode: 0o600 });
    expect(() => loadEvidence(changed.manifestPath)).toThrow("journey_evidence_artifact_hash_mismatch");

    const wrongBuild = packageEvidence({ wrongFingerprint: true });
    expect(() => loadEvidence(wrongBuild.manifestPath)).toThrow("journey_evidence_manifest_version_or_build_mismatch");

    const wrongVersion = packageEvidence({ wrongSuiteVersion: true });
    expect(() => loadEvidence(wrongVersion.manifestPath)).toThrow("journey_evidence_manifest_version_or_build_mismatch");

    const oneReviewer = packageEvidence({ secondReviewer: false });
    expect(() => loadEvidence(oneReviewer.manifestPath)).toThrow("journey_evidence_requires_two_independent_subagents");

    for (const routeUrl of ["https://example.com/", "http://example.com/", "http://127.0.0.1:8798/?token=not-allowed"]) {
      const wrongRoute = packageEvidence({ routeUrl });
      expect(() => loadEvidence(wrongRoute.manifestPath)).toThrow("journey_evidence_route_url_invalid");
    }
    const wrongProduct = packageEvidence();
    expect(() => loadEvidence(wrongProduct.manifestPath, "cloud")).toThrow("journey_evidence_requires_selected_product_route");
  });

  it("does not accept copied or incomplete reviewer objects as readiness authority", () => {
    const journey = loadPassedPackage();
    const results = gradeAll(journey);
    expect(goldenReady(results, { ...journey })).toBe(false);
    expect(goldenReady(results, journey, new Map(), [
      { id: "runtime", status: "BLOCKED", reason: "The supported product route is unavailable.", evidence: null },
    ])).toBe(false);
  });

  it("does not let runner-only native failures be hidden by reviewed outcomes", () => {
    const journey = loadPassedPackage();
    const results = gradeAll(journey);
    const blocker: GoldenObservation = {
      variantId: "explicit-provider-result", criterion: "rendered_chart", status: "FAIL", reason: "The selected provider route has no sentiment chart.",
      evidence: ["source:CloudResearchDesk.tsx"], kind: "code_inspection",
    };
    const g3 = gradeGoldenCase(GOLDEN_CASES[2]!, journey.observations.get("G3")!, [blocker]);
    expect(g3.status).toBe("FAIL");
    expect(goldenReady(results, journey, new Map([["G3", [blocker]]]))).toBe(false);
  });

  it("recomputes bound failures instead of trusting caller-supplied case statuses", () => {
    const journey = loadPassedPackage();
    const callerSuppliedPasses = GOLDEN_CASES.map((scenario) => ({
      id: scenario.id, job: scenario.job, status: "PASS" as const, observations: [],
    }));
    const blocker: GoldenObservation = {
      variantId: "explicit-provider-result", criterion: "authentic_provider_result", status: "BLOCKED",
      reason: "No saved authentic selected-provider result.", evidence: ["native:no-real-classification"], kind: "native_api",
    };
    expect(goldenReady(callerSuppliedPasses, journey, new Map([["G3", [blocker]]]))).toBe(false);
  });

  it("binds known native failures to the correct required criteria", () => {
    const bindings = bindNativeCheckFailures([
      { id: "two-real-issuer-api-selection", status: "FAIL", reason: "A→B→A read mismatch.", evidence: null },
      { id: "unmapped-native-step", status: "BLOCKED", reason: "Runtime precondition missing.", evidence: null },
    ]);
    expect(bindings.get("G2")?.[0]).toMatchObject({ variantId: "desktop-a-b-a", criterion: "identity_readback", status: "FAIL" });
    expect(GOLDEN_CASES.every((scenario) =>
      bindings.get(scenario.id)?.filter((binding) => binding.evidence.includes("native:unmapped-native-step")).length === requiredGoldenCriteria(scenario).length,
    )).toBe(true);
    const journey = loadPassedPackage();
    expect(goldenReady(gradeAll(journey), journey, bindings, [
      { id: "unmapped-native-step", status: "BLOCKED", reason: "Runtime precondition missing.", evidence: null },
    ])).toBe(false);
  });

  it("requires explicit route selection and exact sanitized connection identity", () => {
    const gemini = { loopback: true, providers: [{ provider: "google_gemini", model: "gemini-3.8-flash", configured: true, credentialUnavailable: false }] };
    expect(assessGoldenProviderAuthorization(null, gemini).status).toBe("BLOCKED");
    expect(assessGoldenProviderAuthorization("google-gemini-byok", gemini).status).toBe("PASS");
    for (const provider of [
      { ...gemini.providers[0], configured: false },
      { ...gemini.providers[0], credentialUnavailable: true },
      { ...gemini.providers[0], model: "another-model" },
    ]) expect(assessGoldenProviderAuthorization("google-gemini-byok", { ...gemini, providers: [provider] }).status).toBe("BLOCKED");
    expect(assessGoldenProviderAuthorization("luna-plan", { configured: true, connected: false, modelAvailable: false, ready: false }).status).toBe("BLOCKED");
    expect(assessGoldenProviderAuthorization("luna-plan", { configured: true, connected: true, modelAvailable: true, ready: true }).status).toBe("PASS");
  });

  it.each([
    ["selected-provider-authorization", "authorized_selected_provider_route", "BLOCKED"],
    ["selected-provider-public-input", "public_input_eligible", "FAIL"],
    ["selected-provider-identity", "returned_model_identity", "FAIL"],
    ["selected-provider-source-drilldown", "exact_source_drilldown", "FAIL"],
  ] as const)("keeps %s binding on the public selected-provider task", (id, criterion, status) => {
    const bindings = bindNativeCheckFailures([{ id, status, reason: "Selected provider precondition failed.", evidence: null }]);
    expect([...bindings.keys()]).toEqual(["G3"]);
    expect(bindings.get("G3")).toEqual([expect.objectContaining({ variantId: "explicit-provider-result", criterion, status })]);
    const journey = loadPassedPackage();
    expect(gradeGoldenCase(GOLDEN_CASES[2]!, journey.observations.get("G3")!, bindings.get("G3")).status).toBe(status);
    expect(goldenReady(gradeAll(journey), journey, bindings)).toBe(false);
  });

  it("blocks private Luna dispatch without blocking the unselected public Gemini route", () => {
    const bindings = bindNativeCheckFailures([{ id: "private-luna-authorization", status: "BLOCKED", reason: "The user kept ChatGPT disconnected.", evidence: null }]);
    expect([...bindings.keys()]).toEqual(["G7"]);
    expect(bindings.get("G7")).toEqual([expect.objectContaining({ variantId: "confirm-selected-item", criterion: "authorized_plan_route", status: "BLOCKED" })]);
    const journey = loadPassedPackage();
    expect(gradeGoldenCase(GOLDEN_CASES[6]!, journey.observations.get("G7")!, bindings.get("G7")).status).toBe("BLOCKED");
    expect(gradeGoldenCase(GOLDEN_CASES[2]!, journey.observations.get("G3")!, bindings.get("G3")).status).toBe("UNVERIFIED");
    expect(goldenReady(gradeAll(journey), journey, bindings)).toBe(false);
  });

  it("requires an approved, fresh, complete source feed and open collection controls", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const health = {
      externalRequestsEnabled: true,
      health: { sourceApproval: { approvedCollectors: ["google_news_rss"] } },
      storage: { canStartExternalWork: true, writesAllowed: true },
      deliveryHealth: [{
        collector: "google_news_rss", enabled: true, state: "current", intervalSeconds: 900,
        targetCount: 24, coverageCount: 24, latestDeliveryAt: now - 60_000, latestResult: "success",
        latestIngestionRequired: true, latestIngestionState: "success",
        latestIngestionExpectedCount: 100, latestIngestionProcessedCount: 100,
      }],
    };
    expect(assessConfiguredFeedHealth(health, now)).toMatchObject({
      feedReady: true, collectionOpen: true, collector: "google_news_rss", coverageCount: 24, targetCount: 24,
    });
    expect(assessConfiguredFeedHealth({ ...health, storage: { canStartExternalWork: false, writesAllowed: false } }, now).collectionOpen).toBe(false);
    expect(assessConfiguredFeedHealth({ ...health, deliveryHealth: [{ ...health.deliveryHealth[0], latestIngestionProcessedCount: 99 }] }, now).feedReady).toBe(false);
    expect(assessConfiguredFeedHealth({ ...health, deliveryHealth: [{ ...health.deliveryHealth[0], latestDeliveryAt: now - 3_000_000 }] }, now).feedReady).toBe(false);
  });

  it("accepts fresh partial feed coverage while preserving its counts", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const health = {
      externalRequestsEnabled: true,
      health: { sourceApproval: { approvedCollectors: ["google_news_rss"] } },
      storage: { canStartExternalWork: true, writesAllowed: true },
      deliveryHealth: [{
        collector: "google_news_rss", enabled: true, state: "partial", intervalSeconds: 900,
        targetCount: 24, coverageCount: 16, latestDeliveryAt: now - 60_000, latestResult: "success",
        latestIngestionRequired: true, latestIngestionState: "success",
        latestIngestionExpectedCount: 100, latestIngestionProcessedCount: 100,
      }],
    };
    expect(assessConfiguredFeedHealth(health, now)).toMatchObject({
      feedReady: true, collectionOpen: true, coverageCount: 16, targetCount: 24,
    });
    expect(assessConfiguredFeedHealth({ ...health, deliveryHealth: [{ ...health.deliveryHealth[0], latestResult: "partial" }] }, now).feedReady).toBe(false);
  });
});
