import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Desk, type FollowedCompanyEvidencePage } from "../server/db.js";
import { createApp, type AppDeps } from "../server/app.js";
import { Pipeline } from "../server/pipeline.js";
import { Hub } from "../server/hub.js";
import { HealthTracker } from "../server/health.js";
import { config, loadCompanies } from "../server/config.js";
import type { CompanyResearchBriefResponse } from "../shared/company-research-brief.js";
import type { CategoricalBucketEvidencePage, CategoricalTrendResult, MentionDTO } from "../server/types.js";
import { assessConfiguredFeedHealth, assessGoldenProviderAuthorization, bindNativeCheckFailures, GOLDEN_CASES, GOLDEN_PROVIDER_ROUTES, GOLDEN_VERSION, gradeGoldenCase, goldenReady, loadJourneyReviewEvidence, type GoldenObservation, type GoldenProviderRoute, type JourneyReviewEvidence } from "./investor-golden-cases.js";
import { uiAssetReferences, verifyServedUiBuild } from "./served-ui-build.js";
import { loadEnv } from "vite";

// This runner reads sanitized connection status, never credentials, and never dispatches provider requests or creates user data.
// Reads run against a disposable SQLite backup so the user's database stays untouched.
const root = process.cwd();
const appMode = loadEnv("production", root, "VITE_").VITE_APP_MODE ?? "local";
const args = process.argv.slice(2);
const usage = "Usage: npm run evaluate:golden -- [--route http://127.0.0.1:<port>] [--provider-route luna-plan|google-gemini-byok] [--db <configured real database>] [--journey-evidence <review package>]";
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(usage);
  process.exit(0);
}
const options: { db: string; journeyEvidence: string | null; route: string | null; providerRoute: GoldenProviderRoute | null } = { db: config.dbPath, journeyEvidence: null, route: null, providerRoute: null };
const seenOptions = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  const value = args[++i];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage);
  if (seenOptions.has(key!)) throw new Error("Unknown or repeated golden-evaluation option.");
  seenOptions.add(key!);
  if (key === "--db") options.db = value;
  else if (key === "--journey-evidence") options.journeyEvidence = value;
  else if (key === "--route") options.route = value;
  else if (key === "--provider-route" && (value === "luna-plan" || value === "google-gemini-byok")) options.providerRoute = value;
  else throw new Error("Unknown or repeated golden-evaluation option.");
}
const selectedProvider = options.providerRoute ? GOLDEN_PROVIDER_ROUTES[options.providerRoute] : null;
const sourcePath = path.resolve(root, options.db);
if (sourcePath !== path.resolve(root, config.dbPath)) throw new Error("Golden evaluations only accept the configured real product database; fixtures and alternate databases cannot establish readiness.");
const observedAt = new Date().toISOString();
const runId = randomUUID();
const observations = new Map<string, GoldenObservation[]>();
const nativeChecks: Array<{ id: string; status: "PASS" | "FAIL" | "BLOCKED"; reason: string; evidence: unknown }> = [];
function observe(id: string, observation: GoldenObservation) { observations.set(id, [...observations.get(id) ?? [], observation]); }
async function check(id: string, fn: () => Promise<unknown>) {
  try { nativeChecks.push({ id, status: "PASS", reason: "Observed native API and saved readback.", evidence: await fn() }); }
  catch (error) { nativeChecks.push({ id, status: "FAIL", reason: error instanceof assert.AssertionError ? error.message.slice(0, 500) : "Native task execution failed; no acceptance pass recorded.", evidence: null }); }
}
function fingerprint() {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "server", "shared", "web/src", "supabase", "config", "scripts", "tests", "package.json", "package-lock.json", "vite.config.ts"], { encoding: "utf8" }).trim().split("\n");
  return [...new Set(files)].sort().map((file) => ({ file, sha256: existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null }));
}
const inputFiles = fingerprint();
const appFingerprint = createHash("sha256").update(JSON.stringify(inputFiles)).digest("hex");
let journeyEvidence: JourneyReviewEvidence | null = null;
let journeyEvidenceError: string | null = null;

// Read the intended loopback product route before isolating the offline database checks.
const priorFetch = globalThis.fetch;
let routeOrigin: string | null = null;
if (appMode !== "cloud") {
  const route = new URL(options.route ?? `http://127.0.0.1:${config.port}`);
  const hostname = route.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (route.protocol !== "http:" || !loopback || route.username || route.password || route.pathname !== "/" || route.search || route.hash) {
    throw new Error("Golden route must be an exact loopback HTTP origin.");
  }
  routeOrigin = route.origin;
} else if (options.route) throw new Error("The local golden runner cannot target an arbitrary hosted route.");
let liveHealth: Record<string, unknown> | null = null;
let liveFilings: Record<string, unknown> | null = null;
let liveFilingsDiagnostic: { state: string; sourceVerifiedRows: number } | null = null;
let servedUiBuildFingerprint: string | null = null;
let servedUiBuildFailure: string | null = null;
let routeReadError: string | null = null;
let livePlanStatus: unknown = null;
let liveSelectedProviderStatus: unknown = null;
if (routeOrigin) {
  try {
    const healthResponse = await priorFetch(`${routeOrigin}/api/health`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    assert.equal(healthResponse.status, 200, "The configured Desk health route is unavailable.");
    liveHealth = await healthResponse.json() as Record<string, unknown>;
    assert.equal(liveHealth.ok, true, "The configured Desk health route did not identify a healthy app.");
    const filingsResponse = await priorFetch(`${routeOrigin}/api/sec-filings-inbox`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    assert.equal(filingsResponse.status, 200, "The tickerless public filings route is unavailable.");
    liveFilings = await filingsResponse.json() as Record<string, unknown>;
  } catch (error) {
    routeReadError = error instanceof Error ? error.message.slice(0, 240) : "configured_local_route_unavailable";
  }
}
if (routeOrigin) {
  const readStatus = async (endpoint: string): Promise<unknown> => {
    try {
      const response = await priorFetch(`${routeOrigin}${endpoint}`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
      return response.status === 200 ? await response.json() : null;
    } catch { return null; }
  };
  livePlanStatus = await readStatus("/api/chatgpt-plan/status");
  liveSelectedProviderStatus = options.providerRoute === "google-gemini-byok"
    ? await readStatus("/api/model-providers/status") : livePlanStatus;
}
const selectedAuthorization = assessGoldenProviderAuthorization(options.providerRoute, liveSelectedProviderStatus);
nativeChecks.push({ id: "selected-provider-authorization", ...selectedAuthorization, evidence: {
  selectedRoute: options.providerRoute, provider: selectedProvider?.provider ?? null, requestedModel: selectedProvider?.model ?? null,
  accountingRoute: selectedProvider?.accountingRoute ?? null, accountTierVerified: false,
} });
const privateAuthorization = assessGoldenProviderAuthorization("luna-plan", livePlanStatus);
nativeChecks.push({ id: "private-luna-authorization", ...privateAuthorization, evidence: {
  route: "luna-plan", provider: "openai_luna", requestedModel: "gpt-6-luna", itemConsentVerified: false,
  note: "Local private reads remain available. The confirmed-send variant requires a connected Luna route and observed item-level consent; Gemini Free is never admitted for private evidence.",
} });
nativeChecks.push({ id: "supported-desk-health-route", status: liveHealth ? "PASS" : "BLOCKED", reason: liveHealth ? "Read the configured loopback Sentiment Desk health route." : routeReadError ?? "A hosted route is not evaluated by this local-only runner.", evidence: routeOrigin });
if (liveFilings) {
  const rows = Array.isArray(liveFilings.rows) ? liveFilings.rows : [];
  const liveRows = rows.filter((row) => typeof row === "object" && row !== null && typeof (row as Record<string, unknown>).filingUrl === "string"
    && /^https:\/\/www\.sec\.gov\//.test((row as Record<string, unknown>).filingUrl as string));
  liveFilingsDiagnostic = { state: String(liveFilings.state ?? "unknown"), sourceVerifiedRows: liveRows.length };
}
if (routeOrigin) {
  try {
    const response = await priorFetch(routeOrigin, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    assert.equal(response.status, 200, "The configured Desk page route is unavailable.");
    const servedHtml = await response.text();
    const builtHtml = readFileSync(path.join(root, "dist/web/index.html"), "utf8");
    const servedAssets = new Map<string, Uint8Array>();
    for (const asset of uiAssetReferences(servedHtml)) {
      const assetResponse = await priorFetch(new URL(asset, routeOrigin), { signal: AbortSignal.timeout(5_000), redirect: "error" });
      assert.equal(assetResponse.status, 200, `The configured Desk asset route is unavailable: ${asset}`);
      servedAssets.set(asset, new Uint8Array(await assetResponse.arrayBuffer()));
    }
    const distRoot = path.resolve(root, "dist/web");
    const localAsset = (asset: string) => {
      const file = path.resolve(distRoot, asset.slice(1));
      return file.startsWith(distRoot + path.sep) && existsSync(file) ? readFileSync(file) : null;
    };
    servedUiBuildFingerprint = verifyServedUiBuild(
      servedHtml,
      builtHtml,
      (asset) => servedAssets.get(asset) ?? null,
      localAsset,
    ).fingerprint;
  } catch (error) {
    servedUiBuildFailure = error instanceof Error ? error.message.slice(0, 240) : "served_ui_build_mismatch";
  }
}
if (liveHealth) {
  const feed = assessConfiguredFeedHealth(liveHealth);
  nativeChecks.push({ id: "live-configured-feed-health", status: feed.feedReady ? "PASS" : "BLOCKED", reason: feed.feedReady ? "At least one approved feed has a recent successful delivery, completed ingestion and measurable eligible coverage." : "No approved enabled feed has a recent successful delivery, completed ingestion and measurable eligible coverage.", evidence: feed });
  nativeChecks.push({ id: "live-collection-admission", status: feed.collectionOpen ? "PASS" : "BLOCKED", reason: feed.collectionOpen ? "External collection and database writes are currently admitted." : "Collection or saved writes are paused by the live source or storage controls.", evidence: { collector: feed.collector, collectionOpen: feed.collectionOpen, storage: liveHealth.storage } });
  if (feed.feedReady) for (const criterion of ["approved_source_enabled", "fresh_successful_delivery", "completed_ingestion", "eligible_coverage_visible"]) {
    observe("G4", { variantId: "configured-feed-health", criterion, status: "PASS", reason: "Live configured feed health reports an approved fresh receipt, completed ingestion and visible coverage counts.", evidence: ["native:live-configured-feed-health"], kind: "native_api" });
  }
  if (feed.collectionOpen) observe("G4", { variantId: "configured-feed-health", criterion: "collection_admission_open", status: "PASS", reason: "The live app currently permits bounded public collection and saved writes.", evidence: ["native:live-collection-admission"], kind: "native_api" });
}
nativeChecks.push({
  id: "served-ui-build-match",
  status: servedUiBuildFingerprint ? "PASS" : "BLOCKED",
  reason: servedUiBuildFingerprint ? "The supported route serves the exact local build HTML, JavaScript and stylesheet assets." : servedUiBuildFailure ?? "The supported route UI build could not be compared with the local production bundle.",
  evidence: servedUiBuildFingerprint ? { fingerprint: servedUiBuildFingerprint } : null,
});
if (options.journeyEvidence) {
  try {
    if (!servedUiBuildFingerprint) throw new Error("journey_evidence_served_ui_build_unavailable");
    journeyEvidence = loadJourneyReviewEvidence(
      path.resolve(root, options.journeyEvidence),
      appFingerprint,
      appMode === "cloud" ? "cloud" : "local",
      servedUiBuildFingerprint,
    );
  } catch (error) {
    journeyEvidenceError = error instanceof Error ? error.message.slice(0, 240) : "journey_evidence_invalid";
  }
}

// Code-level missing capability is a failure, never a rendered positive claim.
const cloudDesk = readFileSync("web/src/components/CloudResearchDesk.tsx", "utf8");
const cloudSentimentMounted = /<(?:CategoricalTrendChart|CloudSentimentChart)\b/.test(cloudDesk);
const localDesk = readFileSync("web/src/App.tsx", "utf8");
const sentimentChartMounted = appMode === "cloud" ? cloudSentimentMounted : /<CategoricalTrendChart\b/.test(localDesk);
if (!sentimentChartMounted) observe("G3", { variantId: "explicit-provider-result", criterion: "rendered_chart", status: "FAIL", reason: appMode === "cloud"
  ? "The selected hosted cloud Desk does not mount a sentiment chart. TradingView price and page-only company assessments do not satisfy this task."
  : "The selected local Desk does not mount the source-linked sentiment chart.",
evidence: ["web/src/main.tsx", appMode === "cloud" ? "web/src/components/CloudResearchDesk.tsx" : "web/src/App.tsx"], kind: "code_inspection" });

let directory: string | null = null;
let db: Desk | null = null;
let snapshotDb: DatabaseSync | null = null;
let realSourceInventory: unknown = null;
let attemptedExternalCalls = 0;
try {
  if (!existsSync(sourcePath)) {
    nativeChecks.push({ id: "real-source-prestate", status: "BLOCKED", reason: "No retained real-source database is available.", evidence: null });
  } else {
    directory = mkdtempSync(path.join(tmpdir(), "sentiment-golden-"));
    const dbPath = path.join(directory, "desk.db");
    execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()", sourcePath, dbPath]);
    // Hard network boundary: ordinary reads and saves cannot classify or collect.
    globalThis.fetch = async () => { attemptedExternalCalls++; throw new Error("Golden run prohibits all external requests"); };
    const limits = { maxDatabaseBytes: 512 * 1024 * 1024, maxFamilyBytes: 768 * 1024 * 1024, minimumFreeBytes: 1024 * 1024, writeHeadroomBytes: 1024 * 1024 };
    db = new Desk(dbPath, limits);
    db.seedCompanies(loadCompanies());
    const makeApp = (desk: Desk) => {
      const hub = new Hub(); const health = new HealthTracker(false, false, "unconfigured");
      const pipeline = new Pipeline({ db: desk, judge: null, classifier: null, hub, health, engineLabel: "golden-read-only", inputPricePerMTok: 0, concurrency: 1, allowedCollectors: new Set(), externalRequestsEnabled: false, dailyBudget: { utcDay: () => observedAt.slice(0, 10), maxRequests: 0, maxRequestBytes: 0 } });
      return createApp({ db: desk, dbPath, pipeline, market: {} as AppDeps["market"], hub, health, version: runId, deliverySources: [], opportunityRadarEnabled: false, configuredPublicCompanyIds: new Set(loadCompanies().map((company) => company.id)) });
    };
    let app = makeApp(db);
    const read = async <T>(url: string): Promise<T> => { const response = await app.request(`http://127.0.0.1${url}`); assert.equal(response.status, 200, `HTTP read failed: ${url}`); return await response.json() as T; };
    const publicCompanies = loadCompanies();
    const companies = [publicCompanies.find((company) => company.ticker === "AAPL"), publicCompanies.find((company) => company.ticker === "MSFT")].filter((company) => company != null);
    const raw = snapshotDb = new DatabaseSync(dbPath, { readOnly: true });
    const inventory = raw.prepare("SELECT collector, COUNT(*) AS count, MAX(retrieved_at) AS latestRetrievedAt FROM source_observations GROUP BY collector").all();
    const sourceModelCounts = ["categorical_classifications", "model_provider_classifications"].map((table) => ({ table, count: raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0 }));
    const savedDecisionCompanyIds = new Set((raw.prepare("SELECT DISTINCT company_id AS companyId FROM company_research_decisions").all() as Array<{ companyId: string }>).map((row) => row.companyId));
    const savedDecisionCompany = publicCompanies.find((item) => savedDecisionCompanyIds.has(item.id)) ?? null;
    const existingBaselines = raw.prepare("SELECT company_id AS companyId, id, version, captured_at AS capturedAt, eligible_observation_count AS eligibleObservationCount, policy_version AS policyVersion FROM followed_company_baselines ORDER BY captured_at DESC").all() as Array<{ companyId: string; id: string; version: number; capturedAt: number; eligibleObservationCount: number; policyVersion: string }>;
    let privateEvidenceItemCount = 0;
    let privateEvidenceState: "readable" | "unavailable" = "readable";
    const privateEvidencePath = path.join(path.dirname(sourcePath), "private-evidence", "evidence.sqlite");
    if (existsSync(privateEvidencePath)) {
      let privateDb: DatabaseSync | null = null;
      try {
        privateDb = new DatabaseSync(privateEvidencePath, { readOnly: true });
        const companyIds = publicCompanies.map((item) => item.id);
        const placeholders = companyIds.map(() => "?").join(",");
        privateEvidenceItemCount = Number((privateDb.prepare(`SELECT COUNT(*) AS count FROM private_evidence WHERE company_id IN (${placeholders})`).get(...companyIds) as { count?: number } | undefined)?.count ?? 0);
      } catch {
        privateEvidenceState = "unavailable";
      } finally {
        try { privateDb?.close(); } catch { /* already closed */ }
      }
    }
    const baselineWithFollowup = existingBaselines.find((baseline) => publicCompanies.some((item) => item.id === baseline.companyId)
      && Number(raw!.prepare("SELECT COUNT(*) AS count FROM source_observations WHERE company_id=? AND retrieved_at>? AND collector<>'legacy_unknown'").get(baseline.companyId, baseline.capturedAt)?.count ?? 0) > 0);
    if (!baselineWithFollowup) nativeChecks.push({ id: "followed-company-baseline-prestate", status: "BLOCKED", reason: "No configured public-company baseline has a later retained non-legacy source observation to compare. The evaluator will not create a baseline.", evidence: { savedBaselineCount: existingBaselines.length } });
    if (privateEvidenceState !== "readable" || privateEvidenceItemCount === 0) nativeChecks.push({ id: "owner-private-evidence-prestate", status: "BLOCKED", reason: privateEvidenceState === "readable" ? "No owner-authored private evidence item for a configured public issuer is available. The evaluator reads counts only and will not create a note." : "The local private-evidence store could not be read without opening its contents.", evidence: { state: privateEvidenceState, configuredPublicIssuerItemCount: privateEvidenceItemCount } });
    realSourceInventory = { inventory, sourceModelCounts, savedDecisionCount: savedDecisionCompanyIds.size, followedBaselineCount: existingBaselines.length, ownerPrivateEvidenceCount: privateEvidenceItemCount, ownerPrivateEvidenceState: privateEvidenceState, note: "Retained rows alone are not eligible real task evidence. Legacy_unknown remains excluded by product reads. Private-evidence content is never read by this evaluator." };
    const briefs = new Map<string, CompanyResearchBriefResponse>();
    await check("two-real-issuer-api-selection", async () => {
      assert.equal(companies.length, 2, "Two public issuers required.");
      for (const company of [...companies, companies[0]!]) {
        const response = await read<CompanyResearchBriefResponse>(`/api/companies/${company.id}/research-brief`);
        assert.equal(response.brief.company.companyId, company.id);
        assert.equal(response.brief.company.ticker, company.ticker);
        assert.ok(response.brief.observations.every((item) => item.companyId === company.id));
        assert.ok(response.brief.facts.length + response.brief.observations.length > 0, "Empty evidence does not satisfy real issuer selection.");
        briefs.set(company.id, response);
      }
      observe("G2", { variantId: "desktop-a-b-a", criterion: "identity_readback", status: "PASS", reason: "AAPL → MSFT → AAPL native reads retain distinct issuer-bound real evidence.", evidence: ["native:two-real-issuer-api-selection"], kind: "native_api" });
      return companies.map((company) => ({ companyId: company.id, cik: briefs.get(company.id)?.brief.company.cik, sourceCount: briefs.get(company.id)?.brief.observations.length, factCount: briefs.get(company.id)?.brief.facts.length }));
    });
    const company = savedDecisionCompany ?? companies[0];
    if (company && !briefs.has(company.id)) briefs.set(company.id, await read<CompanyResearchBriefResponse>(`/api/companies/${company.id}/research-brief`));
    if (company && briefs.has(company.id)) {
      const brief = briefs.get(company.id)!;
      await check("exact-real-source-readback-and-clocks", async () => {
        assert.ok(brief.brief.observations.length > 0, "At least one eligible source required.");
        for (const item of brief.brief.observations) {
          const original = raw.prepare("SELECT id, company_id, title, snippet, source_url, retrieved_at, ingested_at, time_basis, delivery_id, collector FROM source_observations WHERE id=?").get(item.id);
          assert.ok(original); assert.notEqual(original.collector, "legacy_unknown");
          assert.equal(original.company_id, company.id); assert.equal(item.title, original.title);
          assert.equal(item.snippet, original.snippet); assert.equal(item.sourceUrl, original.source_url);
          assert.equal(item.retrievedAt, original.retrieved_at); assert.equal(item.ingestedAt, original.ingested_at);
          assert.equal(item.timeBasis, original.time_basis); assert.equal(item.deliveryId, original.delivery_id);
          assert.ok(item.deliveryCompletedAt <= item.ingestionCompletedAt && item.ingestionCompletedAt <= brief.brief.asOfMs);
        }
        for (const criterion of ["real_source_readback", "source_clocks"]) observe("G4", { variantId: "restart", criterion, status: "PASS", reason: "Exact source identity, content and separate clocks match retained receipt-linked records.", evidence: ["native:exact-real-source-readback-and-clocks"], kind: "native_api" });
        return { companyId: company.id, sourceIds: brief.brief.observations.map((item) => item.id), evidenceDigest: createHash("sha256").update(JSON.stringify(brief.brief.observations)).digest("hex"), asOfMs: brief.brief.asOfMs };
      });
      await check("retained-real-state-reopen", async () => {
        const baselineCompanyId = raw.prepare("SELECT company_id AS companyId FROM followed_company_baselines ORDER BY captured_at DESC").all()
          .map((row) => (row as { companyId: string }).companyId)
          .find((companyId) => publicCompanies.some((item) => item.id === companyId));
        let baselineBefore: FollowedCompanyEvidencePage | null = null;
        if (baselineCompanyId) {
          baselineBefore = await read<FollowedCompanyEvidencePage>(`/api/companies/${baselineCompanyId}/followed-evidence?limit=100`);
          const original = raw.prepare("SELECT id, company_id AS companyId, version, captured_at AS capturedAt, eligible_observation_count AS eligibleObservationCount, policy_version AS policyVersion FROM followed_company_baselines WHERE company_id = ? ORDER BY version DESC LIMIT 1").get(baselineCompanyId) as { id: string; companyId: string; version: number; capturedAt: number; eligibleObservationCount: number; policyVersion: string } | undefined;
          assert.ok(original && baselineBefore.baseline);
          assert.deepEqual({ ...baselineBefore.baseline }, { ...original });
        }
        db!.close(); db = new Desk(dbPath, limits); app = makeApp(db);
        const resumed = await read<CompanyResearchBriefResponse>(`/api/companies/${company.id}/research-brief?asOfMs=${brief.brief.asOfMs}`);
        assert.equal(resumed.snapshotKey, brief.snapshotKey); assert.deepEqual(resumed.brief.observations, brief.brief.observations);
        assert.deepEqual(resumed.decision, brief.decision, "Only a previously saved real analyst decision may be checked after reopen.");
        if (!brief.decision) nativeChecks.push({ id: "owner-authored-decision-prestate", status: "BLOCKED", reason: "The selected configured issuer has no saved analyst-authored question and decision to reopen.", evidence: { companyId: company.id } });
        if (baselineCompanyId && baselineBefore) {
          const after = await read<FollowedCompanyEvidencePage>(`/api/companies/${baselineCompanyId}/followed-evidence?limit=100`);
          assert.deepEqual(after.baseline, baselineBefore.baseline);
          assert.equal(after.companyId, baselineBefore.companyId);
          observe("G6", { variantId: "baseline-immutability", criterion: "baseline_restart_readback", status: "PASS", reason: "Existing real baseline identity and version survive SQLite close/reopen.", evidence: ["native:retained-baseline-readback"], kind: "native_api" });
        }
        observe("G5", { variantId: "real-source-window", criterion: "nonempty_real_evidence", status: "PASS", reason: "Real retained source and filing evidence is present.", evidence: ["native:two-real-issuer-api-selection"], kind: "native_api" });
        if (brief.decision) observe("G5", { variantId: "saved-decision-resume", criterion: "decision_restart_readback", status: "PASS", reason: "Existing saved real analyst decision and evidence snapshot survive close/reopen.", evidence: ["native:retained-research-decision-readback"], kind: "native_api" });
        return { companyId: company.id, snapshotKey: brief.snapshotKey, persistedSourceCount: resumed.brief.observations.length, decisionPresent: Boolean(brief.decision), existingBaselineCompanyId: baselineCompanyId ?? null, existingBaselineId: baselineBefore?.baseline?.id ?? null, note: "Read-only persistence check; no analyst decision or baseline is created." };
      });
      try {
        if (!selectedProvider) {
          nativeChecks.push({ id: "current-real-sentiment-availability", status: "BLOCKED", reason: "No provider route was explicitly selected; the evaluator does not substitute Luna or Gemini.", evidence: null });
        } else {
        const result = await read<CategoricalTrendResult>(`/api/companies/${company.id}/${selectedProvider.series}?hours=168`);
        assert.equal(result.companyId, company.id);
        assert.equal(result.timeBasis, "validated_source_time");
        assert.equal(result.countBasis, "immutable_source_observation");
        if (selectedProvider.provider === "google_gemini") {
          assert.equal(result.classifierProvider, selectedProvider.provider);
          assert.equal(result.classifierModel, selectedProvider.model);
        }
        const available = result.plottedObservationCount > 0;
        nativeChecks.push({ id: "current-real-sentiment-availability", status: available ? "PASS" : "BLOCKED", reason: available ? "The real issuer has saved categories in the selected provider's requested window." : "The selected provider's chart API is reachable, but this issuer has no eligible saved categories in the requested window.", evidence: { companyId: company.id, selectedRoute: options.providerRoute, provider: selectedProvider.provider, model: selectedProvider.model, plottedObservationCount: result.plottedObservationCount, total: result.counts.total } });
        if (!available) {
          for (const id of ["selected-provider-public-input", "selected-provider-identity"]) nativeChecks.push({ id, status: "BLOCKED", reason: "No eligible receipt-backed selected-provider result is available to inspect. The runner does not manufacture results or invoke credentials.", evidence: { selectedRoute: options.providerRoute, companyId: company.id } });
        } else {
          const sourceItems: MentionDTO[] = [];
          await check("selected-provider-source-drilldown", async () => {
            assert.equal(result.counts.total, result.plottedObservationCount);
            assert.equal(result.points.reduce((sum, point) => sum + point.counts.total, 0), result.plottedObservationCount);
            for (const point of result.points.filter((item) => item.counts.total > 0)) {
              let cursor: CategoricalBucketEvidencePage["nextCursor"] = null;
              const cursors = new Set<string>();
              let bucketCount = 0;
              do {
                const query = new URLSearchParams({ snapshot: result.snapshotKey, at: String(point.bucketStartMs), span: String(result.bucketMs), limit: "100" });
                if (cursor) query.set("cursor", JSON.stringify(cursor));
                const page = await read<CategoricalBucketEvidencePage>(`/api/companies/${company.id}/${selectedProvider.bucket}?${query}`);
                assert.equal(page.companyId, company.id);
                assert.equal(page.snapshotKey, result.snapshotKey);
                assert.deepEqual(page.counts, point.counts);
                assert.ok(page.items.length > 0 && page.items.length <= 100, "A populated selected-provider bucket must return a bounded nonempty page.");
                sourceItems.push(...page.items);
                bucketCount += page.items.length;
                cursor = page.nextCursor;
                if (cursor) {
                  const key = JSON.stringify(cursor);
                  assert.ok(!cursors.has(key), "The selected-provider drilldown repeated a cursor.");
                  cursors.add(key);
                  assert.ok(bucketCount < point.counts.total, "The selected-provider drilldown exceeded its declared bucket count.");
                }
              } while (cursor);
              assert.equal(bucketCount, point.counts.total);
            }
            assert.equal(sourceItems.length, result.plottedObservationCount);
            assert.equal(new Set(sourceItems.map((item) => item.id)).size, sourceItems.length);
            return { selectedRoute: options.providerRoute, companyId: company.id, sourceCount: sourceItems.length, sourceIdsSha256: createHash("sha256").update(JSON.stringify(sourceItems.map((item) => item.id).sort())).digest("hex") };
          });
          await check("selected-provider-public-input", async () => {
            assert.equal(sourceItems.length, result.plottedObservationCount, "A complete selected-provider source drilldown is required.");
            assert.ok(sourceItems.every((item) => item.companyId === company.id && item.source.deliveryId
              && item.collector !== "legacy_unknown" && item.collector !== "demo_simulation"), "Only receipt-linked real public source observations are eligible; private evidence is never read here.");
            return { selectedRoute: options.providerRoute, companyId: company.id, publicSourceCount: sourceItems.length, privateEvidenceRead: false };
          });
          await check("selected-provider-identity", async () => {
            assert.equal(sourceItems.length, result.plottedObservationCount, "A complete selected-provider source drilldown is required.");
            assert.ok(sourceItems.every((item) => {
              if (selectedProvider.provider === "google_gemini") {
                const classification = item.providerCategorical;
                return classification?.provider === selectedProvider.provider && classification.modelRequested === selectedProvider.model
                  && classification.modelReturned === selectedProvider.model && Boolean(classification.attemptId) && /^[a-f0-9]{64}$/.test(classification.sourceSha256);
              }
              const classification = item.classification;
              return classification?.provider === selectedProvider.provider && classification.modelRequested === selectedProvider.model
                && classification.modelReturned === selectedProvider.model && classification.accountingRoute === selectedProvider.accountingRoute
                && Boolean(classification.attemptId && classification.responseId) && /^[a-f0-9]{64}$/.test(classification.responseSha256);
            }), "Saved provider/model/accounting identity or linked request receipt does not match the selected route.");
            return { selectedRoute: options.providerRoute, provider: selectedProvider.provider, requestedModel: selectedProvider.model, verifiedSavedIdentityCount: sourceItems.length };
          });
        }
        // A nonzero count is not enough: authentic provider bytes, current send path,
        // independent expected buckets and rendered source drilldown are still required.
        }
      } catch (error) {
        nativeChecks.push({ id: "current-real-sentiment-availability", status: "FAIL", reason: error instanceof assert.AssertionError ? error.message.slice(0, 500) : "The real sentiment series could not be read from the configured database.", evidence: null });
      }
    }
    raw.close(); snapshotDb = null;
    assert.equal(attemptedExternalCalls, 0, "Read-only checks attempted an external request.");
  }
} catch {
  nativeChecks.push({ id: "real-source-runtime", status: "BLOCKED", reason: "Real-source runtime could not be initialized. No task acceptance inferred.", evidence: null });
} finally {
  globalThis.fetch = priorFetch;
  try { db?.close(); } catch { /* already closed */ }
  try { snapshotDb?.close(); } catch { /* already closed */ }
  if (directory) rmSync(directory, { recursive: true, force: true });
}

const nativeBindings = bindNativeCheckFailures(nativeChecks);
for (const [id, items] of nativeBindings) for (const item of items) observe(id, item);
const caseEvidence = journeyEvidence?.observations ?? observations;
const bindingEvidenceByCase = new Map([...observations].map(([id, items]) => [
  id,
  items.filter((item) => item.status === "FAIL" || item.status === "BLOCKED"),
]));
const results = GOLDEN_CASES.map((scenario) => gradeGoldenCase(
  scenario,
  caseEvidence.get(scenario.id) ?? [],
  bindingEvidenceByCase.get(scenario.id) ?? [],
));
const requiredRouteCaptureCount = GOLDEN_CASES.reduce((count, scenario) => count + scenario.variants.length, 0);
const report = { schemaVersion: 1, version: GOLDEN_VERSION, runId, observedAt, gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runtime: { node: process.version, packageLockSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex") }, appFingerprint, appMode, selectedProviderRoute: options.providerRoute ? { id: options.providerRoute, ...selectedProvider, accountTierVerified: false } : null, inputFiles, sourceDatabaseSha256: existsSync(sourcePath) ? createHash("sha256").update(readFileSync(sourcePath)).digest("hex") : null, evaluatedRoute: journeyEvidence?.routes[0]?.url ?? routeOrigin ?? "unavailable", requiredRoute: appMode === "cloud" ? "the intended hosted Sentiment Desk workflow and its saved-source drilldown" : "the supported local Sentiment Desk workflow and its saved-source drilldown", servedUiBuildFingerprint, liveRuntimeId: liveHealth?.runtimeId ?? null, liveFilingsState: liveFilings?.state ?? null, liveFilingsDiagnostic, reviewedRouteCaptureCount: journeyEvidence?.routes.length ?? 0, requiredRouteCaptureCount, reviewedRouteCapturePresent: journeyEvidence?.routes.length === requiredRouteCaptureCount, journeyReviewPackagePresent: Boolean(journeyEvidence), journeyReviewEvidence: journeyEvidence ? { runId: journeyEvidence.runId, reviewers: journeyEvidence.reviewers, routes: journeyEvidence.routes.map(({ id, url, screenshot }) => ({ id, url, screenshot })) } : null, journeyEvidenceError, ready: goldenReady(results, journeyEvidence, bindingEvidenceByCase, nativeChecks), realSourceInventory, attemptedExternalCalls, nativeChecks, cases: results, limitations: ["The recent SEC filings status is a separate route diagnostic; it does not by itself establish a useful tickerless investor lead.", "No synthetic source records, classifications, decisions, baselines, private notes or model replies are inserted. No provider credentials are used.", "Gemini account tier, remaining free allowance and provider balance are unverified. Gemini Free is admitted only for public source evidence; private evidence remains local or explicitly confirmed through a connected Luna route.", "Native connection status and saved source readback cannot certify the current explicit send or rendered provider-specific chart and drilldown; file-based reviewer PASS claims remain UNVERIFIED.", "Subagent judgments do not establish statistical model quality or replace a separately calibrated model-quality evaluation.", "Any required user-owned analyst or private state must already exist as real owner-authored data; the evaluator never creates it. Price data is optional."] };
const out = path.join(root, ".engineering-evidence/investor-golden"); mkdirSync(out, { recursive: true, mode: 0o700 });
const reportPath = path.join(out, `${observedAt.replaceAll(":", "-")}-${runId}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
for (const result of results) process.stdout.write(`${result.id} ${result.status}: ${result.job}\n`);
for (const result of nativeChecks) process.stdout.write(`native ${result.id}: ${result.status}\n`);
process.stdout.write(`Ready: ${report.ready ? "YES" : "NO"}\nReport: ${reportPath}\n`);
process.exitCode = report.ready ? 0 : 1;
