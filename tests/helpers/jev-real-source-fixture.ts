import { createHash } from "node:crypto";
import { parseLabelSet, parseModelRun, sampleManifestSha256 } from "../../scripts/jev-label-evaluation.js";
import { EVENT_TYPES, RUBRIC_SHA } from "../../server/rubric.js";

const digest = "a".repeat(64);

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function wellSupportedFinalStudy(codeRevision = "1".repeat(40)) {
  const eventClasses = [...EVENT_TYPES];
  const items = Array.from({ length: 30 }, (_issuer, issuerIndex) => {
    const cik = String(issuerIndex + 100000).padStart(10, "0");
    return eventClasses.map((eventType, eventIndex) => {
      // Generated records exercise the issuer-scoped profile, not real filing correspondence.
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
    analysisCodeRevision: codeRevision,
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
    codeRevision,
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
