import type { Desk, RawMentionInput } from "./db.js";
import { rowToDTO } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import { JevError } from "./jev.js";
import { RUBRIC, RUBRIC_SHA } from "./rubric.js";
import {
  applyPostRules,
  bucketMsFor,
  forwardReturn,
  hasStrongIdentity,
  parseJudgment,
  shouldAlert,
  smoothedSeries,
  summarizeReactions,
  weightedIndex,
} from "./scoring.js";
import { TIER_WEIGHT } from "./sources/tiers.js";
import type {
  Company,
  CompanySnapshot,
  CollectorId,
  EarningsSurprise,
  JevState,
  MentionScore,
  SeriesPoint,
  SourceTier,
} from "./types.js";

/**
 * The pipeline ties ingestion to judgment: normalized mentions enter, validated
 * Jev judgments leave, the index recomputes, and every change is broadcast.
 * Scoring runs through a bounded-concurrency queue so a burst of mentions never
 * stampedes the API, and a failed judgment is marked failed, never silently
 * dropped and never replaced by a default score.
 */

export interface JudgeFn {
  (state: JevState): Promise<{
    answers: Record<string, unknown>;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}

export interface PipelineDeps {
  db: Desk;
  judge: JudgeFn | null;
  hub: Hub;
  health: HealthTracker;
  engineLabel: string;
  inputPricePerMTok: number;
  concurrency: number;
  allowedCollectors: ReadonlySet<CollectorId>;
  dailyBudget: {
    utcDay: () => string;
    maxRequests: number;
    maxRequestBytes: number;
  };
  alert?: { webhookUrl: string; eventScore: number; impact: number; freshMinutes: number };
}

export type OperatorRetryResult =
  | "queued"
  | "usage_review_required"
  | "not_retryable"
  | "jev_unavailable"
  | "budget_exhausted";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_JEV_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;

export class Pipeline {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private inFlight = 0;
  private readonly idleWaiters = new Set<() => void>();
  private memoryCache: Map<string, { at: number; block: JevState["deskMemory"] }> = new Map();

  private companyCache: Map<
    string,
    { name: string; ticker: string; sector: string; color: string; aliases: string[]; ambiguous?: boolean }
  > | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  /** Insert a normalized source observation; exact replays do not reach Jev. */
  ingest(m: RawMentionInput): boolean {
    const stored = this.deps.db.insertObservation(m);
    const collector = m.collector ?? "legacy_unknown";
    if (stored.inserted && this.deps.judge && this.deps.allowedCollectors.has(collector) && this.hasDailyBudgetCapacity()) {
      this.enqueue(stored.observationId);
    }
    return stored.inserted;
  }

  /** Re-queue existing pending mentions (used after rubric migrations). */
  drainPending(limit = 1_000): number {
    if (!this.deps.judge || this.deps.allowedCollectors.size === 0) return 0;
    const remaining = this.remainingDailyRequests();
    if (remaining <= 0) return 0;
    const ids = this.deps.db.pendingIds(Math.min(limit, remaining), [...this.deps.allowedCollectors]);
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }

  retryFailed(id: string, reviewedProviderUsage: boolean): OperatorRetryResult {
    if (!this.deps.judge) return "jev_unavailable";
    const current = this.deps.db.mentionRow(id);
    if (!current) return "not_retryable";
    if (![...this.deps.allowedCollectors].some((collector) => collector === current.collector)) {
      return "jev_unavailable";
    }
    if (!this.hasDailyBudgetCapacity()) return "budget_exhausted";
    const result = this.deps.db.requeueFailed(id, reviewedProviderUsage);
    if (result !== "queued") return result;
    const requeued = this.deps.db.mentionRow(id);
    if (requeued) this.deps.hub.broadcast("mention", rowToDTO(requeued));
    this.deps.db.logEvent(
      "info",
      "jev",
      `operator authorized a new Jev input for failed judgment ${id}; provider usage review=${reviewedProviderUsage}`,
    );
    this.enqueue(id);
    return "queued";
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.pump();
  }

  private remainingDailyRequests(): number {
    return this.deps.db.remainingJevRequests({
      utcDay: this.deps.dailyBudget.utcDay(),
      maxRequests: this.deps.dailyBudget.maxRequests,
      maxRequestBytes: this.deps.dailyBudget.maxRequestBytes,
    });
  }

  private hasDailyBudgetCapacity(): boolean {
    return this.remainingDailyRequests() > 0;
  }

  private pump(): void {
    while (this.inFlight < this.deps.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      this.queued.delete(id);
      this.inFlight += 1;
      void this.scoreOne(id).finally(() => {
        this.inFlight -= 1;
        this.pump();
        this.resolveIdleWaiters();
      });
    }
  }

  waitForIdle(): Promise<void> {
    if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private resolveIdleWaiters(): void {
    if (this.inFlight !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async scoreOne(id: string): Promise<void> {
    const db = this.deps.db;
    const queuedRow = db.mentionRow(id);
    if (!queuedRow || (queuedRow.status !== "pending" && queuedRow.status !== "retrying")) return;
    if (![...this.deps.allowedCollectors].some((collector) => collector === queuedRow.collector)) return;

    if (!this.deps.judge) {
      // No engine configured: leave the real observation pending. An
      // intentionally absent provider is not a failed provider request.
      return;
    }
    if (!this.hasDailyBudgetCapacity()) return;

    const meta = this.companyMeta(queuedRow.company_id);
    // Lexically ambiguous names matched by text alone (Google News, GDELT)
    // must clear a much higher about bar: "apple sauce" is not Apple Inc.
    const strongIdentity = hasStrongIdentity({
      company: { name: meta.name, ticker: meta.ticker, aliases: meta.aliases, ambiguous: meta.ambiguous },
      title: queuedRow.title,
      snippet: queuedRow.snippet,
      scoped: queuedRow.scoped === 1,
    });
    const strictAbout = meta.ambiguous === true && !strongIdentity;
    const deskMemory = this.memoryFor(queuedRow.company_id, meta.ticker);
    const state: JevState = {
      company: {
        id: queuedRow.company_id,
        name: meta.name,
        ticker: meta.ticker,
        sector: meta.sector,
      },
      mention: {
        title: queuedRow.title,
        snippet: queuedRow.snippet,
        source: {
          name: queuedRow.source_name,
          url: queuedRow.source_url,
          tier: queuedRow.source_tier as SourceTier,
        },
        publishedAt: queuedRow.published_at == null
          ? "Unknown (publisher did not provide a timestamp)"
          : new Date(queuedRow.published_at).toISOString(),
      },
      deskMemory,
    };

    const requestBytes = Buffer.byteLength(JSON.stringify({
      model: this.deps.engineLabel,
      state,
      questions: RUBRIC,
    }), "utf8");
    const claim = db.claimForScoringWithBudget({
      id,
      now: Date.now(),
      allowedCollectors: [...this.deps.allowedCollectors],
      utcDay: this.deps.dailyBudget.utcDay(),
      requestBytes,
      maxRequests: this.deps.dailyBudget.maxRequests,
      maxRequestBytes: this.deps.dailyBudget.maxRequestBytes,
    });
    if (claim.kind !== "claimed") return;
    const row = claim.row;
    this.deps.hub.broadcast("mention", rowToDTO(row));

    let judgeResponseReceived = false;
    try {
      const out = await this.deps.judge(state);
      judgeResponseReceived = true;
      if (
        !Number.isSafeInteger(out.inputTokens) || out.inputTokens < 0 ||
        !Number.isSafeInteger(out.outputTokens) || out.outputTokens < 0
      ) {
        throw new Error("Jev returned invalid token usage; score withheld");
      }
      const parsed = parseJudgment(out.answers);
      const tier = row.source_tier as SourceTier;
      const final = applyPostRules(parsed, TIER_WEIGHT[tier], { strictAbout: strictAbout });
      const inputTokens = out.inputTokens;
      const score: MentionScore = {
        sentiment: parsed.sentiment,
        pPos: parsed.pPos,
        pNeu: parsed.pNeu,
        pNeg: parsed.pNeg,
        confidence: parsed.confidence,
        about: parsed.about,
        material: parsed.material,
        novel: parsed.novel,
        credible: parsed.credible,
        investorRelevant: parsed.investorRelevant,
        eventType: parsed.eventType,
        takeaway: parsed.takeaway,
        magnitude: parsed.magnitude,
        surprise: parsed.surprise,
        eventScore: final.eventScore,
        impact: final.impact,
        weight: final.weight,
        engine: out.model,
        inputTokens,
        outputTokens: out.outputTokens,
        estimatedInputCostUsd: (inputTokens / 1_000_000) * this.deps.inputPricePerMTok,
        latencyMs: out.latencyMs,
        rubricSha: RUBRIC_SHA,
        scoredAt: Date.now(),
      };
      db.markScored(id, score, final.exclude);
      this.deps.health.recordJev(true);

      const updated = db.mentionRow(id);
      if (updated) {
        this.deps.hub.broadcast("mention", rowToDTO(updated));
        this.deps.hub.broadcast("company", this.snapshot(row.company_id));
        this.maybeAlert(updated);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof JevError && err.retryable && row.score_attempts < MAX_JEV_ATTEMPTS) {
        const backoffMs = RETRY_BASE_MS * 2 ** (row.score_attempts - 1);
        const retryAt = Date.now() + Math.max(backoffMs, err.retryAfterMs ?? 0);
        db.markRetrying(id, `${message}; retry ${row.score_attempts + 1} of ${MAX_JEV_ATTEMPTS} is scheduled`, retryAt);
      } else {
        const outcomeNote = err instanceof JevError && err.outcomeUnknown
          ? "; provider outcome is unknown, so automatic retry is withheld to avoid a duplicate charge"
          : "";
        const usageCheckRequired = judgeResponseReceived || (
          err instanceof JevError && (err.outcomeUnknown || err.status != null)
        );
        db.markFailed(id, `${message}${outcomeNote}`, usageCheckRequired);
      }
      this.deps.health.recordJev(false, message);
      db.logEvent("warn", "jev", `score failed for ${id}: ${message}`);
      const updated = db.mentionRow(id);
      if (updated) this.deps.hub.broadcast("mention", rowToDTO(updated));
    }
  }

  /** Fire-and-forget webhook on fresh, high-strength events; never blocks scoring. */
  private maybeAlert(row: {
    company_id: string;
    title: string;
    published_at: number | null;
    impact: number | null;
    event_score: number | null;
  }): void {
    const alert = this.deps.alert;
    if (!alert?.webhookUrl) return;
    if (row.impact == null || row.event_score == null || row.published_at == null) return;
    const meta = this.companyMeta(row.company_id);
    if (
      !shouldAlert({
        eventScore: row.event_score,
        impact: row.impact,
        publishedAt: row.published_at,
        now: Date.now(),
        thresholdScore: alert.eventScore,
        thresholdImpact: alert.impact,
        freshMs: alert.freshMinutes * 60_000,
      })
    ) {
      return;
    }
    const impact = row.impact;
    const eventScore = row.event_score;
    const arrow = impact > 0 ? "↑" : impact < 0 ? "↓" : "·";
    const text = `${arrow} ${meta.ticker} ${impact > 0 ? "+" : ""}${impact.toFixed(0)} (event ${Math.round(eventScore)}) — ${row.title.slice(0, 140)}`;
    void fetch(alert.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      /* alerts are best-effort */
    });
  }

  /**
   * TradingAgents-style reflection: measured 30-minute reactions after this
   * desk's own past judgments on this company, cached for 10 minutes and
   * attached to scoring state for calibration. Omitted below 5 measured
   * events — no memory is better than a noisy one.
   */
  private memoryFor(companyId: string, ticker: string): JevState["deskMemory"] {
    const cached = this.memoryCache.get(companyId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.block;
    let block: JevState["deskMemory"] | undefined;
    try {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const events = this.deps.db.scoredMentionEvents(since).filter((e) => e.companyId === companyId);
      const series = this.deps.db.priceWindow(ticker, since - 60 * 60 * 1000);
      const rows = events.map((e) => ({
        sentiment: e.sentiment,
        eventType: e.eventType,
        r30: forwardReturn(series, e.publishedAt, 30 * 60_000),
        r240: null,
      }));
      const overall = summarizeReactions(rows);
      if (overall.n >= 5) {
        const fmt = (v: number | null) => (v == null ? "--" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
        const byType: Record<string, string> = {};
        for (const t of new Set(rows.map((r) => r.eventType))) {
          const s = summarizeReactions(rows.filter((r) => r.eventType === t));
          if (s.n >= 3) byType[t] = `n=${s.n}, median30m=${fmt(s.median30m)}, hit=${s.hitRate ?? "-"}%`;
        }
        block = {
          overall: `n=${overall.n}, median30m=${fmt(overall.median30m)}, hit=${overall.hitRate ?? "-"}%`,
          byType,
        };
        this.deps.db.logEvent("info", "memory", `${ticker}: ${block.overall}`);
      }
    } catch {
      block = undefined;
    }
    this.memoryCache.set(companyId, { at: Date.now(), block });
    return block;
  }

  private companyMeta(companyId: string): {
    name: string;
    ticker: string;
    sector: string;
    color: string;
    aliases: string[];
    ambiguous?: boolean;
  } {
    if (!this.companyCache) {
      this.companyCache = new Map(
        this.deps.db.companies().map((c) => [c.id, c] as const),
      );
    }
    return (
      this.companyCache.get(companyId) ?? {
        name: companyId,
        ticker: companyId,
        sector: "",
        color: "#64748b",
        aliases: [],
        ambiguous: false,
      }
    );
  }

  snapshot(companyId: string): CompanySnapshot {
    const now = Date.now();
    const companies = new Map(this.deps.db.companies().map((c) => [c.id, c] as const));
    const events = this.deps.db.scoredMentions(now - DAY_MS);
    const counts = this.deps.db.counts24h(now - DAY_MS);
    const extras = this.earningsExtras();
    return this.computeSnapshot(companies, counts, events, companyId, now, extras);
  }

  snapshots(): CompanySnapshot[] {
    const now = Date.now();
    const companies = this.deps.db.companies();
    const byId = new Map(companies.map((c) => [c.id, c] as const));
    const events = this.deps.db.scoredMentions(now - DAY_MS);
    const counts = this.deps.db.counts24h(now - DAY_MS);
    const extras = this.earningsExtras();
    return companies.map((c) => this.computeSnapshot(byId, counts, events, c.id, now, extras));
  }

  /** Measured earnings facts (Finnhub) cached in kv, surfaced on snapshots. */
  private earningsExtras(): Map<string, { earningsAt: number | null; lastSurprise: EarningsSurprise | null }> {
    const out = new Map<string, { earningsAt: number | null; lastSurprise: EarningsSurprise | null }>();
    for (const c of this.deps.db.companies()) {
      const earningsRaw = this.deps.db.getKv(`finnhub:earnings:${c.id}`);
      const surpriseRaw = this.deps.db.getKv(`finnhub:surprise:${c.id}`);
      const earningsAt = earningsRaw ? Number(earningsRaw) : NaN;
      let lastSurprise: EarningsSurprise | null = null;
      try {
        lastSurprise = surpriseRaw ? (JSON.parse(surpriseRaw) as EarningsSurprise) : null;
      } catch {
        lastSurprise = null;
      }
      out.set(c.id, {
        earningsAt: Number.isFinite(earningsAt) ? earningsAt : null,
        lastSurprise,
      });
    }
    return out;
  }

  private computeSnapshot(
    companies: Map<string, { id: string; name: string; ticker: string; sector: string; color: string }>,
    counts: Map<string, { count: number; lastAt: number | null }>,
    events: Array<{ companyId: string; publishedAt: number; impact: number; weight: number }>,
    companyId: string,
    now: number,
    extras: Map<string, { earningsAt: number | null; lastSurprise: EarningsSurprise | null }> = new Map(),
  ): CompanySnapshot {
    const meta = companies.get(companyId);
    const own = events.filter((m) => m.companyId === companyId);
    const current = weightedIndex(own.filter((m) => m.publishedAt >= now - CURRENT_WINDOW_MS));
    const baseline = weightedIndex(own);
    const count = counts.get(companyId);
    return {
      id: companyId,
      name: meta?.name ?? companyId,
      ticker: meta?.ticker ?? companyId,
      sector: meta?.sector ?? "",
      color: meta?.color ?? "#64748b",
      index: current ?? baseline,
      delta: current != null && baseline != null ? Math.round((current - baseline) * 100) / 100 : null,
      mentions24h: count?.count ?? 0,
      lastMentionAt: count?.lastAt ?? null,
      earningsAt: extras.get(companyId)?.earningsAt ?? null,
      lastSurprise: extras.get(companyId)?.lastSurprise ?? null,
    };
  }

  series(companyId: string, windowHours: number): SeriesPoint[] {
    const now = Date.now();
    const windowMs = windowHours * 60 * 60 * 1000;
    const items = this.deps.db.scoredMentions(now - windowMs).filter((m) => m.companyId === companyId);
    return smoothedSeries(items, windowMs, bucketMsFor(windowHours), now);
  }
}
