import type { EventType } from "../rubric.js";

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
  filedAt: number; // filingDate
  acceptanceAt: number; // acceptanceDateTime, the exchange-accepted instant
  primaryDocUrl: string;
}

/** ticker -> CIK, from the official directory. */
export async function fetchTickerCikMap(userAgent: string): Promise<Map<string, string>> {
  const res = await fetch(`${SEC_WWW}/files/company_tickers.json`, {
    headers: { "user-agent": userAgent, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`SEC ticker directory HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
  const map = new Map<string, string>();
  for (const entry of Object.values(body)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
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
  if (!recent) return [];
  const forms = recent.form ?? [];
  const out: SecFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (form !== "8-K" && form !== "8-K/A") continue;
    const acc = recent.accessionNumber?.[i];
    const acceptance = recent.acceptanceDateTime?.[i];
    if (!acc || !acceptance) continue;
    const acceptanceAt = Date.parse(acceptance);
    if (!Number.isFinite(acceptanceAt) || acceptanceAt < sinceMs) continue;

    const primaryDoc = recent.primaryDocument?.[i] ?? "";
    const items = (recent.items?.[i] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    out.push({
      cik,
      ticker,
      accessionNo: acc,
      formType: form,
      items,
      filedAt: Date.parse(recent.filingDate?.[i] ?? acceptance) || acceptanceAt,
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
  const res = await fetch(`${SEC_BASE}/submissions/CIK${opts.cik}.json`, {
    headers: { "user-agent": opts.userAgent, accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`SEC submissions HTTP ${res.status} for ${opts.ticker}`);
  return parseRecent8Ks((await res.json()) as SubmissionsBody, opts.cik, opts.ticker, opts.sinceMs);
}

/** Plain-text extraction from the primary document, bounded for the state block. */
export async function fetchPrimaryDocText(url: string, userAgent: string, maxChars = 3_000): Promise<string> {
  if (!url) return "";
  const res = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/html,text/plain" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`SEC document HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
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
