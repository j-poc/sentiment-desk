import type { FundamentalMetricKey, PersistedFundamentalFact } from "../shared/company-fundamentals.js";
import type { CompanyResearchBrief, CompanyResearchBriefInput, FundamentalChangeLead } from "../shared/company-research-brief.js";
import { classifyPeriodAlignment, decimalComparison } from "./company-fundamentals.js";

const METRIC_LABEL: Record<FundamentalMetricKey, string> = {
  revenue: "revenue",
  operating_income: "operating income",
  net_income: "net income",
  operating_cash_flow: "operating cash flow",
};

function isFiniteDecimal(value: string): boolean {
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
}

function hasNonZeroDigit(value: string): boolean {
  const mantissa = value.split(/[eE]/u, 1)[0] ?? "";
  return /[1-9]/u.test(mantissa);
}

function validComparable(input: CompanyResearchBriefInput, metric: FundamentalMetricKey, eligibleFactIds: ReadonlySet<string>) {
  const candidates = input.comparisons.filter((candidate) => candidate.metric === metric && candidate.state === "comparable")
    .map((comparison) => {
      if (comparison.currentFactId == null || comparison.priorFactId == null || comparison.periodAlignment == null) return null;
      const current = input.facts.find((fact) => fact.id === comparison.currentFactId);
      const prior = input.facts.find((fact) => fact.id === comparison.priorFactId);
      return current && prior ? { comparison, current, prior } : null;
    }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.current.endDate.localeCompare(left.current.endDate)
      || (right.current.acceptedAt ?? 0) - (left.current.acceptedAt ?? 0)
      || left.current.id.localeCompare(right.current.id));

  for (const candidate of candidates) {
    const { comparison, current, prior } = candidate;
    if (!eligibleFactIds.has(current.id) || !eligibleFactIds.has(prior.id)
      || comparison.delta == null || !isFiniteDecimal(comparison.delta) || !hasNonZeroDigit(comparison.delta)
      || comparison.changeInterpretation === "within_reported_precision"
      || comparison.changeInterpretation === "no_reported_difference" || comparison.changeInterpretation === "withheld") continue;
    if (!validPair(input.company.companyId, metric, current, prior)
      || classifyPeriodAlignment(prior, current) !== comparison.periodAlignment) continue;
    const calculated = decimalComparison(current.value, prior.value);
    if (!calculated || calculated.delta !== comparison.delta) continue;
    // Percentages are displayed only when both SEC facts declared exact values.
    // Missing precision must withhold the percentage without erasing an otherwise
    // verifiable absolute difference between the reported values.
    const exactInputs = current.reportedPrecisionStatus === "declared" && prior.reportedPrecisionStatus === "declared"
      && current.reportedDecimals === "INF" && prior.reportedDecimals === "INF";
    const expectedPercent = exactInputs ? calculated.percentChange : null;
    if (comparison.percentChange !== expectedPercent) continue;
    return candidate;
  }
  return null;
}

function validPair(companyId: string, metric: FundamentalMetricKey, current: PersistedFundamentalFact, prior: PersistedFundamentalFact): boolean {
  return current.companyId === companyId && prior.companyId === companyId
    && current.id !== prior.id && current.cik === prior.cik
    && current.metric === metric && prior.metric === metric
    && current.form === prior.form && current.accession === prior.accession
    && current.taxonomy === prior.taxonomy && current.concept === prior.concept
    && current.durationClass === prior.durationClass && !current.amended && !prior.amended
    && current.unit === prior.unit && current.endDate > prior.endDate
    && current.acceptedAt != null && current.acceptedAt === prior.acceptedAt
    && isFiniteDecimal(current.value) && isFiniteDecimal(prior.value);
}

/**
 * Compile a read-only, deterministic research brief from one persisted as-of view.
 * This function makes no market, sentiment, materiality, independence, or worthiness claims.
 */
export function compileCompanyResearchBrief(input: CompanyResearchBriefInput): CompanyResearchBrief {
  const facts = input.facts.filter((fact) => fact.companyId === input.company.companyId && fact.retrievedAt <= input.asOfMs)
    .slice().sort((a, b) => a.metric.localeCompare(b.metric) || a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id));
  const eligibleFactIds = new Set(facts.map((fact) => fact.id));
  const comparisons = input.comparisons.filter((c) => (c.currentFactId == null || eligibleFactIds.has(c.currentFactId))
    && (c.priorFactId == null || eligibleFactIds.has(c.priorFactId)))
    .slice().sort((a, b) => a.metric.localeCompare(b.metric));
  const observations = input.observations.filter((item) => item.companyId === input.company.companyId
    && item.retrievedAt <= input.asOfMs && item.ingestedAt <= input.asOfMs)
    .slice().sort((a, b) => (b.sourceTime ?? b.retrievedAt) - (a.sourceTime ?? a.retrievedAt)
      || b.retrievedAt - a.retrievedAt || a.id.localeCompare(b.id));

  const secState = facts.length === 0 ? "empty" : input.coverage.sec === "complete" ? "complete" : "partial";
  const observationState = observations.length === 0 ? "empty" : input.coverage.publicObservations === "complete" ? "complete" : "partial";
  const coverage: CompanyResearchBrief["coverage"] = { sec: secState, publicObservations: observationState, reasons: [...input.coverage.reasons] };

  const fundamentalLeads: FundamentalChangeLead[] = [];
  for (const metric of ["revenue", "operating_income", "net_income", "operating_cash_flow"] as const) {
    const pair = validComparable(input, metric, eligibleFactIds);
    if (!pair || !eligibleFactIds.has(pair.current.id) || !eligibleFactIds.has(pair.prior.id)) continue;
    const direction = pair.comparison.delta!.startsWith("-") ? "reported_decrease" : "reported_increase";
    const directionText = direction === "reported_decrease" ? "decrease" : "increase";
    fundamentalLeads.push({
      metric,
      direction,
      delta: pair.comparison.delta!,
      percentChange: pair.comparison.percentChange,
      currentFactId: pair.current.id,
      priorFactId: pair.prior.id,
      currentPeriodEnd: pair.current.endDate,
      priorPeriodEnd: pair.prior.endDate,
      currentAccession: pair.current.accession,
      priorAccession: pair.prior.accession,
      question: `What filing, segment, or operating item explains the reported difference of ${pair.comparison.delta} ${pair.current.unit}${pair.comparison.percentChange == null ? "" : ` (${pair.comparison.percentChange}%)`} in ${METRIC_LABEL[metric]}—a reported ${directionText}—from ${pair.prior.endDate} to ${pair.current.endDate}? Did it recur, and what filing evidence challenges that explanation?`,
    });
  }

  const nextLead = fundamentalLeads[0];
  const nextResearchQuestion: CompanyResearchBrief["nextResearchQuestion"] = nextLead ? {
    metric: nextLead.metric,
    currentFactId: nextLead.currentFactId,
    priorFactId: nextLead.priorFactId,
    question: nextLead.question,
  } : null;
  const measureCount = fundamentalLeads.length;
  const researchFollowUp: CompanyResearchBrief["researchFollowUp"] = fundamentalLeads.length > 0
    ? { state: "indicated", leads: fundamentalLeads,
      explanation: `${measureCount} comparable SEC-reported measure${measureCount === 1 ? "" : "s"} ${measureCount === 1 ? "has" : "have"} different reported values. Inspect the linked filings and source leads to decide whether any difference merits more work.` }
    : { state: "undetermined", leads: [],
      explanation: "The saved snapshot does not contain a validated comparable metric difference. This is not evidence that the business did not change." };

  return {
    schemaVersion: 1,
    company: { ...input.company },
    asOfMs: input.asOfMs,
    snapshotId: input.snapshotId,
    coverage,
    facts,
    comparisons,
    observations,
    researchFollowUp,
    nextResearchQuestion,
    missingEvidenceReason: nextResearchQuestion ? null : "No valid comparable SEC metric with two same-company, same-unit facts in this as-of snapshot.",
    interpretationLimits: [
      "Saved observations are leads for research; inclusion does not establish material support or counterevidence.",
      "Sentiment labels do not establish factual support, source independence, company quality, or research-worthiness.",
      "A reported fundamental difference creates a follow-up lead only; the Desk does not infer whether it is favorable, material, recurring, or important to valuation.",
      "Coverage describes only the supplied eligible saved records and is not a claim about the entire public web.",
    ],
  };
}
