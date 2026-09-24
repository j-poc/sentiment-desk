import { createHash } from "node:crypto";
import type { SourceTier } from "./types.js";
import { validateChoiceAnswer, validateNoulAnswer } from "./jev.js";
import type { EventType } from "./rubric.js";
import { EVENT_TYPES } from "./rubric.js";

/**
 * Pure scoring functions. Everything here is deterministic so any stored score
 * can be recomputed and audited offline, and so tests can pin the exact index
 * behavior the dashboard displays.
 */

export interface ParsedJudgment {
  sentiment: "negative" | "neutral" | "positive";
  pPos: number;
  pNeu: number;
  pNeg: number;
  confidence: number;
  about: number;
  material: number;
  novel: number;
  credible: number;
  investorRelevant: number;
  eventType: EventType;
  magnitude: number;
  surprise: number;
}

const SENTIMENTS = ["negative", "neutral", "positive"] as const;

export class JudgmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgmentError";
  }
}

/**
 * Parse the Jev answers for the sentiment rubric. Fails closed: a missing or
 * out-of-range answer throws and the mention is marked failed, never scored by
 * defaults. Choice ties break alphabetically, mirroring the Go adapter.
 */
export function parseJudgment(answers: Record<string, unknown>): ParsedJudgment {
  const rawSentiment = answers["sentiment"];
  if (rawSentiment == null) throw new JudgmentError("missing sentiment answer");

  const choice = validateChoiceAnswer(rawSentiment);
  const probs = choice.probabilities ?? {};
  const allowed = new Map(
    SENTIMENTS.map((s) => [s, clamp01(probs[s] ?? 0)] as const),
  );

  let sentiment: (typeof SENTIMENTS)[number];
  if (choice.choice != null && (SENTIMENTS as readonly string[]).includes(choice.choice)) {
    sentiment = choice.choice as (typeof SENTIMENTS)[number];
  } else {
    sentiment = topChoice(allowed) as (typeof SENTIMENTS)[number];
  }

  let confidence: number | undefined = choice.confidence;
  if (confidence == null && choice.choice != null) {
    const p = probs[choice.choice];
    if (p != null) confidence = clamp01(p);
  }
  if (confidence == null) confidence = allowed.get(sentiment) ?? 0.5;

  const about = noul(answers, "about");
  const material = noul(answers, "material");
  const novel = noul(answers, "novel");
  const credible = noul(answers, "credible");
  const magnitude = noul(answers, "magnitude");
  const surprise = noul(answers, "surprise");
  const investorRelevant = noul(answers, "investor_relevant");

  const rawEvent = answers["event_type"];
  if (rawEvent == null) throw new JudgmentError("missing event_type answer");
  const eventAnswer = validateChoiceAnswer(rawEvent);
  const eventProbs = eventAnswer.probabilities ?? {};
  const eventType: EventType =
    eventAnswer.choice != null && (EVENT_TYPES as readonly string[]).includes(eventAnswer.choice)
      ? (eventAnswer.choice as EventType)
      : (topChoice(new Map(EVENT_TYPES.map((t) => [t, clamp01(eventProbs[t] ?? 0)]))) as EventType);

  return {
    sentiment,
    pPos: allowed.get("positive") ?? 0,
    pNeu: allowed.get("neutral") ?? 0,
    pNeg: allowed.get("negative") ?? 0,
    confidence: clamp01(confidence),
    about,
    material,
    novel,
    credible,
    investorRelevant,
    eventType,
    magnitude,
    surprise,
  };
}

/**
 * Post-rules: deterministic adjustments so the typed answers cannot contradict
 * the product's hard rules (same philosophy as the coarse-filter post-rules in
 * the newsjack pipeline).
 *
 * 1. Off-target floor. about < 0.5 means the item is not really about the
 *    company; it is kept for display but excluded from every index.
 * 2. Uncertainty damping. confidence < 0.55 damps the weight by 40%: a
 *    low-confidence mention should move the meter less.
 * 3. Weight blend. confidence x materiality x novelty x source tier x
 *    credibility, each a fixed curve, all stored so the number is auditable.
 * 4. Impact is signed: (P(positive) - P(negative)) x 100.
 */
export interface FinalScore {
  sentiment: ParsedJudgment["sentiment"];
  pPos: number;
  pNeu: number;
  pNeg: number;
  confidence: number;
  about: number;
  material: number;
  novel: number;
  credible: number;
  investorRelevant: number;
  eventType: EventType;
  magnitude: number;
  surprise: number;
  /** 0-100 event-strength composite: materiality, surprise, magnitude. */
  eventScore: number;
  impact: number;
  weight: number;
  exclude: boolean;
}

export function applyPostRules(j: ParsedJudgment, sourceWeight: number): FinalScore {
  /** Off-target: not really about the company, or about it only as consumer
   * entertainment / brand lifestyle rather than an investment. Both fail. */
  const exclude = j.about < 0.5 || j.investorRelevant < 0.35;
  const impact = round2((j.pPos - j.pNeg) * 100);
  const dampedConfidence = j.confidence < 0.55 ? j.confidence * 0.6 : j.confidence;
  const weight = round4(
    dampedConfidence *
      (0.55 + 0.45 * j.material) *
      (0.7 + 0.3 * j.novel) *
      sourceWeight *
      (0.5 + 0.5 * j.credible),
  );
  const eventScore = round2(100 * (0.34 * j.material + 0.33 * j.surprise + 0.33 * j.magnitude));
  return { ...j, eventScore, impact, weight, exclude };
}

/* ------------------------------------------------------------------ */
/* Outcome verification: measure the market's actual reaction against  */
/* every judgment. We compute forward returns from stored price points */
/* and report hit rates honestly (reaction is evidence, not causation).*/
/* ------------------------------------------------------------------ */

export interface PriceLike {
  t: number;
  price: number;
}

/** Price of the last known point at or before time t; null if none. */
export function priceAt(points: PriceLike[], t: number): number | null {
  let best: number | null = null;
  for (const p of points) {
    if (p.t <= t) best = p.price;
    else break;
  }
  return best;
}

/**
 * Forward return in % from the last price at or before `t` (plus a small
 * detection allowance) to the last price at or before `t + windowMs`.
 * Null when either end is missing: we never impute a reaction.
 */
export function forwardReturn(points: PriceLike[], t: number, windowMs: number): number | null {
  const p0 = priceAt(points, t + 90_000);
  const p1 = priceAt(points, t + windowMs);
  if (p0 == null || p1 == null || p0 === 0) return null;
  return Math.round(((p1 - p0) / p0) * 10000) / 100;
}

export interface ReactionSummary {
  n: number;
  median30m: number | null;
  median4h: number | null;
  /** Share of events where the 30m reaction matched the judged direction. */
  hitRate: number | null;
}

export function summarizeReactions(
  items: Array<{ sentiment: string; r30: number | null; r240: number | null }>,
): ReactionSummary {
  const usable = items.filter((x) => x.r30 != null || x.r240 != null);
  const median = (arr: number[]): number | null => {
    if (arr.length === 0) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const a = s[mid];
    const b = s[mid - 1];
    if (a == null) return null;
    const value = s.length % 2 ? a : b != null ? (a + b) / 2 : a;
    return Math.round(value * 100) / 100;
  };
  const r30s = usable.map((x) => x.r30).filter((v): v is number => v != null);
  const r240s = usable.map((x) => x.r240).filter((v): v is number => v != null);
  const confirms = usable.filter((x) => {
    const r = x.r30 ?? x.r240;
    if (r == null) return false;
    if (x.sentiment === "negative") return r < 0;
    if (x.sentiment === "positive") return r > 0;
    return Math.abs(r) < 0.25;
  }).length;
  return {
    n: usable.length,
    median30m: median(r30s),
    median4h: median(r240s),
    hitRate: usable.length > 0 ? Math.round((confirms / usable.length) * 100) : null,
  };
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it",
  "its", "of", "on", "or", "says", "s", "that", "the", "to", "was", "were", "will", "with", "after",
  "over", "amid", "report", "reports", "update", "updates",
]);

function tokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().match(/[a-z0-9$%+.]+/g) ?? []) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Cross-source confirmation: group mentions of the same company whose titles
 * are near-duplicates within a 20-minute window. The count tells you how many
 * distinct items cover the same event, which is a rough proxy for how many
 * outlets moved at once.
 */
export function clusterConfirmations(
  ms: Array<{ id: string; title: string; publishedAt: number; companyId: string }>,
  windowMs = 20 * 60_000,
): Map<string, number> {
  const sizes = new Map<string, number>();
  const byCompany = new Map<string, Array<{ id: string; title: string; publishedAt: number }>>();
  for (const m of ms) {
    const list = byCompany.get(m.companyId) ?? [];
    list.push(m);
    byCompany.set(m.companyId, list);
  }
  for (const list of byCompany.values()) {
    list.sort((a, b) => a.publishedAt - b.publishedAt);
    const clusters: Array<{ rep: Set<string>; t: number; ids: string[] }> = [];
    for (const m of list) {
      const tk = tokens(m.title);
      let home: (typeof clusters)[number] | undefined;
      for (const c of clusters) {
        if (m.publishedAt - c.t <= windowMs && jaccard(tk, c.rep) >= 0.4) {
          home = c;
          break;
        }
      }
      if (home) {
        home.ids.push(m.id);
        for (const t of tk) home.rep.add(t);
      } else {
        clusters.push({ rep: new Set(tk), t: m.publishedAt, ids: [m.id] });
      }
    }
    for (const c of clusters) {
      for (const id of c.ids) sizes.set(id, c.ids.length);
    }
  }
  return sizes;
}

/* ------------------------------------------------------------------ */
/* Ingest-time relevance guard. Free and deterministic: finance-context  */
/* lexicon for weak-tier outlets, trusted tiers bypass, cashtag rule for */
/* social. Kills word-collision and lifestyle noise before it costs a    */
/* Jev call. False drops are acceptable: wires re-report anything that   */
/* matters.                                                             */
/* ------------------------------------------------------------------ */

const FINANCE_CONTEXT_RE =
  /\b(stocks?|shares?|share price|market cap|markets?|earnings|revenue|profits?|guidance|outlook|forecast|quarterly|quarter|fiscal|q[1-4]\b|analysts?|upgrade|downgrade|price target|investors?|wall street|dow|s&p|nasdaq|sec\b|filing|filings|8-k|10-k|10-q|ceo|cfo|coo|founder|board of directors|merger|acqui\w+|takeover|buyback|dividend|ipo|lawsuit|sues|sued|probe|antitrust|regulators?|regulatory|fda|doj|ftc|layoffs?|restructuring|bankruptcy|valuation|beats|misses|raises|supply chain|tariffs?|inflation|factory|plant|chip|chips|data center|smartphone|smartphones|handset|handsets|sales fell|sales rose|demand for|deliveries|subscribers|price cut)\b/i;

const MONEY_RE = /[$€£]\s?\d|\b\d+(\.\d+)?\s?(billion|million|bn)\b/i;

export interface RelevanceCheck {
  title: string;
  snippet: string;
  tier: string;
  kind: string;
  ticker: string;
}

/**
 * True when the item plausibly concerns the company as a business. Trusted
 * finance/official venues pass on tier alone; everything else must show a
 * finance-context term, a money amount, or (for social) a cashtag.
 */
export function isFinanceRelevant(check: RelevanceCheck): boolean {
  if (check.tier === "filing") return true;
  if (check.tier === "wire" || check.tier === "major") return true;
  if ((check.kind === "x" || check.kind === "reddit") &&
    new RegExp(`\\$${check.ticker}\\b`, "i").test(check.title)) {
    return true;
  }
  const hay = `${check.title} ${check.snippet}`;
  return FINANCE_CONTEXT_RE.test(hay) || MONEY_RE.test(hay);
}

export interface WeightedMention {
  publishedAt: number;
  impact: number;
  weight: number;
}

/** Weighted mean impact in [-100, 100]; null when there is nothing to average. */
export function weightedIndex(mentions: WeightedMention[]): number | null {
  let wSum = 0;
  let wImpact = 0;
  for (const m of mentions) {
    wSum += m.weight;
    wImpact += m.weight * m.impact;
  }
  if (wSum <= 0) return null;
  return round2(wImpact / wSum);
}

export interface SeriesBucket {
  t: number;
  v: number | null;
  n: number;
}

/** Bucket mentions into fixed time slots; null value where a slot has no scored mentions. */
export function bucketSeries(
  mentions: WeightedMention[],
  windowMs: number,
  bucketMs: number,
  nowMs: number,
): SeriesBucket[] {
  const start = nowMs - windowMs;
  const buckets = new Map<number, { w: number; wi: number; n: number }>();
  for (const m of mentions) {
    if (m.publishedAt < start || m.publishedAt > nowMs) continue;
    const t = Math.floor(m.publishedAt / bucketMs) * bucketMs;
    const b = buckets.get(t) ?? { w: 0, wi: 0, n: 0 };
    b.w += m.weight;
    b.wi += m.weight * m.impact;
    b.n += 1;
    buckets.set(t, b);
  }
  const out: SeriesBucket[] = [];
  const first = Math.floor(start / bucketMs) * bucketMs;
  for (let t = first; t <= nowMs; t += bucketMs) {
    const b = buckets.get(t);
    out.push({
      t,
      v: b && b.w > 0 ? round2(b.wi / b.w) : null,
      n: b?.n ?? 0,
    });
  }
  return out;
}

/** Content digest binding mention identity to source, URL, and title. */
export function mentionDigest(kind: string, url: string, title: string): string {
  const normalizedUrl = url.trim().replace(/#.*$/, "").replace(/\?utm_\w+=[^&]*/g, "");
  return createHash("sha256").update(`${kind}|${normalizedUrl}|${title.trim()}`).digest("hex").slice(0, 40);
}

function noul(answers: Record<string, unknown>, key: string): number {
  const raw = answers[key];
  if (raw == null) throw new JudgmentError(`missing ${key} answer`);
  const parsed = validateNoulAnswer(raw);
  return clamp01(parsed.noul);
}

function topChoice(probs: Map<string, number>): string {
  let best = "";
  let bestP = -1;
  const keys = [...probs.keys()].sort();
  for (const k of keys) {
    const p = probs.get(k) ?? -1;
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export type { SourceTier };
