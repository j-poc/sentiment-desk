import { createHash } from "node:crypto";
import type { SourceTier } from "./types.js";
import { validateChoiceAnswer, validateNoulAnswer } from "./jev.js";

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
  impact: number;
  weight: number;
  exclude: boolean;
}

export function applyPostRules(j: ParsedJudgment, sourceWeight: number): FinalScore {
  const exclude = j.about < 0.5;
  const impact = round2((j.pPos - j.pNeg) * 100);
  const dampedConfidence = j.confidence < 0.55 ? j.confidence * 0.6 : j.confidence;
  const weight = round4(
    dampedConfidence *
      (0.55 + 0.45 * j.material) *
      (0.7 + 0.3 * j.novel) *
      sourceWeight *
      (0.5 + 0.5 * j.credible),
  );
  return { ...j, impact, weight, exclude };
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
