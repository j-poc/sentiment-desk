/**
 * API client: typed mirrors of the server DTOs, plain fetch helpers, and one
 * EventSource wrapper with liveness callbacks. The browser never sees source
 * credentials; everything here is read-only.
 */

export interface EarningsSurprise {
  percent: number;
  period: string;
}

export interface CompanySnapshot {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  color: string;
  index: number | null;
  delta: number | null;
  mentions24h: number;
  lastMentionAt: number | null;
  earningsAt: number | null;
  lastSurprise: EarningsSurprise | null;
}

export type Sentiment = "negative" | "neutral" | "positive";
export type MentionStatus = "pending" | "scored" | "off_target" | "failed";
export type SourceTier = "wire" | "major" | "trade" | "blog" | "social";

export interface MentionScore {
  sentiment: Sentiment;
  pPos: number;
  pNeu: number;
  pNeg: number;
  confidence: number;
  about: number;
  material: number;
  novel: number;
  credible: number;
  eventType: string;
  magnitude: number;
  surprise: number;
  eventScore: number;
  impact: number;
  weight: number;
  engine: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  rubricSha: string;
  scoredAt: number;
}

export interface Mention {
  id: string;
  companyId: string;
  source: { name: string; url: string; kind: "rss" | "x" | "sec"; tier: SourceTier };
  title: string;
  snippet: string;
  publishedAt: number;
  retrievedAt: number;
  status: MentionStatus;
  score: MentionScore | null;
  error: string | null;
  confirmations?: number;
}

export interface ReactionEvent {
  id: string;
  title: string;
  publishedAt: number;
  sentiment: string;
  eventScore: number;
  eventType: string;
  r30: number | null;
  r240: number | null;
}

export interface ReactionSummary {
  n: number;
  median30m: number | null;
  median4h: number | null;
  hitRate: number | null;
}

export interface ReactionsDTO {
  ticker: string;
  events: ReactionEvent[];
  bull: ReactionSummary;
  bear: ReactionSummary;
  all: ReactionSummary;
}

export interface SeriesPoint {
  t: number;
  v: number | null;
  n: number;
}

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  currency: string;
  at: number;
}

export interface MarketSnapshot {
  quotes: Record<string, Quote>;
  updatedAt: number;
}

export interface PricePoint {
  t: number;
  price: number;
}

export interface SourceHealth {
  enabled: boolean;
  ok: number;
  fail: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export interface HealthDTO {
  ok: boolean;
  version: string;
  demo: boolean;
  uptimeSec: number;
  sseClients: number;
  dbSizeBytes: number | null;
  health: {
    rss: SourceHealth;
    x: SourceHealth;
    quotes: SourceHealth;
    sec: SourceHealth;
    finnhub: SourceHealth;
    reddit: SourceHealth;
    jev: SourceHealth & { model: string };
  };
  usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  events: Array<{ at: number; level: string; source: string; message: string }>;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export interface StreamHandlers {
  onHello?: (data: { demo: boolean; now: number }) => void;
  onMention?: (m: Mention) => void;
  onCompany?: (s: CompanySnapshot) => void;
  onQuotes?: (s: MarketSnapshot) => void;
  onState?: (connected: boolean) => void;
}

/** EventSource with explicit event names; the browser reconnects natively. */
export function openStream(handlers: StreamHandlers): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", (e) => handlers.onHello?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("mention", (e) => handlers.onMention?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("company", (e) => handlers.onCompany?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("quotes", (e) => handlers.onQuotes?.(JSON.parse((e as MessageEvent).data)));
  es.onopen = () => handlers.onState?.(true);
  es.onerror = () => handlers.onState?.(false);
  return () => es.close();
}
