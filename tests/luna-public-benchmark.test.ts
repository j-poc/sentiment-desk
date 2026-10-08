import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateLunaPublicBenchmark,
  lunaPublicBenchmarkInputBindingSha256,
  sha256CanonicalJson,
  verifyLunaPublicBenchmarkArtifacts,
} from "../scripts/luna-public-benchmark.js";

// Isolated in-memory test-only labels and receipts. No raw benchmark text or
// product records are used, persisted, or implied to be real observations.
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const profilePayload = { requestedModel: "gpt-6-luna", promptSha256: sha("test prompt"), schemaSha256: sha("test schema"), profileSha256: sha("test profile") } as const;
const profile = { ...profilePayload, artifactSha256: sha256CanonicalJson(profilePayload) } as const;
const rightsPayload = {
  attested: true,
  benchmark: "FinEntity",
  datasetSha256: "3208667de69383120b0380aebeaabe360669eda72269c33e1c8b09d63df55463",
  permittedUses: ["provider_transmission", "local_scoring", "retention"],
  provider: "OpenAI",
} as const;
const rights = { ...rightsPayload, artifactSha256: sha256CanonicalJson(rightsPayload) };

function rawRow(rowId: string, paragraphId: string, targetId: string, referenceSentiment: "negative" | "neutral" | "positive") {
  return {
    rowId, paragraphId, targetId, entityId: `entity-${targetId}`, referenceSentiment,
    requestSha256: sha(`exact request ${rowId}`),
  };
}
function row(rowId: string, paragraphId: string, targetId: string, referenceSentiment: "negative" | "neutral" | "positive") {
  const value = rawRow(rowId, paragraphId, targetId, referenceSentiment);
  return { ...value, inputBindingSha256: lunaPublicBenchmarkInputBindingSha256({ ...value, inputBindingSha256: sha("temporary binding") }, profile) };
}
const rows = [
  row("r1", "p1", "t1", "negative"),
  row("r2", "p1", "t2", "neutral"),
  row("r3", "p2", "t1", "positive"),
  row("r4", "p3", "t3", "neutral"),
];

function prediction(rowItem: typeof rows[number], sentimentValue: unknown, status = "completed") {
  return {
    rowId: rowItem.rowId, paragraphId: rowItem.paragraphId, targetId: rowItem.targetId, entityId: rowItem.entityId,
    status, sentiment: sentimentValue,
    requestSha256: rowItem.requestSha256, responseSha256: sha(`response ${rowItem.rowId}`),
    usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.00001, latencyMs: 42 },
  };
}

function makeRun(items: unknown[], override: Record<string, unknown> = {}) {
  const payload = {
    runId: "persisted-test-run", startedAt: "2026-10-08T09:59:00Z", persistedAt: "2026-10-08T10:00:00Z",
    provider: "OpenAI", requestedModel: profile.requestedModel, modelReturned: "gpt-6-luna",
    promptSha256: profile.promptSha256, schemaSha256: profile.schemaSha256, profileSha256: profile.profileSha256,
    datasetRowsSha256: sha256CanonicalJson(rows), rightsArtifactSha256: rights.artifactSha256, classifierProfileArtifactSha256: profile.artifactSha256,
    items, ...override,
  };
  return { ...payload, artifactSha256: sha256CanonicalJson(payload) };
}

function makeInput(items: unknown[] = rows.map((item) => prediction(item, item.referenceSentiment)), override: {
  rights?: unknown; rows?: typeof rows; rowsArtifactSha256?: unknown; classifierProfile?: unknown;
  run?: Record<string, unknown>; bootstrapReplicates?: number;
} = {}) {
  const runArtifact = makeRun(items, override.run ?? {});
  const eligibleRows = override.rows ?? rows;
  return {
    rights: override.rights === undefined ? rights : override.rights,
    rows: eligibleRows,
    rowsArtifactSha256: override.rowsArtifactSha256 ?? sha256CanonicalJson(eligibleRows),
    classifierProfile: override.classifierProfile ?? profile,
    predictionRun: runArtifact,
    bootstrapReplicates: override.bootstrapReplicates ?? 200,
  };
}

describe("offline Luna public finance benchmark adapter", () => {
  it("blocks absent benchmark rights, rows, profile, or persisted run", () => {
    expect(evaluateLunaPublicBenchmark(null)).toMatchObject({ status: "BLOCKED" });
    expect(evaluateLunaPublicBenchmark(makeInput([], { rights: null }))).toMatchObject({ status: "BLOCKED" });
    expect(evaluateLunaPublicBenchmark(makeInput([], { rows: [] }))).toMatchObject({ status: "BLOCKED" });
    const noRun = { ...makeInput([]), predictionRun: null };
    expect(evaluateLunaPublicBenchmark(noRun)).toMatchObject({ status: "BLOCKED" });
  });

  it("verifies all canonical artifact digests and refuses tampered rights, rows, and run payloads", () => {
    const input = makeInput();
    expect(verifyLunaPublicBenchmarkArtifacts(input).ok).toBe(true);
    const changedRights = { ...rights, artifactSha256: sha("tampered rights digest") };
    expect(verifyLunaPublicBenchmarkArtifacts({ ...input, rights: changedRights }).issues.join(" ")).toMatch(/rights artifact SHA-256/);
    const changedRows = structuredClone(rows); changedRows[0]!.targetId = "tampered-target";
    expect(verifyLunaPublicBenchmarkArtifacts({ ...input, rows: changedRows }).issues.join(" ")).toMatch(/eligible row artifact SHA-256/);
    const changedRun = { ...(input.predictionRun as Record<string, unknown>), runId: "tampered-run" };
    expect(verifyLunaPublicBenchmarkArtifacts({ ...input, predictionRun: changedRun }).issues.join(" ")).toMatch(/prediction run SHA-256/);
  });

  it("binds request digests to the exact paragraph-target entity and frozen profile", () => {
    const good = makeInput();
    const wrongRequest = { ...prediction(rows[0]!, "negative"), requestSha256: sha("different request") };
    const requestReport = evaluateLunaPublicBenchmark(makeInput([wrongRequest]));
    expect(requestReport).toMatchObject({ status: "BLOCKED" });

    const wrongEntity = { ...prediction(rows[0]!, "negative"), entityId: "wrong-entity" };
    expect(evaluateLunaPublicBenchmark(makeInput([wrongEntity]))).toMatchObject({ status: "BLOCKED" });

    const badProfile = { ...profile, promptSha256: sha("other prompt") };
    expect(evaluateLunaPublicBenchmark({ ...good, classifierProfile: badProfile })).toMatchObject({ status: "BLOCKED" });
    expect(evaluateLunaPublicBenchmark(makeInput([], { run: { modelReturned: "other-model" } }))).toMatchObject({ status: "BLOCKED" });
    expect(evaluateLunaPublicBenchmark(makeInput([], { run: { profileSha256: sha("run uses another profile") } }))).toMatchObject({ status: "BLOCKED" });
  });

  it("counts missing, failed, invalid, and abstained predictions as uncovered errors", () => {
    const report = evaluateLunaPublicBenchmark(makeInput([
      prediction(rows[0]!, "negative"),
      prediction(rows[1]!, null, "abstained"),
      prediction(rows[2]!, "positive", "failed"),
      prediction(rows[3]!, "not-a-sentiment", "invalid"),
    ])) as any;
    expect(report.status).toBe("UNVERIFIED");
    expect(report.qualityPassAllowed).toBe(false);
    expect(report.denominators).toEqual({ selected: 4, missing: 0, failed: 1, invalid: 1, abstained: 1, scored: 1 });
    expect(report.sentiment.coverage).toBe(0.25);
    expect(report.sentiment.accuracyIncludingAbstentionsAsErrors).toBe(0.25);
    expect(report.sentiment.selectiveAccuracy).toBe(1);
    expect(report.sentiment.denominators.selected).toBe(4);
  });

  it("keeps absent run rows in the denominator and never reports overall quality PASS", () => {
    const report = evaluateLunaPublicBenchmark(makeInput([prediction(rows[0]!, "negative")])) as any;
    expect(report.denominators).toMatchObject({ selected: 4, missing: 3, scored: 1 });
    expect(report.sentiment.coverage).toBe(0.25);
    expect(report.sentiment.accuracyIncludingAbstentionsAsErrors).toBe(0.25);
    expect(report.status).toBe("UNVERIFIED");
    expect(report.qualityPassAllowed).toBe(false);
  });

  it("produces stable paragraph-cluster uncertainty and states its scope limits", () => {
    const input = makeInput([
      prediction(rows[0]!, "negative"), prediction(rows[1]!, null, "abstained"),
      prediction(rows[2]!, "positive"), prediction(rows[3]!, "unexpected-label"),
    ]);
    const first = evaluateLunaPublicBenchmark(input) as any;
    const second = evaluateLunaPublicBenchmark(input) as any;
    expect(first.uncertainty).toEqual(second.uncertainty);
    expect(first.uncertainty).toMatchObject({ clusterCount: 3, replicates: 200 });
    expect(first.limitations.join(" ")).toMatch(/citation entailment/);
    expect(first.limitations.join(" ")).toMatch(/unit, numeric correctness/);
    expect(first.evidence.providerCallsMadeByEvaluator).toBe(0);
  });

  it("recovers after missing input, accepts identical reruns, and rejects conflicting output bytes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "luna-public-benchmark-test-"));
    try {
      const input = makeInput();
      const evidence = {
        rights: input.rights,
        rows: { artifactSha256: input.rowsArtifactSha256, rows: input.rows },
        profile: input.classifierProfile,
        run: input.predictionRun,
      };
      const files = Object.fromEntries(Object.entries(evidence).map(([name, value]) => {
        const file = path.join(directory, `${name}.json`); writeFileSync(file, JSON.stringify(value)); return [name, file];
      }));
      const cli = path.resolve("scripts/luna-public-benchmark.ts");
      const outputPath = path.join(directory, "report.json");
      const args = [cli, "--rights", files.rights!, "--rows", files.rows!, "--profile", files.profile!, "--run", path.join(directory, "missing-run.json"), "--out", outputPath];
      const missing = spawnSync("node_modules/.bin/tsx", args, { cwd: process.cwd(), encoding: "utf8" });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/BLOCKED/);
      expect(existsSync(outputPath)).toBe(false);

      args[args.indexOf("--run") + 1] = files.run!;
      const valid = spawnSync("node_modules/.bin/tsx", args, { cwd: process.cwd(), encoding: "utf8" });
      expect(valid.status).toBe(2);
      const reportBytes = readFileSync(outputPath);
      expect(JSON.parse(reportBytes.toString("utf8"))).toMatchObject({ status: "UNVERIFIED", qualityPassAllowed: false });

      const identical = spawnSync("node_modules/.bin/tsx", args, { cwd: process.cwd(), encoding: "utf8" });
      expect(identical.status).toBe(2);
      expect(readFileSync(outputPath)).toEqual(reportBytes);

      const changedRun = makeRun(rows.map((item) => prediction(item, item.referenceSentiment === "negative" ? "positive" : item.referenceSentiment)));
      writeFileSync(files.run!, JSON.stringify(changedRun));
      const conflict = spawnSync("node_modules/.bin/tsx", args, { cwd: process.cwd(), encoding: "utf8" });
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toMatch(/new versioned --out path/);
      expect(readFileSync(outputPath)).toEqual(reportBytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
