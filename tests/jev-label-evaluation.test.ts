import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
    schemaVersion: 2 as const,
    stage,
    studyId: "sec-jev-pilot-2026-09",
    source: "sec_edgar" as const,
    evaluationProfile: "sec_edgar_scoped_standard_v1" as const,
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

function agentLabelsFor(stage: "pilot" | "final" = "pilot") {
  const humanArtifact = labelsFor(stage);
  return {
    ...humanArtifact,
    schemaVersion: 3 as const,
    reviewers: ["agent-a", "agent-b"].map((id, index) => ({
      id,
      kind: "independent_subagent" as const,
      agentThreadId: `thread-${id}`,
      configuredModel: "gpt-6-luna",
      resolvedModel: null,
      modelResolutionEvidence: null,
      independenceAttested: true as const,
      blindedToJevOutputsAttested: true as const,
    })),
    agentLabelProtocol: {
      version: "independent-subagents-blinded-v1" as const,
      frozenAt: humanArtifact.frozenAt,
      jevOutputsOpenedAt: "2026-09-04T10:00:00.000Z",
    },
    items: humanArtifact.items.map((item) => ({
      ...item,
      reviews: item.reviews.map((review, index) => ({ ...review, reviewerId: index === 0 ? "agent-a" : "agent-b" })),
    })),
  };
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function product24AgentStudy() {
  const study = wellSupportedFinalStudy();
  const companyIds = ((JSON.parse(readFileSync(new URL("../config/companies.json", import.meta.url), "utf8")) as { companies: Array<{ id: string }> }).companies.map(({ id }) => id)).sort();
  const artifact = {
    ...study.labelArtifact,
    schemaVersion: 3 as const,
    evaluationProfile: "sec_edgar_product24_diagnostic_v1" as const,
    productCompanyUniverseSha256: digestJson(companyIds),
    reviewers: ["agent-a", "agent-b"].map((id) => ({
      id,
      kind: "independent_subagent" as const,
      agentThreadId: `thread-${id}`,
      configuredModel: "gpt-6-luna",
      resolvedModel: null,
      modelResolutionEvidence: null,
      independenceAttested: true as const,
      blindedToJevOutputsAttested: true as const,
    })),
    agentLabelProtocol: {
      version: "independent-subagents-blinded-v1" as const,
      frozenAt: study.labelArtifact.frozenAt,
      jevOutputsOpenedAt: study.run.startedAt,
    },
    populationFrame: study.labelArtifact.populationFrame.map((item, index) => ({ ...item, companyId: companyIds[index % 8]! })),
    items: study.labelArtifact.items.map((item, index) => ({
      ...item,
      companyId: companyIds[index % 8]!,
      reviews: item.reviews.map((review, reviewerIndex) => ({ ...review, reviewerId: reviewerIndex === 0 ? "agent-a" : "agent-b" })),
    })),
  };
  artifact.populationFrameSha256 = sampleManifestSha256(artifact.populationFrame);
  artifact.sampleManifestSha256 = sampleManifestSha256(artifact.items);
  const labels = parseLabelSet(artifact);
  const labelsSha256 = digestJson(artifact);
  const run = parseModelRun({ ...study.run, labelsSha256, sampleManifestSha256: artifact.sampleManifestSha256 });
  return { artifact, labels, labelsSha256, run };
}

function wellSupportedFinalStudy() {
  const eventClasses = [...EVENT_TYPES];
  const items = Array.from({ length: 30 }, (_issuer, issuerIndex) => {
    const cik = String(issuerIndex + 100000).padStart(10, "0");
    return eventClasses.map((eventType, eventIndex) => {
      // This fixture models the actual issuer-scoped SEC profile, which never
      // enters the ambiguous-identity strictAbout branch.
      const strictAbout = false;
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
    schemaVersion: 2 as const,
    stage: "final" as const,
    studyId: "frozen-test-study",
    source: "sec_edgar" as const,
    evaluationProfile: "sec_edgar_scoped_standard_v1" as const,
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
  it("preserves human schema v2 and reports v3 labels as agent agreement only", () => {
    const historical = labelsFor();
    expect(parseLabelSet(historical).schemaVersion).toBe(2);

    const artifact = agentLabelsFor();
    const labels = parseLabelSet(artifact);
    const report = analyzePilot({ labels, labelsSha256: digestJson(artifact) });

    expect(report).toMatchObject({
      mode: "agent-label-agreement-pilot",
      labelAuthority: "independent_subagents",
      humanGroundTruth: "NOT_PROVIDED",
      statisticalCertification: "UNVERIFIED",
    });
    expect(report).toHaveProperty("rawAgentAgreement.sentiment");
    expect(report).not.toHaveProperty("agreement");
    expect(JSON.stringify(report)).not.toContain("qualifiedHumanAttested");
  });

  it("rejects duplicate agent identities and chronology that opens Jev outputs before freeze", () => {
    const artifact = agentLabelsFor();
    expect(() => parseLabelSet({ ...artifact, reviewers: [artifact.reviewers[0], { ...artifact.reviewers[1], agentThreadId: artifact.reviewers[0]!.agentThreadId }] })).toThrow(/distinct thread identities/i);
    expect(() => parseLabelSet({ ...artifact, agentLabelProtocol: { ...artifact.agentLabelProtocol, jevOutputsOpenedAt: "2026-09-02T10:00:00.000Z" } })).toThrow(/cannot be opened before/i);
    expect(() => parseLabelSet({ ...artifact, reviewers: artifact.reviewers.map(({ independenceAttested: _independenceAttested, ...reviewer }) => reviewer) })).toThrow();
  });

  it("retains unsupported agent-label fields as abstentions with explicit denominators", () => {
    const artifact = agentLabelsFor();
    (artifact.items[0]!.reviews[0]!.labels as any).about = null;
    artifact.items[0]!.reviews[0]!.rationale = "The filing text does not support a reliable about-company classification.";
    const report = analyzePilot({ labels: parseLabelSet(artifact), labelsSha256: digestJson(artifact) });

    expect(report).toMatchObject({ itemCount: 1, unresolvedLabelFields: [{ observationId: "obs-1", field: "about" }] });
    expect(report.rawAgentAgreement).toMatchObject({ about: { selectedCases: 1, resolvedPairCount: 0, rate: null } });
  });

  it("keeps final agent comparisons separate from human classifier quality", () => {
    const study = wellSupportedFinalStudy();
    const artifact = {
      ...study.labelArtifact,
      schemaVersion: 3 as const,
      reviewers: ["agent-a", "agent-b"].map((id) => ({
        id,
        kind: "independent_subagent" as const,
        agentThreadId: `thread-${id}`,
        configuredModel: "gpt-6-luna",
        resolvedModel: null,
        modelResolutionEvidence: null,
        independenceAttested: true as const,
        blindedToJevOutputsAttested: true as const,
      })),
      agentLabelProtocol: {
        version: "independent-subagents-blinded-v1" as const,
        frozenAt: study.labelArtifact.frozenAt,
        jevOutputsOpenedAt: study.run.startedAt,
      },
      items: study.labelArtifact.items.map((item) => ({
        ...item,
        reviews: item.reviews.map((review, reviewerIndex) => ({ ...review, reviewerId: reviewerIndex === 0 ? "agent-a" : "agent-b" })),
      })),
    };
    const labels = parseLabelSet(artifact);
    const labelsSha256 = digestJson(artifact);
    const run = parseModelRun({ ...study.run, labelsSha256 });
    const report = analyzeFinal({ labels, labelsSha256, run });

    expect(report).toMatchObject({
      mode: "final-agent-agreement-evaluation",
      labelAuthority: "independent_subagents",
      humanGroundTruth: "NOT_PROVIDED",
      statisticalCertification: "UNVERIFIED",
    });
    expect(report.agentAgreement.sentiment.metrics.exactAgreement).toBe(1);
    expect(report.gates.statisticalCertification.status).toBe("UNVERIFIED");
    expect(JSON.stringify(report)).not.toContain("qualifiedHumanAttested");
  });

  it("runs the bounded product24 diagnostic with its own thresholds and statistical status", () => {
    const study = product24AgentStudy();
    const report = analyzeFinal({ labels: study.labels, labelsSha256: study.labelsSha256, run: study.run });

    expect(report).toMatchObject({
      mode: "final-agent-agreement-evaluation",
      status: "PASS",
      agentReferenceAgreementStatus: "PASS",
      provenanceExecutionStatus: "PASS",
      statisticalCertification: "UNVERIFIED",
      humanGroundTruth: "NOT_PROVIDED",
    });
    expect(report).toMatchObject({ selectedCaseDenominator: study.artifact.items.length, resolvedReferenceCaseDenominator: study.artifact.items.length, configuredCompanySupport: 8 });
    expect(report.agentAgreement.untestedEventTypes).toEqual([]);
    expect(report.agentAgreement.rawAgentAgreement.sentiment.rate).toBe(1);
  });

  it("keeps unresolved dimensions in the product24 sample and reports their metric exclusions", () => {
    const study = product24AgentStudy();
    (study.artifact.items[0]!.reviews[0]!.labels as any).about = null;
    const labels = parseLabelSet(study.artifact);
    const labelsSha256 = digestJson(study.artifact);
    const run = parseModelRun({ ...study.run, labelsSha256 });
    const report = analyzeFinal({ labels, labelsSha256, run });

    expect(report.selectedCaseDenominator).toBe(study.artifact.items.length);
    expect(report.unresolvedLabelFieldDenominator).toBeGreaterThan(0);
    expect(report.agentAgreement.unresolvedLabels).toContainEqual({ observationId: study.artifact.items[0]!.observationId, field: "about" });
    expect(report.agentAgreement.aboutInclusion).toMatchObject({ selectedCases: study.artifact.items.length, resolvedReferenceCases: study.artifact.items.length - 1 });
  });

  it("requires the product24 diagnostic sample to come from the configured universe and meet minimum support", () => {
    const study = product24AgentStudy();
    expect(() => parseLabelSet({ ...study.artifact, productCompanyUniverseSha256: "0".repeat(64) })).toThrow(/does not bind the current configured company universe/i);
    expect(() => parseLabelSet({ ...study.artifact, items: study.artifact.items.slice(0, 29), sampleManifestSha256: sampleManifestSha256(study.artifact.items.slice(0, 29)), populationFrame: study.artifact.populationFrame.slice(0, 29), populationFrameSha256: sampleManifestSha256(study.artifact.populationFrame.slice(0, 29)), samplePlan: [{ filingType: "8-K", acceptanceQuarter: "2026-Q3", eligibleCount: 29, sampleCount: 29 }] })).toThrow(/at least 30 cases across at least 8/i);
  });

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
    expect(report.inclusionBoundaries.about.overall.cutoffCounts).toEqual({ "0.5": 240 });
    expect(report.inclusionBoundaries.about.standard.falseInclusionRate).toBe(0);
    expect(report.pathApplicability).toEqual({ standard: "IN_SCOPE", strictIdentity: "OUT_OF_SCOPE" });
    expect(report.inclusionBoundaries.about.strictIdentity.status).toBe("NOT_APPLICABLE");
    expect(report.gates.aboutStandardPrecision.status).toBe("PASS");
    expect(report.gates.aboutStrictIdentityPrecision.status).toBe("NOT_APPLICABLE");
    expect(report.gates.investorRelevantStandardPrecision.status).toBe("PASS");
    expect(report.gates.investorRelevantStrictIdentityPrecision.status).toBe("NOT_APPLICABLE");
    expect(report.gates.evaluationBudget.status).toBe("PASS");
    expect(report.provenance.modelRunSha256).toBe(digestJson(study.run));
  });

  it("rejects strict identity labels from the SEC issuer-scoped evaluation profile", () => {
    const raw = labelsFor("final");
    const strictPopulation = { ...raw, populationFrame: raw.populationFrame.map((item, index) => index === 0 ? { ...item, strictAbout: true } : item) };
    const strictSample = { ...raw, items: raw.items.map((item) => ({ ...item, strictAbout: true })) };

    expect(() => parseLabelSet(strictPopulation)).toThrow(/does not exercise the strict identity path/i);
    expect(() => parseLabelSet(strictSample)).toThrow(/does not exercise the strict identity path/i);
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
