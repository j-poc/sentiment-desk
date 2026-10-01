import type { EventType } from "../rubric.js";
import { paceProviderRequest, parseRetryAfterMs, ProviderRateLimitError } from "../provider-cooldown.js";

/**
 * SEC EDGAR as a first-class source. No third-party library needed: EDGAR is
 * free, official, and the submissions API carries acceptanceDateTime with
 * second precision, which is better provenance than any news feed. The fair-
 * access rule is a declared User-Agent with contact info; keep the pacing
 * well under the 10 req/s ceiling.
 *
 * 8-K items map onto the desk's event taxonomy, so a filing arrives already
 * typed: Item 2.02 is results, Item 5.02 is leadership, Item 4.02 is the
 * accounting bombshell.
 */

const SEC_BASE = "https://data.sec.gov";
const SEC_WWW = "https://www.sec.gov";

export interface SecFiling {
  cik: string;
  ticker: string;
  accessionNo: string;
  formType: string;
  items: string[];
  filedAt: number | null; // filingDate, absent if EDGAR did not provide a valid value
  acceptanceAt: number; // acceptanceDateTime, the exchange-accepted instant
  primaryDocUrl: string;
}

/** ticker -> CIK, from the official directory. */
export async function fetchTickerCikMap(userAgent: string): Promise<Map<string, string>> {
  await paceProviderRequest("sec", 125);
  const res = await fetch(`${SEC_WWW}/files/company_tickers.json`, {
    headers: { "user-agent": userAgent, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) throw new ProviderRateLimitError("sec", parseRetryAfterMs(res.headers.get("retry-after")), "SEC ticker directory HTTP 429");
  if (!res.ok) throw new Error(`SEC ticker directory HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("SEC ticker directory returned an invalid response shape");
  }
  const map = new Map<string, string>();
  for (const entry of Object.values(body)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("SEC ticker directory returned a malformed row");
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.ticker !== "string" || row.ticker.trim() === ""
      || typeof row.cik_str !== "number" || !Number.isSafeInteger(row.cik_str) || row.cik_str <= 0) {
      throw new Error("SEC ticker directory row is missing a valid ticker or CIK");
    }
    map.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, "0"));
  }
  return map;
}

interface SubmissionsBody {
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      acceptanceDateTime?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
      items?: Array<string | null>;
    };
  };
}

/** Parse the parallel arrays of a submissions document into recent 8-Ks. */
export function parseRecent8Ks(
  body: SubmissionsBody,
  cik: string,
  ticker: string,
  sinceMs: number,
): SecFiling[] {
  const recent = body.filings?.recent;
  if (!recent || !Array.isArray(recent.form)
    || !Array.isArray(recent.filingDate)
    || !Array.isArray(recent.acceptanceDateTime)
    || !Array.isArray(recent.accessionNumber)
    || !Array.isArray(recent.primaryDocument)) {
    throw new Error("SEC submissions omitted required recent-filing arrays");
  }
  const forms = recent.form;
  if ([recent.filingDate, recent.acceptanceDateTime, recent.accessionNumber, recent.primaryDocument]
    .some((values) => values.length !== forms.length)) {
    throw new Error("SEC submissions recent-filing arrays have inconsistent lengths");
  }
  const out: SecFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (typeof form !== "string") throw new Error("SEC submissions form array contains a malformed row");
    if (form !== "8-K" && form !== "8-K/A") continue;
    const acc = recent.accessionNumber?.[i];
    const acceptance = recent.acceptanceDateTime?.[i];
    if (typeof acc !== "string" || acc.trim() === "" || typeof acceptance !== "string" || acceptance.trim() === "") {
      throw new Error("SEC 8-K row is missing its accession number or acceptance timestamp");
    }
    const acceptanceAt = Date.parse(acceptance);
    if (!Number.isFinite(acceptanceAt)) throw new Error("SEC 8-K row has an invalid acceptance timestamp");
    if (acceptanceAt < sinceMs) continue;

    const primaryDoc = recent.primaryDocument?.[i] ?? "";
    const rawItems = recent.items?.[i] ?? "";
    if (typeof rawItems !== "string") throw new Error("SEC 8-K row contains malformed item codes");
    const items = rawItems
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    out.push({
      cik,
      ticker,
      accessionNo: acc,
      formType: form,
      items,
      filedAt: Number.isFinite(Date.parse(recent.filingDate?.[i] ?? ""))
        ? Date.parse(recent.filingDate?.[i] ?? "")
        : null,
      acceptanceAt,
      primaryDocUrl:
        primaryDoc && primaryDoc.length > 0
          ? `${SEC_WWW}/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/${primaryDoc}`
          : "",
    });
  }
  return out;
}

export async function fetchRecent8Ks(opts: {
  cik: string;
  ticker: string;
  sinceMs: number;
  userAgent: string;
  timeoutMs?: number;
}): Promise<SecFiling[]> {
  await paceProviderRequest("sec", 125);
  const res = await fetch(`${SEC_BASE}/submissions/CIK${opts.cik}.json`, {
    headers: { "user-agent": opts.userAgent, accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (res.status === 429) throw new ProviderRateLimitError("sec", parseRetryAfterMs(res.headers.get("retry-after")), `SEC submissions HTTP 429 for ${opts.ticker}`);
  if (!res.ok) throw new Error(`SEC submissions HTTP ${res.status} for ${opts.ticker}`);
  return parseRecent8Ks((await res.json()) as SubmissionsBody, opts.cik, opts.ticker, opts.sinceMs);
}

export const SEC_PRIMARY_ADAPTER_VERSION = "sec-primary-document/2";

/** Keep the event section inside the bounded state instead of spending it on the cover page. */
export function extractPrimaryDocText(html: string, maxChars = 3_000): string {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("Invalid SEC excerpt limit");
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|ix:header|ix:hidden)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:br|\/?(?:div|p|tr|td|section|h[1-6]))\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_entity, digits: string) => {
      const codePoint = digits[0]?.toLowerCase() === "x"
        ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10);
      return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt|minus|ndash|mdash|lsquo|rsquo|ldquo|rdquo);/gi, (_entity, name: string) => (
      ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", minus: "−", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" } as Record<string, string>)[name.toLowerCase()] ?? _entity
    ));
  // Block boundaries prevent a sentence mentioning an item from being used as a heading.
  const heading = /(?:^|\n)[\t \u00a0]*Item\s+[1-9]\.[0-9]{2}\b/i.exec(text);
  return text.slice(heading?.index ?? 0).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Plain-text extraction from the primary document, bounded for the state block. */
export async function fetchPrimaryDocText(url: string, userAgent: string, maxChars = 3_000): Promise<string> {
  if (!url) return "";
  await paceProviderRequest("sec", 125);
  const res = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/html,text/plain" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new ProviderRateLimitError("sec", parseRetryAfterMs(res.headers.get("retry-after")), "SEC document HTTP 429");
  if (!res.ok) throw new Error(`SEC document HTTP ${res.status}`);
  const html = await res.text();
  return extractPrimaryDocText(html, maxChars);
}

export const ITEM_LABELS: Record<string, string> = {
  "1.01": "Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "2.02": "Results of Operations",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.04": "Triggering Events That Accelerate Obligations",
  "2.05": "Costs Associated With Exit or Disposal",
  "3.01": "Delisting or Failure to Satisfy Listing Rule",
  "4.02": "Non-Reliance on Previously Issued Financials",
  "5.01": "Changes in Control",
  "5.02": "Departure, Appointment of Officers or Directors",
  "5.03": "Amendments to Articles or Bylaws",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

/** 8-K item codes -> the desk's event taxonomy. */
export const ITEM_TO_EVENT: Record<string, EventType> = {
  "1.01": "corporate_action",
  "1.02": "corporate_action",
  "1.03": "legal_regulatory",
  "2.02": "results",
  "2.03": "corporate_action",
  "2.04": "corporate_action",
  "2.05": "results",
  "3.01": "legal_regulatory",
  "3.03": "legal_regulatory",
  "4.02": "results",
  "5.01": "corporate_action",
  "5.02": "leadership",
  "5.03": "leadership",
  "6.02": "leadership",
  "7.01": "other",
  "8.01": "other",
  "9.01": "other",
};

export function eventForItems(items: string[]): EventType {
  for (const item of items) {
    const mapped = ITEM_TO_EVENT[item];
    if (mapped && item !== "9.01") return mapped;
  }
  return "other";
}

export function titleForItems(formType: string, items: string[]): string {
  const meaningful = items.filter((i) => ITEM_LABELS[i] != null);
  if (meaningful.length === 0) return `${formType} filed`;
  const first = meaningful[0];
  if (first == null) return `${formType} filed`;
  const label = ITEM_LABELS[first];
  const rest = meaningful.length - 1;
  return `${formType} ${first} — ${label ?? first}${rest > 0 ? ` (+${rest} more)` : ""}`;
}
