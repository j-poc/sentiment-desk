/**
 * Find exchange-style ticker references that differ from the desk issuer.
 * This is a review cue, not an entity-resolution verdict: comparison and
 * value-chain stories can legitimately name several public companies.
 */
export function otherExplicitTickerSymbols(
  text: string,
  issuerTicker: string,
  knownTickers: readonly string[] = [],
): string[] {
  const expected = normalizeTicker(issuerTicker);
  if (!expected) return [];
  const known = new Set(knownTickers.map(normalizeTicker));

  const symbols = new Set<string>();
  const patterns = [
    /\b(?:NASDAQ|NYSE|NYSEAMERICAN|AMEX|OTC(?:QX|QB)?)\s*:\s*([A-Z][A-Z0-9.-]{0,5})\b/gi,
    /(?:^|\s)\$([A-Z][A-Z0-9.-]{0,5})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const symbol = normalizeTicker(match[1] ?? "");
      if (symbol && symbol !== expected) symbols.add(symbol);
    }
  }
  const parentheticalTicker = /\(([A-Z][A-Z0-9.-]{0,5})\)/g;
  for (const match of text.matchAll(parentheticalTicker)) {
    const symbol = normalizeTicker(match[1] ?? "");
    const afterSymbol = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 36);
    // Plain parentheses also contain common acronyms (FDA, BTK, CEO). Treat
    // them as a ticker only with nearby stock/price language; exchange and
    // dollar-prefixed symbols above remain explicit without this extra cue.
    const tickerContext = /^\s*(?:stock|shares?\b|ticker\b|price\b|trades?\b|rose\b|rises\b|fell\b|drops?\b|gained\b|jumped\b)/i.test(afterSymbol);
    if ((known.has(symbol) || tickerContext) && symbol && symbol !== expected) symbols.add(symbol);
  }
  return [...symbols].sort();
}

/**
 * Catch a narrow, legible issuer-context mismatch: a headline led by another
 * possessive company name while the saved excerpt mentions the desk company.
 * This is only a prompt to check relevance; it does not resolve the article's
 * subject or suppress a legitimate comparison/value-chain story.
 */
export function differentPossessiveHeadlineSubject(
  title: string,
  snippet: string,
  issuerName: string,
  issuerTicker: string,
): string | null {
  const subject = title.match(/^\s*["“]?([\p{Lu}][\p{L}\p{N}&.-]*(?:\s+[\p{Lu}][\p{L}\p{N}&.-]*){0,3})[’']s(?:\s|:)/u)?.[1];
  if (!subject) return null;

  const normalizedSubject = normalizeCompanyName(subject);
  const normalizedIssuer = normalizeCompanyName(issuerName);
  const issuerNameParts = normalizedIssuer.split(" ");
  if (!normalizedSubject || !normalizedIssuer ||
      normalizedSubject === normalizedIssuer ||
      normalizedSubject.startsWith(`${normalizedIssuer} `) ||
      normalizedIssuer.startsWith(`${normalizedSubject} `) ||
      issuerNameParts.includes(normalizedSubject)) return null;

  const normalizedSnippet = normalizeCompanyName(snippet);
  const tickerPattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(normalizeTicker(issuerTicker))}([^A-Z0-9]|$)`, "i");
  if (!normalizedSnippet.includes(normalizedIssuer) && !tickerPattern.test(snippet)) return null;

  return subject;
}

/** Whether an article path names the issuer; this never verifies page contents. */
export function sourceLinkPathNamesCompany(sourceUrl: string, issuerName: string): boolean {
  try {
    const path = decodeURIComponent(new URL(sourceUrl).pathname).replace(/[-_]+/gu, " ");
    const normalizedPath = ` ${normalizeCompanyName(path)} `;
    const normalizedIssuer = normalizeCompanyName(issuerName);
    return Boolean(normalizedIssuer && normalizedPath.includes(` ${normalizedIssuer} `));
  } catch {
    return false;
  }
}

function normalizeCompanyName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|holdings?)\b/gu, " ")
    .replace(/\band\b/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the\s+/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTicker(value: string): string {
  return value.trim().replace(/^\$/, "").toLocaleUpperCase("en-US");
}
