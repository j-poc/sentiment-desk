import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApp } from "../../../server/app.js";
import { Desk } from "../../../server/db.js";
import { CompanyFundamentals } from "../../../server/company-fundamentals.js";
import { HealthTracker } from "../../../server/health.js";
import { Hub } from "../../../server/hub.js";
import { MarketData } from "../../../server/market.js";
import { Pipeline } from "../../../server/pipeline.js";
import { PRIVATE_EVIDENCE_ANALYSIS_DATA_CONTROLS } from "../../../server/private-evidence-analysis.js";
import { PrivateEvidenceStore } from "../../../server/private-evidence-store.js";
import type { Company, CollectorId } from "../../../server/types.js";
import type { PrivateEvidenceAnalysisRecord, PrivateEvidenceItem } from "../../../shared/private-evidence.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, "../../..");
const runId = randomUUID();
const startedAt = new Date().toISOString();
const productFiles = [
  "server/app.ts",
  "server/company-fundamentals.ts",
  "server/config.ts",
  "server/db.ts",
  "server/index.ts",
  "server/private-evidence-analysis.ts",
  "server/private-evidence-store.ts",
  "server/storage-capacity.ts",
  "shared/company-fundamentals.ts",
  "shared/private-evidence.ts",
  "web/src/components/PrivateEvidencePanel.tsx",
  "tests/app-private-evidence.test.ts",
  "tests/private-evidence-panel.test.tsx",
];
const verifierFiles = [
  ".agents/skills/verify-sentiment-desk/SKILL.md",
  ".agents/skills/verify-sentiment-desk/features/README.md",
  ".agents/skills/verify-sentiment-desk/features/sec-fundamentals-recovery.md",
  ".agents/skills/verify-sentiment-desk/features/private-evidence-explicit-consent.md",
  ".agents/skills/verify-sentiment-desk/tsconfig.json",
  ".agents/skills/verify-sentiment-desk/verify-sec-fundamentals-recovery.ts",
];
const apiResponseSchema = z.object({
  state: z.enum(["idle", "ready", "partial", "empty", "stale", "blocked", "failed"]),
  snapshotId: z.string().nullable(),
  facts: z.array(z.object({ metric: z.string(), acceptedAt: z.number().nullable() })),
  retrievedAt: z.number().nullable(),
  latestAttemptAt: z.number().nullable(),
  staleReason: z.string().nullable(),
  lastRefreshError: z.string().nullable(),
});
const doctorSchema = z.object({ ok: z.literal(true), version: z.literal("sentiment-desk-verifier-fixture"), runtimeId: z.string().uuid() });
const proofReadbackSchema = z.object({
  runId: z.string().uuid(), result: z.enum(["PASS", "FAIL"]),
  product: z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    finalFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    unchangedDuringRun: z.boolean(),
  }),
  verifier: z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    finalFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    unchangedDuringRun: z.boolean(),
  }),
});

interface FixtureCall { url: string; status: number; kind: "fixture" | "injected_failure" | "unmapped" }

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(files: readonly string[]): Array<{ path: string; sha256: string }> {
  return files.map((relativePath) => ({ path: relativePath, sha256: sha256(readFileSync(path.join(repo, relativePath))) }));
}

function aggregateFingerprint(files: readonly { path: string; sha256: string }[]): string {
  return sha256(JSON.stringify(files));
}

function deterministicRevenueOnlyResponses(options: {
  acceptedAtMs: number;
  cik: number;
  issuer: string;
}): Map<string, unknown> {
  const { acceptedAtMs, cik, issuer } = options;
  const cikText = String(cik).padStart(10, "0");
  const acceptedAt = new Date(acceptedAtMs);
  const acceptedDate = acceptedAt.toISOString().slice(0, 10);
  const accessionYear = acceptedAt.getUTCFullYear();
  const reportYear = accessionYear - 1;
  const accession = `${cikText}-${String(accessionYear).slice(-2)}-000001`;
  const fact = (periodYear: number, value: number) => ({
    start: `${periodYear}-01-01`, end: `${periodYear}-12-31`, val: value, accn: accession,
    fy: reportYear, fp: "FY", form: "10-K", filed: acceptedDate, decimals: -6,
  });
  return new Map<string, unknown>([
    [`https://data.sec.gov/submissions/CIK${cikText}.json`, {
      cik,
      filings: { recent: {
        form: ["10-K"], filingDate: [acceptedDate], reportDate: [`${reportYear}-12-31`],
        acceptanceDateTime: [acceptedAt.toISOString()], accessionNumber: [accession], primaryDocument: ["fixture-annual-report.htm"],
      } },
    }],
    [`https://data.sec.gov/api/xbrl/companyfacts/CIK${cikText}.json`, {
      cik, entityName: issuer, facts: { "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
          fact(reportYear - 1, 100_000_000), fact(reportYear, 101_000_000),
        ] } },
      } },
    }],
  ]);
}

function checkedResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function privateEvidenceAnalysis(company: Company, evidence: PrivateEvidenceItem, payloadSha256: string, requestBytes: number): PrivateEvidenceAnalysisRecord {
  return {
    companyId: company.id,
    evidenceId: evidence.id,
    evidenceSha256: evidence.sha256,
    payloadSha256,
    requestBytes,
    modelRequested: "gpt-6-luna",
    modelReturned: "gpt-6-luna",
    serviceTierRequested: "default",
    serviceTier: "default",
    promptVersion: "private-evidence-luna-analysis/1",
    promptSha256: sha256("verifier-only private evidence prompt fingerprint"),
    schemaVersion: "private-evidence-luna-analysis-json/1",
    schemaSha256: sha256("verifier-only private evidence schema fingerprint"),
    profileVersion: "private-evidence-luna-profile/1",
    profileSha256: sha256("verifier-only private evidence profile fingerprint"),
    responseId: "resp_verifier_private_evidence",
    responseSha256: sha256("verifier-only private evidence response fingerprint"),
    usage: { inputTokens: 30, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20,
      reasoningTokens: 0, totalTokens: 50, estimatedCostUsd: 0 },
    analysis: {
      sentiment: "positive",
      summary: "The selected verifier note reports that orders improved.",
      evidence: [{ quote: "Orders improved this month.", explanation: "The selected note describes an operating trend." }],
      uncertainties: ["This verifier note is unverified and does not establish the trend's scale or cause."],
      nextQuestion: "What independent records corroborate the reported order trend?",
    },
    latencyMs: 0,
    httpStatus: 200,
    dataControls: PRIVATE_EVIDENCE_ANALYSIS_DATA_CONTROLS,
  };
}

async function main(): Promise<void> {
  const sourceInventory = fingerprint(productFiles);
  const verifierInventory = fingerprint(verifierFiles);
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const productFingerprint = aggregateFingerprint(sourceInventory);
  const verifierFingerprint = aggregateFingerprint(verifierInventory);
  const evidenceDirectory = path.join(directory, "evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, `${runId}.json`);
  const scratchPath = mkdtempSync(path.join(tmpdir(), "sentiment-desk-verification-"));
  const databasePath = path.join(scratchPath, "desk.sqlite");
  const company: Company = {
    id: "verifier-issuer", name: "Verifier Fixture Issuer", ticker: "TST",
    sector: "Deterministic test fixture", aliases: [], color: "#64748b",
  };
  const recentCompany: Company = {
    id: "verifier-recent-issuer", name: "Verifier Recent Fixture Issuer", ticker: "FST",
    sector: "Deterministic test fixture", aliases: [], color: "#16a34a",
  };
  const externalCollectorAllowlist: ReadonlySet<CollectorId> = new Set();
  const fixtureAcceptedAt = Date.now() - 366 * 24 * 60 * 60 * 1_000;
  const recentFixtureAcceptedAt = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  const fixtureResponses = new Map<string, unknown>([
    ...deterministicRevenueOnlyResponses({ acceptedAtMs: fixtureAcceptedAt, cik: 1, issuer: company.name }),
    ...deterministicRevenueOnlyResponses({ acceptedAtMs: recentFixtureAcceptedAt, cik: 2, issuer: recentCompany.name }),
    ["https://www.sec.gov/files/company_tickers.json", {
      "0": { cik_str: 1, ticker: company.ticker, title: company.name },
      "1": { cik_str: 2, ticker: recentCompany.ticker, title: recentCompany.name },
    }],
  ]);
  const expectedFailureUrl = "https://data.sec.gov/submissions/CIK0000000001.json";
  const fixtureCalls: FixtureCall[] = [];
  let server: ReturnType<typeof serve> | null = null;
  let db: Desk | null = null;
  let reopenedDb: Desk | null = null;
  let privateEvidenceStore: PrivateEvidenceStore | null = null;
  let reopenedPrivateEvidenceStore: PrivateEvidenceStore | null = null;
  let pipeline: Pipeline | null = null;
  let outcome: "PASS" | "FAIL" = "PASS";
  let errorMessage: string | null = null;
  let cleanupResult = "not_started";
  let port: number | null = null;
  const actions: Array<Record<string, unknown>> = [];
  let persistedReadback: Record<string, unknown> | null = null;
  let privateEvidenceId: string | null = null;
  let privateEvidenceSha256: string | null = null;
  let privateEvidenceAnalysisCalls = 0;
  let privateEvidenceAnalysisCallsBeforeConsent = 0;

  try {
    db = new Desk(databasePath);
    db.seedCompanies([company, recentCompany]);
    const health = new HealthTracker(false, false, "deterministic-fixture", false, false, false, false);
    const hub = new Hub();
    pipeline = new Pipeline({
      db, judge: null, hub, health, engineLabel: "deterministic-fixture", inputPricePerMTok: 0,
      concurrency: 1, allowedCollectors: externalCollectorAllowlist, externalRequestsEnabled: false,
      dailyBudget: { utcDay: () => new Date().toISOString().slice(0, 10), maxRequests: 0, maxRequestBytes: 0 },
    });
    const market = new MarketData({
      companies: [company, recentCompany], indices: [], hub, health, db, externalRequestsEnabled: false,
      quoteRequestsEnabled: false, chartRequestsEnabled: false,
    });
    let clock = Date.now();
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const body = fixtureResponses.get(url);
      if (body == null) {
        fixtureCalls.push({ url, status: 502, kind: "unmapped" });
        return new Response("unexpected URL: fixture adapter is closed", { status: 502 });
      }
      if (fixtureCalls.length === 4) {
        if (url !== expectedFailureUrl) {
          fixtureCalls.push({ url, status: 502, kind: "unmapped" });
          return new Response("unexpected failure-boundary URL", { status: 502 });
        }
        fixtureCalls.push({ url, status: 503, kind: "injected_failure" });
        return new Response("deterministic verifier failure", { status: 503 });
      }
      fixtureCalls.push({ url, status: 200, kind: "fixture" });
      return checkedResponse(body);
    };
    const fundamentals = new CompanyFundamentals({
      db, externalRequestsEnabled: true, secCompanyFactsEnabled: true,
      userAgent: "Sentiment Desk deterministic verifier fixture contact verifier@example.invalid",
      fetcher, now: () => ++clock,
    });
    privateEvidenceStore = new PrivateEvidenceStore(path.join(scratchPath, "private-evidence", "evidence.sqlite"), () => ++clock);
    const app = createApp({
      db, dbPath: databasePath, pipeline, market, hub, health,
      version: "sentiment-desk-verifier-fixture", deliverySources: [], companyFundamentals: fundamentals,
      privateEvidence: privateEvidenceStore,
      privateEvidenceEnabled: true,
      privateEvidenceCompanyIds: new Set([company.id]),
      privateEvidenceAnalysis: {
        enabled: true,
        blockedReason: null,
        analyze: async (selectedCompany, evidence, attempt) => {
          privateEvidenceAnalysisCalls += 1;
          assert.equal(selectedCompany.id, company.id, "analysis must remain bound to the selected listed issuer");
          assert.equal(evidence.id, privateEvidenceId, "analysis must remain bound to the selected private item");
          assert.equal(evidence.sha256, privateEvidenceSha256, "analysis must use the saved item digest");
          assert.ok(evidence.content.includes("Orders improved this month."), "selected item must reach only its own analysis callback");
          const payload = JSON.stringify({ companyId: selectedCompany.id, evidenceId: evidence.id, evidenceSha256: evidence.sha256 });
          const payloadSha256 = sha256(payload);
          const requestBytes = Buffer.byteLength(payload, "utf8");
          assert.equal(attempt.begin({ payloadSha256, evidenceSha256: evidence.sha256, requestBytes }), true,
            "explicitly confirmed analysis must reserve one item-bound attempt");
          return privateEvidenceAnalysis(selectedCompany, evidence, payloadSha256, requestBytes);
        },
      },
    });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", resolve);
      server?.once("error", reject);
    });
    const address = server.address();
    assert.ok(address != null && typeof address !== "string", "owned verifier server must bind an ephemeral TCP port");
    port = address.port;
    const origin = `http://127.0.0.1:${port}`;
    const route = `/api/companies/${encodeURIComponent(company.id)}/fundamentals`;

    const doctorResponse = await fetch(`${origin}/api/health`);
    assert.equal(doctorResponse.status, 200);
    const doctor = doctorSchema.parse(await doctorResponse.json());
    assert.equal(fixtureCalls.length, 0, "read-only doctor must not reach the SEC fixture boundary");
    actions.push({
      phase: "doctor", method: "GET", path: "/api/health", status: doctorResponse.status,
      result: "healthy own instance", version: doctor.version, runtimeId: doctor.runtimeId,
      fixtureCallsBeforeDrive: fixtureCalls.length,
    });

    const firstRequestKey = randomUUID();
    const firstResponse = await fetch(`${origin}${route}/refresh`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ requestKey: firstRequestKey }),
    });
    assert.equal(firstResponse.status, 200);
    const first = apiResponseSchema.parse(await firstResponse.json());
    assert.equal(first.state, "stale", "old source observation must remain stale after this run's retrieval");
    assert.ok(first.snapshotId);
    assert.equal(first.facts.length, 2);
    assert.ok(first.facts.every((fact) => fact.metric === "revenue"));
    assert.ok(first.staleReason?.includes("accepted more than 365 days ago"));
    assert.equal(first.lastRefreshError, null);
    assert.equal(fixtureCalls.length, 3);
    actions.push({
      phase: "first_refresh", method: "POST", path: `${route}/refresh`, requestKey: firstRequestKey,
      requestBody: { requestKey: firstRequestKey }, status: firstResponse.status,
      result: "partial persisted snapshot; source freshness stale", state: first.state,
      snapshotId: first.snapshotId, factMetrics: first.facts.map((fact) => fact.metric),
      retrievedAt: first.retrievedAt, staleReason: first.staleReason,
      fixtureCalls: fixtureCalls.slice(0, 3),
    });

    const readResponse = await fetch(`${origin}${route}`);
    assert.equal(readResponse.status, 200);
    const read = apiResponseSchema.parse(await readResponse.json());
    assert.equal(read.snapshotId, first.snapshotId);
    assert.equal(read.retrievedAt, first.retrievedAt);
    assert.ok(read.staleReason?.includes("accepted more than 365 days ago"));
    assert.ok(!read.staleReason?.includes("last retrieved more than 24 hours ago"));
    actions.push({
      phase: "saved_read", method: "GET", path: route, status: readResponse.status,
      result: "same saved response time; old SEC observation remains stale",
      snapshotId: read.snapshotId, retrievedAt: read.retrievedAt,
      latestAttemptAt: read.latestAttemptAt, staleReason: read.staleReason,
    });

    const failedRequestKey = randomUUID();
    const failedResponse = await fetch(`${origin}${route}/refresh`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ requestKey: failedRequestKey }),
    });
    assert.equal(failedResponse.status, 200);
    const failed = apiResponseSchema.parse(await failedResponse.json());
    assert.equal(failed.snapshotId, first.snapshotId);
    assert.equal(failed.retrievedAt, first.retrievedAt);
    assert.deepEqual(failed.facts, first.facts);
    assert.ok(failed.lastRefreshError?.includes("HTTP 503"));
    assert.ok(failed.latestAttemptAt != null && failed.latestAttemptAt > (failed.retrievedAt ?? 0));
    assert.equal(failed.staleReason, read.staleReason);
    assert.equal(fixtureCalls.length, 5);
    assert.deepEqual(fixtureCalls.map(({ url, status, kind }) => [url, status, kind]), [
      ["https://www.sec.gov/files/company_tickers.json", 200, "fixture"],
      ["https://data.sec.gov/submissions/CIK0000000001.json", 200, "fixture"],
      ["https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json", 200, "fixture"],
      ["https://www.sec.gov/files/company_tickers.json", 200, "fixture"],
      [expectedFailureUrl, 503, "injected_failure"],
    ]);
    actions.push({
      phase: "failed_refresh", method: "POST", path: `${route}/refresh`, requestKey: failedRequestKey,
      requestBody: { requestKey: failedRequestKey }, status: failedResponse.status,
      result: "latest attempt failed; accepted snapshot and retrieval time retained",
      snapshotId: failed.snapshotId, retrievedAt: failed.retrievedAt,
      latestAttemptAt: failed.latestAttemptAt, lastRefreshError: failed.lastRefreshError,
      fixtureCalls: fixtureCalls.slice(3),
    });

    const recentRoute = `/api/companies/${encodeURIComponent(recentCompany.id)}/fundamentals`;
    const recentRequestKey = randomUUID();
    const recentResponse = await fetch(`${origin}${recentRoute}/refresh`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ requestKey: recentRequestKey }),
    });
    assert.equal(recentResponse.status, 200);
    const recent = apiResponseSchema.parse(await recentResponse.json());
    assert.equal(recent.state, "partial", "recent revenue-only observations must stay partial without a stale marker");
    assert.equal(recent.staleReason, null, "recent SEC acceptance must not be marked observation-stale");
    assert.ok(recent.snapshotId);
    assert.equal(recent.facts.length, 2);
    assert.ok(recent.facts.every((fact) => fact.metric === "revenue"));
    assert.ok(recent.facts.every((fact) => fact.acceptedAt === recentFixtureAcceptedAt));
    assert.ok(recent.retrievedAt != null && recent.retrievedAt > recentFixtureAcceptedAt,
      "retrieval must follow, but remain distinct from, the source acceptance timestamp");
    const recentReadResponse = await fetch(`${origin}${recentRoute}`);
    assert.equal(recentReadResponse.status, 200);
    const recentRead = apiResponseSchema.parse(await recentReadResponse.json());
    assert.equal(recentRead.snapshotId, recent.snapshotId);
    assert.equal(recentRead.state, "partial");
    assert.equal(recentRead.staleReason, null);
    assert.equal(recentRead.retrievedAt, recent.retrievedAt);
    assert.ok(recentRead.facts.every((fact) => fact.acceptedAt === recentFixtureAcceptedAt));
    assert.equal(fixtureCalls.length, 8);
    assert.deepEqual(fixtureCalls.slice(5).map(({ url, status, kind }) => [url, status, kind]), [
      ["https://www.sec.gov/files/company_tickers.json", 200, "fixture"],
      ["https://data.sec.gov/submissions/CIK0000000002.json", 200, "fixture"],
      ["https://data.sec.gov/api/xbrl/companyfacts/CIK0000000002.json", 200, "fixture"],
    ]);
    actions.push({
      phase: "recent_acceptance_countercase", method: "POST+GET", path: recentRoute,
      requestKey: recentRequestKey, requestBody: { requestKey: recentRequestKey }, status: recentResponse.status,
      result: "recent revenue-only snapshot is partial and not observation-stale",
      snapshotId: recent.snapshotId, acceptedAt: recent.facts[0]?.acceptedAt,
      retrievedAt: recent.retrievedAt, staleReason: recent.staleReason,
      readback: {
        method: "GET", status: recentReadResponse.status, state: recentRead.state,
        snapshotId: recentRead.snapshotId, acceptedAt: recentRead.facts[0]?.acceptedAt,
        retrievedAt: recentRead.retrievedAt, staleReason: recentRead.staleReason,
      },
      fixtureCalls: fixtureCalls.slice(5),
    });

    const privateEvidenceRoute = `/api/companies/${encodeURIComponent(company.id)}/private-evidence`;
    const privateNoteText = "The verifier-only source note says Orders improved this month.";
    const privateSaveResponse = await fetch(`${origin}${privateEvidenceRoute}`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ title: "Verifier-only channel note", sourceLabel: "Isolated verifier fixture", content: privateNoteText }),
    });
    assert.equal(privateSaveResponse.status, 201);
    const privateSaved = await privateSaveResponse.json() as { id: string; companyId: string; sha256: string };
    assert.equal(privateSaved.companyId, company.id);
    assert.match(privateSaved.sha256, /^[a-f0-9]{64}$/);
    privateEvidenceId = privateSaved.id;
    privateEvidenceSha256 = privateSaved.sha256;
    const privateListResponse = await fetch(`${origin}${privateEvidenceRoute}`);
    assert.equal(privateListResponse.status, 200);
    const privateListText = await privateListResponse.text();
    const privateList = JSON.parse(privateListText) as { items: Array<{ id: string; sha256: string }>; totalCount: number };
    assert.equal(privateList.totalCount, 1);
    assert.deepEqual(privateList.items.map(({ id, sha256: digest }) => ({ id, sha256: digest })), [{ id: privateSaved.id, sha256: privateSaved.sha256 }]);
    assert.ok(!privateListText.includes(privateNoteText), "list endpoint must not expose private note contents");
    const privateReadResponse = await fetch(`${origin}${privateEvidenceRoute}/${encodeURIComponent(privateSaved.id)}`);
    assert.equal(privateReadResponse.status, 200);
    const privateRead = await privateReadResponse.json() as { id: string; companyId: string; content: string; savedAnalysis: unknown };
    assert.equal(privateRead.id, privateSaved.id);
    assert.equal(privateRead.companyId, company.id);
    assert.equal(privateRead.content === privateNoteText, true, "detail readback must return the exact selected private note");
    assert.equal(privateRead.savedAnalysis, null);
    const excludedIssuerResponse = await fetch(`${origin}/api/companies/${encodeURIComponent(recentCompany.id)}/private-evidence`);
    assert.equal(excludedIssuerResponse.status, 404, "an issuer outside the verifier's explicit public allowlist must be excluded");
    actions.push({
      phase: "private_evidence_local_save_read", method: "POST+GET", companyId: company.id, evidenceId: privateSaved.id,
      contentSha256: privateSaved.sha256, listMetadataOnly: !privateListText.includes(privateNoteText),
      detailReadback: privateRead.content === privateNoteText, excludedIssuerStatus: excludedIssuerResponse.status,
      result: "private note stays in the selected issuer's separate local store",
    });

    const analysisRoute = `${privateEvidenceRoute}/${encodeURIComponent(privateSaved.id)}/analyze`;
    const unconfirmedAnalysisResponse = await fetch(`${origin}${analysisRoute}`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({}),
    });
    assert.equal(unconfirmedAnalysisResponse.status, 400);
    assert.equal(privateEvidenceAnalysisCalls, 0, "absence of explicit confirmation must make zero analysis dispatches");
    privateEvidenceAnalysisCallsBeforeConsent = privateEvidenceAnalysisCalls;
    assert.equal(privateEvidenceStore.getAnalysis(company.id, privateSaved.id), null,
      "an unconfirmed request must not leave an attempt in the private store");
    actions.push({
      phase: "private_evidence_consent_required", method: "POST", status: unconfirmedAnalysisResponse.status,
      analysisCalls: privateEvidenceAnalysisCalls, attemptPersisted: false,
      result: "no external processing without explicit confirmation",
    });

    const confirmedAnalysisResponse = await fetch(`${origin}${analysisRoute}`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ confirmExternalProcessing: true }),
    });
    assert.equal(confirmedAnalysisResponse.status, 201);
    assert.equal(confirmedAnalysisResponse.headers.get("cache-control"), "no-store");
    const confirmedAnalysis = await confirmedAnalysisResponse.json() as {
      status: string; reusedSavedAnalysis: boolean; record: PrivateEvidenceAnalysisRecord;
    };
    assert.equal(confirmedAnalysis.status, "complete");
    assert.equal(confirmedAnalysis.reusedSavedAnalysis, false);
    assert.equal(confirmedAnalysis.record.modelRequested, "gpt-6-luna");
    assert.equal(confirmedAnalysis.record.modelReturned, "gpt-6-luna");
    assert.equal(confirmedAnalysis.record.companyId, company.id);
    assert.equal(confirmedAnalysis.record.evidenceId, privateSaved.id);
    assert.equal(confirmedAnalysis.record.evidenceSha256, privateSaved.sha256);
    assert.equal(privateEvidenceAnalysisCalls, 1);
    const repeatedAnalysisResponse = await fetch(`${origin}${analysisRoute}`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ confirmExternalProcessing: true }),
    });
    assert.equal(repeatedAnalysisResponse.status, 200);
    const repeatedAnalysis = await repeatedAnalysisResponse.json() as {
      status: string; reusedSavedAnalysis: boolean; record: PrivateEvidenceAnalysisRecord;
    };
    assert.equal(repeatedAnalysis.status, "complete");
    assert.equal(repeatedAnalysis.reusedSavedAnalysis, true);
    assert.equal(repeatedAnalysis.record.responseSha256, confirmedAnalysis.record.responseSha256);
    assert.equal(privateEvidenceAnalysisCalls, 1, "reopening a saved analysis must not repeat external work");
    const publicMentionsResponse = await fetch(`${origin}/api/companies/${encodeURIComponent(company.id)}/mentions?hours=168`);
    assert.equal(publicMentionsResponse.status, 200);
    const publicMentions = await publicMentionsResponse.json() as unknown[];
    assert.deepEqual(publicMentions, [], "private notes must not enter the public sentiment feed");
    assert.equal(db.realObservationCount(), 0, "private notes and their analysis must not become public observations");
    actions.push({
      phase: "private_evidence_selected_analysis", method: "POST", status: confirmedAnalysisResponse.status,
      companyId: confirmedAnalysis.record.companyId, evidenceId: confirmedAnalysis.record.evidenceId,
      evidenceSha256: confirmedAnalysis.record.evidenceSha256, model: confirmedAnalysis.record.modelReturned,
      result: "one selected item analyzed after explicit confirmation; saved result reused without another call",
      analysisCalls: privateEvidenceAnalysisCalls, repeatedResponseReused: repeatedAnalysis.reusedSavedAnalysis,
      publicMentionCount: publicMentions.length,
    });

    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = null;
    pipeline.stop();
    pipeline = null;
    privateEvidenceStore.close();
    privateEvidenceStore = null;
    db.close();
    db = null;
    reopenedDb = new Desk(databasePath);
    reopenedPrivateEvidenceStore = new PrivateEvidenceStore(path.join(scratchPath, "private-evidence", "evidence.sqlite"));
    const snapshot = reopenedDb.latestCompanyFundamentals(company.id);
    const latestAttempt = reopenedDb.latestFundamentalAttempt(company.id);
    const recentSnapshot = reopenedDb.latestCompanyFundamentals(recentCompany.id);
    const recentAttempt = reopenedDb.latestFundamentalAttempt(recentCompany.id);
    const privateEvidenceReadback = reopenedPrivateEvidenceStore.get(company.id, privateEvidenceId!);
    const privateEvidenceAnalysisReadback = reopenedPrivateEvidenceStore.getAnalysis(company.id, privateEvidenceId!);
    assert.equal(snapshot?.snapshotId, first.snapshotId);
    assert.equal(snapshot?.state, "partial");
    assert.equal(snapshot?.createdAt, first.retrievedAt);
    assert.equal(snapshot?.facts.length, 2);
    assert.equal(latestAttempt?.status, "failed");
    assert.ok(latestAttempt?.error?.includes("HTTP 503"));
    assert.ok(latestAttempt.requestedAt > (snapshot?.createdAt ?? 0));
    assert.equal(recentSnapshot?.snapshotId, recent.snapshotId);
    assert.equal(recentSnapshot?.state, "partial");
    assert.equal(recentSnapshot?.createdAt, recent.retrievedAt);
    assert.ok(recentSnapshot?.facts.every((fact) => fact.acceptedAt === recentFixtureAcceptedAt));
    assert.equal(recentAttempt?.status, "partial");
    assert.equal(recentAttempt?.error, null);
    assert.equal(privateEvidenceReadback?.sha256, privateEvidenceSha256);
    assert.equal(privateEvidenceReadback?.content === privateNoteText, true, "private note content must survive store reopen");
    assert.equal(privateEvidenceAnalysisReadback?.status, "complete");
    assert.equal(privateEvidenceAnalysisReadback?.record?.evidenceId, privateEvidenceId);
    assert.equal(privateEvidenceAnalysisReadback?.record?.responseSha256,
      confirmedAnalysis.record.responseSha256);
    assert.equal(reopenedDb.realObservationCount(), 0, "private research remains separate after store and database reopen");
    persistedReadback = {
      reopenedDatabase: true, snapshotId: snapshot?.snapshotId, snapshotState: snapshot?.state,
      factMetrics: snapshot?.facts.map((fact) => fact.metric), snapshotRetrievedAt: snapshot?.createdAt,
      latestAttemptStatus: latestAttempt?.status, latestAttemptAt: latestAttempt?.requestedAt,
      latestAttemptError: latestAttempt?.error,
      recentAcceptanceCountercase: {
        snapshotId: recentSnapshot?.snapshotId, snapshotState: recentSnapshot?.state,
        acceptedAt: recentSnapshot?.facts[0]?.acceptedAt, retrievedAt: recentSnapshot?.createdAt,
        latestAttemptStatus: recentAttempt?.status, latestAttemptAt: recentAttempt?.requestedAt,
      },
      privateEvidence: {
        companyId: company.id, evidenceId: privateEvidenceId, contentSha256: privateEvidenceReadback?.sha256,
        analysisStatus: privateEvidenceAnalysisReadback?.status,
        analysisResponseSha256: privateEvidenceAnalysisReadback?.record?.responseSha256,
        analysisCallsBeforeRestart: privateEvidenceAnalysisCalls, publicObservationCount: reopenedDb.realObservationCount(),
      },
    };
    actions.push({ phase: "durable_readback", result: "PASS after API and database close/reopen", ...persistedReadback });
  } catch (error) {
    outcome = "FAIL";
    errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    try {
      if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = null;
      pipeline?.stop();
      pipeline = null;
      reopenedPrivateEvidenceStore?.close();
      reopenedPrivateEvidenceStore = null;
      privateEvidenceStore?.close();
      privateEvidenceStore = null;
      reopenedDb?.close();
      reopenedDb = null;
      db?.close();
      db = null;
      rmSync(scratchPath, { recursive: true, force: true });
      cleanupResult = existsSync(scratchPath) ? "FAIL: scratch remains" : "PASS: owned server and temporary data removed";
      assert.equal(cleanupResult.startsWith("PASS"), true);
    } catch (error) {
      outcome = "FAIL";
      const cleanupError = error instanceof Error ? error.message : String(error);
      errorMessage = errorMessage ? `${errorMessage}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      cleanupResult = `FAIL: ${cleanupError}`;
    }
  }

  let finalSourceInventory: Array<{ path: string; sha256: string }> | null = null;
  let finalVerifierInventory: Array<{ path: string; sha256: string }> | null = null;
  let finalGitHead: string | null = null;
  try {
    finalSourceInventory = fingerprint(productFiles);
    finalVerifierInventory = fingerprint(verifierFiles);
    finalGitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    if (aggregateFingerprint(finalSourceInventory) !== productFingerprint) {
      outcome = "FAIL";
      errorMessage = errorMessage ? `${errorMessage}; product source changed during verification` : "product source changed during verification";
    }
    if (aggregateFingerprint(finalVerifierInventory) !== verifierFingerprint) {
      outcome = "FAIL";
      errorMessage = errorMessage ? `${errorMessage}; verifier source changed during verification` : "verifier source changed during verification";
    }
    if (finalGitHead !== gitHead) {
      outcome = "FAIL";
      errorMessage = errorMessage ? `${errorMessage}; Git HEAD changed during verification` : "Git HEAD changed during verification";
    }
  } catch (error) {
    outcome = "FAIL";
    const fingerprintError = error instanceof Error ? error.message : String(error);
    errorMessage = errorMessage ? `${errorMessage}; final fingerprint failed: ${fingerprintError}` : `final fingerprint failed: ${fingerprintError}`;
  }

  const record = {
    schema: "sentiment-desk-verification-run/1",
    runId,
    featureIds: ["sec-fundamentals-recovery", "private-evidence-explicit-consent"],
    result: outcome,
    error: errorMessage,
    startedAt,
    completedAt: new Date().toISOString(),
    product: {
      gitHead, finalGitHead, files: sourceInventory, fingerprint: productFingerprint,
      finalFiles: finalSourceInventory, finalFingerprint: finalSourceInventory ? aggregateFingerprint(finalSourceInventory) : null,
      unchangedDuringRun: finalSourceInventory != null && aggregateFingerprint(finalSourceInventory) === productFingerprint && finalGitHead === gitHead,
    },
    verifier: {
      files: verifierInventory, fingerprint: verifierFingerprint,
      finalFiles: finalVerifierInventory, finalFingerprint: finalVerifierInventory ? aggregateFingerprint(finalVerifierInventory) : null,
      unchangedDuringRun: finalVerifierInventory != null && aggregateFingerprint(finalVerifierInventory) === verifierFingerprint,
    },
    environment: {
      repository: repo, cwd: process.cwd(), node: process.version, platform: process.platform,
      architecture: process.arch, pid: process.pid, ownedLoopbackPort: port,
    },
    configuration: {
      appVersion: "sentiment-desk-verifier-fixture", host: "127.0.0.1", externalRequestsEnabledForService: true,
      secCompanyFactsEnabledForService: true, providerCalls: "none; injected deterministic fixture boundary",
      privateEvidenceAnalysisEnabledForVerifier: true,
      privateEvidenceProviderCalls: "none; selected-item callback is a local deterministic verifier fixture",
      modelDownloads: "none", paidRequests: "none", database: "temporary isolated SQLite; removed after run",
    },
    fixture: { label: "deterministic historical test evidence only", acceptedAt: new Date(fixtureAcceptedAt).toISOString(), calls: fixtureCalls },
    actions,
    persistedReadback,
    privateEvidence: {
      result: privateEvidenceAnalysisCalls === 1 ? "PASS: one isolated selected-item fixture call" : "FAIL: unexpected fixture call count",
      externalProviderRequests: 0,
      noConfirmationDispatches: privateEvidenceAnalysisCallsBeforeConsent,
    },
    cleanup: cleanupResult,
  };
  writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const verified = proofReadbackSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
  assert.equal(verified.runId, runId);
  assert.equal(verified.result, outcome);
  assert.equal(verified.product.fingerprint, productFingerprint);
  assert.equal(verified.verifier.fingerprint, verifierFingerprint);
  if (outcome === "PASS") {
    assert.equal(verified.product.finalFingerprint, productFingerprint);
    assert.equal(verified.product.unchangedDuringRun, true);
    assert.equal(verified.verifier.finalFingerprint, verifierFingerprint);
    assert.equal(verified.verifier.unchangedDuringRun, true);
  }
  console.log(`${outcome}: run=${runId}; product=${productFingerprint}; verifier=${verifierFingerprint}; proof=${path.relative(repo, evidencePath)}; cleanup=${cleanupResult}`);
  if (outcome === "FAIL") {
    console.error(errorMessage ?? "verification failed");
    process.exitCode = 1;
  }
}

await main();
