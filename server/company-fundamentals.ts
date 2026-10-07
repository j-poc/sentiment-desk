import { createHash, randomUUID } from "node:crypto";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import { Desk, type SecFundamentalFactInput, type SecFundamentalPayloadInput } from "./db.js";
import { StorageCapacityError } from "./storage-capacity.js";
import { clearProviderRateLimit, paceProviderRequest, parseRetryAfterMs, providerCoolingDown, ProviderRateLimitError, recordProviderRateLimit } from "./provider-cooldown.js";
import type { Company } from "./types.js";
import type {
  CompanyFundamentalsView,
  FundamentalComparison,
  FundamentalMetricKey,
  FundamentalPeriodAlignment,
  FundamentalRefreshResult,
  PersistedFundamentalFact,
  PersistedFundamentalPoint,
} from "../shared/company-fundamentals.js";

const SEC_DATA = "https://data.sec.gov";
const SEC_WEB = "https://www.sec.gov";
const POLICY_VERSION = "sec-fundamentals/3";
const FRESH_FOR_MS = 24 * 60 * 60 * 1_000;
const OBSERVATION_FRESH_FOR_MS = 365 * 24 * 60 * 60 * 1_000;
const DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
const SUBMISSIONS_MAX_BYTES = 8 * 1024 * 1024;
const COMPANYFACTS_MAX_BYTES = 32 * 1024 * 1024;
const SEC_TIMEOUT_MS = 15_000;
const FACTS_PER_METRIC_LIMIT = 48;
const FACT_VINTAGES_PER_PERIOD_LIMIT = 10;
const PERIOD_COMPARISON_POLICY_VERSION = "sec-period-comparison/2";
const DAY_MS = 86_400_000;

export interface CompanyFundamentalsOptions {
  db: Desk;
  externalRequestsEnabled: boolean;
  secCompanyFactsEnabled: boolean;
  userAgent: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface SecResponse {
  url: string;
  startedAt: number;
  retrievedAt: number;
  body: string;
  bodyBytes: number;
  sha256: string;
}

interface LosslessReviverContext { source?: string }
type LosslessJsonParse = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context?: LosslessReviverContext) => unknown,
) => unknown;

function parseLosslessJson(text: string): unknown {
  // Node's current runtime passes the source token to the reviver. Keep every
  // JSON number as its original decimal token so CompanyFacts values never
  // pass through binary floating point before validation and persistence.
  const parse = JSON.parse as unknown as LosslessJsonParse;
  return parse(text, (_key, value, context) => typeof value === "number" ? context?.source ?? String(value) : value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isoDate(value: unknown): string | null {
  const raw = string(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function epochFromDate(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Expand an exact JSON decimal token, including exponent notation, to plain base-10 text. */
export function normalizeExactDecimal(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 96) return null;
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || exponent < -40 || exponent > 40) return null;
  const digits = `${integer}${fraction}`;
  const decimalAt = integer.length + exponent;
  let normalized: string;
  if (decimalAt <= 0) normalized = `0.${"0".repeat(-decimalAt)}${digits}`;
  else if (decimalAt >= digits.length) normalized = `${digits}${"0".repeat(decimalAt - digits.length)}`;
  else normalized = `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
  const [wholeRaw, fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw!.replace(/^0+(?=\d)/, "");
  const decimal = fractionRaw.replace(/0+$/, "");
  const magnitude = decimal ? `${whole}.${decimal}` : whole;
  if (magnitude.length > 80) return null;
  return /^0(?:\.0*)?$/.test(magnitude) ? "0" : `${sign}${magnitude}`;
}

function decimalParts(value: string): { units: bigint; scale: number } | null {
  const normalized = normalizeExactDecimal(value);
  if (normalized == null) return null;
  const negative = normalized.startsWith("-");
  const magnitude = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = magnitude.split(".");
  const units = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

function decimalText(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : whole;
  return /^0(?:\.0*)?$/.test(result) ? "0" : `${negative ? "-" : ""}${result}`;
}

function decimalComparison(current: string, prior: string): { delta: string; percentChange: string | null } | null {
  const currentParts = decimalParts(current);
  const priorParts = decimalParts(prior);
  if (!currentParts || !priorParts) return null;
  const scale = Math.max(currentParts.scale, priorParts.scale);
  const currentUnits = currentParts.units * 10n ** BigInt(scale - currentParts.scale);
  const priorUnits = priorParts.units * 10n ** BigInt(scale - priorParts.scale);
  const deltaUnits = currentUnits - priorUnits;
  if (priorUnits <= 0n) return { delta: decimalText(deltaUnits, scale), percentChange: null };
  const numerator = deltaUnits * 10_000n;
  let quotient = numerator / priorUnits;
  const remainder = numerator % priorUnits;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= priorUnits) quotient += numerator < 0n ? -1n : 1n;
  return { delta: decimalText(deltaUnits, scale), percentChange: decimalText(quotient, 2) };
}

function parseCikDirectory(body: unknown, ticker: string): { cik: string; title: string } {
  const root = record(body);
  if (!root) throw new SecFundamentalsError("The SEC ticker directory had an invalid response shape.");
  const matches: Array<{ cik: string; title: string }> = [];
  for (const raw of Object.values(root)) {
    const row = record(raw);
    if (!row) throw new SecFundamentalsError("The SEC ticker directory contained a malformed entry.");
    const symbol = string(row.ticker)?.trim().toUpperCase();
    if (symbol !== ticker.toUpperCase()) continue;
    const cikRaw = string(row.cik_str);
    const title = string(row.title)?.trim();
    if (!cikRaw || !/^\d{1,10}$/.test(cikRaw) || !title) throw new SecFundamentalsError("The SEC ticker directory omitted a valid issuer identity.");
    matches.push({ cik: cikRaw.padStart(10, "0"), title });
  }
  const unique = [...new Map(matches.map((item) => [item.cik, item])).values()];
  if (unique.length !== 1) throw new SecFundamentalsError(unique.length === 0
    ? `The SEC directory has no current CIK mapping for ${ticker}.`
    : `The SEC directory has multiple CIK mappings for ${ticker}; issuer identity is ambiguous.`);
  return unique[0]!;
}

interface SubmissionRow {
  form: string;
  filingDate: string;
  reportDate: string;
  acceptedAt: number;
  accession: string;
  primaryDocument: string;
}

function parseRecentSubmissions(body: unknown, cik: string): Map<string, SubmissionRow> {
  const root = record(body);
  if (!root || string(root.cik)?.padStart(10, "0") !== cik) {
    throw new SecFundamentalsError("SEC submissions returned a different issuer than the selected company.");
  }
  const filings = record(root?.filings);
  const recent = record(filings?.recent);
  if (!recent) throw new SecFundamentalsError("SEC submissions omitted recent filing metadata.");
  const fields = ["form", "filingDate", "reportDate", "acceptanceDateTime", "accessionNumber", "primaryDocument"] as const;
  const columns = new Map<typeof fields[number], unknown[]>();
  for (const field of fields) {
    const entries = array(recent[field]);
    if (!entries) throw new SecFundamentalsError(`SEC submissions omitted the ${field} filing array.`);
    columns.set(field, entries);
  }
  const count = columns.get("form")!.length;
  if (count > 2_000 || fields.some((field) => columns.get(field)!.length !== count)) {
    throw new SecFundamentalsError("SEC submissions filing arrays have inconsistent lengths or exceed the row limit.");
  }
  const byAccession = new Map<string, SubmissionRow>();
  for (let index = 0; index < count; index += 1) {
    const form = string(columns.get("form")![index]);
    const filingDate = isoDate(columns.get("filingDate")![index]);
    const reportDate = isoDate(columns.get("reportDate")![index]);
    const acceptance = string(columns.get("acceptanceDateTime")![index]);
    const accession = string(columns.get("accessionNumber")![index]);
    const primaryDocument = string(columns.get("primaryDocument")![index]);
    if (!form || !filingDate || !reportDate || !acceptance || !accession || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || !primaryDocument || !/^[A-Za-z0-9_.-]{1,255}$/.test(primaryDocument)) continue;
    const acceptedAt = Date.parse(acceptance);
    if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) continue;
    const row = { form, filingDate, reportDate, acceptedAt, accession, primaryDocument };
    const previous = byAccession.get(accession);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
      throw new SecFundamentalsError(`SEC submissions contain conflicting metadata for CIK ${cik}.`);
    }
    byAccession.set(accession, row);
  }
  return byAccession;
}

interface MetricConcept {
  metric: FundamentalMetricKey;
  concepts: readonly string[];
}

const METRICS: readonly MetricConcept[] = [
  { metric: "revenue", concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "Revenues"] },
  { metric: "operating_income", concepts: ["OperatingIncomeLoss"] },
  { metric: "net_income", concepts: ["NetIncomeLoss"] },
  { metric: "operating_cash_flow", concepts: ["NetCashProvidedByUsedInOperatingActivities"] },
];

function parseIntegerToken(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseReportedDecimals(value: unknown): { value: string | null; status: "declared" | "missing" | "invalid" } {
  if (value == null) return { value: null, status: "missing" };
  if (value === "INF") return { value: "INF", status: "declared" };
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d?)$/.test(value)) return { value: null, status: "invalid" };
  const exponent = Number(value);
  if (!Number.isSafeInteger(exponent) || exponent < -18 || exponent > 18) return { value: null, status: "invalid" };
  return { value: String(exponent), status: "declared" };
}

function validReportedDecimals(value: string): boolean {
  if (value === "INF") return true;
  if (!/^-?(?:0|[1-9]\d?)$/.test(value)) return false;
  const exponent = Number(value);
  return Number.isSafeInteger(exponent) && exponent >= -18 && exponent <= 18;
}

/** Classify arithmetic between returned values against each filing's reported accuracy. */
export function interpretReportedDifference(
  delta: string,
  currentDecimals: string,
  priorDecimals: string,
): "change_exceeds_precision" | "within_reported_precision" | "no_reported_difference" | null {
  if (!validReportedDecimals(currentDecimals) || !validReportedDecimals(priorDecimals)) return null;
  const deltaParts = decimalParts(delta);
  if (!deltaParts) return null;
  const quantum = (reportedDecimals: string): { units: bigint; scale: number } => {
    if (reportedDecimals === "INF") return { units: 0n, scale: 0 };
    const exponent = Number(reportedDecimals);
    return exponent < 0
      ? { units: 10n ** BigInt(-exponent), scale: 0 }
      : { units: 1n, scale: exponent };
  };
  const currentQuantum = quantum(currentDecimals);
  const priorQuantum = quantum(priorDecimals);
  const commonScale = Math.max(deltaParts.scale, currentQuantum.scale, priorQuantum.scale);
  const deltaUnits = deltaParts.units * 10n ** BigInt(commonScale - deltaParts.scale);
  const currentUncertainty = currentQuantum.units * 10n ** BigInt(commonScale - currentQuantum.scale);
  const priorUncertainty = priorQuantum.units * 10n ** BigInt(commonScale - priorQuantum.scale);
  // SEC allows decimals to describe rounding or truncation, so use the full
  // precision quantum for each reported value instead of assuming half-quantum rounding.
  const conservativeBound = currentUncertainty + priorUncertainty;
  const magnitude = deltaUnits < 0n ? -deltaUnits : deltaUnits;
  if (conservativeBound > 0n && magnitude <= conservativeBound) return "within_reported_precision";
  if (conservativeBound === 0n && deltaUnits === 0n) return "no_reported_difference";
  return "change_exceeds_precision";
}

function durationClass(startDate: string | null, endDate: string): PersistedFundamentalFact["durationClass"] {
  if (!startDate) return "unknown";
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (days >= 330 && days <= 400) return "annual";
  if (days >= 65 && days <= 125) return "quarter";
  if (days >= 130 && days <= 210) return "ytd_q2";
  if (days >= 230 && days <= 320) return "ytd_q3";
  return "unknown";
}

interface ParsedCompanyFacts {
  facts: SecFundamentalFactInput[];
  coverage: string[];
}

function parseCompanyFacts(body: unknown, cik: string, submissions: Map<string, SubmissionRow>, retrievedAt: number): ParsedCompanyFacts {
  const root = record(body);
  const factsRoot = record(root?.facts);
  const gaap = record(factsRoot?.["us-gaap"]);
  if (!root || !factsRoot || !gaap || string(root.cik)?.padStart(10, "0") !== cik) {
    throw new SecFundamentalsError("SEC CompanyFacts returned an unexpected issuer or taxonomy structure.");
  }
  const coverage: string[] = [];
  const facts: SecFundamentalFactInput[] = [];
  for (const metricSpec of METRICS) {
    let selectedConcept: string | null = null;
    let acceptedRows: Array<SecFundamentalFactInput & { acceptedAtForOrder: number }> = [];
    let unresolvedPeriodKeys = new Set<string>();
    let unmatched = 0;
    let invalid = 0;
    let precisionMissing = 0;
    let precisionInvalid = 0;
    for (const concept of metricSpec.concepts) {
      const tag = record(gaap[concept]);
      const units = record(tag?.units);
      const usd = array(units?.USD);
      if (!usd?.length) continue;
      const candidates: Array<SecFundamentalFactInput & { acceptedAtForOrder: number }> = [];
      const conceptUnresolvedPeriodKeys = new Set<string>();
      let conceptPrecisionMissing = 0;
      let conceptPrecisionInvalid = 0;
      for (const rawFact of usd) {
        const fact = record(rawFact);
        const form = string(fact?.form);
        if (!form || !["10-Q", "10-Q/A", "10-K", "10-K/A"].includes(form)) continue;
        const accession = string(fact?.accn);
        const startDate = fact?.start == null ? null : isoDate(fact.start);
        const endDate = isoDate(fact?.end);
        const filedDate = isoDate(fact?.filed);
        const filingFocusYear = parseIntegerToken(fact?.fy);
        const fiscalPeriodValue = string(fact?.fp);
        const filingFocusPeriod = fiscalPeriodValue && ["FY", "Q1", "Q2", "Q3"].includes(fiscalPeriodValue) ? fiscalPeriodValue : null;
        const value = normalizeExactDecimal(fact?.val);
        const precision = parseReportedDecimals(fact?.decimals);
        if (!accession || !endDate || !filedDate || (fact?.start != null && !startDate)) {
          invalid += 1;
          continue;
        }
        const unresolvedKey = comparisonKey({ metric: metricSpec.metric, taxonomy: "us-gaap", concept, unit: "USD",
          startDate, endDate, durationClass: durationClass(startDate, endDate) });
        if (value == null) {
          invalid += 1;
          conceptUnresolvedPeriodKeys.add(unresolvedKey);
          continue;
        }
        const submission = submissions.get(accession);
        if (!submission) {
          unmatched += 1;
          conceptUnresolvedPeriodKeys.add(unresolvedKey);
          continue;
        }
        // SEC fy/fp identify the filing's fiscal focus. CompanyFacts can also
        // carry comparative facts from earlier periods in that same filing.
        // Keep those only when their period ended no later than the filing's
        // own report date; period identity comes from start/end below.
        if (submission.form !== form || submission.filingDate !== filedDate || submission.reportDate < endDate) {
          invalid += 1;
          conceptUnresolvedPeriodKeys.add(unresolvedKey);
          continue;
        }
        const startEpoch = startDate ? epochFromDate(startDate) : null;
        const endEpoch = epochFromDate(endDate);
        if (endEpoch == null || (startDate != null && startEpoch == null)
          || (startEpoch != null && startEpoch > endEpoch)) {
          invalid += 1;
          continue;
        }
        const sourceUrl = `${SEC_WEB}/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${submission.primaryDocument}`;
        if (precision.status === "missing") conceptPrecisionMissing += 1;
        if (precision.status === "invalid") conceptPrecisionInvalid += 1;
        candidates.push({
          metric: metricSpec.metric, value, unit: "USD", reportedDecimals: precision.value,
          reportedPrecisionStatus: precision.status, taxonomy: "us-gaap", concept,
          startDate, endDate, filingFocusYear, filingFocusPeriod, form, accession,
          filedAt: epochFromDate(filedDate), acceptedAt: submission.acceptedAt, retrievedAt,
          sourceUrl, durationClass: durationClass(startDate, endDate),
          amended: form.endsWith("/A"), acceptedAtForOrder: submission.acceptedAt,
        });
      }
      if (candidates.length) {
        selectedConcept = concept;
        acceptedRows = candidates;
        unresolvedPeriodKeys = conceptUnresolvedPeriodKeys;
        precisionMissing = conceptPrecisionMissing;
        precisionInvalid = conceptPrecisionInvalid;
        break;
      }
    }
    if (!selectedConcept) {
      coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: no supported us-gaap USD concept with a matching recent filing acceptance record was found.`);
      continue;
    }
    if (metricSpec.concepts.indexOf(selectedConcept) > 0) {
      coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: SEC uses ${selectedConcept}; preferred concepts were unavailable, so no cross-concept comparison is made.`);
    }
    if (unmatched > 0) coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: ${unmatched} fact row(s) lacked a match in the SEC submissions response and were withheld.`);
    if (invalid > 0) coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: ${invalid} malformed or inconsistent fact row(s) were withheld.`);
    if (precisionMissing > 0) coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: ${precisionMissing} saved fact row(s) had no SEC decimals precision field; calculations remain qualified as differences between reported values.`);
    if (precisionInvalid > 0) coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: ${precisionInvalid} fact row(s) had malformed or unsupported SEC decimals metadata; precision-dependent comparisons are withheld.`);
    // Apply the history limit after grouping every filing vintage for an
    // economic period. Cutting raw rows first could hide a conflicting value.
    const periodGroups = new Map<string, typeof acceptedRows>();
    for (const row of acceptedRows) {
      const key = comparisonKey(row);
      const group = periodGroups.get(key) ?? [];
      group.push(row);
      periodGroups.set(key, group);
    }
    const orderedPeriods = [...periodGroups.values()].sort((a, b) => b[0]!.endDate.localeCompare(a[0]!.endDate));
    if (orderedPeriods.length > FACTS_PER_METRIC_LIMIT) coverage.push(`${metricSpec.metric.replaceAll("_", " ")}: only the ${FACTS_PER_METRIC_LIMIT} most recent distinct reported periods are retained.`);
    for (const period of orderedPeriods.slice(0, FACTS_PER_METRIC_LIMIT)) {
      const key = comparisonKey(period[0]!);
      if (unresolvedPeriodKeys.has(key)) {
        coverage.push(`${metricSpec.metric.replaceAll("_", " ")} ${period[0]!.endDate}: a filing row for this period lacks a complete, matched SEC acceptance record; the period is withheld.`);
        continue;
      }
      if (period.length > FACT_VINTAGES_PER_PERIOD_LIMIT) {
        coverage.push(`${metricSpec.metric.replaceAll("_", " ")} ${period[0]!.endDate}: more than ${FACT_VINTAGES_PER_PERIOD_LIMIT} accession-linked vintages exist; this period is withheld to keep revision checks complete.`);
        continue;
      }
      for (const row of period) {
        const { acceptedAtForOrder: _acceptedAtForOrder, ...saved } = row;
        facts.push(saved);
      }
    }
  }
  return { facts, coverage: coverage.slice(0, 200) };
}

export function companyFactsPeriodIdentity(fact: Pick<PersistedFundamentalFact, "metric" | "taxonomy" | "concept" | "unit" | "startDate" | "endDate" | "durationClass">): string {
  // A period is the reported interval, never the fiscal year/period focus of
  // the filing that happened to contain this row.
  return JSON.stringify([fact.metric, fact.taxonomy, fact.concept, fact.unit, fact.startDate, fact.endDate, fact.durationClass]);
}

const comparisonKey = companyFactsPeriodIdentity;

export type FundamentalPeriodFact = Pick<PersistedFundamentalFact,
  "companyId" | "cik" | "metric" | "taxonomy" | "concept" | "unit" | "startDate" | "endDate"
  | "durationClass" | "form" | "accession" | "acceptedAt" | "amended">;

function utcDay(date: string | null): number | null {
  if (date == null || isoDate(date) == null) return null;
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function classifyPeriodAlignment(
  prior: FundamentalPeriodFact,
  current: FundamentalPeriodFact,
): FundamentalPeriodAlignment | null {
  if (prior.companyId !== current.companyId || prior.cik !== current.cik
    || prior.metric !== current.metric || prior.taxonomy !== current.taxonomy
    || prior.concept !== current.concept || prior.unit !== current.unit
    || prior.durationClass === "unknown" || prior.durationClass !== current.durationClass
    || prior.form !== current.form || !prior.accession || prior.accession !== current.accession
    || prior.acceptedAt == null || prior.acceptedAt !== current.acceptedAt
    || prior.amended || current.amended) return null;

  const priorStart = utcDay(prior.startDate);
  const priorEnd = utcDay(prior.endDate);
  const currentStart = utcDay(current.startDate);
  const currentEnd = utcDay(current.endDate);
  if (priorStart == null || priorEnd == null || currentStart == null || currentEnd == null
    || priorEnd < priorStart || currentEnd < currentStart
    || currentStart <= priorStart || currentEnd <= priorEnd) return null;

  if (addOneCalendarYear(prior.startDate) === current.startDate
    && addOneCalendarYear(prior.endDate) === current.endDate) return "calendar_anniversary";

  const startShift = (currentStart - priorStart) / DAY_MS;
  const endShift = (currentEnd - priorEnd) / DAY_MS;
  if (startShift !== endShift || ![364, 371].includes(startShift)
    || currentEnd - currentStart !== priorEnd - priorStart) return null;
  if (current.durationClass === "annual" && currentStart - priorEnd !== DAY_MS) return null;
  return startShift === 364 ? "same_filing_52_week" : "same_filing_53_week";
}

function resolvedFacts(facts: readonly PersistedFundamentalFact[], coverage: string[]): PersistedFundamentalFact[] {
  const groups = new Map<string, PersistedFundamentalFact[]>();
  for (const fact of facts) {
    const key = comparisonKey(fact);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  const result: PersistedFundamentalFact[] = [];
  for (const group of groups.values()) {
    const values = new Set(group.map((fact) => fact.value));
    if (values.size > 1) {
      coverage.push(`${group[0]!.metric.replaceAll("_", " ")} ${group[0]!.endDate}: SEC filings report conflicting values for the same period; the value and comparisons are withheld until the difference is resolved.`);
      continue;
    }
    const precisionMetadata = new Set(group.map((fact) => `${fact.reportedPrecisionStatus}:${fact.reportedDecimals ?? ""}`));
    if (precisionMetadata.size > 1) {
      coverage.push(`${group[0]!.metric.replaceAll("_", " ")} ${group[0]!.endDate}: repeated SEC filings report different precision metadata for the same value; the latest filing is shown and its precision is used.`);
    }
    result.push(group.reduce((latest, candidate) => candidate.acceptedAt! > latest.acceptedAt!
      || (candidate.acceptedAt === latest.acceptedAt && candidate.filedAt! > latest.filedAt!)
      || (candidate.acceptedAt === latest.acceptedAt && candidate.filedAt === latest.filedAt && candidate.accession > latest.accession)
      ? candidate : latest));
  }
  return result.sort((a, b) => b.endDate.localeCompare(a.endDate) || a.metric.localeCompare(b.metric));
}

export function addOneCalendarYear(date: string | null): string | null {
  if (!date || epochFromDate(date) == null) return null;
  const [year, month, day] = date.split("-").map(Number);
  const targetYear = year! + 1;
  const targetMonth = month! - 1;
  const finalDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(month).padStart(2, "0")}-${String(Math.min(day!, finalDay)).padStart(2, "0")}`;
}

function comparisonFor(fact: PersistedFundamentalFact, facts: readonly PersistedFundamentalFact[]): FundamentalComparison {
  if (fact.amended) return { metric: fact.metric, state: "not_comparable", periodAlignment: null, currentFactId: fact.id, priorFactId: null, delta: null, percentChange: null, changeInterpretation: "withheld", reason: "The current fact comes from an amended filing; review the filing before comparing." };
  if (fact.durationClass === "unknown" || fact.startDate == null || fact.acceptedAt == null) {
    return { metric: fact.metric, state: "not_comparable", periodAlignment: null, currentFactId: fact.id, priorFactId: null, delta: null, percentChange: null, changeInterpretation: "withheld", reason: "The reported period duration could not be assigned from its start and end dates." };
  }
  const sameMetric = facts.filter((prior) => prior.id !== fact.id && prior.metric === fact.metric
    && prior.companyId === fact.companyId && prior.cik === fact.cik && prior.form === fact.form
    && prior.taxonomy === fact.taxonomy && prior.concept === fact.concept && prior.unit === fact.unit
    && prior.durationClass === fact.durationClass && prior.endDate < fact.endDate && prior.amended === false
    && prior.acceptedAt != null && prior.accession === fact.accession);
  const priorCandidates = sameMetric.map((prior) => ({ prior, alignment: classifyPeriodAlignment(prior, fact) }))
    .filter((candidate): candidate is { prior: PersistedFundamentalFact; alignment: FundamentalPeriodAlignment } => candidate.alignment != null);
  if (priorCandidates.length !== 1) {
    const similar = sameMetric.length > 0;
    return { metric: fact.metric, state: similar ? "not_comparable" : "insufficient", periodAlignment: null, currentFactId: fact.id, priorFactId: null,
      delta: null, percentChange: null, changeInterpretation: "withheld",
      reason: priorCandidates.length > 1 ? "More than one earlier reported period in this filing matches the date window." : similar
        ? "An earlier reported period exists, but this filing does not provide an exact calendar-anniversary or 52/53-week same-filing date match." : "No same-filing earlier period with the same metric, concept, unit, and reported duration class was saved." };
  }
  const { prior, alignment: periodAlignment } = priorCandidates[0]!;
  const precisionMetadataValid = (candidate: PersistedFundamentalFact): boolean => candidate.reportedPrecisionStatus === "declared"
    ? candidate.reportedDecimals != null && validReportedDecimals(candidate.reportedDecimals)
    : candidate.reportedDecimals === null && (candidate.reportedPrecisionStatus === "missing" || candidate.reportedPrecisionStatus === "invalid");
  if (!precisionMetadataValid(fact) || !precisionMetadataValid(prior)
    || fact.reportedPrecisionStatus === "invalid" || prior.reportedPrecisionStatus === "invalid") {
    return { metric: fact.metric, state: "not_comparable", periodAlignment: null, currentFactId: fact.id, priorFactId: prior.id,
      delta: null, percentChange: null, changeInterpretation: "withheld",
      reason: "SEC reported precision metadata is malformed or outside supported bounds; comparison is withheld." };
  }
  const calculation = decimalComparison(fact.value, prior.value);
  if (!calculation) return { metric: fact.metric, state: "not_comparable", periodAlignment: null, currentFactId: fact.id, priorFactId: prior.id, delta: null, percentChange: null, changeInterpretation: "withheld", reason: "The SEC value could not be parsed as a decimal." };
  const precisionKnown = fact.reportedPrecisionStatus === "declared" && prior.reportedPrecisionStatus === "declared";
  const precisionInterpretation = precisionKnown
    ? interpretReportedDifference(calculation.delta, fact.reportedDecimals!, prior.reportedDecimals!)
    : null;
  if (precisionKnown && precisionInterpretation === null) {
    return { metric: fact.metric, state: "not_comparable", periodAlignment: null, currentFactId: fact.id, priorFactId: prior.id,
      delta: null, percentChange: null, changeInterpretation: "withheld",
      reason: "SEC reported precision metadata could not be interpreted; comparison is withheld." };
  }
  const changeInterpretation: FundamentalComparison["changeInterpretation"] = precisionInterpretation ?? "reported_values_only";
  const precisionWithinBound = changeInterpretation === "within_reported_precision";
  const bothInputsDeclaredExact = fact.reportedDecimals === "INF" && prior.reportedDecimals === "INF";
  const percentChange = !bothInputsDeclaredExact ? null : calculation.percentChange;
  const reasonParts: string[] = [];
  if (!precisionKnown) reasonParts.push("SEC source precision metadata is unavailable; this is arithmetic between returned CompanyFacts values only.");
  else if (precisionWithinBound) reasonParts.push("The reported difference is within a conservative bound based on the SEC decimals fields; direction is unresolved and percentage change is withheld.");
  else if (changeInterpretation === "no_reported_difference") reasonParts.push("No difference was reported between values declared exact in XBRL.");
  else if (fact.reportedDecimals !== "INF" || prior.reportedDecimals !== "INF") reasonParts.push(`Reported precision fields ${fact.reportedDecimals} and ${prior.reportedDecimals}; the calculation uses returned values and does not rescale them.`);
  else reasonParts.push("Both XBRL inputs declare decimals=INF; the calculation uses values as declared in those filings.");
  if (!precisionKnown) reasonParts.push("Percentage change is withheld because the SEC source precision metadata is unavailable.");
  else if (!bothInputsDeclaredExact && !precisionWithinBound) reasonParts.push("Percentage change is withheld because one or both SEC amounts have finite reported precision.");
  else if (percentChange === null && !precisionWithinBound && decimalParts(prior.value)!.units <= 0n) reasonParts.push("Percentage change is withheld because the prior value is zero or negative.");
  return { metric: fact.metric, state: "comparable", periodAlignment, currentFactId: fact.id, priorFactId: prior.id,
    delta: calculation.delta, percentChange, changeInterpretation, reason: reasonParts.length ? reasonParts.join(" ") : null };
}

function derivePoints(facts: readonly PersistedFundamentalFact[]): PersistedFundamentalPoint[] {
  // Keep the chart to one stable series: annual revenue, one exact concept and unit.
  const annualRevenue = facts.filter((fact) => fact.metric === "revenue" && fact.durationClass === "annual" && !fact.amended)
    .sort((a, b) => a.endDate.localeCompare(b.endDate));
  const chosen = annualRevenue[0];
  if (!chosen || annualRevenue.length < 2) return [];
  return annualRevenue.filter((fact) => fact.taxonomy === chosen.taxonomy && fact.concept === chosen.concept && fact.unit === chosen.unit)
    .map((fact) => ({ periodEnd: fact.endDate, metric: fact.metric, value: fact.value, unit: fact.unit,
      reportedDecimals: fact.reportedDecimals, reportedPrecisionStatus: fact.reportedPrecisionStatus }));
}

class SecFundamentalsError extends Error {
  constructor(message: string) { super(message); this.name = "SecFundamentalsError"; }
}

function friendlyError(error: unknown): string {
  if (error instanceof ProviderRateLimitError) return "The SEC rate-limited this refresh; wait for its cooldown before trying again.";
  if (error instanceof ExternalRequestPausedError) return "The refresh stopped because external requests or storage were paused.";
  if (error instanceof StorageCapacityError) return "The refresh stopped because local storage capacity is paused.";
  if (error instanceof SecFundamentalsError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The SEC response timed out; saved fundamentals were retained.";
  return "SEC fundamentals could not be refreshed. Previously saved facts were retained.";
}

export class CompanyFundamentals {
  private readonly db: Desk;
  private readonly externalRequestsEnabled: boolean;
  private readonly secCompanyFactsEnabled: boolean;
  private readonly userAgent: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<FundamentalRefreshResult>>();
  private inflightCompanyId: string | null = null;

  constructor(options: CompanyFundamentalsOptions) {
    this.db = options.db;
    this.externalRequestsEnabled = options.externalRequestsEnabled;
    this.secCompanyFactsEnabled = options.secCompanyFactsEnabled;
    this.userAgent = options.userAgent;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private company(companyId: string): Company | null {
    return this.db.companies().find((candidate) => candidate.id === companyId) ?? null;
  }

  private blockedReason(companyId: string, hasSavedFacts = this.hasSavedFacts(companyId)): string | null {
    if (!this.externalRequestsEnabled) return hasSavedFacts
      ? "External requests are disabled; saved SEC facts remain available."
      : "No SEC facts are saved for this company; external requests are disabled.";
    if (!this.secCompanyFactsEnabled) return "Selected-company facts need the separate sec_company_facts request scope and matching source-use approval.";
    if (!this.userAgent) return "The SEC request identity is not configured for this Sentiment Desk process.";
    if (providerCoolingDown(this.db, "sec", this.now())) return "The SEC provider cooldown is active.";
    if (!this.db.externalRequestAllowed()) return "Local storage capacity is paused; SEC requests are not sent.";
    if (this.inflightCompanyId != null && this.inflightCompanyId !== companyId) return "Another company's SEC refresh is running; retry after it finishes.";
    const latestAttempt = this.db.latestFundamentalAttempt(companyId);
    if (latestAttempt?.status === "running") return "Another SEC fundamentals refresh is already running for this company.";
    return null;
  }

  private hasSavedFacts(companyId: string): boolean {
    const snapshot = this.db.latestCompanyFundamentals(companyId);
    return snapshot != null && resolvedFacts(snapshot.facts, snapshot.coverage).length > 0;
  }

  read(companyId: string): CompanyFundamentalsView {
    const company = this.company(companyId);
    if (!company) throw new Error("unknown_company");
    const snapshot = this.db.latestCompanyFundamentals(companyId);
    const latestAttempt = this.db.latestFundamentalAttempt(companyId);
    const coverage = snapshot?.coverage.slice() ?? [];
    const facts = snapshot ? resolvedFacts(snapshot.facts, coverage) : [];
    const blocked = this.blockedReason(companyId, facts.length > 0);
    const retrievedAt = snapshot?.createdAt ?? null;
    const checkedAt = this.now();
    const staleDelivery = retrievedAt != null && checkedAt - retrievedAt > FRESH_FOR_MS;
    const latestAcceptedAt = facts.reduce<number | null>((latest, fact) =>
      Number.isSafeInteger(fact.acceptedAt) ? Math.max(latest ?? fact.acceptedAt!, fact.acceptedAt!) : latest, null);
    const staleObservation = latestAcceptedAt != null && checkedAt - latestAcceptedAt > OBSERVATION_FRESH_FOR_MS;
    const stale = staleDelivery || staleObservation;
    const staleReasons = [
      staleObservation ? "The newest saved matched SEC filing fact was accepted more than 365 days ago; a recent download does not make its underlying filing current." : null,
      staleDelivery ? "The saved SEC response was last retrieved more than 24 hours ago; refresh to check whether newer filings are available." : null,
    ].filter((reason): reason is string => reason != null);
    const attemptFailedAfterSnapshot = latestAttempt != null && ["failed", "interrupted", "blocked"].includes(latestAttempt.status)
      && (retrievedAt == null || latestAttempt.requestedAt > retrievedAt);
    const state: CompanyFundamentalsView["state"] = !snapshot
      ? latestAttempt && ["failed", "interrupted", "blocked"].includes(latestAttempt.status) ? "failed" : blocked ? "blocked" : "idle"
      : stale ? "stale" : facts.length === 0 && snapshot.state === "empty" ? "empty" : snapshot.state;
    return {
      companyId, state, periodComparisonPolicyVersion: PERIOD_COMPARISON_POLICY_VERSION,
      snapshotId: snapshot?.snapshotId ?? null, facts,
      comparisons: facts.map((fact) => comparisonFor(fact, facts)), points: derivePoints(facts), coverage,
      refreshAllowed: blocked == null,
      refreshBlockedReason: blocked,
      lastRefreshError: attemptFailedAfterSnapshot ? latestAttempt?.error : null,
      staleReason: stale ? staleReasons.join(" ") : null,
      latestAttemptAt: latestAttempt?.requestedAt ?? null, retrievedAt,
    };
  }

  async refresh(companyId: string, requestKey: string): Promise<FundamentalRefreshResult> {
    const key = `${companyId}:${requestKey}`;
    const priorOperation = this.inflight.get(key);
    if (priorOperation) return priorOperation;
    const company = this.company(companyId);
    if (!company) throw new Error("unknown_company");
    const priorAttempt = this.db.fundamentalAttemptByKey(companyId, requestKey);
    if (priorAttempt) {
      if (priorAttempt.status === "running") {
        const reason = "This SEC fundamentals request is already running; retry after it finishes.";
        return { ...this.read(companyId), refresh: "blocked", refreshAllowed: false, refreshBlockedReason: reason };
      }
      return { ...this.read(companyId), refresh: "reused" };
    }
    const blocked = this.blockedReason(companyId);
    if (blocked) return { ...this.read(companyId), refresh: "blocked", refreshAllowed: false, refreshBlockedReason: blocked };
    if (!this.db.prepareExternalWork()) {
      const reason = "Local storage capacity is paused; SEC requests are not sent.";
      return { ...this.read(companyId), refresh: "blocked", refreshAllowed: false, refreshBlockedReason: reason };
    }
    const claim = this.db.claimFundamentalAttempt({ companyId, requestKey, now: this.now() });
    if (claim.kind === "active") {
      const reason = "Another SEC fundamentals refresh is already running for this company.";
      return { ...this.read(companyId), refresh: "blocked", refreshAllowed: false, refreshBlockedReason: reason };
    }
    if (claim.kind === "existing") {
      if (claim.attempt.status === "running") {
        const reason = "This SEC fundamentals request is already running; retry after it finishes.";
        return { ...this.read(companyId), refresh: "blocked", refreshAllowed: false, refreshBlockedReason: reason };
      }
      return { ...this.read(companyId), refresh: "reused" };
    }
    const operation = this.acquire(company, claim.attempt.id);
    this.inflightCompanyId = companyId;
    this.inflight.set(key, operation);
    try { return await operation; }
    finally {
      this.inflight.delete(key);
      if (this.inflightCompanyId === companyId) this.inflightCompanyId = null;
    }
  }

  private async requestJson(url: string, userAgent: string, maxBytes: number): Promise<{ response: SecResponse; body: unknown; itemCount: number }> {
    if (providerCoolingDown(this.db, "sec", this.now())) throw new ProviderRateLimitError("sec", undefined, "SEC provider cooldown is active");
    if (!this.externalRequestsEnabled || !this.secCompanyFactsEnabled || !this.userAgent || !this.db.externalRequestAllowed()) {
      throw new ExternalRequestPausedError();
    }
    await paceProviderRequest("sec", 125);
    if (!this.db.prepareExternalWork()) throw new ExternalRequestPausedError();
    const startedAt = this.now();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(SEC_TIMEOUT_MS),
        headers: { "user-agent": userAgent, accept: "application/json" },
      });
    } catch (error) {
      if (error instanceof ExternalRequestPausedError) throw error;
      if (error instanceof TypeError && /redirect/i.test(error.message)) throw new SecFundamentalsError("SEC redirected the request; this adapter does not follow redirects.");
      throw error;
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      recordProviderRateLimit({ db: this.db, provider: "sec", minDelayMs: 1_000, retryAfterMs, now: this.now() });
      throw new ProviderRateLimitError("sec", retryAfterMs, "SEC fundamentals HTTP 429");
    }
    if (!response.ok) throw new SecFundamentalsError(`SEC returned HTTP ${response.status}; previously saved facts remain available.`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new SecFundamentalsError("SEC returned a response that was not application/json.");
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) {
      try { await response.body?.cancel(); } catch { /* release provider response */ }
      throw new SecFundamentalsError("SEC response exceeded its configured byte limit.");
    }
    if (!response.body) throw new SecFundamentalsError("SEC returned an empty response body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new SecFundamentalsError("SEC response exceeded its configured byte limit.");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const digest = createHash("sha256").update(buffer).digest("hex");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new SecFundamentalsError("SEC returned invalid UTF-8 JSON."); }
    let body: unknown;
    try { body = parseLosslessJson(text); }
    catch { throw new SecFundamentalsError("SEC returned malformed JSON."); }
    const retrievedAt = this.now();
    return { response: { url, startedAt, retrievedAt, body: text, bodyBytes: buffer.byteLength, sha256: digest }, body, itemCount: 1 };
  }

  private async acquire(company: Company, attemptId: string): Promise<FundamentalRefreshResult> {
    const payloads: SecFundamentalPayloadInput[] = [];
    try {
      const directoryResult = await this.requestJson(`${SEC_WEB}/files/company_tickers.json`, this.userAgent, DIRECTORY_MAX_BYTES);
      const directoryPayload = { endpoint: "ticker_directory" as const, ...directoryResult.response, itemCount: directoryResult.itemCount };
      this.db.persistCompanyFundamentalPayloadReceipt({ attemptId, companyId: company.id, payload: directoryPayload });
      payloads.push(directoryPayload);
      const identity = parseCikDirectory(directoryResult.body, company.ticker);

      const submissionsResult = await this.requestJson(`${SEC_DATA}/submissions/CIK${identity.cik}.json`, this.userAgent, SUBMISSIONS_MAX_BYTES);
      const submissionsResponsePayload = { endpoint: "submissions" as const, ...submissionsResult.response, itemCount: submissionsResult.itemCount };
      this.db.persistCompanyFundamentalPayloadReceipt({ attemptId, companyId: company.id, payload: submissionsResponsePayload });
      const submissions = parseRecentSubmissions(submissionsResult.body, identity.cik);
      payloads.push({ ...submissionsResponsePayload, itemCount: submissions.size });

      const factsResult = await this.requestJson(`${SEC_DATA}/api/xbrl/companyfacts/CIK${identity.cik}.json`, this.userAgent, COMPANYFACTS_MAX_BYTES);
      const companyfactsResponsePayload = { endpoint: "companyfacts" as const, ...factsResult.response, itemCount: factsResult.itemCount };
      this.db.persistCompanyFundamentalPayloadReceipt({ attemptId, companyId: company.id, payload: companyfactsResponsePayload });
      const parsed = parseCompanyFacts(factsResult.body, identity.cik, submissions, factsResult.response.retrievedAt);
      payloads.push({ ...companyfactsResponsePayload, itemCount: parsed.facts.length });

      const mergedCoverage = parsed.coverage;
      const state = parsed.facts.length === 0 ? mergedCoverage.length ? "partial" : "empty"
        : mergedCoverage.length > 0 ? "partial" : "ready";
      const saved = this.db.saveCompanyFundamentals({
        attemptId, companyId: company.id, cik: identity.cik, completedAt: this.now(), state,
        coverage: mergedCoverage, payloads, facts: parsed.facts,
      });
      clearProviderRateLimit(this.db, "sec");
      this.db.logEvent("info", "sec-fundamentals", `Saved ${parsed.facts.length} filing-linked SEC fundamentals for ${company.ticker}; snapshot ${saved.snapshotId}.`);
    } catch (error) {
      if (error instanceof ProviderRateLimitError && !providerCoolingDown(this.db, "sec", this.now())) {
        recordProviderRateLimit({ db: this.db, provider: "sec", minDelayMs: 1_000, retryAfterMs: error.retryAfterMs, now: this.now() });
      }
      const message = friendlyError(error);
      try { this.db.failFundamentalAttempt({ attemptId, error: message }); }
      catch (finishError) { this.db.logEvent("error", "sec-fundamentals", `Could not finalize SEC fundamentals attempt: ${String(finishError).slice(0, 200)}`); }
      this.db.logEvent("warn", "sec-fundamentals", `${company.ticker} fundamentals refresh failed: ${message}`);
      return { ...this.read(company.id), refresh: "completed" };
    }
    return { ...this.read(company.id), refresh: "completed" };
  }
}

export function fundamentalRequestKey(): string { return randomUUID(); }
