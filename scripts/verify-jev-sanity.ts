import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config } from "../server/config.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevClient } from "../server/jev.js";
import { Pipeline } from "../server/pipeline.js";
import { RUBRIC, RUBRIC_SHA } from "../server/rubric.js";
import type { Company, JevState } from "../server/types.js";

const caseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["clear", "namesake", "sector", "consumer_trivia"]),
  title: z.string().min(1),
  snippet: z.string().min(1),
  expected: z.object({
    sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
    eventType: z.string().optional(),
    aboutBelow: z.number().optional(),
    investorRelevantBelow: z.number().optional(),
  }),
});
const caseSetSchema = z.array(caseSchema).length(10);
type EvalCase = z.infer<typeof caseSchema>;

const fixtureCompany: Company = {
  id: "northstar-testworks",
  name: "Northstar Testworks",
  ticker: "NSTX",
  sector: "Synthetic Software",
  aliases: [],
  color: "#34d399",
};
const reportPath = path.resolve("project-record/4-log/2026-09-28-jev-synthetic-sanity.json");
const sourcePath = path.resolve("scripts/jev-sanity-cases.json");
const retryBudgetMs = 8 * 60_000;

interface AttemptRecord {
  startedAt: string;
  elapsedMs: number;
  outcome: "response" | "error";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  errorKind?: string;
  status?: number | null;
  retryable?: boolean;
  outcomeUnknown?: boolean;
}

async function runCase(item: EvalCase, jev: JevClient): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(path.join(os.tmpdir(), `jev-sanity-${item.id}-`));
  const dbPath = path.join(directory, "case.db");
  const db = new Desk(dbPath);
  const hub = new Hub();
  const health = new HealthTracker(false, true, config.jev.model);
  const attempts: AttemptRecord[] = [];
  const pipeline = new Pipeline({
    db,
    judge: async (state: JevState) => {
      const started = Date.now();
      try {
        const outcome = await jev.judge(state, RUBRIC);
        attempts.push({
          startedAt: new Date(started).toISOString(),
          elapsedMs: Date.now() - started,
          outcome: "response",
          model: outcome.model,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
        });
        return outcome;
      } catch (error) {
        attempts.push({
          startedAt: new Date(started).toISOString(),
          elapsedMs: Date.now() - started,
          outcome: "error",
          errorKind: error instanceof Error ? error.name : "unknown",
          status: error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : null,
          retryable: error instanceof Error && "retryable" in error ? error.retryable === true : false,
          outcomeUnknown: error instanceof Error && "outcomeUnknown" in error ? error.outcomeUnknown === true : false,
        });
        throw error;
      }
    },
    hub,
    health,
    engineLabel: config.jev.model,
    inputPricePerMTok: 0.042,
    concurrency: 1,
  });
  const startedAt = Date.now();

  try {
    db.seedCompanies([fixtureCompany]);
    const now = Date.now();
    const inserted = db.insertObservation({
      companyId: fixtureCompany.id,
      kind: "rss",
      sourceName: "Fictional Jev evaluation case",
      sourceUrl: `https://example.invalid/jev-sanity/${item.id}`,
      tier: "major",
      title: item.title,
      snippet: item.snippet,
      publishedAt: now,
      retrievedAt: now,
      collector: "google_news_rss",
      sourceItemId: `jev-sanity-${item.id}`,
      publisherName: "Fictional evaluation fixture",
      publisherDomain: "example.invalid",
    });
    if (!inserted.inserted) throw new Error("case observation did not insert into its fresh database");
    pipeline.drainPending(1);

    const deadline = Date.now() + retryBudgetMs;
    let terminalStatus = "pending";
    while (Date.now() < deadline) {
      await pipeline.waitForIdle();
      const row = db.mentionRow(inserted.observationId);
      if (!row) throw new Error("persisted case judgment disappeared");
      terminalStatus = row.status;
      if (["scored", "off_target", "failed", "corrupt"].includes(row.status)) break;
      if (row.status === "pending" || (row.status === "retrying" && row.score_retry_at != null && row.score_retry_at <= Date.now())) {
        pipeline.drainPending(5_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const persisted = db.mentionRow(inserted.observationId);
    if (persisted) terminalStatus = persisted.status;
    const dto = db.mentionsForCompany(fixtureCompany.id, now - 60_000, 5)[0] ?? null;
    const score = dto?.score ?? null;
    const checks: Record<string, boolean | null> = {
      terminal: persisted != null && ["scored", "off_target", "failed", "corrupt"].includes(terminalStatus),
      sentiment: item.expected.sentiment == null ? null : score?.sentiment === item.expected.sentiment,
      eventType: item.expected.eventType == null ? null : score?.eventType === item.expected.eventType,
      aboutBoundary: item.expected.aboutBelow == null ? null : score != null && score.about < item.expected.aboutBelow,
      investorRelevantBoundary: item.expected.investorRelevantBelow == null ? null : score != null && score.investorRelevant < item.expected.investorRelevantBelow,
    };
    const applicableChecks = Object.values(checks).filter((value): value is boolean => value !== null);
    return {
      id: item.id,
      kind: item.kind,
      expected: item.expected,
      actual: score ? {
        sentiment: score.sentiment,
        eventType: score.eventType,
        about: score.about,
        investorRelevant: score.investorRelevant,
        model: score.engine,
        rubricSha: score.rubricSha,
        inputTokens: score.inputTokens,
        outputTokens: score.outputTokens,
        estimatedInputCostUsd: score.estimatedInputCostUsd,
        responseLatencyMs: score.latencyMs,
      } : null,
      terminalStatus,
      scoreAttempts: persisted?.score_attempts ?? attempts.length,
      requestCount: attempts.length,
      endToEndMs: Date.now() - startedAt,
      providerAttempts: attempts,
      checks,
      pass: applicableChecks.length > 0 && applicableChecks.every(Boolean),
      errorCategory: persisted?.score_error ? sanitizeProviderError(persisted.score_error) : null,
    };
  } finally {
    hub.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function sanitizeProviderError(message: string): string {
  return message
    .replaceAll(config.jev.apiKey, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

function gitMetadata(): { revision: string; sourceTreeDirty: boolean; untrackedFileCount: number } {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n").filter(Boolean).length;
  return { revision, sourceTreeDirty: tracked.length > 0, untrackedFileCount: untracked };
}

async function main(): Promise<void> {
  const rawCaseSet = readFileSync(sourcePath);
  const cases = caseSetSchema.parse(JSON.parse(rawCaseSet.toString("utf8")));
  const sourceDigest = createHash("sha256").update(rawCaseSet).digest("hex");
  const git = gitMetadata();
  const report: Record<string, unknown> = {
    runId: `jev-sanity-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    startedAt: new Date().toISOString(),
    status: "BLOCKED",
    caseSet: { path: "scripts/jev-sanity-cases.json", expectedCount: 10, actualCount: cases.length, sha256: sourceDigest },
    code: git,
    requestedModel: config.jev.model,
    rubricSha: RUBRIC_SHA,
    dataBoundary: "fictional text only; independent temporary SQLite database per case; no market/source adapters",
    billingLimit: "estimated cost sums provider-reported input tokens; rejected/unknown attempts may not report usage, and billing for them is unverified",
    limitations: [
      "Ten synthetic cases detect gross protocol/rubric/serving defects only; they do not estimate real-source accuracy, calibration, or investment performance.",
      "The report does not treat synthetic labels as validated real-world ground truth.",
      "Provider-reported token counts are not an account invoice; 429/529 usage semantics remain unverified.",
    ],
    cases: [],
  };

  if (!config.jev.apiKey) {
    report.status = "BLOCKED_PROVIDER_KEY_UNAVAILABLE";
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ result: report.status, caseCount: cases.length, report: reportPath }));
    process.exitCode = 2;
    return;
  }

  const jev = new JevClient({
    apiKey: config.jev.apiKey,
    baseUrl: config.jev.baseUrl,
    model: config.jev.model,
    timeoutMs: config.jev.timeoutMs,
  });
  const caseResults: Array<Record<string, unknown>> = [];
  let stoppedOnSystemicFailure = false;
  for (const item of cases) {
    if (stoppedOnSystemicFailure) {
      caseResults.push({ id: item.id, kind: item.kind, expected: item.expected, actual: null, terminalStatus: "not_run_systemic_stop", requestCount: 0, pass: false, errorCategory: "stopped after repeated systemic failure" });
      continue;
    }
    try {
      const result = await runCase(item, jev);
      caseResults.push(result);
      const errorAttempts = (result.providerAttempts as AttemptRecord[]).filter((attempt) => attempt.outcome === "error");
      if (errorAttempts.length >= 3 && errorAttempts.every((attempt) => attempt.status === errorAttempts[0]?.status)) {
        stoppedOnSystemicFailure = true;
      }
    } catch (error) {
      caseResults.push({
        id: item.id,
        kind: item.kind,
        expected: item.expected,
        actual: null,
        terminalStatus: "runner_error",
        requestCount: 0,
        pass: false,
        errorCategory: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const clearCases = caseResults.filter((result) => result.kind === "clear");
  const boundaryCases = caseResults.filter((result) => result.kind !== "clear");
  const allTerminal = caseResults.length === cases.length && caseResults.every((result) => ["scored", "off_target", "failed", "corrupt"].includes(String(result.terminalStatus)));
  const passCount = caseResults.filter((result) => result.pass === true).length;
  const requestCount = caseResults.reduce((sum, result) => sum + (typeof result.requestCount === "number" ? result.requestCount : 0), 0);
  const reportedInputTokens = caseResults.flatMap((result) => result.providerAttempts as AttemptRecord[] ?? [])
    .reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0);
  const reportedOutputTokens = caseResults.flatMap((result) => result.providerAttempts as AttemptRecord[] ?? [])
    .reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0);
  const estimatedInputCostUsd = (reportedInputTokens / 1_000_000) * 0.042;
  report.finishedAt = new Date().toISOString();
  report.status = allTerminal && passCount === cases.length ? "PASS_SYNTHETIC_SANITY_ONLY" : allTerminal ? "FAIL_SYNTHETIC_SANITY" : "INCOMPLETE_RETRY_BUDGET_OR_PROVIDER_FAILURE";
  report.summary = {
    allTenCasesTerminal: allTerminal,
    passingCases: passCount,
    totalCases: cases.length,
    sevenClearCases: {
      exactDirectionAndEventMatchCount: clearCases.filter((result) => result.pass === true).length,
      total: clearCases.length,
    },
    boundaryCases: boundaryCases.map((result) => ({ id: result.id, kind: result.kind, pass: result.pass, checks: result.checks ?? null })),
    requestCount,
    reportedInputTokens,
    reportedOutputTokens,
    estimatedInputCostUsd,
    successfulResponseLatencyMs: caseResults.flatMap((result) => result.providerAttempts as AttemptRecord[] ?? [])
      .filter((attempt) => attempt.outcome === "response").map((attempt) => attempt.elapsedMs),
  };
  report.cases = caseResults;
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ result: report.status, requestCount, passCount, totalCases: cases.length, caseSetSha256: sourceDigest, report: reportPath }));
  if (report.status !== "PASS_SYNTHETIC_SANITY_ONLY") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ result: "RUNNER_FAILURE", errorType: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
});
