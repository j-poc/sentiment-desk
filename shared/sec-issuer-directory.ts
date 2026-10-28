export const SEC_ISSUER_DIRECTORY_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
export const SEC_ISSUER_DIRECTORY_FRESH_FOR_MS = 24 * 60 * 60 * 1_000;
export const SEC_ISSUER_DIRECTORY_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;
export const MAX_SEC_ISSUER_DIRECTORY_SEARCH_ROWS = 50;
export const MAX_SEC_ISSUER_RESEARCH_SUBJECTS = 500;

/** An identity in the SEC's exchange ticker mapping; this does not prove an active listing. */
export interface SecIssuerDirectoryEntry {
  cik: string;
  name: string;
  ticker: string;
  exchange: string | null;
}

export type SecIssuerDirectoryParseErrorCode = "invalid_shape" | "malformed_row" | "invalid_identity";

export class SecIssuerDirectoryParseError extends Error {
  constructor(readonly code: SecIssuerDirectoryParseErrorCode) {
    super(`SEC issuer directory parse failed: ${code}`);
    this.name = "SecIssuerDirectoryParseError";
  }
}

/** One canonical validator shared by the local development path and cloud ingest. */
export function parseSecIssuerDirectoryEntries(body: unknown): SecIssuerDirectoryEntry[] {
  const root = body != null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const fields = root?.fields;
  const rows = root?.data;
  if (!root || Object.keys(root).length !== 2 || !Array.isArray(fields) || !Array.isArray(rows)
    || fields.length !== 4 || rows.length > 100_000
    || fields.some((field) => typeof field !== "string")
    || new Set(fields).size !== fields.length
    || !["cik", "name", "ticker", "exchange"].every((field) => fields.includes(field))) {
    throw new SecIssuerDirectoryParseError("invalid_shape");
  }
  const column = Object.fromEntries(fields.map((field, index) => [field as string, index]));
  const entries: SecIssuerDirectoryEntry[] = [];
  const unique = new Set<string>();
  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length !== fields.length) {
      throw new SecIssuerDirectoryParseError("malformed_row");
    }
    const rawCik = raw[column.cik!];
    const rawTicker = raw[column.ticker!];
    const rawName = raw[column.name!];
    const exchange = raw[column.exchange!];
    const cikText = typeof rawCik === "number" && Number.isSafeInteger(rawCik) ? String(rawCik)
      : typeof rawCik === "string" ? rawCik.trim() : "";
    const ticker = typeof rawTicker === "string" ? rawTicker.trim().toUpperCase() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!/^\d{1,10}$/.test(cikText) || Number(cikText) === 0
      || !/^[A-Z0-9.\-]{1,14}$/.test(ticker)
      || !name || name.length > 512 || /[\u0000-\u001f\u007f]/u.test(name)
      || (exchange !== null && (typeof exchange !== "string" || exchange.length > 80 || /[\u0000-\u001f\u007f]/u.test(exchange)))) {
      throw new SecIssuerDirectoryParseError("invalid_identity");
    }
    const cik = cikText.padStart(10, "0");
    const key = `${cik}\u0000${ticker}`;
    if (unique.has(key)) throw new SecIssuerDirectoryParseError("invalid_identity");
    unique.add(key);
    entries.push({ cik, ticker, name, exchange: exchange as string | null });
  }
  if (entries.length === 0) throw new SecIssuerDirectoryParseError("invalid_shape");
  return entries;
}

export interface SecIssuerDirectoryReceipt {
  source: typeof SEC_ISSUER_DIRECTORY_URL;
  retrievedAt: string;
  sha256: string;
  rowCount: number;
}

/** Validated SEC mapping cached locally so search stays offline after download. */
export interface SecIssuerDirectorySnapshot {
  source: typeof SEC_ISSUER_DIRECTORY_URL;
  retrievedAt: string;
  sha256: string;
  /** Exact UTF-8 response text whose bytes are committed by sha256. */
  sourceBody: string;
  entries: SecIssuerDirectoryEntry[];
}

export interface SecIssuerDirectoryView {
  state: "not_loaded" | "ready" | "empty" | "stale" | "failed" | "rate_limited" | "unavailable";
  freshness: "current" | "stale" | "unknown";
  query: string;
  rows: SecIssuerDirectoryEntry[];
  receipt: SecIssuerDirectoryReceipt | null;
  canRefresh: boolean;
  nextRefreshAt: string | null;
  message: string | null;
}

/** A saved CIK-scoped research subject. It stays outside the monitored watchlist. */
export interface SecIssuerResearchSubject {
  kind: "sec_issuer_research";
  companyId: string;
  cik: string;
  ticker: string;
  name: string;
  exchange: string | null;
  identityReceipt: {
    source: typeof SEC_ISSUER_DIRECTORY_URL;
    retrievedAt: string;
    sha256: string;
  };
  createdAt: number;
}
