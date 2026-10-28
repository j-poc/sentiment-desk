export const SEC_COMPANYFACTS_URL = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
export const SEC_SUBMISSIONS_URL = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;
export const SEC_COMPANY_DATA_FRESH_FOR_MS = 24 * 60 * 60 * 1_000;
export const SEC_COMPANY_FACT_LIMIT = 50_000;
export const SEC_FILING_LIMIT = 100_000;

export interface SecCompanyFactInput {
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
  fiscal_year: number | null;
  fiscal_period: string | null;
  reported_decimals: string | null;
  frame: string | null;
}

export interface SecFilingInput {
  cik: string;
  accession: string;
  form: string;
  filed_at: string;
  report_period: string | null;
  accepted_at: string | null;
  primary_document: string | null;
  source_url: string;
}

export class SecCompanyDataParseError extends Error {
  constructor(readonly code: string) {
    super(`SEC company data parse failed: ${code}`);
  }
}

const RESEARCH_CONCEPTS = new Set([
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "Revenues",
  "OperatingIncomeLoss",
  "NetIncomeLoss",
  "ProfitLoss",
  "NetCashProvidedByUsedInOperatingActivities",
]);
const SUPPORTED_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "6-K"]);
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function textNumber(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length <= 120 && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return value;
  if (isRecord(value) && value.isLosslessNumber === true && typeof value.toString === "function") {
    const exactText = value.toString();
    return exactText.length <= 120 && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(exactText) ? exactText : null;
  }
  return null;
}

function sourceCik(value: unknown): string | null {
  const losslessText = isRecord(value) && value.isLosslessNumber === true && typeof value.toString === "function"
    ? value.toString() : null;
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value)
    : typeof value === "string" && /^\d{1,10}$/.test(value) ? value
      : typeof losslessText === "string" && /^\d{1,10}$/.test(losslessText) ? losslessText : null;
  return text && Number(text) > 0 && text.length <= 10 ? text.padStart(10, "0") : null;
}

function textInteger(value: unknown): number | null {
  const text = isRecord(value) && value.isLosslessNumber === true && typeof value.toString === "function"
    ? value.toString() : typeof value === "number" ? String(value) : null;
  if (!text || !/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export function parseSecCompanyFacts(body: unknown, expectedCik: string): SecCompanyFactInput[] {
  if (!isRecord(body) || !isRecord(body.facts)) throw new SecCompanyDataParseError("companyfacts_shape_invalid");
  const returnedCik = sourceCik(body.cik);
  if (returnedCik !== expectedCik) throw new SecCompanyDataParseError("companyfacts_cik_mismatch");
  const result: SecCompanyFactInput[] = [];
  for (const [taxonomy, rawFacts] of Object.entries(body.facts)) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(taxonomy) || !isRecord(rawFacts)) continue;
    for (const [concept, rawFact] of Object.entries(rawFacts)) {
      if (!RESEARCH_CONCEPTS.has(concept) || !isRecord(rawFact) || !isRecord(rawFact.units)) continue;
      if (concept.length > 200) continue;
      for (const [unit, rawValues] of Object.entries(rawFact.units)) {
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(unit) || !Array.isArray(rawValues)) continue;
        for (const rawValue of rawValues) {
          if (!isRecord(rawValue)) continue;
          const value = textNumber(rawValue.val);
          const form = typeof rawValue.form === "string" ? rawValue.form : "";
          const accession = typeof rawValue.accn === "string" ? rawValue.accn : "";
          if (value == null || !SUPPORTED_FORMS.has(form) || !ACCESSION_RE.test(accession)
            || !validDate(rawValue.end) || !validDate(rawValue.filed)
            || (rawValue.start != null && !validDate(rawValue.start))) continue;
          if (result.length >= SEC_COMPANY_FACT_LIMIT) throw new SecCompanyDataParseError("companyfacts_fact_limit_exceeded");
          const reportedFy = textInteger(rawValue.fy);
          const fy = reportedFy != null && reportedFy >= 1900 && reportedFy <= 2200 ? reportedFy : null;
          const fp = typeof rawValue.fp === "string" && rawValue.fp.length <= 8 ? rawValue.fp : null;
          const dec = typeof rawValue.dec === "string" && rawValue.dec.length <= 32 ? rawValue.dec : null;
          const frame = typeof rawValue.frame === "string" && rawValue.frame.length <= 24 ? rawValue.frame : null;
          result.push({ cik: expectedCik, taxonomy, concept, unit, value_text: value,
            period_start: typeof rawValue.start === "string" ? rawValue.start : null,
            period_end: rawValue.end, filed_at: rawValue.filed, form, accession,
            fiscal_year: fy, fiscal_period: fp, reported_decimals: dec, frame });
        }
      }
    }
  }
  if (result.length === 0) throw new SecCompanyDataParseError("companyfacts_no_supported_research_facts");
  return result;
}

export function parseSecSubmissions(body: unknown, expectedCik: string): SecFilingInput[] {
  if (!isRecord(body) || !isRecord(body.filings) || !isRecord(body.filings.recent)) {
    throw new SecCompanyDataParseError("submissions_shape_invalid");
  }
  const returnedCik = sourceCik(body.cik);
  if (returnedCik !== expectedCik) throw new SecCompanyDataParseError("submissions_cik_mismatch");
  const recent = body.filings.recent;
  const accession = recent.accessionNumber;
  const form = recent.form;
  const filingDate = recent.filingDate;
  const reportDate = recent.reportDate;
  const accepted = recent.acceptanceDateTime;
  const primaryDocument = recent.primaryDocument;
  if (!Array.isArray(accession) || !Array.isArray(form) || !Array.isArray(filingDate)
    || !Array.isArray(reportDate) || !Array.isArray(accepted) || !Array.isArray(primaryDocument)) {
    throw new SecCompanyDataParseError("submissions_recent_fields_missing");
  }
  const length = accession.length;
  if (length === 0 || length > SEC_FILING_LIMIT || [form, filingDate, reportDate, accepted, primaryDocument].some((items) => items.length !== length)) {
    throw new SecCompanyDataParseError("submissions_recent_fields_misaligned");
  }
  const seen = new Set<string>();
  const result: SecFilingInput[] = [];
  for (let index = 0; index < length; index += 1) {
    const acc = accession[index];
    const frm = form[index];
    const filedAt = filingDate[index];
    if (typeof acc !== "string" || !ACCESSION_RE.test(acc) || typeof frm !== "string" || !/^[A-Za-z0-9.-]{1,20}$/.test(frm)
      || !validDate(filedAt)) continue;
    if (seen.has(acc)) throw new SecCompanyDataParseError("submissions_duplicate_accession");
    seen.add(acc);
    const primary = typeof primaryDocument[index] === "string" && /^[A-Za-z0-9._-]{1,260}$/.test(primaryDocument[index] as string)
      ? primaryDocument[index] as string : null;
    const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${Number(expectedCik)}/${acc.replaceAll("-", "")}/${primary ?? "index.json"}`;
    const report = validDate(reportDate[index]) ? reportDate[index] as string : null;
    const acceptedText = typeof accepted[index] === "string" && Number.isFinite(Date.parse(accepted[index] as string))
      ? new Date(accepted[index] as string).toISOString() : null;
    result.push({ cik: expectedCik, accession: acc, form: frm, filed_at: filedAt as string,
      report_period: report, accepted_at: acceptedText, primary_document: primary, source_url: sourceUrl });
  }
  if (result.length === 0) throw new SecCompanyDataParseError("submissions_no_valid_recent_filings");
  return result;
}
