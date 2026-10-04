import type { EventType } from "../rubric.js";
import { paceProviderRequest, parseRetryAfterMs, ProviderRateLimitError } from "../provider-cooldown.js";
import { createHash } from "node:crypto";
import type { SecDocumentAttempt, SecDocumentContext, SecDocumentRole, SecItem202Link } from "../types.js";
import { ExternalRequestPausedError } from "../external-request-gate.js";

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
export const SEC_EVIDENCE_ADAPTER_VERSION = "sec-filing-evidence/1";
const SEC_DOCUMENT_LIMIT = 2_097_152;
const SEC_DOCUMENT_TIMEOUT = 15_000;
const HTML_VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
type VisibleTag = { name: string; suppressesText: boolean };
function closeVisibleTag(stack: VisibleTag[], name: string): void {
  const index = stack.map((tag) => tag.name).lastIndexOf(name);
  if (index >= 0) stack.splice(index);
}
function textIsSuppressed(stack: VisibleTag[]): boolean { return stack.some((tag) => tag.suppressesText); }

function secDirectory(filing: SecFiling): string | null {
  if (!/^\d{1,10}$/.test(filing.cik) || !/^\d{10}-\d{2}-\d{6}$/.test(filing.accessionNo)) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(filing.cik)}/${filing.accessionNo.replace(/-/g, "")}/`;
}

function validatedDocumentUrl(raw: string, filing: SecFiling): string | null {
  const directory = secDirectory(filing);
  if (!directory || !raw || raw.length > 2048 || raw.startsWith("//") || raw.includes("\\") || /%2f|%5c/i.test(raw)) return null;
  // Inspect the original path before URL() can normalize dot segments.
  const path = raw.startsWith("https://www.sec.gov") ? raw.slice("https://www.sec.gov".length) : raw;
  if (path.split("/").some((part) => part === "." || part === "..") || /%2e|%25(?:2f|5c)/i.test(raw)
    || /[?#]/.test(raw) || /^https:\/\/www\.sec\.gov:\d+/i.test(raw)) return null;
  try {
    const url = new URL(raw, directory);
    if (url.protocol !== "https:" || url.origin !== "https://www.sec.gov" || url.username || url.password || url.port
      || url.search || url.hash || !/^https:\/\/www\.sec\.gov\//i.test(url.href)) return null;
    if (!url.href.startsWith(directory) || !/^[^/]+\.htm(?:l)?$/i.test(url.href.slice(directory.length))) return null;
    return url.href;
  } catch { return null; }
}

function decodeHtml(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_m, digits: string) => {
    const n = digits[0]?.toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
  }).replace(/&(nbsp|amp|quot|apos|lt|gt|minus|ndash|mdash);/gi, (_m, n: string) => ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", minus: "−", ndash: "–", mdash: "—" } as Record<string, string>)[n.toLowerCase()] ?? " ");
}

type ExhibitSelection = { kind: "unique"; url: string } | { kind: "missing" | "ambiguous" | "invalid" };
type ExhibitSelectionDetail = { kind: "unique"; url: string; description: string } | { kind: "missing" | "ambiguous" | "invalid" };
function selectLinkedEarningsExhibit(primaryHtml: string, filing: SecFiling): ExhibitSelectionDetail {
  if (primaryHtml.length > SEC_DOCUMENT_LIMIT) return { kind: "invalid" };
  const rows: Array<{ cells: Array<{ text: string; hrefs: string[] }>; current: { text: string; hrefs: string[] } | null }> = [];
  const stack: VisibleTag[] = [];
  let row: (typeof rows)[number] | null = null;
  let cell: { text: string; hrefs: string[] } | null = null;
  let anchor: { href: string; text: string } | null = null;
  const safeMarkup = primaryHtml
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|ix:header|ix:hidden)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const tokens = safeMarkup.match(/<![^>]*>|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.length > 200_000) return { kind: "invalid" };
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<!") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const name = /^<\/\s*([\w:-]+)/.exec(token)?.[1]?.toLowerCase();
      if (!name) return { kind: "invalid" };
      if (name === "a" && anchor) { if (cell && anchor.href) cell.hrefs.push(anchor.href); anchor = null; }
      if (name === "td" || name === "th") { if (row && cell) row.cells.push(cell); cell = null; }
      if (name === "tr") { if (row) rows.push(row); row = null; cell = null; }
      closeVisibleTag(stack, name);
      continue;
    }
    if (!token.startsWith("<")) {
      if (!textIsSuppressed(stack)) { const text = decodeHtml(token); if (cell) cell.text += text; if (anchor) anchor.text += text; }
      continue;
    }
    const match = /^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/.exec(token);
    if (!match) return { kind: "invalid" };
    const name = match[1]!.toLowerCase(), attrs = match[2]!;
    const hidden = /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || /style\s*=\s*(["'])[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs);
    const suppressesText = hidden || ["script", "style", "noscript", "svg", "ix:header", "ix:hidden"].includes(name);
    if (!textIsSuppressed(stack) && !suppressesText) {
      if (name === "tr") { if (row) rows.push(row); row = { cells: [], current: null }; }
      if ((name === "td" || name === "th") && row) cell = { text: "", hrefs: [] };
      if (name === "a" && cell) {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        anchor = { href: decodeHtml(href?.[1] ?? href?.[2] ?? href?.[3] ?? ""), text: "" };
      }
    }
    if (!/\/\s*>$/.test(token) && !HTML_VOID_ELEMENTS.has(name)) stack.push({ name, suppressesText });
    else if (name === "td" || name === "th") { if (row && cell) row.cells.push(cell); cell = null; }
  }
  if (row) rows.push(row);
  const targets: Array<{ url: string; description: string }> = [];
  let invalid = false;
  for (const candidate of rows) {
    const numberCell = candidate.cells.findIndex((c) => c.text.replace(/\s+/g, " ").trim() === "99.1");
    if (numberCell < 0) continue;
    const description = candidate.cells.slice(numberCell + 1).map((c) => c.text.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
    const hrefs = candidate.cells.flatMap((c) => c.hrefs);
    if (!hrefs.length) continue;
    for (const raw of hrefs) {
      const url = validatedDocumentUrl(raw, filing);
      if (!url || url === filing.primaryDocUrl) invalid = true;
      else targets.push({ url, description });
    }
  }
  if (invalid) return { kind: "invalid" };
  const unique = [...new Map(targets.map((target) => [target.url, target])).values()];
  return unique.length === 1 ? { ...unique[0]!, kind: "unique" } : unique.length ? { kind: "ambiguous" } : { kind: "missing" };
}
export function findLinkedEarningsExhibit(primaryHtml: string, filing: SecFiling): ExhibitSelection {
  const result = selectLinkedEarningsExhibit(primaryHtml, filing);
  return result.kind === "unique" ? { kind: "unique", url: result.url } : result;
}

function visibleTextForLinkage(html: string): string {
  const safeMarkup = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|ix:header|ix:hidden)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const tokens = safeMarkup.match(/<![^>]*>|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.length > 200_000) return "";
  const stack: VisibleTag[] = [], out: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("<!") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const name = /^<\/\s*([\w:-]+)/.exec(token)?.[1]?.toLowerCase(); if (!name) return "";
      const wasSuppressed = textIsSuppressed(stack);
      closeVisibleTag(stack, name);
      if (!wasSuppressed && ["p", "div", "tr", "td", "th", "section", "h1", "h2", "h3", "h4"].includes(name)) out.push("\n");
    } else if (token.startsWith("<")) {
      const match = /^<\s*([\w:-]+)([\s\S]*?)\/?>$/.exec(token); if (!match) return "";
      const name = match[1]!.toLowerCase(), attrs = match[2]!;
      const suppressesText = name === "table" || /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || /style\s*=\s*(["'])[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs)
        || ["script", "style", "noscript", "svg", "ix:header", "ix:hidden"].includes(name);
      const wasSuppressed = textIsSuppressed(stack);
      if (!wasSuppressed && !suppressesText && ["p", "div", "tr", "td", "th", "section", "h1", "h2", "h3", "h4"].includes(name)) out.push("\n");
      if (!wasSuppressed && !suppressesText && name === "br") out.push(" ");
      if (!/\/\s*>$/.test(token) && !HTML_VOID_ELEMENTS.has(name)) stack.push({ name, suppressesText });
    } else if (!textIsSuppressed(stack)) out.push(decodeHtml(token));
  }
  return out.join("").replace(/[\t \u00a0]+/g, " ").replace(/ *\n */g, "\n");
}

function visibleMarkupForExcerpt(html: string): string {
  const safeMarkup = html.replace(/<!--[\s\S]*?-->/g, " ");
  const tokens = safeMarkup.match(/<![^>]*>|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.length > 200_000) return "";
  const stack: VisibleTag[] = [], out: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<!") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const name = /^<\/\s*([\w:-]+)/.exec(token)?.[1]?.toLowerCase();
      if (!name) return "";
      const suppressed = textIsSuppressed(stack);
      closeVisibleTag(stack, name);
      if (!suppressed) out.push(token);
      continue;
    }
    if (!token.startsWith("<")) {
      if (!textIsSuppressed(stack)) out.push(token);
      continue;
    }
    const match = /^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/.exec(token);
    if (!match) return "";
    const name = match[1]!.toLowerCase(), attrs = match[2]!;
    const suppressesText = /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)
      || /style\s*=\s*(["'])[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs)
      || ["script", "style", "noscript", "svg", "ix:header", "ix:hidden"].includes(name);
    if (!textIsSuppressed(stack) && !suppressesText) out.push(token);
    if (!/\/\s*>$/.test(token) && !HTML_VOID_ELEMENTS.has(name)) stack.push({ name, suppressesText });
  }
  return out.join("");
}

type SecDocumentKind = "press_release" | "shareholder_letter" | "update";
type ResultsDeclaration =
  | { kind: "results_artifact"; documentKind: "press_release" | "update"; text: string }
  | { kind: "event_only"; text: string }
  | { kind: "unverified" };

function splitVisibleStatements(text: string): string[] {
  const result: string[] = [];
  for (const block of text.split(/\n+/)) {
    let start = 0;
    for (let index = 0; index < block.length; index++) {
      const char = block[index]!;
      if (char !== "." && char !== "?" && char !== "!") continue;
      if (char === "." && (/[0-9]/.test(block[index + 1] ?? "") || /\b(?:inc|corp|co|ltd|llc|plc|u\.s|u\.k)\.$/i.test(block.slice(start, index + 1).trim()))) continue;
      let next = index + 1;
      while (/\s/.test(block[next] ?? "")) next++;
      if (next < block.length && !/[A-Z“"'(]/.test(block[next]!)) continue;
      const statement = block.slice(start, index + 1).trim();
      if (statement) result.push(statement);
      start = next;
      index = next - 1;
    }
    const tail = block.slice(start).trim();
    if (tail) result.push(tail);
  }
  return result;
}

function classifyResultsDeclaration(text: string): ResultsDeclaration {
  const declaresResults = /\b(?:announc(?:ed|ing)|issu(?:ed|ing)|report(?:ed|ing)|releas(?:ed|ing)|post(?:ed|ing))\b[^.!?]{0,500}\bresults\b/i.test(text);
  if (!declaresResults) return { kind: "unverified" };
  const release = /\bpress\s+release\b/i.test(text);
  const update = /\bupdate\b/i.test(text);
  const letter = /\bletter to shareholders\b/i.test(text);
  const kinds = Number(release) + Number(update) + Number(letter);
  if (kinds === 0) return { kind: "event_only", text };
  if (kinds !== 1 || letter) return { kind: "unverified" };
  if (release && (text.match(/\bpress release\b/gi)?.length ?? 0) !== 1) return { kind: "unverified" };
  const releaseDeclaresResults = /\bpress\s+release\b[^.!?]{0,180}\b(?:announc\w*|concern\w*|regard\w*|report\w*)\b[^.!?]{0,120}\bresults\b/i.test(text)
    || /\bresults\b[^.!?]{0,220}\bin a press release\b/i.test(text)
    || /\bissuing a press release and holding a conference call regarding its financial results\b/i.test(text);
  if (release && releaseDeclaresResults) return { kind: "results_artifact", documentKind: "press_release", text };
  const updateDeclaresResults = /\bresults\b[^.!?]{0,100}\bby posting its [^.!?]{1,100}\bupdate\b/i.test(text);
  if (update && updateDeclaresResults) return { kind: "results_artifact", documentKind: "update", text };
  return { kind: "unverified" };
}

function exhibitNumbers(text: string): string[] {
  return [...text.matchAll(/\bExhibits?\s+99\.\s*[1-9]\b/gi)].map((m) => m[0].replace(/\s+/g, " ").toUpperCase().replace("99. ", "99."));
}

function hasExhibit99_1(text: string): boolean {
  const numbers = exhibitNumbers(text), selected = numbers.indexOf("EXHIBIT 99.1");
  return selected >= 0 && !numbers.some((number, index) => number !== "EXHIBIT 99.1" && index < selected);
}

function tableKinds(description: string): SecDocumentKind[] {
  const kinds: SecDocumentKind[] = [];
  if (/\bpress release\b/i.test(description)) kinds.push("press_release");
  if (/\bletter to shareholders\b/i.test(description)) kinds.push("shareholder_letter");
  if (/\bupdate\b/i.test(description)) kinds.push("update");
  return kinds;
}

function findItem202Link(html: string, tableDescription: string): SecItem202Link {
  const visible = visibleTextForLinkage(html);
  const headings = [...visible.matchAll(/\bitem\s+([1-9]\.\d{2})\b/gi)];
  const sections: string[] = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!; if (heading[1]!.toLowerCase() !== "2.02") continue;
    const end = headings.slice(index + 1).find((entry) => entry[1]!.toLowerCase() !== "2.02")?.index ?? visible.length;
    const section = visible.slice(heading.index!, end).slice(0, 20_000).trim(); if (section) sections.push(section);
  }
  if (!sections.length) return { kind: "unverified", reason: "missing_item_body" };
  let sawDifferentExhibit = false;
  const hasAttachmentFor = (text: string, kind: SecDocumentKind, route: "named" | "event_only"): boolean => {
    if (!hasExhibit99_1(text)) { if (exhibitNumbers(text).some((number) => number !== "EXHIBIT 99.1")) sawDifferentExhibit = true; return false; }
    if (kind === "press_release" && route === "named") {
      const subject = /^(The press release|A copy of this press release|A copy of the press release)/i.exec(text);
      if (!subject) return false;
      return /^is attached(?: hereto)? as Exhibit 99\.1\b/i.test(text.slice(subject[0].length).trimStart())
        || /^is furnished and attached hereto as Exhibit 99\.1\b/i.test(text.slice(subject[0].length).trimStart())
        || /^is furnished as Exhibit 99\.1\b/i.test(text.slice(subject[0].length).trimStart());
    }
    if (kind === "press_release" && route === "event_only") return /^A copy of the press release containing the announcement is included as Exhibit 99\.1\b/i.test(text);
    if (kind === "update" && route === "named") return /^The full text of the update is attached hereto as Exhibit 99\.1\b/i.test(text);
    if (kind === "shareholder_letter" && route === "event_only") return /^The Letter to Shareholders, which is attached hereto as Exhibit 99\.1(?: and is incorporated herein by reference)?, includes reference to the non-GAAP financial information\b/i.test(text);
    return false;
  };
  for (const section of sections) {
    const statements = splitVisibleStatements(section);
    for (let index = 0; index < statements.length; index++) {
      const declaration = classifyResultsDeclaration(statements[index]!);
      if (declaration.kind === "unverified") continue;
      let kind: SecDocumentKind | null = declaration.kind === "results_artifact" ? declaration.documentKind : null;
      let support: string | null = null;
      const currentStatement = statements[index]!;
      const sameStatementRelease = kind === "press_release"
        && (currentStatement.match(/\bpress release\b/gi)?.length ?? 0) === 1
        && /\bresults\b[^.!?]{0,220}\bin a press release that is attached hereto as Exhibit 99\.1\b/i.test(currentStatement)
        && hasExhibit99_1(currentStatement);
      if (sameStatementRelease) {
        support = currentStatement;
      } else if (kind !== null && hasAttachmentFor(statements[index + 1] ?? "", kind, "named")) {
        support = `${statements[index]} ${statements[index + 1]}`;
      } else if (declaration.kind === "event_only") {
        const next = statements[index + 1] ?? "";
        if (hasAttachmentFor(next, "press_release", "event_only")) { kind = "press_release"; support = `${statements[index]} ${next}`; }
        else if (hasAttachmentFor(next, "shareholder_letter", "event_only")
          && /\breconciliation to the GAAP equivalent\b[^.!?]*\bExhibit 99\.1\b/i.test(statements[index + 2] ?? "")) {
          kind = "shareholder_letter";
          support = `${statements[index]} ${next} ${statements[index + 2]}`;
        }
      }
      if (!support) continue;
      if (support.length > 1500) return { kind: "unverified", reason: "ambiguous_results_reference" };
      const rowKinds = tableKinds(tableDescription);
      if (rowKinds.length !== 1 || rowKinds[0] !== kind) return { kind: "unverified", reason: "conflicting_table_description" };
      return { kind: "linked", itemCode: "2.02", exhibitNumber: "99.1", supportingText: support };
    }
  }
  return { kind: "unverified", reason: sawDifferentExhibit ? "different_results_exhibit" : "missing_results_attachment_reference" };
}

export interface SecFilingEvidence {
  context: SecDocumentContext;
  selected: { role: SecDocumentRole; url: string; excerpt: string; retrievedAt: number; bodySha256: string } | null;
  result: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid";
  rateLimit: { retryAfterMs?: number; phase: SecDocumentRole } | null;
}

type SecFetchedDocument = SecDocumentAttempt & { documentHtml?: string; retryAfterMs?: number };
async function requestSecDocument(url: string, role: SecDocumentRole, userAgent: string, htmlRequired = true, visibleOnly = false): Promise<SecFetchedDocument> {
  const startedAt = Date.now();
  await paceProviderRequest("sec", 125);
  let observedStatus: number | null = null;
  let cancelResponseBody: (() => Promise<void>) | undefined;
  try {
    const response = await fetch(url, { redirect: "manual", headers: { "user-agent": userAgent, accept: "text/html" }, signal: AbortSignal.timeout(SEC_DOCUMENT_TIMEOUT) });
    observedStatus = response.status;
    cancelResponseBody = async () => { try { await response.body?.cancel(); } catch { /* best-effort release of an unread response */ } };
    if (response.status === 429) { await cancelResponseBody(); return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: 429, outcome: "rate_limited", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "http_429", retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) ?? undefined }; }
    if (response.status >= 300 && response.status < 400) { await cancelResponseBody(); return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: response.status, outcome: "invalid", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "redirect_rejected" }; }
    if (!response.ok) { await cancelResponseBody(); return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: response.status, outcome: "failed", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "http_error" }; }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (htmlRequired && !["text/html", "application/xhtml+xml"].includes(type)) { await cancelResponseBody(); return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: response.status, outcome: "invalid", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "content_type" }; }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > SEC_DOCUMENT_LIMIT) { await cancelResponseBody(); return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: response.status, outcome: "invalid", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "body_too_large" }; }
    if (!response.body) return { role, url, startedAt, completedAt: Date.now(), retrievedAt: Date.now(), httpStatus: response.status, outcome: "empty", bodyBytes: 0, bodySha256: createHash("sha256").digest("hex"), excerpt: "", errorCode: null };
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; cancelResponseBody = async () => { try { await reader.cancel(); } catch { /* best-effort stream cancellation */ } }; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > SEC_DOCUMENT_LIMIT) { await reader.cancel(); return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: response.status, outcome: "invalid", bodyBytes: bytes, bodySha256: null, excerpt: "", errorCode: "body_too_large" }; } chunks.push(value); }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const documentHtml = new TextDecoder().decode(body);
    const retrievedAt = Date.now(), excerpt = extractPrimaryDocText(visibleOnly ? visibleMarkupForExcerpt(documentHtml) : documentHtml);
    return { role, url, startedAt, completedAt: Date.now(), retrievedAt, httpStatus: response.status, outcome: excerpt ? "success" : "empty", bodyBytes: body.length, bodySha256: createHash("sha256").update(body).digest("hex"), excerpt, errorCode: null, documentHtml };
  } catch (error) {
    await cancelResponseBody?.();
    if (error instanceof ExternalRequestPausedError) {
      const dispatched = error.dispatchedRequests > 0;
      return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null,
        httpStatus: dispatched ? error.lastHttpStatus : null,
        outcome: dispatched ? "failed" : "paused", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "storage_paused" };
    }
    const message = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed";
    return { role, url, startedAt, completedAt: Date.now(), retrievedAt: null, httpStatus: observedStatus, outcome: "failed", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: message };
  }
}

export async function fetchFilingEvidence(filing: SecFiling, userAgent: string): Promise<SecFilingEvidence> {
  const now = Date.now(), primaryUrl = validatedDocumentUrl(filing.primaryDocUrl, filing);
  const context: SecDocumentContext = { version: "sec-document-context/1", cik: filing.cik, accessionNo: filing.accessionNo,
    primaryUrl: filing.primaryDocUrl, acceptedAt: filing.acceptanceAt, filedAt: filing.filedAt,
    classificationInputStatus: "incomplete", selectionReason: "primary_unavailable", item202Link: null, selectedRole: null, selectedUrl: null, documents: [] };
  if (!primaryUrl) { context.documents.push({ role: "8k_primary", url: filing.primaryDocUrl.slice(0, 2048), startedAt: now, completedAt: Date.now(), retrievedAt: null, httpStatus: null, outcome: "invalid", bodyBytes: null, bodySha256: null, excerpt: "", errorCode: "invalid_primary_url" }); return { context, selected: null, result: "invalid", rateLimit: null }; }
  const primary = await requestSecDocument(primaryUrl, "8k_primary", userAgent, true, true);
  const { documentHtml: primaryHtml, ...primaryAttempt } = primary;
  context.documents.push(primaryAttempt);
  if (primary.outcome === "paused") {
    context.selectionReason = "storage_paused";
    return { context, selected: null, result: "partial", rateLimit: null };
  }
  if (primary.outcome === "rate_limited") return { context, selected: null, result: "rate_limited", rateLimit: { retryAfterMs: primary.retryAfterMs, phase: primary.role } };
  if (primary.outcome !== "success") return { context, selected: null, result: primary.outcome === "empty" ? "empty" : primary.outcome, rateLimit: null };
  if (!filing.items.includes("2.02")) {
    context.classificationInputStatus = "ready"; context.selectionReason = "primary_selected"; context.selectedRole = primary.role; context.selectedUrl = primary.url;
    return { context, selected: { role: primary.role, url: primary.url, excerpt: primary.excerpt, retrievedAt: primary.retrievedAt!, bodySha256: primary.bodySha256! }, result: "success", rateLimit: null };
  }
  const candidate = selectLinkedEarningsExhibit(primaryHtml ?? "", filing);
  if (candidate.kind !== "unique") {
    context.selectionReason = candidate.kind === "missing" ? "missing_exhibit" : candidate.kind === "ambiguous" ? "ambiguous_exhibit" : "invalid_exhibit_link";
    return { context, selected: null, result: "partial", rateLimit: null };
  }
  const itemLink = findItem202Link(primaryHtml ?? "", candidate.description);
  context.item202Link = itemLink;
  if (itemLink.kind !== "linked") { context.selectionReason = "unverified_event_link"; return { context, selected: null, result: "partial", rateLimit: null }; }
  const exhibitUrl = validatedDocumentUrl(candidate.url, filing);
  if (!exhibitUrl || exhibitUrl === primaryUrl) {
    context.selectionReason = "invalid_exhibit_link";
    return { context, selected: null, result: "partial", rateLimit: null };
  }
  const exhibit = await requestSecDocument(exhibitUrl, "earnings_exhibit_99_1", userAgent, true, true);
  const { documentHtml: _exhibitHtml, ...exhibitAttempt } = exhibit;
  context.documents.push(exhibitAttempt);
  if (exhibit.outcome === "paused") { context.selectionReason = "storage_paused"; return { context, selected: null, result: "partial", rateLimit: null }; }
  if (exhibit.outcome === "rate_limited") { context.selectionReason = "exhibit_unavailable"; return { context, selected: null, result: "rate_limited", rateLimit: { retryAfterMs: exhibit.retryAfterMs, phase: exhibit.role } }; }
  if (exhibit.outcome !== "success") { context.selectionReason = "exhibit_unavailable"; return { context, selected: null, result: "partial", rateLimit: null }; }
  context.classificationInputStatus = "ready"; context.selectionReason = "unique_exhibit_selected";
  context.selectedRole = exhibit.role; context.selectedUrl = exhibit.url;
  return { context, selected: { role: exhibit.role, url: exhibit.url, excerpt: exhibit.excerpt, retrievedAt: exhibit.retrievedAt!, bodySha256: exhibit.bodySha256! }, result: "success", rateLimit: null };
}

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
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || maxChars > 3_000) throw new Error("Invalid SEC excerpt limit");
  const doc = await requestSecDocument(url, "8k_primary", userAgent, false);
  if (doc.outcome === "rate_limited") throw new ProviderRateLimitError("sec", doc.retryAfterMs, "SEC document HTTP 429");
  if (doc.outcome === "failed" || doc.outcome === "invalid") throw new Error(`SEC document ${doc.errorCode ?? doc.outcome}`);
  return doc.excerpt.slice(0, maxChars);
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
