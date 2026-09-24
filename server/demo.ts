import type { RawMention, JevState } from "./types.js";
import type { JudgeFn } from "./pipeline.js";
import { tierForHost } from "./sources/tiers.js";
import { mentionDigest } from "./scoring.js";

/**
 * Demo mode. Generates synthetic mentions and scores them with a deterministic
 * stub that mimics the Jev answer shape, so the full path (ingest -> judge ->
 * index -> broadcast) runs without a key and without spending money. The UI
 * shows a DEMO badge whenever this is active; demo data never pretends to be
 * market judgment.
 */

interface Template {
  polarity: -1 | 0 | 1;
  text: string;
  material: number;
}

const TEMPLATES: Template[] = [
  { polarity: 1, text: "{name} beats quarterly estimates as data-center revenue jumps {n}%", material: 0.95 },
  { polarity: 1, text: "{name} lands multi-year supply deal worth ${b}B with a top hyperscaler", material: 0.9 },
  { polarity: 1, text: "Analysts upgrade {ticker} to Buy, citing accelerating {seg} demand", material: 0.75 },
  { polarity: 1, text: "{name} announces ${b}B buyback and raises dividend", material: 0.85 },
  { polarity: 1, text: "{name} unveils next-gen {seg} platform, early benchmarks impress", material: 0.7 },
  { polarity: -1, text: "{name} faces antitrust probe over {seg} licensing terms", material: 0.9 },
  { polarity: -1, text: "{name} cuts full-year guidance, warns of softening {seg} demand", material: 0.95 },
  { polarity: -1, text: "Short seller report alleges accounting gaps at {name}", material: 0.85 },
  { polarity: -1, text: "{name} recalls flagship product after safety reports", material: 0.8 },
  { polarity: -1, text: "{name} loses key {seg} contract to rival in competitive rebid", material: 0.85 },
  { polarity: 0, text: "{name} to report quarterly results on the 24th", material: 0.4 },
  { polarity: 0, text: "{name} names new head of {seg} operations", material: 0.45 },
  { polarity: 0, text: "{name} expands European {seg} footprint with new office", material: 0.35 },
  { polarity: 0, text: "Roundup: what analysts said about {ticker} this week", material: 0.3 },
];

const SEGMENTS = ["cloud", "data center", "automotive", "enterprise", "consumer", "advertising"];
const SOURCES = [
  { domain: "reuters.com", name: "Reuters" },
  { domain: "bloomberg.com", name: "Bloomberg" },
  { domain: "cnbc.com", name: "CNBC" },
  { domain: "wsj.com", name: "The Wall Street Journal" },
  { domain: "seekingalpha.com", name: "Seeking Alpha" },
  { domain: "benzinga.com", name: "Benzinga" },
];

export function generateDemoMention(
  companies: Array<{ id: string; name: string; ticker: string; aliases: string[] }>,
  now = Date.now(),
): RawMention & { digest: string } {
  const company = pick(companies);
  const template = pick(TEMPLATES);
  const source = pick(SOURCES);
  const seg = pick(SEGMENTS);
  const title = template.text
    .replaceAll("{name}", company.name)
    .replaceAll("{ticker}", company.ticker)
    .replaceAll("{seg}", seg)
    .replaceAll("{n}", String(20 + Math.floor(Math.random() * 140)))
    .replaceAll("{b}", String(5 + Math.floor(Math.random() * 60)));
  const url = `https://www.${source.domain}/markets/${slugify(title)}-${Math.random().toString(36).slice(2, 8)}`;
  const publishedAt = now - Math.floor(Math.random() * 90_000);
  return {
    companyId: company.id,
    kind: "rss",
    sourceName: source.name,
    sourceUrl: url,
    tier: tierForHost(url),
    title,
    snippet: `${title}. Full coverage at ${source.name}.`,
    publishedAt,
    retrievedAt: now,
    digest: mentionDigest("rss", url, title),
  };
}

/**
 * Deterministic stub judge: same output contract as the real Jev client
 * (choice answer with probabilities, noul answers), driven by a hash of the
 * title so the same mention always scores the same.
 */
export const demoJudge: JudgeFn = async (state: JevState) => {
  const seed = hash(`${state.company.id}|${state.mention.title}`);
  const bias = polarityBias(state.mention.title);
  const jitter = () => (nextRand(seed + jitter.calls++) - 0.5) * 0.24;
  jitter.calls = 0;

  const clamp = (n: number) => Math.min(0.98, Math.max(0.01, n));
  let pPos = clamp(0.33 + bias * 0.42 + jitter());
  let pNeg = clamp(0.33 - bias * 0.42 + jitter());
  let pNeu = clamp(1 - pPos - pNeg);
  // Renormalize into a valid distribution.
  const sum = pPos + pNeg + pNeu;
  pPos /= sum;
  pNeg /= sum;
  pNeu /= sum;

  const tierCred: Record<string, number> = { wire: 0.92, major: 0.85, trade: 0.7, blog: 0.55, social: 0.4 };
  const about = clamp(0.62 + nextRand(seed + 11) * 0.35);
  const material = clamp(Math.max(0.15, templateMaterial(state.mention.snippet)) + (nextRand(seed + 12) - 0.5) * 0.2);
  const novel = clamp(0.25 + nextRand(seed + 13) * 0.7);

  return {
    answers: {
      sentiment: {
        choice: pPos > pNeg && pPos > pNeu ? "positive" : pNeg > pPos && pNeg > pNeu ? "negative" : "neutral",
        probabilities: { positive: round4(pPos), neutral: round4(pNeu), negative: round4(pNeg) },
        confidence: round4(0.55 + nextRand(seed + 14) * 0.44),
      },
      about: { noul: round4(about) },
      material: { noul: round4(material) },
      novel: { noul: round4(novel) },
      credible: { noul: round4(tierCred[state.mention.source.tier] ?? 0.6) },
    },
    model: "demo-sim",
    inputTokens: 900 + (seed % 400),
    outputTokens: 0,
    latencyMs: 25 + (seed % 60),
  };
};

function pick<T>(arr: T[]): T {
  const at = arr[Math.floor(Math.random() * arr.length)];
  if (at === undefined) throw new Error("pick from empty list");
  return at;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function nextRand(seed: number): number {
  const x = Math.sin(seed) * 10_000;
  return x - Math.floor(x);
}

function polarityBias(title: string): number {
  const t = title.toLowerCase();
  const pos = ["beats", "wins", "upgrade", "buyback", "record", "impress", "raises", "jumps", "unveils"];
  const neg = ["probe", "cuts", "warns", "recalls", "loses", "short seller", "softening", "accounting", "sues", "breach"];
  let bias = 0;
  for (const w of pos) if (t.includes(w)) bias += 1;
  for (const w of neg) if (t.includes(w)) bias -= 1;
  return Math.max(-1, Math.min(1, bias));
}

/** Demo templates carry a materiality prior; recover it from the snippet text. */
function templateMaterial(snippet: string): number {
  const t = snippet.toLowerCase();
  if (t.includes("guidance") || t.includes("estimates") || t.includes("supply deal")) return 0.95;
  if (t.includes("probe") || t.includes("recall") || t.includes("short")) return 0.85;
  if (t.includes("report") || t.includes("results") || t.includes("earnings")) return 0.5;
  return 0.4;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-|-$/g, "");
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
