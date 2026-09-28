import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeFinal,
  analyzePilot,
  classificationMetrics,
  jevRequestPayloadSha256,
  parseLabelSet,
  parseModelRun,
  sampleManifestSha256,
} from "../scripts/jev-label-evaluation.js";
import { EVENT_TYPES, RUBRIC_SHA } from "../server/rubric.js";

const digest = "a".repeat(64);
const provenance = {
  observationId: "obs-1",
  companyId: "apple",
  strictAbout: false,
  collectorVersion: "sec-edgar-collector/1.0.0",
  parserVersion: "sec-edgar-parser/1.0.0",
  cik: "0000320193",
  accession: "0000320193-26-000001",
  filingType: "8-K",
  filingAt: "2026-09-01T12:00:00.000Z",
  acceptedAt: "2026-09-01T12:01:00.000Z",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260831.htm",
  excerptSha256: digest,
  jevInputSha256: "b".repeat(64),
};

function labelsFor(stage: "pilot" | "final" = "pilot") {
  const item = {
    ...provenance,
    reviews: [
      {
        reviewerId: "reviewer-a",
        labels: { about: true, investorRelevant: true, sentiment: "positive", eventType: "product" },
        rationale: "The filing describes a material business launch.",
      },
      {
        reviewerId: "reviewer-b",
        labels: { about: true, investorRelevant: true, sentiment: "positive", eventType: "product" },
        rationale: "The filing reports a company product event.",
      },
    ],
  };
  const items = [item];
  const sampledRank = (seed: number, observationId: string) => digestJson(`${seed}:${observationId}`);
  let secondObservationId = "unselected-obs-2";
  while (sampledRank(481516, secondObservationId) < sampledRank(481516, provenance.observationId)) {
    secondObservationId = `${secondObservationId}-x`;
  }
  const populationFrame = [
    items.map(({ reviews: _reviews, ...row }) => row)[0]!,
    {
      ...provenance,
      observationId: secondObservationId,
      accession: "0000320193-26-000002",
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000002/aapl-20260831.htm",
      excerptSha256: "c".repeat(64),
      jevInputSha256: "d".repeat(64),
    },
  ];
  return {
    schemaVersion: 1 as const,
    stage,
    studyId: "sec-jev-pilot-2026-09",
    source: "sec_edgar" as const,
    sampleSeed: 481516,
    samplingWindowStart: "2026-08-01T00:00:00.000Z",
    samplingWindowEnd: "2026-09-02T00:00:00.000Z",
    sampledAt: "2026-09-02T10:00:00.000Z",
    frozenAt: "2026-09-03T10:00:00.000Z",
    analysisCodeRevision: "1".repeat(40),
    analysisCodeDirty: false as const,
    rubricSha256: RUBRIC_SHA,
    populationFrameSha256: sampleManifestSha256(populationFrame),
    evaluationBudget: {
      maxRequests: 2,
      maxEstimatedCostUsd: 0.01,
      inputPricePerMTokUsd: 0.042,
      outputPricePerMTokUsd: 0.1,
      accountOwnerApproval: {
        attested: true as const,
        approvedAt: "2026-09-03T09:00:00.000Z",
        approvalRecordSha256: digest,
      },
    },
    populationFrame,
    samplePlan: [{ filingType: "8-K", acceptanceQuarter: "2026-Q3", eligibleCount: 2, sampleCount: 1 }],
    sampleManifestSha256: sampleManifestSha256(items),
    reviewers: [
      { id: "reviewer-a", qualifiedHumanAttested: true },
      { id: "reviewer-b", qualifiedHumanAttested: true },
    ],
    items,
  };
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function wellSupportedFinalStudy() {
  const eventClasses = [...EVENT_TYPES];
  const items = Array.from({ length: 30 }, (_issuer, issuerIndex) => {
    const cik = String(issuerIndex + 100000).padStart(10, "0");
    return eventClasses.map((eventType, eventIndex) => {
      const strictAbout = issuerIndex < 10 && eventIndex < 2;
      const accession = `${cik}-26-${String(eventIndex + 1).padStart(6, "0")}`;
      const labels = {
        about: strictAbout ? eventIndex === 0 : (issuerIndex + eventIndex) % 2 === 0,
        investorRelevant: strictAbout ? eventIndex === 1 : (issuerIndex + eventIndex) % 3 === 0,
        sentiment: (issuerIndex % 3 === 0 ? "negative" : issuerIndex % 3 === 1 ? "neutral" : "positive") as "negative" | "neutral" | "positive",
        eventType,
      };
      const row = {
        observationId: `obs-${issuerIndex}-${eventIndex}`,
        companyId: `issuer-${issuerIndex}`,
        strictAbout,
        collectorVersion: "sec-edgar-collector/1.0.0",
        parserVersion: "sec-edgar-parser/1.0.0",
        cik,
        accession,
        filingType: "8-K",
        filingAt: "2026-09-01T12:00:00.000Z",
        acceptedAt: "2026-09-01T12:01:00.000Z",
        sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/filing.htm`,
        excerptSha256: digest,
        jevInputSha256: "b".repeat(64),
        reviews: [
          { reviewerId: "reviewer-a", labels, rationale: "The filing contains evidence supporting these company-level labels." },
          { reviewerId: "reviewer-b", labels, rationale: "The filing contains evidence supporting these company-level labels." },
        ],
      };
      return row;
    });
  }).flat();
  const populationFrame = items.map(({ reviews: _reviews, ...row }) => row);
  const labelArtifact = {
    schemaVersion: 1 as const,
    stage: "final" as const,
    studyId: "frozen-test-study",
    source: "sec_edgar" as const,
    sampleSeed: 481516,
    samplingWindowStart: "2026-08-01T00:00:00.000Z",
    samplingWindowEnd: "2026-09-02T00:00:00.000Z",
    sampledAt: "2026-09-02T10:00:00.000Z",
    frozenAt: "2026-09-03T10:00:00.000Z",
    analysisCodeRevision: "1".repeat(40),
    analysisCodeDirty: false as const,
    rubricSha256: RUBRIC_SHA,
    populationFrameSha256: sampleManifestSha256(populationFrame),
    evaluationBudget: {
      maxRequests: items.length,
      maxEstimatedCostUsd: 0.01,
      inputPricePerMTokUsd: 0.042,
      outputPricePerMTokUsd: 0.1,
      accountOwnerApproval: {
        attested: true as const,
        approvedAt: "2026-09-03T09:00:00.000Z",
        approvalRecordSha256: digest,
      },
    },
    populationFrame,
    samplePlan: [{ filingType: "8-K", acceptanceQuarter: "2026-Q3", eligibleCount: items.length, sampleCount: items.length }],
    sampleManifestSha256: sampleManifestSha256(items),
    reviewers: [
      { id: "reviewer-a", qualifiedHumanAttested: true as const },
      { id: "reviewer-b", qualifiedHumanAttested: true as const },
    ],
    items,
  };
  const labels = parseLabelSet(labelArtifact);
  const labelsSha256 = digestJson(labelArtifact);
  const modelItems = items.map((item) => {
    const sentiment = item.reviews[0]!.labels.sentiment;
    const sentimentProbabilities = { negative: 0.01, neutral: 0.01, positive: 0.01 };
    sentimentProbabilities[sentiment] = 0.98;
    return {
      observationId: item.observationId,
      terminalStatus: item.reviews[0]!.labels.about ? "scored" as const : "off_target" as const,
      score: {
        sentiment,
        eventType: item.reviews[0]!.labels.eventType,
        about: item.reviews[0]!.labels.about ? 0.91 : 0.12,
        investorRelevant: item.reviews[0]!.labels.investorRelevant ? 0.88 : 0.14,
        sentimentProbabilities,
        resolvedModel: "jev-1.13.0",
        rubricSha256: RUBRIC_SHA,
      },
      attempts: [{ outcome: "response" as const, submitted: true, payloadSha256: item.jevInputSha256, statusCode: 200, inputTokens: 100, outputTokens: 20, latencyMs: 100, usageReconciled: true }],
    };
  });
  const run = parseModelRun({
    runId: "final-test-run",
    studyId: labelArtifact.studyId,
    labelsSha256,
    sampleManifestSha256: labelArtifact.sampleManifestSha256,
    rubricSha256: RUBRIC_SHA,
    codeRevision: "1".repeat(40),
    sourceTreeDirty: false as const,
    requestedModel: "jev-latest",
    startedAt: "2026-09-04T10:00:00.000Z",
    requestCount: modelItems.length,
    inputPricePerMTokUsd: 0.042,
    outputPricePerMTokUsd: 0.1,
    items: modelItems,
  });
  return { labels, labelsSha256, run, labelArtifact };
}

describe("offline real-source Jev label analysis", () => {
  it("computes a confusion matrix with missing judgments counted as misses", () => {
    const result = classificationMetrics({
      labels: ["positive", "negative", "positive", "neutral"],
      predictions: ["positive", "positive", null, "neutral"],
      classes: ["positive", "neutral", "negative"],
    });

    expect(result.matrix).toEqual({
      positive: { positive: 1, neutral: 0, negative: 0, missing: 1 },
      neutral: { positive: 0, neutral: 1, negative: 0, missing: 0 },
      negative: { positive: 1, neutral: 0, negative: 0, missing: 0 },
    });
    expect(result.exactAgreement).toBe(0.5);
    expect(result.perClass.positive).toMatchObject({ support: 2, predicted: 2, precision: 0.5, recall: 0.5, f1: 0.5 });
  });

  it("reports blinded pilot reviewer agreement and class prevalence without model fields", () => {
    const raw = labelsFor();
    const labels = parseLabelSet(raw);
    const report = analyzePilot({ labels, labelsSha256: digestJson(raw) });

    expect(report).toMatchObject({
      mode: "label-only-pilot",
      studyId: "sec-jev-pilot-2026-09",
      itemCount: 1,
      issuerClusterCount: 1,
      agreement: {
        sentiment: { exactCount: 1, total: 1, rate: 1 },
        eventType: { exactCount: 1, total: 1, rate: 1 },
      },
    });
    expect(JSON.stringify(report)).not.toContain("The filing describes a material business launch.");
    expect(() => parseLabelSet({ ...raw, jevResults: [] })).toThrow();
  });

  it("rejects a sample manifest digest that does not bind the provenance rows", () => {
    const raw = { ...labelsFor(), sampleManifestSha256: "0".repeat(64) };
    expect(() => parseLabelSet(raw)).toThrow(/manifest/i);
  });

  it("rejects a selected item that is not the deterministic stratified sample for the frozen seed", () => {
    const raw = labelsFor();
    let changedSeed = raw.sampleSeed + 1;
    const rank = (seed: number, observationId: string) => digestJson(`${seed}:${observationId}`);
    while (rank(changedSeed, raw.populationFrame[1]!.observationId) >= rank(changedSeed, raw.items[0]!.observationId)) changedSeed += 1;
    expect(() => parseLabelSet({ ...raw, sampleSeed: changedSeed })).toThrow(/deterministic stratified selection/i);
  });

  it("requires collector and parser versions on every frozen population observation", () => {
    const raw = labelsFor();
    const populationFrame = raw.populationFrame.map((row, index) => index === 0 ? { ...row, parserVersion: undefined } : row);
    expect(() => parseLabelSet({ ...raw, populationFrame })).toThrow(/parserVersion/i);
  });

  it("fails the final sampling gate when a declared eligible source/time stratum has no selected cases", () => {
    const study = wellSupportedFinalStudy();
    const omitted = {
      ...study.labels.populationFrame[0]!,
      observationId: "eligible-but-not-selected",
      accession: "0010000000-26-000009",
      filingType: "10-K",
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/100000/001000000026000009/filing.htm",
    };
    const populationFrame = [...study.labels.populationFrame, omitted];
    const rawLabels = {
      ...study.labels,
      populationFrame,
      populationFrameSha256: sampleManifestSha256(populationFrame),
      samplePlan: [...study.labels.samplePlan, { filingType: "10-K", acceptanceQuarter: "2026-Q3", eligibleCount: 1, sampleCount: 0 }],
    };
    const labels = parseLabelSet(rawLabels);
    const labelsSha256 = digestJson(rawLabels);
    const run = parseModelRun({ ...study.run, labelsSha256 });
    const report = analyzeFinal({ labels, labelsSha256, run });

    expect(report.gates.samplingFrameCoverage.status).toBe("FAIL");
    expect(report.sampling.strata.at(-1).statusCounts.missing).toBe(0);
    expect(report.status).toBe("FAIL");
  });

  it("refuses to join a final Jev run to changed labels, rubric, or source excerpts", () => {
    const rawLabels = labelsFor("final");
    const labels = parseLabelSet(rawLabels);
    const run = parseModelRun({
      runId: "run-1",
      studyId: rawLabels.studyId,
      labelsSha256: digestJson(rawLabels),
      sampleManifestSha256: rawLabels.sampleManifestSha256,
      rubricSha256: RUBRIC_SHA,
      codeRevision: "1".repeat(40),
      sourceTreeDirty: false as const,
      requestedModel: "jev-latest",
      startedAt: "2026-09-04T10:00:00.000Z",
      items: [],
    });

    expect(() => analyzeFinal({ labels, labelsSha256: "2".repeat(64), run })).toThrow(/label digest/i);
  });

  it("does not call an uncovered event class a passing Jev evaluation", () => {
    expect(EVENT_TYPES).toContain("other");
    const raw = labelsFor("final");
    const labels = parseLabelSet(raw);
    const run = parseModelRun({
      runId: "run-1",
      studyId: raw.studyId,
      labelsSha256: digestJson(raw),
      sampleManifestSha256: raw.sampleManifestSha256,
      rubricSha256: RUBRIC_SHA,
      codeRevision: "1".repeat(40),
      sourceTreeDirty: false as const,
      requestedModel: "jev-latest",
      startedAt: "2026-09-04T10:00:00.000Z",
      items: [],
    });
    const report = analyzeFinal({ labels, labelsSha256: digestJson(raw), run });

    expect(report.status).toBe("FAIL");
    expect(report.gates.eventTypeCoverage.status).toBe("UNVERIFIED");
  });

  it("passes the frozen gates on a well-supported, issuer-clustered final fixture", () => {
    const study = wellSupportedFinalStudy();
    const report = analyzeFinal(study);

    expect(report.status).toBe("PASS");
    expect(report.sentiment.metrics.macroF1).toBe(1);
    expect(report.eventType.metrics.macroF1).toBe(1);
    expect(report.operations.requestCount).toBe(240);
    expect(report.operations.estimatedCostUsd).toBeCloseTo(0.001488, 10);
    expect(report.calibration.status).toBe("DESCRIPTIVE_ONLY");
    expect(report.gates.eventTypeCoverage.status).toBe("PASS");
    expect(report.inclusionBoundaries.about.overall.cutoffCounts).toEqual({ "0.5": 220, "0.8": 20 });
    expect(report.inclusionBoundaries.about.standard.falseInclusionRate).toBe(0);
    expect(report.inclusionBoundaries.about.strictIdentity.falseExclusionRate).toBe(0);
    expect(report.gates.aboutStandardPrecision.status).toBe("PASS");
    expect(report.gates.aboutStrictIdentityPrecision.status).toBe("PASS");
    expect(report.gates.investorRelevantStandardPrecision.status).toBe("PASS");
    expect(report.gates.investorRelevantStrictIdentityPrecision.status).toBe("PASS");
    expect(report.gates.evaluationBudget.status).toBe("PASS");
    expect(report.provenance.modelRunSha256).toBe(digestJson(study.run));
  });

  it("does not let strong standard-path performance hide strict-identity false inclusions", () => {
    const study = wellSupportedFinalStudy();
    const labelsById = new Map(study.labels.items.map((item) => [item.observationId, item]));
    const run = parseModelRun({
      ...study.run,
      items: study.run.items.map((item) => {
        const label = labelsById.get(item.observationId)!;
        if (!label.strictAbout || label.reviews[0]!.labels.about) return item;
        return { ...item, score: { ...item.score!, about: 0.91 } };
      }),
    });
    const report = analyzeFinal({ ...study, run });

    expect(report.inclusionBoundaries.about.overall.precision).toBeGreaterThan(0.9);
    expect(report.inclusionBoundaries.about.strictIdentity.precision).toBe(0.5);
    expect(report.gates.aboutStrictIdentityPrecision.status).toBe("FAIL");
    expect(report.status).toBe("FAIL");
  });

  it("fails when estimated provider cost exceeds the pre-frozen approved ceiling", () => {
    const study = wellSupportedFinalStudy();
    const labelArtifact = {
      ...study.labelArtifact,
      evaluationBudget: { ...study.labelArtifact.evaluationBudget, maxEstimatedCostUsd: 0.00001 },
    };
    const labels = parseLabelSet(labelArtifact);
    const labelsSha256 = digestJson(labelArtifact);
    const run = parseModelRun({ ...study.run, labelsSha256 });
    const report = analyzeFinal({ labels, labelsSha256, run });

    expect(report.operations.estimatedCostUsd).toBeGreaterThan(labelArtifact.evaluationBudget.maxEstimatedCostUsd);
    expect(report.gates.evaluationBudget.status).toBe("FAIL");
    expect(report.status).toBe("FAIL");
  });

  it("fails when submitted request count exceeds the frozen ceiling", () => {
    const study = wellSupportedFinalStudy();
    const unexpected = { ...study.run.items[0]!, observationId: "unexpected-extra-call" };
    const run = parseModelRun({
      ...study.run,
      requestCount: study.run.requestCount! + 1,
      items: [...study.run.items, unexpected],
    });
    const report = analyzeFinal({ ...study, run });

    expect(report.gates.evaluationBudget.status).toBe("FAIL");
    expect(report.gates.evaluationBudget.reason).toMatch(/request ceiling/i);
  });

  it("cannot pass if the Jev run omits or changes frozen approved pricing", () => {
    const study = wellSupportedFinalStudy();
    const missingPrice = parseModelRun({ ...study.run, inputPricePerMTokUsd: undefined });
    expect(analyzeFinal({ ...study, run: missingPrice }).gates.evaluationBudget.status).toBe("FAIL");
    const changedPrice = parseModelRun({ ...study.run, inputPricePerMTokUsd: 0.001 });
    expect(analyzeFinal({ ...study, run: changedPrice }).gates.evaluationBudget.status).toBe("FAIL");
  });

  it("keeps approved-cost compliance unverified when provider token usage is missing", () => {
    const study = wellSupportedFinalStudy();
    const run = parseModelRun({
      ...study.run,
      items: study.run.items.map((item, index) => index === 0 ? {
        ...item,
        attempts: [{ ...item.attempts[0]!, inputTokens: null }],
      } : item),
    });
    const report = analyzeFinal({ ...study, run });

    expect(report.operations.estimatedCostUsd).toBeNull();
    expect(report.gates.evaluationBudget.status).toBe("UNVERIFIED");
    expect(report.status).toBe("UNVERIFIED");
  });

  it.each([
    ["two successful responses", (first: any) => [first, { ...first }]],
    ["a response after an HTTP 401", (first: any) => [
      { ...first, outcome: "rejected", statusCode: 401, inputTokens: null, outputTokens: null },
      first,
    ]],
  ])("rejects duplicate provider submissions after %s", (_caseName, makeAttempts) => {
    const study = wellSupportedFinalStudy();
    const first = study.run.items[0]!.attempts[0]!;
    const attempts = makeAttempts(first);
    const run = {
      ...study.run,
      requestCount: study.run.requestCount! + 1,
      items: study.run.items.map((item, index) => index === 0 ? { ...item, attempts } : item),
    };
    expect(() => parseModelRun(run)).toThrow(/duplicate submitted provider request/i);
  });

  it("rejects a run that retries after an outcome-unknown submission", () => {
    expect(() => parseModelRun({
      runId: "run-unsafe",
      studyId: "frozen-test-study",
      labelsSha256: digest,
      sampleManifestSha256: digest,
      rubricSha256: RUBRIC_SHA,
      codeRevision: "1".repeat(40),
      sourceTreeDirty: false as const,
      requestedModel: "jev-latest",
      startedAt: "2026-09-04T10:00:00.000Z",
      items: [{
        observationId: "obs-1",
        terminalStatus: "failed",
        score: null,
        attempts: [
          { outcome: "unknown", submitted: true, payloadSha256: digest, statusCode: null, inputTokens: null, outputTokens: null, latencyMs: 1000, usageReconciled: false },
          { outcome: "response", submitted: true, payloadSha256: digest, statusCode: 200, inputTokens: 100, outputTokens: 20, latencyMs: 100, usageReconciled: true },
        ],
      }],
    })).toThrow(/unsafe resubmission/i);
  });

  it("fails the run gate for an outcome-unknown request without provider-usage reconciliation", () => {
    const study = wellSupportedFinalStudy();
    const first = study.run.items[0]!;
    const items = study.run.items.map((item, index) => index === 0 ? {
      ...item,
      terminalStatus: "failed" as const,
      score: null,
      attempts: [{ outcome: "unknown" as const, submitted: true, payloadSha256: first.attempts[0]!.payloadSha256, statusCode: null, inputTokens: null, outputTokens: null, latencyMs: 1000, usageReconciled: false }],
    } : item);
    const run = parseModelRun({ ...study.run, items, requestCount: items.length });
    const report = analyzeFinal({ ...study, run });

    expect(report.gates.requestSafety.status).toBe("FAIL");
    expect(report.operations.unknownOutcomeCount).toBe(1);
    expect(report.operations.estimatedCostUsd).toBeNull();
  });

  it("binds a final model response to the frozen Jev request body digest", () => {
    const state = { company: { id: "apple" }, mention: { title: "Filing headline" } };
    expect(jevRequestPayloadSha256("jev-latest", state, { sentiment: { type: "choice" } })).toBe(digestJson({
      model: "jev-latest",
      state,
      questions: { sentiment: { type: "choice" } },
    }));

    const study = wellSupportedFinalStudy();
    const mismatchedRun = parseModelRun({
      ...study.run,
      items: study.run.items.map((item, index) => index === 0 ? {
        ...item,
        attempts: item.attempts.map((attempt) => ({ ...attempt, payloadSha256: digest })),
      } : item),
    });
    expect(() => analyzeFinal({ ...study, run: mismatchedRun })).toThrow(/frozen input/i);
  });
});
