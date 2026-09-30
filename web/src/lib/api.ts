/**
 * API client: typed mirrors of the server DTOs, fetch helpers, and one
 * EventSource wrapper with liveness callbacks. The browser never sees source
 * credentials; Jev retry is the only explicit write action.
 */
import { z } from "zod";

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
  indexWindow: "3h" | "24h" | null;
  indexRecordCount: number;
  delta: number | null;
  sourceRecords24h: number;
  latestSourceCollectedAt: number | null;
  earningsAt: number | null;
  lastSurprise: EarningsSurprise | null;
}

export type Sentiment = "negative" | "neutral" | "positive";
export type MentionStatus = "pending" | "scoring" | "retrying" | "scored" | "off_target" | "failed" | "corrupt";
export type SourceTier = "wire" | "major" | "trade" | "blog" | "social" | "filing";
export type CollectorId = "legacy_unknown" | "google_news_rss" | "yahoo_finance_rss" | "yahoo_quote" | "gdelt_doc_api" | "sec_edgar" | "finnhub" | "reddit" | "x" | "yahoo_chart";

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
  takeaway: string;
  magnitude: number;
  surprise: number;
  eventScore: number;
  impact: number;
  weight: number;
  engine: string;
  inputTokens: number;
  outputTokens: number;
  estimatedInputCostUsd: number;
  latencyMs: number;
  rubricSha: string;
  scoredAt: number;
}

export interface Mention {
  id: string;
  companyId: string;
  source: { name: string; url: string; kind: "rss" | "x" | "sec" | "finnhub" | "reddit"; tier: SourceTier; collector: CollectorId; publisher: string; publisherDomain: string | null; deliveryId?: string | null };
  title: string;
  snippet: string;
  publishedAt: number | null;
  providerObservedAt: number | null;
  retrievedAt: number;
  ingestedAt: number;
  timeBasis: "publisher_declared" | "provider_observed" | "unknown" | "legacy_unknown";
  collector: CollectorId;
  publisherName: string;
  publisherDomain: string | null;
  filedAt?: number | null;
  status: MentionStatus;
  scoreRetryAt: number | null;
  usageCheckRequired: boolean;
  score: MentionScore | null;
  error: string | null;
}

export interface MentionPage {
  items: Mention[];
  nextCursor: { orderAt: number; ingestedAt: number; id: string } | null;
}

export interface ScoreBucketEvidencePage {
  bucketFromMs: number;
  bucketThroughMs: number;
  includeFromBoundary: boolean;
  items: Mention[];
  nextCursor: { scoredAt: number; id: string } | null;
}

export interface ReactionEvent {
  id: string;
  title: string;
  publishedAt: number | null;
  availableAt: number;
  sentiment: string;
  eventScore: number;
  eventType: string;
  r30: number | null;
  r240: number | null;
}

export interface ReactionSummary {
  n30m: number;
  n4h: number;
  median30m: number | null;
  median4h: number | null;
  hitRate: number | null;
}

export interface ReactionsDTO {
  ticker: string;
  events: ReactionEvent[];
  measuredEventCount: number;
  bull: ReactionSummary;
  bear: ReactionSummary;
  all: ReactionSummary;
}

export interface ValidationBucket {
  range: string;
  n: number;
  medianAbs30: number | null;
  median30: number | null;
  hitRate: number | null;
}

export interface ValidationDTO {
  hours: number;
  totalEvents: number;
  withReaction: number;
  rankIC: number | null;
  buckets: ValidationBucket[];
  generatedAt: number;
}

export type RadarEventType =
  | "results"
  | "corporate_action"
  | "legal_regulatory"
  | "leadership"
  | "product"
  | "analyst_action"
  | "macro_sector"
  | "other";

export interface RadarEvidenceItem {
  id: string;
  title: string;
  sourceUrl: string;
  publisherName: string;
  publisherDomain: string | null;
  publishedAt: number;
  retrievedAt: number;
  collector: CollectorId;
  eventType: string;
  sentiment: string;
  takeaway: string;
}

export interface RadarPeriodSummary {
  sourceRows: number;
  headlineGroups: number;
  publisherCount: number;
  publisherJudgments: number;
  positive: number;
  neutral: number;
  negative: number;
  mixed: number;
}

export interface RadarDTO {
  hours: number;
  generatedAt: number;
  currentFrom: number;
  currentTo: number;
  previousFrom: number;
  previousTo: number;
  current: RadarPeriodSummary;
  previous: RadarPeriodSummary;
  headlineChange: number;
  untimedScored: number;
  unjudged: number;
  unclassified: number;
  categories: Array<{
    eventType: RadarEventType;
    current: RadarPeriodSummary;
    previous: RadarPeriodSummary;
    headlineChange: number;
    recentEvidence: Array<{
      title: string;
      latestPublishedAt: number;
      sources: RadarEvidenceItem[];
    }>;
    previousEvidence: Array<{
      title: string;
      latestPublishedAt: number;
      sources: RadarEvidenceItem[];
    }>;
  }>;
  coverage: HealthDTO["deliveryHealth"];
}

export interface RadarEvidencePageDTO {
  generatedAt: number;
  hours: number;
  period: "current" | "previous";
  eventType: RadarEventType;
  offset: number;
  total: number;
  items: RadarDTO["categories"][number]["recentEvidence"];
}

export interface SeriesPoint {
  t: number;
  v: number | null;
  n: number;
  itemImpactMin: number | null;
  itemImpactMax: number | null;
  lastScoredAt: number | null;
}

export interface SeriesResult {
  points: SeriesPoint[];
  latestScoreAvailableAt: number | null;
}

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  currency: string;
  at: number | null;
  retrievedAt: number;
  lastAttemptAt: number;
  delivery: "network" | "cache";
}

export interface MarketSnapshot {
  quotes: Record<string, Quote>;
  updatedAt: number;
}

export interface PricePoint {
  t: number;
  price: number;
  currency: string;
  collector: "yahoo_chart";
  retrievedAt: number;
  adapterVersion: string;
  deliveryId: string;
}

export interface PriceSeriesDTO {
  points: PricePoint[];
  delivery: "network" | "memory_cache" | "local_store";
  servedAt: number;
  sourceLatestAt: number | null;
  cacheAgeMs: number | null;
  refreshError: string | null;
  resampling: "source_observations_in_window";
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
  externalRequestsEnabled: boolean;
  opportunityRadarEnabled: boolean;
  version: string;
  runtimeId: string;
  uptimeSec: number;
  sseClients: number;
  dbSizeBytes: number | null;
  health: {
    externalRequestsEnabled: boolean;
    sourceApproval: {
      requestedCollectors: CollectorId[];
      approvedCollectors: CollectorId[];
      blockedRequestedCollectors: CollectorId[];
      typesafeAccountUseApproved: boolean;
      jevAllowedCollectors: CollectorId[];
    };
    rss: SourceHealth;
    gdelt: SourceHealth;
    x: SourceHealth;
    quotes: SourceHealth;
    sec: SourceHealth;
    finnhub: SourceHealth;
    reddit: SourceHealth;
    jev: SourceHealth & { model: string };
  };
  deliveries: Array<{
    collector: CollectorId;
    companyId: string | null;
    result: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid";
    completedAt: number;
    parsedItemCount: number;
    adapterVersion: string;
    error: string | null;
  }>;
  deliveryHealth: Array<{
    collector: CollectorId;
    enabled: boolean;
    state: "current" | "processing" | "overdue" | "failed" | "partial" | "never" | "disabled";
    intervalSeconds: number;
    targetCount: number;
    coverageCount: number;
    latestDeliveryAt: number | null;
    latestResult: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid" | null;
    latestItemCount: number | null;
    latestError: string | null;
    adapterVersion: string | null;
    latestIngestionRequired: boolean;
    latestIngestionState: "processing" | "success" | "partial" | "failed" | null;
    latestIngestionExpectedCount: number | null;
    latestIngestionProcessedCount: number | null;
    latestIngestionInsertedCount: number | null;
    latestObservationAt: number | null;
    latestObservationBasis: "publisher_declared" | "provider_observed" | "unknown" | "legacy_unknown" | null;
    latestObservationRetrievedAt: number | null;
  }>;
  /** Saved provider judgments only; failed and retried requests are excluded. */
  usage: {
    judgedItems: number;
    inputTokens: number;
    outputTokens: number;
    estimatedInputCostUsd: number;
  };
  events: Array<{ at: number; level: string; source: string; message: string }>;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function lookupMentionsByIds(companyId: string, ids: string[]): Promise<Mention[]> {
  if (ids.length === 0) return [];
  const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/mentions/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error(`POST mention lookup -> ${response.status}`);
  const body = await response.json() as { items: Mention[] };
  return body.items;
}

const retryErrorSchema = z.object({ error: z.string() });
const retryErrorCopy: Record<string, string> = {
  provider_usage_review_required: "Check TypeSafe usage before authorizing another attempt.",
  mention_not_retryable: "This item changed state. Refresh its details before retrying.",
  jev_not_configured: "Jev is not configured in the running desk.",
  jev_daily_budget_exhausted: "The daily Jev input budget is exhausted. The item remains pending until the next UTC day.",
  retry_confirmation_required: "Confirm the new request and provider-usage review before retrying.",
};

export async function retryMention(
  id: string,
  confirmation: { confirmNewCharge: true; reviewedProviderUsage: boolean },
): Promise<void> {
  const response = await fetch(`/api/mentions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmation),
  });
  if (response.status === 202) return;

  const body: unknown = await response.json().catch(() => null);
  const parsed = retryErrorSchema.safeParse(body);
  const message = parsed.success
    ? retryErrorCopy[parsed.data.error] ?? "Jev retry failed."
    : "Jev retry failed. Refresh the desk and try again.";
  throw new Error(message);
}

export interface StreamHandlers {
  onHello?: (data: { now: number; runtimeId: string }) => void;
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
