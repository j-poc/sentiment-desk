import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LUNA_DIAGNOSTIC_PROFILE,
  LUNA_PROFILE_VERSION,
  PRODUCT_COMPANY_UNIVERSE_SHA256,
  analyzeLunaFinal,
  analyzeLunaPilot,
  lunaLabelSetV1Schema,
  parseLunaLabelSet,
  parseLunaModelRun,
  sampleManifestSha256,
  selectLunaSample,
  sha256Bytes,
  type LunaClassifierContract,
  type LunaLabelSetV1,
  type LunaModelRunV1,
} from "../scripts/luna-label-evaluation.js";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const promptSha = "a".repeat(64);
const schemaSha = "b".repeat(64);
const profileSha = digest(`${promptSha}:${schemaSha}:default`);
const pricing = { inputPerMillionUsd: 0.1, cachedInputPerMillionUsd: 0.01, cacheWritePerMillionUsd: 0.125, outputPerMillionUsd: 0.5 };
const model = "gpt-6-luna";
const promptVersion = "openai-luna-classification/1";
const schemaVersion = "openai-luna-classification-json/1";

function makeContract(): LunaClassifierContract {
  return {
    model, serviceTier: "default", profileSha256: profileSha, promptVersion, schemaVersion, promptSha256: promptSha, schemaSha256: schemaSha, pricing,
    prepareRequest(input, requestedModel = model) {
      const body = JSON.stringify({ model: requestedModel, service_tier: "default", store: false, input });
      const bytes = Buffer.from(body, "utf8");
      return { body, payloadSha256: sha256Bytes(bytes), requestBytes: bytes.byteLength, requestedModel, promptSha256: promptSha, schemaSha256: schemaSha, profileSha256: profileSha };
    },
    estimateCost(inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, modelReturned, serviceTier) {
      if (cachedInputTokens === null || cacheWriteInputTokens === null || modelReturned !== model || serviceTier !== "default" || cachedInputTokens + cacheWriteInputTokens > inputTokens) return null;
      return ((inputTokens - cachedInputTokens - cacheWriteInputTokens) * pricing.inputPerMillionUsd + cachedInputTokens * pricing.cachedInputPerMillionUsd + cacheWriteInputTokens * pricing.cacheWritePerMillionUsd + outputTokens * pricing.outputPerMillionUsd) / 1_000_000;
    },
  };
}

function companies(): Array<{ id: string; name: string; ticker: string; sector: string }> {
  return (JSON.parse(readFileSync("config/companies.json", "utf8")) as { companies: Array<{ id: string; name: string; ticker: string; sector: string }> }).companies;
}

function makeRow(index: number, cikIndex: number) {
  const configuredCompany = companies()[cikIndex]!;
  const company = { id: configuredCompany.id, name: configuredCompany.name, ticker: configuredCompany.ticker, sector: configuredCompany.sector };
  const cik = String(100_000 + cikIndex).padStart(10, "0");
  const accession = `${cik}-${String(26).padStart(2, "0")}-${String(index + 1).padStart(6, "0")}`;
  const excerpt = `Synthetic but source-shaped excerpt for filing ${index}; revenue increased and operations improved.`;
  const provenance = {
    observationId: `sec-${String(index).padStart(3, "0")}`, company, cik, accession, filingType: index % 2 ? "8-K" : "10-Q",
    filingAt: "2026-07-01T12:00:00Z", acceptedAt: "2026-07-01T12:30:00Z",
    sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/filing.htm`,
    collector: "sec-company-filings", publisher: "SEC EDGAR", title: `Company ${index} reports revenue growth`, excerpt,
    rawSourceSha256: digest(`raw html ${index}`), excerptSha256: sha256Bytes(Buffer.from(excerpt, "utf8")), sourceReceiptSha256: digest(`receipt ${index}`),
  };
  return provenance;
}

function planFor(frame: ReturnType<typeof makeRow>[], items: Array<{ cik: string }>) {
  const eligible = new Map<string, number>(); const selected = new Map<string, number>();
  for (const row of frame) eligible.set(row.cik, (eligible.get(row.cik) ?? 0) + 1);
  for (const row of items) selected.set(row.cik, (selected.get(row.cik) ?? 0) + 1);
  return [...eligible.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cik, eligibleCount]) => ({ cik, eligibleCount, selectedCount: selected.get(cik) ?? 0 })).filter(({ selectedCount }) => selectedCount > 0);
}

function labelsFixture(stage: "pilot" | "final" = "pilot", tweak?: (labels: any) => void): LunaLabelSetV1 {
  const classifier = makeContract();
  const counts = [1, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3];
  const frame = counts.flatMap((count, issuer) => Array.from({ length: count }, (_, index) => makeRow(issuer * 10 + index, issuer)));
  const selected = selectLunaSample(frame, 20261001, 30);
  const primary = ["agent-a", "agent-b"];
  const allRows = selected.map((source, index) => {
    const input = { company: { name: source.company.name, ticker: source.company.ticker, sector: source.company.sector }, source: { collector: source.collector, publisher: source.publisher, title: source.title, excerpt: source.excerpt } };
    const prepared = classifier.prepareRequest(input, model);
    const labels = {
      sentiment: (["negative", "neutral", "positive"] as const)[Math.floor(index / 10)]!,
      eventType: index % 2 ? "product" : "results", takeaway: index % 2 ? "results_beat" : "results_miss",
      about: index < 24, material: index % 3 !== 0, investorRelevant: index < 24, evidenceSufficient: true,
    };
    const rationales = Object.fromEntries(["sentiment", "eventType", "takeaway", "about", "material", "investorRelevant", "evidenceSufficient"].map((field) => [field, `Source text supports the ${field} decision.`]));
    return {
      ...source, input,
      requestBinding: { requestedModel: model, requestedServiceTier: "default", payloadSha256: prepared.payloadSha256, requestBytes: prepared.requestBytes, promptSha256: promptSha, schemaSha256: schemaSha, profileSha256: profileSha },
      reviews: primary.map((reviewerId) => ({ reviewerId, labels: { ...labels }, rationales })),
    };
  });
  const frozenAt = "2026-10-01T20:30:00Z";
  const timestamp = "2026-10-01T21:00:00Z";
  const labels: any = {
    schemaVersion: 1, stage, studyId: "luna-study-2026-10", source: "sec_edgar", evaluationProfile: LUNA_DIAGNOSTIC_PROFILE, profileVersion: LUNA_PROFILE_VERSION,
    sampleSeed: 20261001, samplingWindowStart: "2026-06-01T00:00:00Z", samplingWindowEnd: "2026-09-30T23:59:59Z", sampledAt: "2026-10-01T20:20:00Z", frozenAt,
    analysisCodeRevision: "a".repeat(40), analysisCodeDirty: false, requestedModel: model, requestedServiceTier: "default", promptVersion, schemaVersionName: schemaVersion,
    promptSha256: promptSha, schemaSha256: schemaSha, profileSha256: profileSha, productCompanyUniverseSha256: PRODUCT_COMPANY_UNIVERSE_SHA256,
    populationFrameSha256: sampleManifestSha256(frame), sampleManifestSha256: sampleManifestSha256(allRows),
    ...(stage === "final" ? { evaluationBudget: { maxRequests: 40, maxEstimatedCostUsd: 0.01, inputPerMillionUsd: pricing.inputPerMillionUsd, cachedInputPerMillionUsd: pricing.cachedInputPerMillionUsd, cacheWritePerMillionUsd: pricing.cacheWritePerMillionUsd, outputPerMillionUsd: pricing.outputPerMillionUsd, openAIAccountReadback: { kind: "openai_account_spend_limit_readback", observedAt: "2026-10-01T20:25:00Z", availableBudgetUsd: 0.02, artifactSha256: digest("account readback") }, accountOwnerApproval: { attested: true, approvedAt: "2026-10-01T20:25:00Z", approvalRecordSha256: digest("approval") } } } : {}),
    populationFrame: frame, samplePlan: planFor(frame, allRows),
    reviewers: primary.map((id) => ({ id, kind: "independent_subagent", agentThreadId: `thread-${id}`, configuredModel: "gpt-6-luna", resolvedModel: null, modelSettingsSha256: digest(`${id} settings`), modelResolutionEvidenceSha256: null, independenceAttested: true, blindedToLunaOutputsAttested: true })),
    agentLabelProtocol: { version: "independent-subagents-blinded-v1", frozenAt, lunaOutputsOpenedAt: null, chronologyArtifactSha256: digest("reviewers froze before Luna output") },
    items: allRows,
  };
  tweak?.(labels);
  return labels as LunaLabelSetV1;
}

function runFixture(labels: LunaLabelSetV1, labelsSha256: string, mutate?: (run: any) => void): LunaModelRunV1 {
  const items = labels.items.map((item) => {
    const refs = item.reviews[0]!.labels;
    const prepared = makeContract().prepareRequest(item.input, model);
    const usage = { inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 5, outputTokens: 50, reasoningTokens: 10, totalTokens: 150 };
    const estimatedCostUsd = makeContract().estimateCost(usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.outputTokens, model, "default")!;
    const classification = {
      sentiment: refs.sentiment, eventType: refs.eventType, takeaway: refs.takeaway, about: refs.about, material: refs.material, investorRelevant: refs.investorRelevant,
      evidenceSufficient: refs.evidenceSufficient, summary: "The SEC excerpt reports the stated company result.", supportingExcerpt: item.excerpt.slice(0, 50), disposition: refs.about && refs.investorRelevant ? "classified" : "excluded",
    };
    return {
      observationId: item.observationId, requestPayloadSha256: prepared.payloadSha256, terminalStatus: "completed",
      attempts: [{ attemptNumber: 1, requestPayloadSha256: prepared.payloadSha256, outcome: "completed", submitted: true, httpStatus: 200, responseId: `resp-${item.observationId}`, responseSha256: digest(`response ${item.observationId}`), modelReturned: model, serviceTier: "default", latencyMs: 10 + labels.items.indexOf(item), classification, usage: { ...usage, estimatedCostUsd } }],
    };
  });
  const openTime = "2026-10-01T21:00:00Z";
  const finalLabels = { ...labels, agentLabelProtocol: { ...labels.agentLabelProtocol, lunaOutputsOpenedAt: openTime } } as any;
  Object.assign(labels as any, finalLabels);
  const run: any = {
    schemaVersion: 1, studyId: labels.studyId, runId: "luna-run-001", labelsSha256, sampleManifestSha256: labels.sampleManifestSha256,
    evaluationProfile: labels.evaluationProfile, profileSha256: labels.profileSha256, analysisCodeRevision: labels.analysisCodeRevision, sourceTreeDirty: false,
    startedAt: openTime, requestCount: items.length, requestedModel: labels.requestedModel, maxRequests: labels.evaluationBudget!.maxRequests, maxEstimatedCostUsd: labels.evaluationBudget!.maxEstimatedCostUsd,
    inputPerMillionUsd: labels.evaluationBudget!.inputPerMillionUsd, cachedInputPerMillionUsd: labels.evaluationBudget!.cachedInputPerMillionUsd, cacheWritePerMillionUsd: labels.evaluationBudget!.cacheWritePerMillionUsd, outputPerMillionUsd: labels.evaluationBudget!.outputPerMillionUsd,
    items,
  };
  mutate?.(run);
  return run as LunaModelRunV1;
}

describe("offline categorical Luna evaluation", () => {
  it("rejects human or probability-shaped schema fields and binds the configured company universe", () => {
    const labels = labelsFixture();
    expect(lunaLabelSetV1Schema.safeParse({ ...labels, reviewers: [{ id: "human", qualifiedHumanAttested: true }] }).success).toBe(false);
    expect(lunaLabelSetV1Schema.safeParse({ ...labels, pPos: 0.9 }).success).toBe(false);
    expect(parseLunaLabelSet(labels, makeContract()).items).toHaveLength(30);
    const mismatchedIdentity = structuredClone(labels) as any;
    const selected = mismatchedIdentity.items[0];
    const frameRow = mismatchedIdentity.populationFrame.find((row: any) => row.observationId === selected.observationId);
    selected.company.ticker = "WRONG"; selected.input.company.ticker = "WRONG"; frameRow.company.ticker = "WRONG";
    mismatchedIdentity.populationFrameSha256 = sampleManifestSha256(mismatchedIdentity.populationFrame);
    mismatchedIdentity.sampleManifestSha256 = sampleManifestSha256(mismatchedIdentity.items);
    expect(() => parseLunaLabelSet(mismatchedIdentity, makeContract())).toThrow("company identity does not match configured company");
  });

  it("selects two seeded filings per issuer, then deterministically tops up the case count without label input", () => {
    const frame = labelsFixture().populationFrame;
    const first = selectLunaSample(frame, 20261001, 30).map(({ observationId }) => observationId);
    const second = selectLunaSample(frame, 20261001, 30).map(({ observationId }) => observationId);
    expect(first).toEqual(second);
    expect(first).toHaveLength(30);
    expect(new Set(first.map((id) => frame.find((row) => row.observationId === id)!.cik)).size).toBe(15);
  });

  it("reports agent agreement and unresolved fields without implying classifier quality or human truth", () => {
    const labels = labelsFixture("pilot", (value) => {
      value.items[0].reviews[0].labels.material = null;
      value.items[1].reviews[0].labels.sentiment = null;
      value.items[1].reviews[1].labels.sentiment = null;
    });
    const parsed = parseLunaLabelSet(labels, makeContract());
    const report = analyzeLunaPilot(parsed) as any;
    expect(report).toMatchObject({ status: "UNVERIFIED", humanGroundTruth: "NOT_PROVIDED", statisticalCertification: "UNVERIFIED", selectedCaseDenominator: 30 });
    expect(report.unresolvedReferences).toContainEqual({ observationId: labels.items[0]!.observationId, field: "material" });
    expect(report.unresolvedReferenceFieldCount).toBe(2);
    expect(report.rawAgentAgreement.material.selectedCases).toBe(30);
  });

  it("cannot report a final diagnostic PASS without a saved Luna run", () => {
    const labels = parseLunaLabelSet(labelsFixture("final"), makeContract());
    const report = analyzeLunaFinal({ labels, labelsSha256: digest("frozen labels"), run: null });
    expect(report).toMatchObject({ status: "UNVERIFIED", provenanceExecutionStatus: "UNVERIFIED", qualityStatus: "UNVERIFIED", humanGroundTruth: "NOT_PROVIDED" });
  });

  it("passes only the bounded categorical gates on a complete correctly bound synthetic run", () => {
    const raw = labelsFixture("final");
    const labels = parseLunaLabelSet(raw, makeContract());
    const labelsSha256 = digest("frozen labels bytes");
    const run = parseLunaModelRun(runFixture(labels, labelsSha256), labels, makeContract());
    const report = analyzeLunaFinal({ labels, labelsSha256, run }) as any;
    expect(report).toMatchObject({ status: "PASS", qualityStatus: "PASS", provenanceExecutionStatus: "PASS", humanGroundTruth: "NOT_PROVIDED", statisticalCertification: "UNVERIFIED", investmentValue: "UNVERIFIED" });
    expect(report.quality.sentiment.metrics.macroF1).toBe(1);
    expect(report.quality.sentiment.metrics.majorityBaseline).toBeGreaterThan(0.3);
    expect(report.quality.sentiment.metrics.total).toBe(30);
    expect(report.rawAgentAgreement.sentiment.rawAgreementIncludingAbstentions).toBe(1);
    expect(report.usage).toMatchObject({ cachedInputTokensKnownSubtotal: 300, cacheWriteInputTokensKnownSubtotal: 150, reasoningTokensAreIncludedInOutput: true });
    expect(report.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("counts classifier abstentions as missing predictions and keeps unresolved references in total N", () => {
    const raw = labelsFixture("final", (value) => {
      value.items[0].reviews[0].labels.sentiment = null;
      value.items[0].reviews[1].labels.sentiment = null;
      value.sampleManifestSha256 = sampleManifestSha256(value.items);
    });
    const labels = parseLunaLabelSet(raw, makeContract());
    const labelsSha256 = digest("labels with one unresolved sentiment");
    const runRaw: any = runFixture(labels, labelsSha256);
    runRaw.items[1].attempts[0].classification.sentiment = null;
    const run = parseLunaModelRun(runRaw, labels, makeContract());
    const report = analyzeLunaFinal({ labels, labelsSha256, run }) as any;
    expect(report.selectedCaseDenominator).toBe(30);
    expect(report.resolvedReferenceDenominators.sentiment).toBe(29);
    expect(report.unresolvedReferenceFieldDenominator).toBe(1);
    expect(report.quality.sentiment.metrics.total).toBe(29);
    expect(report.quality.sentiment.metrics.matrix.negative.missing).toBe(1);
    expect(report.qualityStatus).toBe("PASS");
  });

  it("counts every rate-limit retry, rechecks exact requests, and forbids retry after an unknown outcome", () => {
    const raw = labelsFixture("final"); const labels = parseLunaLabelSet(raw, makeContract()); const labelsSha256 = digest("retry fixture");
    const retry = runFixture(labels, labelsSha256, (value) => {
      const firstItem = value.items[0];
      firstItem.attempts.unshift({ attemptNumber: 1, requestPayloadSha256: firstItem.requestPayloadSha256, outcome: "rejected", submitted: true, httpStatus: 429, responseId: "rate-limited", responseSha256: digest("429 response"), modelReturned: null, serviceTier: null, latencyMs: 3, classification: null, usage: null });
      firstItem.attempts[1].attemptNumber = 2;
      firstItem.terminalStatus = "completed";
      value.requestCount += 1;
    });
    const parsed = parseLunaModelRun(retry, labels, makeContract());
    const report = analyzeLunaFinal({ labels, labelsSha256, run: parsed }) as any;
    expect(report.execution.retryableRateLimitAttempts).toBe(1);
    expect(report.execution.requestCount).toBe(31);
    const unknownRetry = structuredClone(retry) as any;
    unknownRetry.items[0].attempts[0].outcome = "unknown";
    expect(() => parseLunaModelRun(unknownRetry, labels, makeContract())).toThrow("retries after a terminal or unknown outcome");
  });

  it("rejects fabricated source quotations and tampered cost breakdowns", () => {
    const raw = labelsFixture("final"); const labels = parseLunaLabelSet(raw, makeContract()); const labelsSha256 = digest("quote fixture");
    const badQuote = runFixture(labels, labelsSha256, (value) => { value.items[0].attempts[0].classification.supportingExcerpt = "not in the SEC text"; });
    expect(() => parseLunaModelRun(badQuote, labels, makeContract())).toThrow("quotation absent from the frozen SEC source text");
    const badCost = runFixture(labels, labelsSha256, (value) => { value.items[0].attempts[0].usage.estimatedCostUsd += 0.1; });
    expect(() => parseLunaModelRun(badCost, labels, makeContract())).toThrow("cost does not match the production classifier");
  });

  it("keeps missing cache-write, model, tier, or cost facts unverified instead of applying Luna rates", () => {
    const raw = labelsFixture("final"); const labels = parseLunaLabelSet(raw, makeContract()); const labelsSha256 = digest("unpriced fixture");
    const unpriced = runFixture(labels, labelsSha256, (value) => {
      const usage = value.items[0].attempts[0].usage;
      usage.cacheWriteInputTokens = null; usage.estimatedCostUsd = null;
    });
    const run = parseLunaModelRun(unpriced, labels, makeContract());
    const report = analyzeLunaFinal({ labels, labelsSha256, run }) as any;
    expect(report.status).toBe("UNVERIFIED");
    expect(report.execution.unpricedAttempts).toBe(1);
    expect(report.execution.totalEstimatedCostUsd).toBeNull();
    const wrongTier = structuredClone(unpriced) as any;
    wrongTier.items[0].attempts[0].usage.cacheWriteInputTokens = 5;
    wrongTier.items[0].attempts[0].usage.estimatedCostUsd = 0.0001;
    wrongTier.items[0].attempts[0].serviceTier = "priority";
    expect(() => parseLunaModelRun(wrongTier, labels, makeContract())).toThrow("cost does not match the production classifier");
  });

  it("fails a frozen USD ceiling overrun and tracks refusal and unknown outcomes", () => {
    const raw = labelsFixture("final", (value) => { value.evaluationBudget.maxEstimatedCostUsd = 0.0001; });
    const labels = parseLunaLabelSet(raw, makeContract()); const labelsSha256 = digest("budget fixture");
    const overBudget = runFixture(labels, labelsSha256);
    const overBudgetReport = analyzeLunaFinal({ labels, labelsSha256, run: parseLunaModelRun(overBudget, labels, makeContract()) }) as any;
    expect(overBudgetReport.provenanceExecutionStatus).toBe("FAIL");
    const unknownLabels = parseLunaLabelSet(labelsFixture("final"), makeContract());
    const unknownLabelsSha256 = digest("unknown fixture");
    const unknown = runFixture(unknownLabels, unknownLabelsSha256, (value) => {
      const row = value.items[0]; row.terminalStatus = "unknown"; row.attempts[0] = { attemptNumber: 1, requestPayloadSha256: row.requestPayloadSha256, outcome: "unknown", submitted: true, httpStatus: null, responseId: null, responseSha256: null, modelReturned: null, serviceTier: null, latencyMs: null, classification: null, usage: null };
    });
    const unknownReport = analyzeLunaFinal({ labels: unknownLabels, labelsSha256: unknownLabelsSha256, run: parseLunaModelRun(unknown, unknownLabels, makeContract()) }) as any;
    expect(unknownReport.execution.unknownCases).toContain(unknownLabels.items[0]!.observationId);
    expect(unknownReport.provenanceExecutionStatus).toBe("UNVERIFIED");
  });
});
