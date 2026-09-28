import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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

function verifyFrozenCode(labels: LabelSet): void {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== labels.analysisCodeRevision) throw new Error("current HEAD differs from the code revision frozen with the labels");
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  if (trackedChanges) throw new Error("tracked source tree is dirty; the frozen evaluation code must be run from a clean checkout");
  const untrackedFiles = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /^(server|scripts|tests|web\/src)\//.test(file) || ["package.json", "tsconfig.json"].includes(file));
  if (untrackedFiles.length) throw new Error("untracked executable or test source exists; the frozen evaluation code must be committed first");
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
    writeFileSync(outputPath, output, { flag: "wx" });
    console.log(JSON.stringify({ result: "REPORT_WRITTEN", mode: report.mode, status: report.status ?? "PILOT_DESCRIPTIVE", outputPath }));
  } else {
    process.stdout.write(output);
  }
  if (report.status === "FAIL" || report.status === "UNVERIFIED") process.exitCode = 2;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid evaluation input";
  console.error(JSON.stringify({ result: "INVALID_OR_UNVERIFIED_INPUT", message }));
  process.exitCode = 2;
}
