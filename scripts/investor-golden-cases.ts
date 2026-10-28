import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Frozen real investor jobs; variants and required observations were independently challenged. */
export const GOLDEN_VERSION = "investor-workflows-2026-10-14-v9";
export const GOLDEN_PROVIDER_ROUTES = {
  "luna-plan": { provider: "openai_luna", model: "gpt-6-luna", accountingRoute: "chatgpt_plan", series: "categorical-series", bucket: "categorical-bucket" },
  "google-gemini-byok": { provider: "google_gemini", model: "gemini-3.8-flash", accountingRoute: "api_key", series: "google-gemini-categorical-series", bucket: "google-gemini-categorical-bucket" },
} as const;
export type GoldenProviderRoute = keyof typeof GOLDEN_PROVIDER_ROUTES;
export const GOLDEN_CASES = [
  { id: "G1", job: "Find a source-backed starting point without knowing a ticker", prestate: "Fresh investor session with no ticker or curated issuer set; fixed UTC cutoff.", variants: [
    { id: "relevant-lead", description: "Eligible public evidence supports at least one lead", required: ["real_entry", "useful_lead", "source_checked", "coverage_visible"] },
    { id: "no-relevant-source", description: "The configured sources return no relevant lead", required: ["honest_empty_state", "coverage_visible", "next_check"] },
    { id: "stale-partial-coverage", description: "Coverage is stale or partial", required: ["stale_or_partial_disclosed", "source_checked"] },
    { id: "outside-configured-roster", description: "A candidate is outside the configured coverage universe", required: ["universe_limit_visible", "no_invented_lead"] },
  ], rule: "A real eligible lead is useful only when source links, coverage and a next check are visible. When sources contain no relevant candidate, an honest empty result with coverage limits and a next check passes; inventing a lead fails." },
  { id: "G2", job: "Select A, then B, then A without mixed company evidence", prestate: "Two real configured public issuers with receipt-backed evidence; start on A.", variants: [
    { id: "desktop-a-b-a", description: "Select A, then B, then return to A", required: ["identity_readback", "rendered_selection"] },
    { id: "narrow-390px", description: "Repeat selection at a 390px viewport", required: ["narrow_screen", "rendered_selection"] },
    { id: "empty-issuer", description: "Select an issuer that has no eligible evidence", required: ["honest_empty_state", "identity_readback"] },
  ], rule: "Visible issuer identity, chart, records and saved research always match the selected company. A delayed response cannot replace B; the empty issuer stays explicitly empty." },
  { id: "G3", job: "Explicitly classify real evidence and inspect the sentiment chart", prestate: "Real issuer-bound public sources and the user's explicit selected Luna or Google Gemini route; no prewritten classification. A disconnected or missing selected connection blocks the send.", variants: [
    { id: "explicit-provider-result", description: "Confirm the selected public evidence and exact provider/model route, then save and read back the receipt-backed response in that provider's chart and drilldown", required: ["authorized_selected_provider_route", "public_input_eligible", "explicit_send_only", "disclosed_payload", "returned_model_identity", "authentic_provider_result", "current_write_read_path", "rendered_chart", "exact_source_drilldown"] },
    { id: "bucket-oracle", description: "Reconcile chart counts to source-level saved categories", required: ["independent_bucket_math"] },
    { id: "sparse-window", description: "Only a small number of eligible records exist", required: ["sparse_window_honest"] },
    { id: "opposing-categories", description: "Positive and negative records occur in the same display interval", required: ["opposing_categories_preserved"] },
    { id: "repeated-coverage", description: "Multiple source IDs describe a repeated story", required: ["repeat_lineage_visible"] },
  ], rule: "Use saved Positive, Neutral, Negative, Needs review and Excluded categories from only the explicitly selected exact provider/model route: GPT-6 Luna through a user-connected ChatGPT plan or Google Gemini gemini-3.8-flash through the user's BYOK connection. Google Gemini Free is eligible only for real public source evidence, never private, confidential or personal evidence; account tier, free allowance and balance remain unverified by the app. The chart and drilldown must identify that provider and reconcile only its receipt-backed classifications, without pooling Luna, Gemini or historical Jev. Count each eligible immutable source observation once in its validated source-time 15-minute UTC bucket; display aggregation uses the chart's 30-minute, 1-, 3- or 6-hour interval and must exactly reconcile all five category totals to the source API. Repeated source IDs remain visible lineage and the bucket drilldown must return the same receipt-linked IDs. Invalid receipts, issuer mismatches, untimed rows, lineage mismatches and declined sends are regression tests, not live-user prerequisites. Missing explicit route selection, authentication, an authentic exact-identity response or eligible public evidence means BLOCKED; fixtures and file-based reviewer packages never establish acceptance." },
  { id: "G4", job: "Find, paginate, reopen and recover source evidence", prestate: "Real source archive larger than one page and an opened populated G3 chart bucket.", variants: [
    { id: "configured-feed-health", description: "Inspect live configured source connections and retained delivery state", required: ["configured_source_visible", "approved_source_enabled", "fresh_successful_delivery", "completed_ingestion", "eligible_coverage_visible", "collection_admission_open"] },
    { id: "issuer-and-window-switch", description: "Switch issuer and chart window", required: ["issuer_window_scope"] },
    { id: "stable-pagination", description: "Read every page in the source archive and chart drilldown", required: ["stable_cursor", "no_duplicate_or_missing_ids", "page_count_reconciles"] },
    { id: "restart", description: "Restart and reopen the same evidence snapshot", required: ["real_source_readback", "source_clocks", "rendered_archive"] },
    { id: "confirmed-empty-vs-unknown", description: "Distinguish a confirmed empty response from an unavailable/unknown source", required: ["empty_unknown_distinction"] },
  ], rule: "At least one rights-approved configured source must be enabled and have a successful delivery plus completed ingestion inside its declared freshness budget; the UI shows the source, coverage and clocks. Every displayed item retains exact issuer, source ID, URL, passage and distinct event/publication/availability/retrieval/ingestion clocks. Stable pagination has no omitted or duplicate IDs. Collector failure retention and recovery are exercised by regression tests, not by inducing an outage in a real investor task." },
  { id: "G5", job: "Answer and resume an analyst-authored company research question", prestate: "A genuine analyst-authored question and saved decision for one public issuer, with real supporting and contrary evidence.", variants: [
    { id: "real-source-window", description: "Open the real issuer evidence used for the analyst's question", required: ["nonempty_real_evidence"] },
    { id: "period-unit-conflict", description: "A supporting fact differs by period or unit from a competing fact", required: ["period_and_unit_exact"] },
    { id: "stale-partial-evidence", description: "Relevant sources are stale or partial", required: ["uncertainty_and_freshness_disclosed"] },
    { id: "missing-counterevidence", description: "No adequate contrary evidence is available", required: ["counterevidence_gap_disclosed", "next_check"] },
    { id: "saved-decision-resume", description: "Restart and reopen the analyst's saved decision", required: ["decision_restart_readback", "rendered_resume", "claim_support"] },
  ], rule: "The active analyst's actual question, decision and next action must be used; they must not be invented for the evaluation. Material claims cite exact issuer/source/period/unit; support, contrary evidence, freshness and uncertainty remain visible. Missing analyst-authored state blocks this case." },
  { id: "G6", job: "Understand a real followed-company development against its immutable baseline", prestate: "An existing real immutable baseline and subsequent real source snapshots for one configured public issuer.", variants: [
    { id: "genuine-new-development", description: "A new material source appears after the baseline", required: ["real_changed_development", "rendered_comparison"] },
    { id: "no-change", description: "No new eligible event exists", required: ["no_change_reported_honestly"] },
    { id: "baseline-immutability", description: "Create a later comparison, then recover the old baseline", required: ["baseline_unchanged_and_recoverable", "baseline_restart_readback"] },
  ], rule: "Set differences reconcile to real immutable source IDs and source clocks. A later comparison must not mutate the old baseline; the original version is retrievable after restart. Repost, late-arrival and late-finalized-fact handling remain deterministic regression cases." },
  { id: "G7", job: "Keep private research separate and send only an explicitly selected item", prestate: "An owner-authorized private research item for a configured public issuer; private-company scope is negative.", variants: [
    { id: "ordinary-read", description: "Read the item without invoking an external model", required: ["ordinary_read_sends_nothing", "public_issuer_scope", "private_excluded_from_public_counts"] },
    { id: "switch-issuer", description: "Switch to another issuer", required: ["private_public_separation"] },
    { id: "decline-send", description: "Decline the item-level confirmation", required: ["declined_send_makes_no_request"] },
    { id: "confirm-selected-item", description: "Confirm exact item, disclosed fields and GPT-6 Luna", required: ["authorized_plan_route", "explicit_send_only", "disclosed_payload", "returned_model_identity"] },
  ], rule: "Only selected private evidence about a configured public issuer is in scope; it stays local and out of public evidence counts. Ordinary reads and declined confirmations send nothing. Google Gemini Free must never process private, confidential or personal evidence. Only an explicitly connected Luna route and item-level confirmation authorize the selected private send; the disconnected ChatGPT plan blocks that variant while local reads remain available. Confirmed analysis discloses only shown fields and records actual returned identity. Provider-identity mismatch and private-company rejection remain regression cases. Missing owner-authorized item, connection or confirmation blocks the case." },
] as const;

export type GoldenStatus = "PASS" | "FAIL" | "BLOCKED" | "UNVERIFIED";
export interface GoldenObservation { variantId: string; criterion: string; runId?: string; status: GoldenStatus; reason: string; evidence: string[]; kind: "user_journey" | "native_api" | "fixture" | "code_inspection" | "none" }
export interface GoldenCaseResult { id: string; job: string; status: GoldenStatus; observations: GoldenObservation[] }
export interface GoldenNativeCheck { id: string; status: "PASS" | "FAIL" | "BLOCKED"; reason: string; evidence: unknown }

export interface GoldenArtifactRef { path: string; sha256: string }
export interface JourneyReviewEvidence {
  suiteVersion: string;
  runId: string;
  appFingerprint: string;
  servedUiBuildFingerprint: string;
  reviewers: string[];
  routes: Array<{ runId: string; caseId: string; variantId: string; id: "cloud" | "local"; url: string; servedUiBuildFingerprint: string; screenshot: GoldenArtifactRef }>;
  observations: Map<string, GoldenObservation[]>;
}

const journeyReviewRuns = new WeakMap<object, {
  suiteVersion: string;
  routeId: "cloud" | "local";
  servedUiBuildFingerprint: string;
  observations: Map<string, GoldenObservation[]>;
}>();
const reviewedObservationBatches = new WeakMap<object, { suiteVersion: string; caseId: string; appFingerprint: string; runIds: Map<string, string> }>();
const sha256Pattern = /^[a-f0-9]{64}$/;

export function requiredGoldenCriteria(scenario: typeof GOLDEN_CASES[number]) {
  return scenario.variants.flatMap((variant) => variant.required.map((criterion) => ({ variantId: variant.id, criterion })));
}

/** Connection admission only; it does not prove consent, a result, model quality or account tier. */
export function assessGoldenProviderAuthorization(route: GoldenProviderRoute | null, value: unknown): { status: "PASS" | "BLOCKED"; reason: string } {
  if (!route) return { status: "BLOCKED", reason: "No provider route was explicitly selected for the real public-evidence task." };
  const status = record(value) ? value : null;
  if (route === "luna-plan") {
    const admitted = status?.configured === true && status.connected === true && status.modelAvailable === true && status.ready === true;
    return { status: admitted ? "PASS" : "BLOCKED", reason: admitted
      ? "The selected Luna plan route reports a connected, available connection; item-level consent and an authentic returned identity remain required."
      : "The selected Luna plan route is disconnected, unavailable or not ready; the evaluator will not connect it." };
  }
  const providers = Array.isArray(status?.providers) ? status.providers.filter((item) => record(item) && item.provider === "google_gemini") : [];
  const provider = providers.length === 1 && record(providers[0]) ? providers[0] : null;
  const admitted = status?.loopback === true && provider?.configured === true && provider.credentialUnavailable === false
    && provider.model === GOLDEN_PROVIDER_ROUTES[route].model;
  return { status: admitted ? "PASS" : "BLOCKED", reason: admitted
    ? "The selected exact Gemini BYOK route reports a configured credential. Consent, real public input, authentic response and user-reviewed provider terms remain required; account tier and balance are unverified."
    : "The selected exact Gemini BYOK route has no available configured credential or matching model identity; the evaluator will not load or create a key." };
}

export function assessConfiguredFeedHealth(value: unknown, now = Date.now()) {
  const root = record(value) ? value : null;
  const health = record(root?.health) ? root.health : null;
  const approval = record(health?.sourceApproval) ? health.sourceApproval : null;
  const approved = new Set(Array.isArray(approval?.approvedCollectors)
    ? approval.approvedCollectors.filter((item): item is string => typeof item === "string") : []);
  const rows = Array.isArray(root?.deliveryHealth) ? root.deliveryHealth : [];
  const feeds = rows.filter((item): item is Record<string, unknown> => record(item)
    && typeof item.collector === "string" && approved.has(item.collector) && item.enabled === true);
  const current = feeds.filter((item) => {
    const intervalSeconds = item.intervalSeconds;
    const deliveredAt = item.latestDeliveryAt;
    const coverage = item.coverageCount;
    const target = item.targetCount;
    if (typeof intervalSeconds !== "number" || !Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0
      || typeof deliveredAt !== "number" || !Number.isSafeInteger(deliveredAt) || deliveredAt > now
      || now - deliveredAt > Math.max(intervalSeconds * 3_000, 180_000)
      || !["current", "partial"].includes(String(item.state)) || !["success", "empty"].includes(String(item.latestResult))
      || typeof coverage !== "number" || !Number.isSafeInteger(coverage) || coverage <= 0
      || typeof target !== "number" || !Number.isSafeInteger(target) || target <= 0) return false;
    if (item.latestIngestionRequired !== true) return true;
    return item.latestIngestionState === "success"
      && Number.isSafeInteger(item.latestIngestionExpectedCount)
      && item.latestIngestionExpectedCount === item.latestIngestionProcessedCount;
  });
  const feed = current[0] ?? null;
  const storage = record(root?.storage) ? root.storage : null;
  return {
    feedReady: feed !== null,
    collectionOpen: feed !== null && root?.externalRequestsEnabled === true
      && storage?.canStartExternalWork === true && storage.writesAllowed === true,
    collector: typeof feed?.collector === "string" ? feed.collector : null,
    coverageCount: typeof feed?.coverageCount === "number" ? feed.coverageCount : null,
    targetCount: typeof feed?.targetCount === "number" ? feed.targetCount : null,
    latestDeliveryAt: typeof feed?.latestDeliveryAt === "number" ? feed.latestDeliveryAt : null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validImageContainer(bytes: Buffer): boolean {
  const pngSignature = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (pngSignature) {
    let offset = 8;
    let hasHeader = false;
    let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      if (length > bytes.length - offset - 12) return false;
      if (!hasHeader && (type !== "IHDR" || length !== 13)) return false;
      if (type === "IHDR") hasHeader = true;
      if (type === "IDAT") hasData = true;
      offset += length + 12;
      if (type === "IEND") return length === 0 && hasHeader && hasData && offset === bytes.length;
    }
    return false;
  }
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.length >= 20 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return jpeg || webp;
}

function verifyArtifact(value: unknown, evidenceRoot: string, imageOnly = false): GoldenArtifactRef {
  if (!record(value) || typeof value.path !== "string" || !value.path || typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256)) {
    throw new Error("journey_evidence_invalid_artifact_reference");
  }
  if (path.isAbsolute(value.path) || value.path.split(/[\\/]/).includes("..")) throw new Error("journey_evidence_artifact_path_invalid");
  const root = realpathSync(evidenceRoot);
  const evidenceStat = lstatSync(root);
  if (!evidenceStat.isDirectory() || evidenceStat.isSymbolicLink() || (evidenceStat.mode & 0o077) !== 0) throw new Error("journey_evidence_artifact_directory_must_be_private");
  const unresolved = path.resolve(root, value.path);
  const stat = lstatSync(unresolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 20 * 1024 * 1024) {
    throw new Error("journey_evidence_artifact_must_be_private_regular_file");
  }
  const resolved = realpathSync(unresolved);
  if (!resolved.startsWith(root + path.sep)) throw new Error("journey_evidence_artifact_outside_root");
  const bytes = readFileSync(resolved);
  if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new Error("journey_evidence_artifact_hash_mismatch");
  if (imageOnly && !validImageContainer(bytes)) {
    throw new Error("journey_evidence_route_capture_must_be_image");
  }
  return { path: value.path, sha256: value.sha256 };
}

/** Load a complete independently reviewed package with one real subrun per case variant. */
export function loadJourneyReviewEvidence(
  manifestPath: string,
  expectedAppFingerprint: string,
  expectedRoute: "cloud" | "local",
  expectedServedUiBuildFingerprint: string,
): JourneyReviewEvidence {
  if (!sha256Pattern.test(expectedAppFingerprint)) throw new Error("journey_evidence_expected_fingerprint_invalid");
  if (!sha256Pattern.test(expectedServedUiBuildFingerprint)) throw new Error("journey_evidence_expected_served_ui_build_fingerprint_invalid");
  const root = path.resolve(process.cwd(), ".engineering-evidence/investor-golden/journeys");
  const privateRoot = realpathSync(root);
  const rootStat = lstatSync(root);
  const runRootStat = lstatSync(path.dirname(root));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0
    || !runRootStat.isDirectory() || runRootStat.isSymbolicLink() || (runRootStat.mode & 0o077) !== 0) throw new Error("journey_evidence_root_must_be_private_directory");
  const manifestInput = path.resolve(manifestPath);
  const manifestInputStat = lstatSync(manifestInput);
  if (!manifestInputStat.isFile() || manifestInputStat.isSymbolicLink()) throw new Error("journey_evidence_manifest_must_be_private_regular_file");
  const manifestAbsolute = realpathSync(manifestPath);
  if (!manifestAbsolute.startsWith(privateRoot + path.sep)) throw new Error("journey_evidence_manifest_outside_private_root");
  const manifestStat = lstatSync(manifestAbsolute);
  if (!manifestStat.isFile() || (manifestStat.mode & 0o077) !== 0 || manifestStat.size < 1 || manifestStat.size > 4 * 1024 * 1024) {
    throw new Error("journey_evidence_manifest_must_be_private_regular_file");
  }
  const evidenceDir = path.dirname(manifestAbsolute);
  const raw: unknown = JSON.parse(readFileSync(manifestAbsolute, "utf8"));
  if (!record(raw) || raw.schemaVersion !== 3 || raw.suiteVersion !== GOLDEN_VERSION
    || typeof raw.runId !== "string" || raw.runId.length < 8 || raw.appFingerprint !== expectedAppFingerprint
    || raw.servedUiBuildFingerprint !== expectedServedUiBuildFingerprint
    || !Array.isArray(raw.reviewers) || !Array.isArray(raw.runs)) {
    throw new Error("journey_evidence_manifest_version_or_build_mismatch");
  }

  const reviewers: string[] = [];
  const reviewerReportHashes = new Set<string>();
  const reviewerReports = new Map<string, Record<string, unknown>>();
  for (const item of raw.reviewers) {
    if (!record(item) || item.kind !== "codex_subagent" || typeof item.id !== "string" || item.id.length < 3 || reviewers.includes(item.id)) {
      throw new Error("journey_evidence_requires_distinct_subagent_reviewers");
    }
    const reportRef = verifyArtifact(item.report, evidenceDir);
    if (reviewerReportHashes.has(reportRef.sha256)) throw new Error("journey_evidence_subagent_reports_must_be_distinct");
    reviewerReportHashes.add(reportRef.sha256);
    const reportBody: unknown = JSON.parse(readFileSync(path.resolve(evidenceDir, reportRef.path), "utf8"));
    if (!record(reportBody) || reportBody.schemaVersion !== 3 || reportBody.kind !== "codex_subagent_review"
      || reportBody.reviewerId !== item.id || reportBody.suiteVersion !== GOLDEN_VERSION
      || reportBody.suiteRunId !== raw.runId || reportBody.appFingerprint !== raw.appFingerprint
      || reportBody.servedUiBuildFingerprint !== expectedServedUiBuildFingerprint
      || !Array.isArray(reportBody.runs)) {
      throw new Error("journey_evidence_subagent_report_invalid");
    }
    reviewerReports.set(item.id, reportBody);
    reviewers.push(item.id);
  }
  if (reviewers.length < 2) throw new Error("journey_evidence_requires_two_independent_subagents");

  const expectedVariants = GOLDEN_CASES.flatMap((scenario) => scenario.variants.map((variant) => ({
    caseId: scenario.id,
    variantId: variant.id,
    required: variant.required as readonly string[],
  })));
  const expectedVariantByKey = new Map(expectedVariants.map((variant) => [variant.caseId + "\u001f" + variant.variantId, variant]));
  const seenVariants = new Set<string>();
  const seenRunIds = new Set<string>([raw.runId]);
  const seenScreenshotPaths = new Set<string>();
  const seenScreenshotDigests = new Set<string>();
  const routes: JourneyReviewEvidence["routes"] = [];
  const observationsByCase = new Map<string, GoldenObservation[]>();
  const runBindings = new Map<string, {
    caseId: string;
    variantId: string;
    routeId: "cloud" | "local";
    routeUrl: string;
    servedUiBuildFingerprint: string;
    routeCaptureSha256: string;
    sourceSnapshotSha256: string;
    prestateDescriptionSha256: string;
    prestateEvidenceSha256: string[];
    observations: Map<string, { status: GoldenStatus; evidenceSha256: string[] }>;
  }>();
  let selectedOrigin: string | null = null;

  for (const item of raw.runs) {
    if (!record(item) || typeof item.caseId !== "string" || typeof item.variantId !== "string"
      || typeof item.runId !== "string" || item.runId.length < 8
      || typeof item.appFingerprint !== "string" || item.appFingerprint !== expectedAppFingerprint
      || !record(item.route) || !record(item.prestate) || !Array.isArray(item.observations)) {
      throw new Error("journey_evidence_variant_run_invalid");
    }
    const key = item.caseId + "\u001f" + item.variantId;
    const expectedVariant = expectedVariantByKey.get(key);
    if (!expectedVariant || seenVariants.has(key)) throw new Error("journey_evidence_variant_run_duplicate_or_unknown");
    if (seenRunIds.has(item.runId)) throw new Error("journey_evidence_variant_run_id_duplicate");
    seenVariants.add(key);
    seenRunIds.add(item.runId);

    const route = item.route;
    if ((route.id !== "cloud" && route.id !== "local") || route.id !== expectedRoute || typeof route.url !== "string") {
      throw new Error("journey_evidence_requires_selected_product_route");
    }
    if (route.servedUiBuildFingerprint !== expectedServedUiBuildFingerprint) {
      throw new Error("journey_evidence_served_ui_build_mismatch");
    }
    const url = new URL(route.url);
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (url.username || url.password || url.search || url.hash
      || (route.id === "local" && (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)))
      || (route.id === "cloud" && url.protocol !== "https:")) throw new Error("journey_evidence_route_url_invalid");
    if (selectedOrigin !== null && selectedOrigin !== url.origin) throw new Error("journey_evidence_route_origin_mismatch");
    selectedOrigin = url.origin;
    const screenshot = verifyArtifact(route.screenshot, evidenceDir, true);
    if (seenScreenshotPaths.has(screenshot.path) || seenScreenshotDigests.has(screenshot.sha256)) {
      throw new Error("journey_evidence_route_capture_reused");
    }
    seenScreenshotPaths.add(screenshot.path);
    seenScreenshotDigests.add(screenshot.sha256);

    if (typeof item.prestate.description !== "string" || !item.prestate.description.trim()
      || !Array.isArray(item.prestate.evidence) || item.prestate.evidence.length === 0) {
      throw new Error("journey_evidence_prestate_invalid");
    }
    const prestateEvidence = item.prestate.evidence.map((artifact) => verifyArtifact(artifact, evidenceDir));
    if (!record(item.sourceSnapshot) || typeof item.sourceSnapshotSha256 !== "string"
      || item.sourceSnapshotSha256 !== item.sourceSnapshot.sha256) throw new Error("journey_evidence_source_snapshot_invalid");
    const sourceSnapshot = verifyArtifact(item.sourceSnapshot, evidenceDir);
    if (sourceSnapshot.sha256 !== item.sourceSnapshotSha256) throw new Error("journey_evidence_source_snapshot_mismatch");

    const seenCriteria = new Set<string>();
    const normalizedRunObservations: GoldenObservation[] = [];
    const runObservationMap = new Map<string, { status: GoldenStatus; evidenceSha256: string[] }>();
    for (const observation of item.observations) {
      if (!record(observation) || typeof observation.criterion !== "string"
        || !expectedVariant.required.includes(observation.criterion) || seenCriteria.has(observation.criterion)
        || !["PASS", "FAIL", "BLOCKED", "UNVERIFIED"].includes(String(observation.status))
        || typeof observation.reason !== "string" || !observation.reason.trim()
        || !Array.isArray(observation.evidence) || observation.evidence.length === 0) {
        throw new Error("journey_evidence_observation_invalid_or_incomplete");
      }
      const evidence = observation.evidence.map((artifact) => verifyArtifact(artifact, evidenceDir));
      const evidenceSha256 = evidence.map((artifact) => artifact.sha256).sort();
      const normalizedObservation: GoldenObservation = {
        variantId: item.variantId,
        criterion: observation.criterion,
        runId: item.runId,
        status: observation.status as GoldenStatus,
        reason: observation.reason,
        evidence: Object.freeze(evidence.map((artifact) => "sha256:" + artifact.sha256)) as unknown as string[],
        kind: "user_journey",
      };
      Object.freeze(normalizedObservation);
      normalizedRunObservations.push(normalizedObservation);
      runObservationMap.set(observation.criterion, { status: observation.status as GoldenStatus, evidenceSha256 });
      seenCriteria.add(observation.criterion);
    }
    if (seenCriteria.size !== expectedVariant.required.length
      || expectedVariant.required.some((criterion) => !seenCriteria.has(criterion))) {
      throw new Error("journey_evidence_variant_criteria_incomplete");
    }

    const caseObservations = observationsByCase.get(item.caseId) ?? [];
    caseObservations.push(...normalizedRunObservations);
    observationsByCase.set(item.caseId, caseObservations);
    routes.push({
      runId: item.runId,
      caseId: item.caseId,
      variantId: item.variantId,
      id: route.id,
      url: route.url,
      servedUiBuildFingerprint: route.servedUiBuildFingerprint,
      screenshot,
    });
    runBindings.set(item.runId, {
      caseId: item.caseId,
      variantId: item.variantId,
      routeId: route.id,
      routeUrl: route.url,
      servedUiBuildFingerprint: route.servedUiBuildFingerprint,
      routeCaptureSha256: screenshot.sha256,
      sourceSnapshotSha256: sourceSnapshot.sha256,
      prestateDescriptionSha256: createHash("sha256").update(item.prestate.description).digest("hex"),
      prestateEvidenceSha256: prestateEvidence.map((artifact) => artifact.sha256).sort(),
      observations: runObservationMap,
    });
  }

  if (seenVariants.size !== expectedVariants.length
    || expectedVariants.some((variant) => !seenVariants.has(variant.caseId + "\u001f" + variant.variantId))) {
    throw new Error("journey_evidence_variant_run_missing");
  }
  if (runBindings.size !== expectedVariants.length) throw new Error("journey_evidence_variant_run_missing");

  const reviewerRuns = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [reviewerId, report] of reviewerReports) {
    const current = new Map<string, Record<string, unknown>>();
    for (const reportRun of report.runs as unknown[]) {
      if (!record(reportRun) || typeof reportRun.runId !== "string" || typeof reportRun.caseId !== "string"
        || typeof reportRun.variantId !== "string" || current.has(reportRun.runId)) {
        throw new Error("journey_evidence_subagent_report_run_invalid");
      }
      const sourceRun = runBindings.get(reportRun.runId);
      if (!sourceRun || reportRun.caseId !== sourceRun.caseId || reportRun.variantId !== sourceRun.variantId
        || reportRun.appFingerprint !== raw.appFingerprint || reportRun.routeId !== sourceRun.routeId
        || reportRun.servedUiBuildFingerprint !== sourceRun.servedUiBuildFingerprint
        || reportRun.routeUrl !== sourceRun.routeUrl || reportRun.routeCaptureSha256 !== sourceRun.routeCaptureSha256
        || reportRun.sourceSnapshotSha256 !== sourceRun.sourceSnapshotSha256
        || reportRun.prestateDescriptionSha256 !== sourceRun.prestateDescriptionSha256
        || !Array.isArray(reportRun.prestateEvidenceSha256)
        || [...reportRun.prestateEvidenceSha256].sort().join(",") !== sourceRun.prestateEvidenceSha256.join(",")
        || !Array.isArray(reportRun.observations)) {
        throw new Error("journey_evidence_subagent_report_run_mismatch");
      }
      const expectedVariant = expectedVariantByKey.get(sourceRun.caseId + "\u001f" + sourceRun.variantId)!;
      const judgments = new Map<string, { status: GoldenStatus; evidenceSha256: string[] }>();
      for (const judgment of reportRun.observations) {
        if (!record(judgment) || typeof judgment.criterion !== "string"
          || !expectedVariant.required.includes(judgment.criterion) || judgments.has(judgment.criterion)
          || !["PASS", "FAIL", "BLOCKED", "UNVERIFIED"].includes(String(judgment.status))
          || typeof judgment.reason !== "string" || !judgment.reason.trim() || !Array.isArray(judgment.evidenceSha256)
          || judgment.evidenceSha256.length === 0
          || judgment.evidenceSha256.some((hash) => typeof hash !== "string" || !sha256Pattern.test(hash))) {
          throw new Error("journey_evidence_subagent_report_observation_invalid");
        }
        judgments.set(judgment.criterion, {
          status: judgment.status as GoldenStatus,
          evidenceSha256: [...judgment.evidenceSha256 as string[]].sort(),
        });
      }
      if (judgments.size !== expectedVariant.required.length
        || expectedVariant.required.some((criterion) => !judgments.has(criterion))) {
        throw new Error("journey_evidence_subagent_report_criteria_incomplete");
      }
      current.set(reportRun.runId, reportRun);
    }
    if (current.size !== runBindings.size || [...runBindings.keys()].some((runId) => !current.has(runId))) {
      throw new Error("journey_evidence_subagent_report_runs_incomplete");
    }
    reviewerRuns.set(reviewerId, current);
  }

  for (const [runId, run] of runBindings) {
    for (const [criterion, expected] of run.observations) {
      const judgments = reviewers.map((reviewer) => {
        const reportRun = reviewerRuns.get(reviewer)?.get(runId);
        const judgment = Array.isArray(reportRun?.observations)
          ? reportRun.observations.find((entry) => record(entry) && entry.criterion === criterion)
          : undefined;
        if (!record(judgment) || !Array.isArray(judgment.evidenceSha256)) return null;
        return {
          status: judgment.status,
          evidenceSha256: [...judgment.evidenceSha256 as string[]].sort(),
        };
      });
      if (judgments.some((judgment) => !judgment || judgment.status !== expected.status
        || judgment.evidenceSha256.join(",") !== expected.evidenceSha256.join(","))) {
        throw new Error("journey_evidence_independent_review_disagreement");
      }
    }
  }

  const trustedObservations = new Map<string, GoldenObservation[]>();
  for (const scenario of GOLDEN_CASES) {
    const items = observationsByCase.get(scenario.id) ?? [];
    const frozenItems = Object.freeze([...items]) as unknown as GoldenObservation[];
    const runIds = new Map<string, string>();
    for (const variant of scenario.variants) {
      const run = [...runBindings.entries()].find(([, binding]) => binding.caseId === scenario.id && binding.variantId === variant.id);
      if (!run) throw new Error("journey_evidence_variant_run_missing");
      runIds.set(variant.id, run[0]);
    }
    reviewedObservationBatches.set(frozenItems, {
      suiteVersion: GOLDEN_VERSION,
      caseId: scenario.id,
      appFingerprint: expectedAppFingerprint,
      runIds,
    });
    trustedObservations.set(scenario.id, frozenItems);
  }
  const result: JourneyReviewEvidence = {
    suiteVersion: raw.suiteVersion,
    runId: raw.runId,
    appFingerprint: raw.appFingerprint,
    servedUiBuildFingerprint: expectedServedUiBuildFingerprint,
    reviewers,
    routes,
    observations: trustedObservations,
  };
  journeyReviewRuns.set(result, {
    suiteVersion: GOLDEN_VERSION,
    routeId: expectedRoute,
    servedUiBuildFingerprint: expectedServedUiBuildFingerprint,
    observations: trustedObservations,
  });
  return result;
}

/** File-based reviews can block acceptance, but cannot certify an observed investor task. */
export function gradeGoldenCase(
  scenario: typeof GOLDEN_CASES[number],
  observations: GoldenObservation[],
  bindingEvidence: GoldenObservation[] = [],
): GoldenCaseResult {
  const reviewedBatch = reviewedObservationBatches.get(observations);
  const required = requiredGoldenCriteria(scenario).map(({ variantId, criterion }): GoldenObservation => {
    const bindingFailures = bindingEvidence.filter((item) => item.variantId === variantId && item.criterion === criterion && item.status !== "PASS" && item.status !== "UNVERIFIED");
    if (bindingFailures.length) {
      const blocker = bindingFailures.find((item) => item.status === "FAIL") ?? bindingFailures[0]!;
      return { ...blocker, evidence: blocker.evidence.length ? blocker.evidence : [], reason: `Binding code-inspection result: ${blocker.reason}` };
    }
    const matches = observations.filter((item) => item.variantId === variantId && item.criterion === criterion);
    if (matches.length !== 1) return { variantId, criterion, status: "UNVERIFIED", reason: matches.length ? "Duplicate verdicts are ambiguous." : "No current observation of this required variant outcome.", evidence: [], kind: "none" };
    const item = matches[0]!;
    const expectedRunId = reviewedBatch?.runIds.get(variantId);
    const independentlyReviewed = reviewedBatch?.suiteVersion === GOLDEN_VERSION
      && reviewedBatch.caseId === scenario.id
      && typeof reviewedBatch.appFingerprint === "string"
      && expectedRunId !== undefined
      && item.runId === expectedRunId;
    if (item.status === "FAIL" || item.status === "BLOCKED") return item;
    if (item.status === "PASS") {
      return { ...item, status: "UNVERIFIED", reason: item.kind === "user_journey" && independentlyReviewed
        ? "File-based reviewer claims, screenshots and hashes do not authenticate an observed investor task. A trusted in-process route evaluator is required."
        : "A native API, fixture or code inspection cannot authenticate the observed user journey." };
    }
    if (item.kind === "user_journey" && !independentlyReviewed) {
      return { ...item, status: "UNVERIFIED", reason: "This observation is not bound to a complete, independently reviewed real subrun." };
    }
    return item;
  });
  const status: GoldenStatus = required.some((item) => item.status === "FAIL") ? "FAIL"
    : required.some((item) => item.status === "BLOCKED") ? "BLOCKED"
    : required.some((item) => item.status !== "PASS") ? "UNVERIFIED" : "PASS";
  return { id: scenario.id, job: scenario.job, status, observations: required };
}

/** Bind runner failures to the investor outcomes they invalidate. */
export function bindNativeCheckFailures(checks: GoldenNativeCheck[]): Map<string, GoldenObservation[]> {
  const targets: Record<string, Array<{ caseId: string; variantId: string; criterion: string }>> = {
    "two-real-issuer-api-selection": [
      { caseId: "G2", variantId: "desktop-a-b-a", criterion: "identity_readback" },
      { caseId: "G5", variantId: "real-source-window", criterion: "nonempty_real_evidence" },
    ],
    "exact-real-source-readback-and-clocks": [
      { caseId: "G4", variantId: "restart", criterion: "real_source_readback" },
      { caseId: "G4", variantId: "restart", criterion: "source_clocks" },
    ],
    "retained-real-state-reopen": [
      { caseId: "G5", variantId: "saved-decision-resume", criterion: "decision_restart_readback" },
      { caseId: "G6", variantId: "baseline-immutability", criterion: "baseline_restart_readback" },
    ],
    "current-real-sentiment-availability": [
      { caseId: "G3", variantId: "explicit-provider-result", criterion: "authentic_provider_result" },
    ],
    "selected-provider-authorization": [
      { caseId: "G3", variantId: "explicit-provider-result", criterion: "authorized_selected_provider_route" },
    ],
    "selected-provider-public-input": [
      { caseId: "G3", variantId: "explicit-provider-result", criterion: "public_input_eligible" },
    ],
    "selected-provider-identity": [
      { caseId: "G3", variantId: "explicit-provider-result", criterion: "returned_model_identity" },
    ],
    "selected-provider-source-drilldown": [
      { caseId: "G3", variantId: "explicit-provider-result", criterion: "exact_source_drilldown" },
    ],
    "private-luna-authorization": [
      { caseId: "G7", variantId: "confirm-selected-item", criterion: "authorized_plan_route" },
    ],
    "live-configured-feed-health": [
      { caseId: "G4", variantId: "configured-feed-health", criterion: "approved_source_enabled" },
      { caseId: "G4", variantId: "configured-feed-health", criterion: "fresh_successful_delivery" },
      { caseId: "G4", variantId: "configured-feed-health", criterion: "completed_ingestion" },
      { caseId: "G4", variantId: "configured-feed-health", criterion: "eligible_coverage_visible" },
    ],
    "live-collection-admission": [
      { caseId: "G4", variantId: "configured-feed-health", criterion: "collection_admission_open" },
    ],
    "owner-authored-decision-prestate": [
      { caseId: "G5", variantId: "saved-decision-resume", criterion: "decision_restart_readback" },
      { caseId: "G5", variantId: "saved-decision-resume", criterion: "rendered_resume" },
    ],
    "followed-company-baseline-prestate": [
      { caseId: "G6", variantId: "baseline-immutability", criterion: "baseline_unchanged_and_recoverable" },
      { caseId: "G6", variantId: "baseline-immutability", criterion: "baseline_restart_readback" },
    ],
    "owner-private-evidence-prestate": [
      { caseId: "G7", variantId: "confirm-selected-item", criterion: "explicit_send_only" },
      { caseId: "G7", variantId: "confirm-selected-item", criterion: "disclosed_payload" },
      { caseId: "G7", variantId: "confirm-selected-item", criterion: "returned_model_identity" },
    ],
    "real-source-prestate": [
      { caseId: "G1", variantId: "relevant-lead", criterion: "source_checked" },
      { caseId: "G2", variantId: "desktop-a-b-a", criterion: "identity_readback" },
      { caseId: "G3", variantId: "explicit-provider-result", criterion: "authentic_provider_result" },
      { caseId: "G4", variantId: "restart", criterion: "real_source_readback" },
      { caseId: "G5", variantId: "real-source-window", criterion: "nonempty_real_evidence" },
      { caseId: "G6", variantId: "baseline-immutability", criterion: "baseline_restart_readback" },
      { caseId: "G7", variantId: "ordinary-read", criterion: "public_issuer_scope" },
    ],
    "real-source-runtime": GOLDEN_CASES.flatMap((scenario) => requiredGoldenCriteria(scenario).map((item) => ({
      caseId: scenario.id, variantId: item.variantId, criterion: item.criterion,
    }))),
  };
  const result = new Map<string, GoldenObservation[]>();
  for (const check of checks) {
    if (check.status === "PASS") continue;
    const affected = targets[check.id] ?? GOLDEN_CASES.flatMap((scenario) => requiredGoldenCriteria(scenario).map((item) => ({
      caseId: scenario.id, variantId: item.variantId, criterion: item.criterion,
    })));
    for (const target of affected) {
      const observation: GoldenObservation = {
        variantId: target.variantId,
        criterion: target.criterion,
        status: check.status,
        reason: `Native check ${check.id}: ${check.reason}`,
        evidence: [`native:${check.id}`],
        kind: "native_api",
      };
      result.set(target.caseId, [...result.get(target.caseId) ?? [], observation]);
    }
  }
  return result;
}

export function goldenReady(
  results: GoldenCaseResult[],
  journey: JourneyReviewEvidence | null,
  bindingEvidence: ReadonlyMap<string, GoldenObservation[]> = new Map(),
  nativeChecks: GoldenNativeCheck[] = [],
): boolean {
  const reviewPackage = journey && journeyReviewRuns.get(journey);
  if (!reviewPackage || !["local", "cloud"].includes(reviewPackage.routeId) || nativeChecks.some((check) => check.status !== "PASS")
    || reviewPackage.suiteVersion !== GOLDEN_VERSION
    || journey.servedUiBuildFingerprint !== reviewPackage.servedUiBuildFingerprint
    || journey.routes.some((route) => route.servedUiBuildFingerprint !== reviewPackage.servedUiBuildFingerprint)
    || results.length !== GOLDEN_CASES.length) return false;
  return GOLDEN_CASES.every((scenario) => {
    const matches = results.filter((result) => result.id === scenario.id);
    if (matches.length !== 1) return false;
    const effective = gradeGoldenCase(
      scenario,
      reviewPackage.observations.get(scenario.id) ?? [],
      bindingEvidence.get(scenario.id) ?? [],
    );
    return matches[0]?.status === effective.status && effective.status === "PASS";
  });
}
