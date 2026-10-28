import type { FundamentalPeriodAlignment, PersistedFundamentalFact } from "./company-fundamentals.js";

const DAY_MS = 86_400_000;

export type FundamentalPeriodFact = Pick<PersistedFundamentalFact,
  "companyId" | "cik" | "metric" | "taxonomy" | "concept" | "unit" | "startDate" | "endDate"
  | "durationClass" | "form" | "accession" | "acceptedAt" | "amended">;

function epoch(date: string | null): number | null {
  if (date == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isSafeInteger(value) && new Date(value).toISOString().slice(0, 10) === date ? value : null;
}

export function addOneCalendarYear(date: string | null): string | null {
  if (!date || epoch(date) == null) return null;
  const [year, month, day] = date.split("-").map(Number);
  const targetYear = year! + 1;
  const targetMonth = month! - 1;
  const finalDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(month).padStart(2, "0")}-${String(Math.min(day!, finalDay)).padStart(2, "0")}`;
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

  const priorStart = epoch(prior.startDate);
  const priorEnd = epoch(prior.endDate);
  const currentStart = epoch(current.startDate);
  const currentEnd = epoch(current.endDate);
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
