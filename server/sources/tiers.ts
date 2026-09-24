import type { SourceTier } from "../types.js";

/**
 * Deterministic source-tier prior from the publishing host. The wire tier is
 * reserved for agencies and market-moving first reporters; everything unknown
 * defaults to "trade", which is the honest middle for niche finance media.
 * "filing" outranks everything: an 8-K is the company speaking under penalty
 * of federal law, with an exchange-accepted timestamp.
 */
const RULES: Array<[RegExp, SourceTier]> = [
  [/reuters\.com|apnews\.com|afp\.com|bloomberg\.com/, "wire"],
  [
    /wsj\.com|ft\.com|nytimes\.com|washingtonpost\.com|cnbc\.com|barrons\.com|bbc\.(com|co\.uk)|theguardian\.com|economist\.com/,
    "major",
  ],
  [
    /seekingalpha\.com|benzinga\.com|fool\.com|zacks\.com|investing\.com|barchart\.com|insidermonkey\.com|gurufocus\.com/,
    "blog",
  ],
  [/(^|\.)x\.com|twitter\.com/, "social"],
];

export const TIER_WEIGHT: Record<SourceTier, number> = {
  wire: 1,
  major: 0.9,
  trade: 0.7,
  blog: 0.5,
  social: 0.45,
  filing: 1,
};

export function tierForHost(url: string): SourceTier {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "trade";
  }
  for (const [re, tier] of RULES) {
    if (re.test(host)) return tier;
  }
  return "trade";
}
