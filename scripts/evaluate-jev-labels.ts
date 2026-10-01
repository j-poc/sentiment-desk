import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeFinal,
  analyzePilot,
  type LabelSet,
  parseLabelSet,
  parseModelRun,
  sha256Bytes,
} from "./jev-label-evaluation.js";

function argumentsFrom(argv: string[]): { labelsPath: string; runPath?: string; outputPath?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") {
      console.log("Usage: npm run evaluate:jev-labels -- --labels <local-json> [--run <local-json>] [--out <report-json>]");
      console.log("Omit --run for a blinded label-only pilot. This command reads local JSON files and makes no network or model calls.");
      process.exit(0);
    }
    if (!["--labels", "--run", "--out"].includes(key ?? "")) throw new Error(`unsupported argument: ${key ?? "<missing>"}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a path`);
    if (values.has(key!)) throw new Error(`${key} may be supplied only once`);
    values.set(key!, value);
    index += 1;
  }
  const labelsPath = values.get("--labels");
  if (!labelsPath) throw new Error("--labels is required");
  return { labelsPath, runPath: values.get("--run"), outputPath: values.get("--out") };
}

function readJson(filePath: string): { bytes: Buffer; value: unknown } {
  const bytes = readFileSync(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
}

export function verifyFrozenCode(labels: LabelSet, cwd = process.cwd(), extraSources: string[] = []): void {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  if (revision !== labels.analysisCodeRevision) throw new Error("current HEAD differs from the code revision frozen with the labels");
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim();
  if (trackedChanges) throw new Error("tracked source tree is dirty; the frozen evaluation code must be run from a clean checkout");
  const untrackedFiles = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" })
    .split("\n")
    .filter((file) => /^(server|scripts|tests|web\/src)\//.test(file) || ["package.json", "tsconfig.json"].includes(file));
  if (untrackedFiles.length) throw new Error("untracked executable or test source exists; the frozen evaluation code must be committed first");
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["scripts/evaluate-jev-labels.ts", "scripts/jev-label-evaluation.ts", "server/rubric.ts", ...extraSources];
  if (labels.schemaVersion === 3 && labels.evaluationProfile === "sec_edgar_product24_diagnostic_v1") sources.push("config/companies.json");
  for (const relative of sources) {
    const sourceFile = path.resolve(sourceRoot, relative);
    const frozenFile = path.resolve(cwd, relative);
    if (!frozenFile.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error("frozen evaluator source path escapes its checkout");
    const sourceStat = lstatSync(sourceFile);
    const frozenStat = lstatSync(frozenFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !frozenStat.isFile() || frozenStat.isSymbolicLink() || !readFileSync(sourceFile).equals(readFileSync(frozenFile))) {
      throw new Error(`frozen evaluator source differs from the loaded source: ${relative}`);
    }
    const treeEntry = execFileSync("git", ["--no-replace-objects", "ls-tree", revision, "--", relative], { cwd, encoding: "utf8" });
    if (!/^(100644|100755) blob [0-9a-f]+\t/.test(treeEntry)) {
      throw new Error(`frozen evaluator source is absent from the code revision: ${relative}`);
    }
    const committedBytes = execFileSync("git", ["--no-replace-objects", "show", `${revision}:${relative}`], { cwd });
    if (!committedBytes.equals(readFileSync(frozenFile))) {
      throw new Error(`frozen evaluator source differs from the committed code revision: ${relative}`);
    }
  }
}

export function writeReportIdempotently(outputPath: string, output: string): "written" | "identical" {
  try {
    writeFileSync(outputPath, output, { flag: "wx" });
    return "written";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const stat = lstatSync(outputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("existing report path is not a regular file");
    if (!readFileSync(outputPath).equals(Buffer.from(output, "utf8"))) throw new Error("existing report differs from recomputed evidence; refusing to overwrite");
    return "identical";
  }
}

function main(): void {
  const args = argumentsFrom(process.argv.slice(2));
  const labelsFile = path.resolve(args.labelsPath);
  const labelArtifact = readJson(labelsFile);
  const labels = parseLabelSet(labelArtifact.value);
  verifyFrozenCode(labels);
  const labelsSha256 = sha256Bytes(labelArtifact.bytes);
  let report: Record<string, unknown>;
  if (args.runPath) {
    if (labels.stage !== "final") throw new Error("--run is permitted only for labels frozen as stage=final");
    const runFile = readJson(path.resolve(args.runPath));
    const run = parseModelRun(runFile.value);
    report = analyzeFinal({ labels, labelsSha256, run });
  } else {
    if (labels.stage !== "pilot") throw new Error("final labels require --run; only stage=pilot can be analyzed label-only");
    report = analyzePilot({ labels, labelsSha256 });
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) {
    const outputPath = path.resolve(args.outputPath);
    if (outputPath === labelsFile || outputPath === (args.runPath ? path.resolve(args.runPath) : "")) {
      throw new Error("report output must not overwrite a frozen input artifact");
    }
    const writeResult = writeReportIdempotently(outputPath, output);
    console.log(JSON.stringify({ result: writeResult === "written" ? "REPORT_WRITTEN" : "REPORT_ALREADY_IDENTICAL", mode: report.mode, status: report.status ?? "PILOT_DESCRIPTIVE", outputPath }));
  } else {
    process.stdout.write(output);
  }
  if (report.status === "FAIL" || report.status === "UNVERIFIED") process.exitCode = 2;
}

export function isDirectScriptInvocation(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectScriptInvocation(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid evaluation input";
    console.error(JSON.stringify({ result: "INVALID_OR_UNVERIFIED_INPUT", message }));
    process.exitCode = 2;
  }
}
