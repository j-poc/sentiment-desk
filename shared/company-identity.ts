export interface IdentityCheck {
  company: { name: string; ticker: string; aliases: string[]; ambiguous?: boolean };
  title: string;
  snippet: string;
  scoped: boolean;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Require issuer-specific evidence when a company name is lexically ambiguous.
 * A ticker-targeted feed is a collection hint, not proof that every returned
 * headline concerns that issuer.
 */
export function hasStrongIdentity(input: IdentityCheck): boolean {
  if (!input.company.ambiguous) return true;
  const haystack = `${input.title} ${input.snippet}`;
  const ticker = input.company.ticker.trim();
  const escapedTicker = escapeRe(ticker);
  const tickerMatchesCompanyName = ticker.toLocaleUpperCase("en-US") === input.company.name.trim().toLocaleUpperCase("en-US");
  const explicitSelectedTicker = new RegExp(`(?:\\$\\s*)?\\b${escapedTicker}\\b`, "i").test(haystack);
  const legalCompanyName = new RegExp(`${escapeRe(input.company.name)}\\s*(inc|corp|corporation|plc|ltd)\\b`, "i").test(haystack);
  const headlineLeadTicker = input.title.trim().match(/^(?:is\s+)?[^()]{1,90}\(([A-Z][A-Z0-9.-]{0,5})\)(?=\s|:|$)/i)?.[1];
  // A product/person alias can be incidental when another listed issuer leads
  // the headline (for example, AT&T coverage that mentions an iPhone launch).
  // Keep it in identity review unless the selected issuer is also explicitly
  // named by its ticker or legal corporate name. This preserves joint-issuer
  // stories such as "AT&T (T) and Apple (AAPL)".
  if (headlineLeadTicker && headlineLeadTicker.toLocaleUpperCase("en-US") !== ticker.toLocaleUpperCase("en-US")
    && !explicitSelectedTicker && !legalCompanyName) return false;
  if ((explicitSelectedTicker && !tickerMatchesCompanyName) || legalCompanyName) return true;
  const escapedName = escapeRe(input.company.name.trim());
  const companyNameContext = new RegExp(
    `(?:\\b${escapedName}\\b(?:\\W+\\w+){0,3}\\W+(?:shares?|stocks?|earnings|revenue|guidance|dividend|buyback|valuation|price\\s+target|market\\s+cap(?:italization)?|sales|profit|loss|results|quarter(?:ly)?)|(?:shares?|stocks?|earnings|revenue|guidance|dividend|buyback|valuation|price\\s+target|market\\s+cap(?:italization)?|sales|profit|loss|results|quarter(?:ly)?)(?:\\W+\\w+){0,3}\\W+\\b${escapedName}\\b)`,
    "i",
  );
  const appleAgricultureNamesake = input.company.name.trim().toLocaleLowerCase("en-US") === "apple"
    && /\bapple\s+juice\b|\b(?:apple|fruit)\s+(?:growers?|farmers?|orchards?|orchardists?|harvests?|crops?|trees?)\b|\b(?:growers?|farmers?|orchards?|orchardists?|harvests?|crops?|frost)\b.{0,35}\bapples?\b/i.test(haystack);
  if (appleAgricultureNamesake) return false;
  if (tickerMatchesCompanyName) {
    // Some issuers use everyday acronyms as tickers (AMD is also a common
    // abbreviation for age-related macular degeneration). Require a market,
    // financial, or product cue near the acronym instead of treating every
    // occurrence as the issuer. Distinctive configured aliases below remain
    // sufficient evidence on their own.
    const escapedTicker = escapeRe(ticker);
    const marketContext = new RegExp(`(?:\\$${escapedTicker}\\b|\\b(?:NASDAQ|NYSE|NYSEAMERICAN|AMEX|OTC(?:QX|QB)?)\\s*:\\s*${escapedTicker}\\b)`, "i");
    if (marketContext.test(haystack)) return true;
    const medicalContext = /\b(?:dry|wet)\s+(?:age[- ]related\s+)?(?:macular\s+degeneration|amd)\b|\bage[- ]related\s+macular\s+degeneration\b|\b(?:macular\s+degeneration|retinal?|ophthalm(?:ic|ology)|vision\s+loss|eye\s+disease)\b.{0,40}\bAMD\b|\bAMD\b.{0,40}\b(?:macular\s+degeneration|retinal?|ophthalm(?:ic|ology)|vision\s+loss|eye\s+disease)\b/i;
    if (medicalContext.test(haystack)) return false;
    const issuerContext = new RegExp(
      `(?:\\b${escapedTicker}\\b(?:\\W+\\w+){0,3}\\W+(?:shares?|stock|ticker|trading|earnings|revenue|fiscal|demand|orders|outlook|forecast|guidance|semiconductor|chip(?:maker)?|processor|accelerators?|gpu|cpu|ryzen|instinct)|(?:shares?|stock|ticker|trading|earnings|revenue|fiscal|demand|orders|outlook|forecast|guidance|semiconductor|chip(?:maker)?|processor|accelerators?|gpu|cpu|ryzen|instinct)(?:\\W+\\w+){0,3}\\W+\\b${escapedTicker}\\b)`,
      "i",
    );
    if (issuerContext.test(haystack) || companyNameContext.test(haystack)) return true;
    if (new RegExp(`${escapeRe(input.company.name)}\\s*(inc|corp|corporation|plc|ltd)\\b`, "i").test(haystack)) return true;
    for (const alias of input.company.aliases) {
      if (alias.trim().toLocaleLowerCase("en-US") === input.company.name.trim().toLocaleLowerCase("en-US")) continue;
      if (new RegExp(`\\b${escapeRe(alias)}\\b`, "i").test(haystack)) return true;
    }
    return false;
  } else if (new RegExp(`\\$?${escapeRe(ticker)}\\b`, "i").test(haystack)) {
    return true;
  }
  if (new RegExp(`${escapeRe(input.company.name)}\\s*(inc|corp|corporation|plc|ltd)\\b`, "i").test(haystack)) return true;
  for (const alias of input.company.aliases) {
    // A duplicate of the ambiguous issuer name adds no identity evidence.
    if (alias.trim().toLocaleLowerCase("en-US") === input.company.name.trim().toLocaleLowerCase("en-US")) continue;
    if (new RegExp(`\\b${escapeRe(alias)}\\b`, "i").test(haystack)) return true;
  }
  return companyNameContext.test(haystack);
}
