export interface IdentityCheck {
  company: { name: string; ticker: string; aliases: string[]; ambiguous?: boolean };
  title: string;
  snippet: string;
  scoped: boolean;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Require issuer-specific evidence when a company name is lexically ambiguous. */
export function hasStrongIdentity(input: IdentityCheck): boolean {
  if (!input.company.ambiguous) return true;
  if (input.scoped) return true;
  const haystack = `${input.title} ${input.snippet}`;
  if (new RegExp(`\\$?${escapeRe(input.company.ticker)}\\b`, "i").test(haystack)) return true;
  if (new RegExp(`${escapeRe(input.company.name)}\\s*(inc|corp|corporation|plc|ltd)\\b`, "i").test(haystack)) return true;
  for (const alias of input.company.aliases) {
    // A duplicate of the ambiguous issuer name adds no identity evidence.
    if (alias.trim().toLocaleLowerCase("en-US") === input.company.name.trim().toLocaleLowerCase("en-US")) continue;
    if (new RegExp(`\\b${escapeRe(alias)}\\b`, "i").test(haystack)) return true;
  }
  return false;
}
