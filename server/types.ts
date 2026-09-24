export type SourceKind = "rss" | "x" | "sec" | "finnhub" | "reddit";

/**
 * Source tiers rank publishing venues by expected reliability for business
 * reporting. The tier is a deterministic prior; Jev's per-item credibility
 * judgment blends with it at scoring time. Both live in the stored score so
 * the blend is always auditable.
 */
export type SourceTier = "wire" | "major" | "trade" | "blog" | "social" | "filing";

export interface Company {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  aliases: string[];
  color: string;
  /** True when the name doubles as a common word (Apple, Meta, Intel, Amazon the river): text-matched mentions face a stricter identity bar. */
  ambiguous?: boolean;
}

/**
 * A mention as normalized from a source, before scoring. Provenance rules:
 * publishedAt is the source-declared time and is never inferred from when we
 * fetched it; retrievedAt is our clock; the digest (used as id) binds identity
 * to content so replays are idempotent.
 */
export interface RawMention {
  companyId: string;
  kind: SourceKind;
  sourceName: string;
  sourceUrl: string;
  tier: SourceTier;
  title: string;
  snippet: string;
  publishedAt: number;
  retrievedAt: number;
  /** SEC only: the filing date declared by EDGAR (distinct from acceptance). */
  filedAt?: number;
  /** True when the item arrived via a symbol-scoped query (Yahoo ticker feed, Finnhub, X, Reddit, SEC): the scoping itself is identity evidence. */
  scoped?: boolean;
}

/** The state block sent to Jev: everything the model may judge on. */
export interface JevState {
  company: {
    id: string;
    name: string;
    ticker: string;
    sector: string;
  };
  mention: {
    title: string;
    snippet: string;
    source: { name: string; url: string; tier: SourceTier };
    publishedAt: string;
  };
  /** TradingAgents-style reflection: measured 30-minute reactions after this
   * desk's own past judgments on this company, included for calibration.
   * Populated only when there are enough measured events to be meaningful. */
  deskMemory?: {
    overall?: string;
    byType?: Record<string, string>;
  };
}

export type MentionStatus = "pending" | "scored" | "off_target" | "failed";

export interface MentionScore {
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
  eventType: string;
  takeaway: string;
  magnitude: number;
  surprise: number;
  /** 0-100 event-strength composite: materiality, surprise, magnitude. */
  eventScore: number;
  /** Composite directional index in [-100, 100]. */
  impact: number;
  /** Relative weight of this mention inside any windowed index. */
  weight: number;
  engine: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  rubricSha: string;
  scoredAt: number;
}

export interface MentionDTO {
  id: string;
  companyId: string;
  source: { name: string; url: string; kind: SourceKind; tier: SourceTier };
  title: string;
  snippet: string;
  publishedAt: number;
  retrievedAt: number;
  /** SEC only: EDGAR filing date (distinct from the acceptance timestamp). */
  filedAt?: number | null;
  status: MentionStatus;
  score: MentionScore | null;
  error: string | null;
  /** Distinct near-duplicate items covering the same event (1 = sole report). */
  confirmations?: number;
}

export interface EarningsSurprise {
  percent: number; // (actual - estimate) / |estimate| * 100
  period: string;
}

export interface CompanySnapshot {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  color: string;
  /** Weighted sentiment index over the current window; null with too little data. */
  index: number | null;
  /** index now minus index over the full trailing day. */
  delta: number | null;
  mentions24h: number;
  lastMentionAt: number | null;
  /** Next scheduled earnings date (ms), from the Finnhub calendar when configured. */
  earningsAt: number | null;
  /** Latest reported EPS surprise vs consensus, from Finnhub when configured. */
  lastSurprise: EarningsSurprise | null;
}

export interface SeriesPoint {
  t: number;
  v: number | null;
  n: number;
}
