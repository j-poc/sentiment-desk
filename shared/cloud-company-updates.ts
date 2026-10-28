import { decimalComparison, exactDecimalIsPositive, interpretReportedDifference, isValidReportedDecimals, normalizeExactDecimal } from "./financial-decimal.js";
import { classifyPeriodAlignment, type FundamentalPeriodFact } from "./fundamental-periods.js";
import type { FundamentalMetricKey } from "./company-fundamentals.js";
import { canonicalSecFilingUrl, secFilingArchiveUrl } from "./sec-filing-url.js";

export interface CloudCompanyFact {
  id: string;
  cik: string;
  taxonomy: string;
  concept: string;
  unit: string;
  value_text: string;
  period_start: string | null;
  period_end: string;
  filed_at: string;
  form: string;
  accession: string;
  reported_decimals: string | null;
}

export interface CloudCompanyFiling {
  id: string;
  cik: string;
  accession: string;
  form: string;
  filed_at: string;
  accepted_at: string | null;
  primary_document: string | null;
  source_url: string;
}

export type CloudCompanyUpdate = {
  metric: "Revenue" | "Operating income" | "Net income" | "Operating cash flow";
  direction: "increase" | "decrease" | null;
  precision: "change_exceeds_precision" | "within_reported_precision" | "reported_values_only";
  current: { factId: string; value: string; periodStart: string; periodEnd: string; filedAt: string; accession: string; sourceUrl: string | null };
  prior: { factId: string; value: string; periodStart: string; periodEnd: string; filedAt: string; accession: string; sourceUrl: string | null };
  delta: string;
  unit: string;
  percentChange: string | null;
};

export type CloudCompanyUpdateResult =
  | { state: "updates"; updates: CloudCompanyUpdate[] }
  | { state: "no_comparable_change"; reason: string };

const METRICS: Readonly<Record<string, { key: FundamentalMetricKey; label: CloudCompanyUpdate["metric"] }>> = {
  RevenueFromContractWithCustomerExcludingAssessedTax: { key: "revenue", label: "Revenue" },
  SalesRevenueNet: { key: "revenue", label: "Revenue" },
  Revenues: { key: "revenue", label: "Revenue" },
  OperatingIncomeLoss: { key: "operating_income", label: "Operating income" },
  NetIncomeLoss: { key: "net_income", label: "Net income" },
  NetCashProvidedByUsedInOperatingActivities: { key: "operating_cash_flow", label: "Operating cash flow" },
};
export const CLOUD_COMPANY_UPDATE_CONCEPTS = Object.freeze(Object.keys(METRICS));

type Duration = "annual" | "quarter";

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function duration(fact: CloudCompanyFact): Duration | null {
  if (!validDate(fact.period_start) || !validDate(fact.period_end)) return null;
  const days = (Date.parse(`${fact.period_end}T00:00:00Z`) - Date.parse(`${fact.period_start}T00:00:00Z`)) / 86_400_000 + 1;
  if (fact.form === "10-K" && days >= 330 && days <= 400) return "annual";
  if (fact.form === "10-Q" && days >= 65 && days <= 125) return "quarter";
  return null;
}

function periodFact(fact: CloudCompanyFact, acceptedAt: string | null): FundamentalPeriodFact | null {
  const accepted = Date.parse(acceptedAt ?? `${fact.filed_at}T00:00:00.000Z`);
  const durationClass = duration(fact);
  const metric = METRICS[fact.concept]?.key;
  if (!Number.isSafeInteger(accepted) || accepted < 0 || durationClass == null || !validDate(fact.period_start) || !metric) return null;
  return {
    companyId: fact.cik,
    cik: fact.cik,
    metric,
    taxonomy: fact.taxonomy,
    concept: fact.concept,
    unit: fact.unit,
    startDate: fact.period_start,
    endDate: fact.period_end,
    durationClass,
    form: fact.form,
    accession: fact.accession,
    acceptedAt: accepted,
    amended: false,
  };
}

function bestFactPerPeriod(facts: readonly CloudCompanyFact[], cik: string): CloudCompanyFact[] {
  const byPeriod = new Map<string, CloudCompanyFact>();
  for (const fact of facts) {
    if (fact.cik !== cik || fact.taxonomy !== "us-gaap" || !METRICS[fact.concept]
      || duration(fact) == null || !/^[A-Z0-9]{10}-\d{2}-\d{6}$/.test(fact.accession)
      || !validDate(fact.filed_at) || normalizeExactDecimal(fact.value_text) == null
      || (fact.reported_decimals != null && !isValidReportedDecimals(fact.reported_decimals))) continue;
    const key = [fact.concept, fact.unit, fact.form, fact.period_start, fact.period_end].join("|");
    const existing = byPeriod.get(key);
    if (!existing || fact.filed_at > existing.filed_at
      || (fact.filed_at === existing.filed_at && fact.accession > existing.accession)) byPeriod.set(key, fact);
  }
  return [...byPeriod.values()];
}

function sourceUrl(fact: CloudCompanyFact, filingsByAccession: ReadonlyMap<string, CloudCompanyFiling>): string | null {
  const filing = filingsByAccession.get(fact.accession);
  if (filing && filing.cik === fact.cik && filing.form === fact.form && filing.filed_at === fact.filed_at) {
    return canonicalSecFilingUrl(filing.source_url, fact.cik, fact.accession, filing.primary_document)
      ?? secFilingArchiveUrl(fact.cik, fact.accession);
  }
  return secFilingArchiveUrl(fact.cik, fact.accession);
}

export function buildCloudCompanyUpdates(input: {
  cik: string;
  facts: readonly CloudCompanyFact[];
  filings: readonly CloudCompanyFiling[];
}): CloudCompanyUpdateResult {
  if (!/^\d{10}$/.test(input.cik)) return { state: "no_comparable_change", reason: "A verified SEC company identifier is required for comparisons." };
  const facts = bestFactPerPeriod(input.facts, input.cik);
  const filingsByAccession = new Map(input.filings.filter((filing) => filing.cik === input.cik)
    .map((filing) => [filing.accession, filing]));
  const updates: CloudCompanyUpdate[] = [];

  for (const current of facts) {
    const currentPeriod = periodFact(current, filingsByAccession.get(current.accession)?.accepted_at ?? null);
    if (!currentPeriod) continue;
    const prior = facts.find((candidate) => {
      if (candidate.id === current.id || candidate.cik !== current.cik || candidate.concept !== current.concept
        || candidate.taxonomy !== current.taxonomy || candidate.unit !== current.unit || candidate.form !== current.form
        || candidate.accession !== current.accession) return false;
      const priorPeriod = periodFact(candidate, filingsByAccession.get(candidate.accession)?.accepted_at ?? null);
      return priorPeriod != null && classifyPeriodAlignment(priorPeriod, currentPeriod) != null;
    });
    if (!prior) continue;
    const result = decimalComparison(current.value_text, prior.value_text);
    if (!result || result.delta === "0") continue;
    const currentDecimals = current.reported_decimals;
    const priorDecimals = prior.reported_decimals;
    const precisionResult = currentDecimals != null && priorDecimals != null
      ? interpretReportedDifference(result.delta, currentDecimals, priorDecimals)
      : null;
    if (currentDecimals != null && priorDecimals != null && precisionResult == null) continue;
    if (precisionResult === "no_reported_difference") continue;
    const precision = precisionResult ?? "reported_values_only";
    const direction = precision === "change_exceeds_precision"
      ? result.delta.startsWith("-") ? "decrease" : "increase"
      : null;
    const exactAmounts = currentDecimals === "INF" && priorDecimals === "INF";
    const currentValue = normalizeExactDecimal(current.value_text)!;
    const priorValue = normalizeExactDecimal(prior.value_text)!;
    const percentChange = precision === "change_exceeds_precision" && exactAmounts
      && exactDecimalIsPositive(priorValue) === true ? result.percentChange : null;
    updates.push({
      metric: METRICS[current.concept]!.label, direction, precision,
      current: { factId: current.id, value: currentValue, periodStart: current.period_start!, periodEnd: current.period_end,
        filedAt: current.filed_at, accession: current.accession, sourceUrl: sourceUrl(current, filingsByAccession) },
      prior: { factId: prior.id, value: priorValue, periodStart: prior.period_start!, periodEnd: prior.period_end,
        filedAt: prior.filed_at, accession: prior.accession, sourceUrl: sourceUrl(prior, filingsByAccession) },
      delta: result.delta, unit: current.unit, percentChange,
    });
  }

  const latestByMetric = new Map<CloudCompanyUpdate["metric"], CloudCompanyUpdate>();
  for (const update of updates.sort((a, b) => b.current.periodEnd.localeCompare(a.current.periodEnd)
    || b.current.filedAt.localeCompare(a.current.filedAt) || a.metric.localeCompare(b.metric))) {
    if (!latestByMetric.has(update.metric)) latestByMetric.set(update.metric, update);
  }
  const latest = [...latestByMetric.values()].sort((a, b) => b.current.filedAt.localeCompare(a.current.filedAt));
  return latest.length
    ? { state: "updates", updates: latest }
    : { state: "no_comparable_change", reason: "The available SEC snapshot has no validated same-metric, same-unit prior-year 10-K or 10-Q comparison. This does not mean the business did not change." };
}
