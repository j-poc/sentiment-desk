import type { SourceTier } from "./types.js";
import { validateChoiceAnswer, validateNoulAnswer } from "./jev.js";
import type { EventType, TakeawayKey } from "./rubric.js";
import { EVENT_TYPES, RUBRIC, TAKEAWAY_KEYS } from "./rubric.js";

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
  takeaway: TakeawayKey;
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
  const expectedAnswers = Object.keys(RUBRIC).sort();
  const actualAnswers = Object.keys(answers).sort();
  if (
    actualAnswers.length !== expectedAnswers.length ||
    actualAnswers.some((key, index) => key !== expectedAnswers[index])
  ) {
    throw new JudgmentError("Jev answer names do not match the fixed rubric");
  }

  const sentimentAnswer = parseChoice(answers["sentiment"], "sentiment", SENTIMENTS);
  const sentiment = sentimentAnswer.choice;
  const confidence = sentimentAnswer.confidence;

  const about = noul(answers, "about");
  const material = noul(answers, "material");
  const novel = noul(answers, "novel");
  const credible = noul(answers, "credible");
  const magnitude = noul(answers, "magnitude");
  const surprise = noul(answers, "surprise");
  const investorRelevant = noul(answers, "investor_relevant");

  const eventType: EventType = parseChoice(answers["event_type"], "event_type", EVENT_TYPES).choice;
  const takeaway: TakeawayKey = parseChoice(answers["takeaway"], "takeaway", TAKEAWAY_KEYS).choice;

  const pPos = requiredProbability(sentimentAnswer.probabilities, "positive", "sentiment");
  const pNeu = requiredProbability(sentimentAnswer.probabilities, "neutral", "sentiment");
  const pNeg = requiredProbability(sentimentAnswer.probabilities, "negative", "sentiment");

  return {
    sentiment,
    pPos,
    pNeu,
    pNeg,
    confidence,
    about,
    material,
    novel,
    credible,
    investorRelevant,
    eventType,
    magnitude,
    surprise,
    takeaway,
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
  takeaway: TakeawayKey;
  /** 0-100 event-strength composite: materiality, surprise, magnitude. */
  eventScore: number;
  impact: number;
  weight: number;
  exclude: boolean;
}

/**
 * Identity bar for lexically ambiguous companies: ticker, corporate suffix,
 * an unambiguous alias, or a symbol-scoped source. "Apple beats estimates"
 * from a text match has none of these — the model's about score must then
 * clear a much higher bar.
 */
export interface IdentityCheck {
  company: { name: string; ticker: string; aliases: string[]; ambiguous?: boolean };
  title: string;
  snippet: string;
  scoped: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasStrongIdentity(p: IdentityCheck): boolean {
  if (!p.company.ambiguous) return true;
  if (p.scoped) return true;
  const hay = `${p.title} ${p.snippet}`;
  if (new RegExp(`\\$?${escapeRe(p.company.ticker)}\\b`, "i").test(hay)) return true;
  if (new RegExp(`${escapeRe(p.company.name)}\\s*(inc|corp|corporation|plc|ltd)\\b`, "i").test(hay)) return true;
  for (const alias of p.company.aliases) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`, "i").test(hay)) return true;
  }
  return false;
}

export function applyPostRules(
  j: ParsedJudgment,
  sourceWeight: number,
  opts?: { strictAbout?: boolean },
): FinalScore {
  /** Off-target: not really about the company, about it only as consumer
   * entertainment / brand lifestyle, or — for lexically ambiguous companies
   * matched by text alone — not identified strongly enough. */
  const aboutFloor = opts?.strictAbout ? 0.8 : 0.5;
  const relevanceFloor = opts?.strictAbout ? 0.5 : 0.35;
  const exclude = j.about < aboutFloor || j.investorRelevant < relevanceFloor;
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
  return { ...j, takeaway: j.takeaway, eventScore, impact, weight, exclude };
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

const OUTCOME_PRICE_MAX_GAP_MS = 5 * 60_000;

/** Last observed point at or before time t; null if none. */
function pointAt(points: PriceLike[], t: number): PriceLike | null {
  let best: PriceLike | null = null;
  for (const p of points) {
    if (p.t <= t) best = p;
    else break;
  }
  return best;
}

/** Price of the last known point at or before time t; null if none. */
export function priceAt(points: PriceLike[], t: number): number | null {
  return pointAt(points, t)?.price ?? null;
}

/**
 * Forward return in % from a timely baseline near `t` (plus a small detection
 * allowance) to a timely observation near `t + windowMs`. A prior close must
 * not be carried forward across closed-market or missing-data gaps and counted
 * as a measured zero return.
 */
export function forwardReturn(points: PriceLike[], t: number, windowMs: number): number | null {
  if (!Number.isFinite(t) || !Number.isFinite(windowMs) || windowMs <= 0) return null;
  const baselineAt = t + 90_000;
  const outcomeAt = t + windowMs;
  const p0 = pointAt(points, baselineAt);
  const p1 = pointAt(points, outcomeAt);
  if (p0 == null || p1 == null || !Number.isFinite(p0.price) || !Number.isFinite(p1.price) || p0.price <= 0) return null;
  if (baselineAt - p0.t > OUTCOME_PRICE_MAX_GAP_MS || outcomeAt - p1.t > OUTCOME_PRICE_MAX_GAP_MS) return null;
  return Math.round(((p1.price - p0.price) / p0.price) * 1_000_000) / 10_000;
}

export interface ValidationBucket {
  range: string;
  n: number;
  medianAbs30: number | null;
  median30: number | null;
  hitRate: number | null;
}

const medianOf = (arr: number[]): number | null => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const a = s[mid];
  const b = s[mid - 1];
  if (a == null) return null;
  const value = s.length % 2 ? a : b != null ? (a + b) / 2 : a;
  return Math.round(value * 100) / 100;
};

/**
 * Signal validation: bucket judged events by event strength and measure the
 * realized forward reaction in each bucket. A credible desk shows this table;
 * the claim under test is monotonicity: stronger event scores should come with
 * larger absolute reactions and higher directional hit rates.
 */
export function validateSignal(
  events: Array<{ eventScore: number; sentiment: string; r30: number | null }>,
): ValidationBucket[] {
  const ranges: Array<[number, number]> = [
    [0, 25],
    [25, 50],
    [50, 75],
    [75, 100.01],
  ];
  return ranges.map(([lo, hi]) => {
    const inBucket = events.filter((e) => e.eventScore >= lo && e.eventScore < hi);
    const usable = inBucket.filter((e) => e.r30 != null) as Array<{ eventScore: number; sentiment: string; r30: number }>;
    const confirms = usable.filter((e) =>
      e.sentiment === "negative" ? e.r30 < 0 : e.sentiment === "positive" ? e.r30 > 0 : Math.abs(e.r30) < 0.25,
    ).length;
    return {
      range: `${lo}-${Math.min(hi, 100)}`,
      n: usable.length,
      medianAbs30: medianOf(usable.map((e) => Math.abs(e.r30))),
      median30: medianOf(usable.map((e) => e.r30)),
      hitRate: usable.length > 0 ? Math.round((confirms / usable.length) * 100) : null,
    };
  });
}

/**
 * Spearman rank correlation with average ranks for ties. The standard first
 * question a quant asks about a signal: does a stronger score predict a
 * larger move? Computed on (event strength, |forward reaction|) pairs.
 */
export function rankIC(pairs: Array<[number, number]>): number | null {
  if (pairs.length < 3) return null;
  const rank = (vals: number[]): number[] => {
    const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(vals.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(pairs.map((p) => p[0]));
  const ry = rank(pairs.map((p) => p[1]));
  const n = pairs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (rx[i] ?? 0) - mx;
    const b = (ry[i] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return Math.round((num / Math.sqrt(dx * dy)) * 1000) / 1000;
}

export interface ReactionSummary {
  n30m: number;
  n4h: number;
  median30m: number | null;
  median4h: number | null;
  /** Share of events where the 30m reaction matched the judged direction. */
  hitRate: number | null;
}

export function summarizeReactions(
  items: Array<{ sentiment: string; r30: number | null; r240: number | null }>,
): ReactionSummary {
  const with30m = items.filter((x) => x.r30 != null);
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
  const r30s = items.flatMap((x) => x.r30 == null ? [] : [x.r30]);
  const r240s = items.flatMap((x) => x.r240 == null ? [] : [x.r240]);
  const confirms = with30m.filter((x) => {
    const r = x.r30;
    if (r == null) return false;
    if (x.sentiment === "negative") return r < 0;
    if (x.sentiment === "positive") return r > 0;
    return Math.abs(r) < 0.25;
  }).length;
  return {
    n30m: r30s.length,
    n4h: r240s.length,
    median30m: median(r30s),
    median4h: median(r240s),
    hitRate: with30m.length > 0 ? Math.round((confirms / with30m.length) * 100) : null,
  };
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

/* ------------------------------------------------------------------ */
/* Alert gate: a fresh, high-strength, clearly-directional event is      */
/* worth interrupting someone for. Everything else stays on the desk.    */
/* ------------------------------------------------------------------ */

export interface AlertCheck {
  eventScore: number;
  impact: number;
  publishedAt: number;
  now: number;
  thresholdScore: number;
  thresholdImpact: number;
  freshMs: number;
}

export function shouldAlert(p: AlertCheck): boolean {
  if (p.publishedAt < p.now - p.freshMs) return false;
  return p.eventScore >= p.thresholdScore && Math.abs(p.impact) >= p.thresholdImpact;
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

/**
 * Smoothed sentiment index over a window: a leaky integrator over events.
 * Each mention pulls the index toward its impact with strength proportional
 * to its weight; between events the index decays toward neutral with a
 * half-life proportional to the window. This is how professional event-driven
 * sentiment indices behave: they move on news and fade without it, and the
 * curve is continuous, so the chart reads like an index instead of a
 * seismograph of isolated buckets.
 */
export function smoothedSeries(
  mentions: WeightedMention[],
  windowMs: number,
  bucketMs: number,
  nowMs: number,
  halfLifeMs = windowMs / 3,
): SeriesBucket[] {
  const start = nowMs - windowMs;
  const decay = Math.exp(-bucketMs / Math.max(bucketMs, halfLifeMs));
  const sorted = mentions
    .filter((m) => m.publishedAt >= start && m.publishedAt <= nowMs)
    .sort((a, b) => a.publishedAt - b.publishedAt);

  const first = Math.floor(start / bucketMs) * bucketMs;
  const last = Math.floor(nowMs / bucketMs) * bucketMs;
  const out: SeriesBucket[] = [];
  let v = 0;
  let started = false;
  let mi = 0;

  for (let t = first; t <= last; t += bucketMs) {
    const bucketEnd = t + bucketMs;
    if (started) v *= decay;
    let n = 0;
    while (mi < sorted.length && (sorted[mi]?.publishedAt ?? Infinity) < bucketEnd) {
      const m = sorted[mi++]!;
      started = true;
      const w = Math.min(1, Math.max(0.05, m.weight));
      const alpha = Math.min(1, 0.2 + 0.8 * w) * 0.8;
      v = v + alpha * (m.impact - v);
      n += 1;
    }
    if (started) out.push({ t, v: round2(v), n });
    else out.push({ t, v: null, n: 0 });
  }
  return out;
}

/** Shared bucket rule so the sentiment series and the price series align point-for-point. */
export function bucketMsFor(hours: number): number {
  return hours <= 6 ? 5 * 60_000 : hours <= 48 ? 15 * 60_000 : 60 * 60_000;
}

function noul(answers: Record<string, unknown>, key: string): number {
  const raw = answers[key];
  if (raw == null) throw new JudgmentError(`missing ${key} answer`);
  return validateNoulAnswer(raw).noul;
}

function parseChoice<T extends string>(
  raw: unknown,
  question: string,
  allowed: readonly T[],
): { choice: T; probabilities: ReadonlyMap<T, number>; confidence: number } {
  const answer = validateChoiceAnswer(raw);
  const choice = allowed.find((option) => option === answer.choice);
  if (choice == null) throw new JudgmentError(`${question} choice is outside the fixed rubric`);

  const keys = Object.keys(answer.probabilities);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.some((option) => option === key))) {
    throw new JudgmentError(`${question} probabilities do not match the fixed rubric`);
  }

  const probabilities = new Map<T, number>();
  let total = 0;
  for (const option of allowed) {
    const probability = answer.probabilities[option];
    if (probability == null) throw new JudgmentError(`${question} is missing probability for ${option}`);
    probabilities.set(option, probability);
    total += probability;
  }
  // TypeSafe's API describes a complete distribution whose values sum to
  // approximately 1. A 5-point tolerance allows decimal rounding only.
  if (Math.abs(total - 1) > 0.05) throw new JudgmentError(`${question} probabilities do not sum to approximately 1`);
  const choiceProbability = probabilities.get(choice);
  const maximumProbability = Math.max(...probabilities.values());
  if (choiceProbability == null || choiceProbability < maximumProbability - 1e-9) {
    throw new JudgmentError(`${question} choice is not the highest-probability option`);
  }

  return { choice, probabilities, confidence: answer.confidence };
}

function requiredProbability(probabilities: ReadonlyMap<string, number>, key: string, question: string): number {
  const probability = probabilities.get(key);
  if (probability == null) throw new JudgmentError(`${question} is missing probability for ${key}`);
  return probability;
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
