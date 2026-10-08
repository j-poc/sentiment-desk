export interface SecFilingInboxRow {
  accession: string;
  cik: string;
  /** EDGAR login CIK encoded in the accession; it can differ from the issuer CIK. */
  accessionCik?: string;
  /** CIK component of the official SEC archive path; it can differ from both CIKs above. */
  filingCikPath?: string;
  issuer: string;
  /** The shared Hub profile is deliberately limited to the exact SEC form 8-K. */
  form: "8-K";
  filedOn: string | null;
  acceptedAt: string | null;
  /** SEC Atom entry publication time; this is not a filing date or acceptance time. */
  feedPublishedAt: string | null;
  feedUpdatedAt: string | null;
  filingUrl: string;
}

/** Stable identity for an SEC filing as surfaced for a specific issuer. Joint filings may share an accession. */
export function secFilingIdentity(row: Pick<SecFilingInboxRow, "cik" | "accession">): string {
  return `${row.cik}:${row.accession}`;
}

/** Read the official archive-path CIK from a previously validated SEC filing URL. */
export function secFilingArchiveCikPath(filingUrl: string, accession: string): string | null {
  try {
    const url = new URL(filingUrl);
    const match = url.pathname.match(/^\/Archives\/edgar\/data\/([0-9]{1,10})\/([0-9]{18})\/([0-9]{10}-[0-9]{2}-[0-9]{6})-index\.htm$/);
    if (url.protocol !== "https:" || url.hostname !== "www.sec.gov" || url.port || url.username || url.password || url.search || url.hash
      || !match || match[2] !== accession.replaceAll("-", "") || match[3] !== accession) return null;
    return match[1] ?? null;
  } catch {
    return null;
  }
}

export interface SecFilingsInboxView {
  state: "ready" | "stale" | "empty" | "pending" | "rate_limited" | "failed" | "not_configured" | "unsupported" | "unavailable";
  /** Freshness of the SEC source observation, independent of when the Hub retrieved the saved receipt. */
  freshness: "current" | "stale" | "unknown";
  rows: SecFilingInboxRow[];
  receiptId: string | null;
  retrievedAt: string | null;
  feedUpdatedAt: string | null;
  jobStatus: string | null;
  canActivate: boolean;
  nextRefreshAt: string | null;
  message: string | null;
}

export const SEC_FILINGS_FRESHNESS_BUDGET_MS = 30 * 60 * 1000;

/** Derives observation freshness from the SEC source clock, never from retrieval time. */
export function secFilingsSourceFreshness(feedUpdatedAt: string | null, now = Date.now()): SecFilingsInboxView["freshness"] {
  if (!feedUpdatedAt) return "unknown";
  const observedAt = Date.parse(feedUpdatedAt);
  if (!Number.isFinite(observedAt)) return "unknown";
  return now >= observedAt && now - observedAt <= SEC_FILINGS_FRESHNESS_BUDGET_MS ? "current" : "stale";
}

/** Time until the next source-freshness transition, or null when no future transition is known. */
export function secFilingsFreshnessNextCheckMs(feedUpdatedAt: string | null, now = Date.now()): number | null {
  if (!feedUpdatedAt) return null;
  const observedAt = Date.parse(feedUpdatedAt);
  if (!Number.isFinite(observedAt)) return null;
  const transitionAt = now < observedAt ? observedAt : observedAt + SEC_FILINGS_FRESHNESS_BUDGET_MS + 1;
  return transitionAt > now ? transitionAt - now : null;
}

/** A durable analyst task anchored to the exact SEC filing that prompted it. */
export interface SecFilingResearchTask {
  cik: string;
  issuer: string;
  triggeringAccession: string;
  filingUrl: string;
  nextQuestion: string;
  feedReceiptId: string;
  feedUpdatedAt: string | null;
  retrievedAt: string | null;
  savedAt: string;
}

export const MAX_SEC_RESEARCH_QUESTION_CHARS = 500;

/** An on-demand, exact-accession SEC read. Excerpts are source text, never a model summary. */
export interface SecFilingDetail {
  state: "ready" | "partial" | "not_found" | "paused" | "rate_limited" | "failed";
  cik: string;
  accession: string;
  filingUrl: string;
  filingDate: string | null;
  reportDate: string | null;
  acceptedAt: string | null;
  metadataRetrievedAt: string | null;
  items: Array<{ code: string; label: string | null }>;
  selectionReason: string | null;
  selectedRole: "8k_primary" | "earnings_exhibit_99_1" | null;
  documents: Array<{
    role: "8k_primary" | "earnings_exhibit_99_1";
    url: string;
    outcome: "success" | "empty" | "failed" | "invalid" | "rate_limited" | "paused";
    retrievedAt: string | null;
    bodySha256: string | null;
    excerpt: string;
    errorCode: string | null;
  }>;
  message: string | null;
}

/** Removes the machine-only suffix appended to company names in SEC Atom titles. */
export function secIssuerDisplayName(value: string): string {
  return value.replace(/\s+\([0-9]{10}\)\s+\(Filer\)$/i, "").trim() || value;
}
