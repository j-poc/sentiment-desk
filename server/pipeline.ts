import type { Desk, RawMentionInput } from "./db.js";
import { rowToDTO } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import { RUBRIC_SHA } from "./rubric.js";
import {
  applyPostRules,
  bucketMsFor,
  clusterEvents,
  forwardReturn,
  hasNearDuplicateTitle,
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
  EarningsSurprise,
  JevState,
  MentionScore,
  SeriesPoint,
  SourceTier,
} from "./types.js";
import type { EventCluster } from "./scoring.js";

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
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
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
  alert?: { webhookUrl: string; eventScore: number; impact: number; freshMinutes: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_WINDOW_MS = 3 * 60 * 60 * 1000;

export class Pipeline {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private inFlight = 0;
  private memoryCache: Map<string, { at: number; block: JevState["deskMemory"] }> = new Map();

  private companyCache: Map<
    string,
    { name: string; ticker: string; sector: string; color: string; aliases: string[]; ambiguous?: boolean }
  > | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  /** Insert a normalized mention; on first sight, schedule it for judgment. */
  ingest(m: RawMentionInput): boolean {
    // Syndication suppression: the same story re-arriving from another feed
    // within the window is the same event; drop it before it costs anything.
    const recent = this.deps.db.recentTitles(m.companyId, Date.now() - 45 * 60_000, 40);
    if (hasNearDuplicateTitle(m.title, recent)) return false;
    const id = `${m.companyId}:${m.digest}`;
    const inserted = this.deps.db.insertMention(m);
    if (inserted) this.enqueue(id);
    return inserted;
  }

  /** Re-queue existing pending mentions (used after rubric migrations). */
  drainPending(limit = 1_000): number {
    const ids = this.deps.db.pendingIds(limit);
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.pump();
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
      });
    }
  }

  private async scoreOne(id: string): Promise<void> {
    const db = this.deps.db;
    const row = db.mentionRow(id);
    if (!row || row.status !== "pending") return;

    if (!this.deps.judge) {
      // No engine configured and not demo: the mention stays pending and the
      // gap is visible in health. Nothing is ever scored by default.
      this.deps.health.recordJev(false, "no scoring engine configured");
      return;
    }

    const meta = this.companyMeta(row.company_id);
    // Lexically ambiguous names matched by text alone (Google News, GDELT)
    // must clear a much higher about bar: "apple sauce" is not Apple Inc.
    const strongIdentity = hasStrongIdentity({
      company: { name: meta.name, ticker: meta.ticker, aliases: meta.aliases, ambiguous: meta.ambiguous },
      title: row.title,
      snippet: row.snippet,
      scoped: row.scoped === 1,
    });
    const strictAbout = meta.ambiguous === true && !strongIdentity;
    const deskMemory = this.memoryFor(row.company_id, meta.ticker);
    const state: JevState = {
      company: {
        id: row.company_id,
        name: meta.name,
        ticker: meta.ticker,
        sector: meta.sector,
      },
      mention: {
        title: row.title,
        snippet: row.snippet,
        source: {
          name: row.source_name,
          url: row.source_url,
          tier: row.source_tier as SourceTier,
        },
        publishedAt: new Date(row.published_at).toISOString(),
      },
      deskMemory,
    };

    try {
      const out = await this.deps.judge(state);
      const parsed = parseJudgment(out.answers);
      const tier = row.source_tier as SourceTier;
      const final = applyPostRules(parsed, TIER_WEIGHT[tier], { strictAbout: strictAbout });
      const inputTokens = out.inputTokens ?? 0;
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
        engine: out.model ?? this.deps.engineLabel,
        inputTokens,
        outputTokens: out.outputTokens ?? 0,
        costUsd: (inputTokens / 1_000_000) * this.deps.inputPricePerMTok,
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
      db.markFailed(id, message);
      this.deps.health.recordJev(false, message);
      db.logEvent("warn", "jev", `score failed for ${id}: ${message}`);
    }
  }

  /** Fire-and-forget webhook on fresh, high-strength events; never blocks scoring. */
  private maybeAlert(row: {
    company_id: string;
    title: string;
    published_at: number;
    impact: number | null;
    event_score: number | null;
  }): void {
    const alert = this.deps.alert;
    if (!alert?.webhookUrl) return;
    if (row.impact == null || row.event_score == null) return;
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
    const events = clusterEvents(this.deps.db.scoredMentions(now - DAY_MS));
    const counts = this.deps.db.counts24h(now - DAY_MS);
    const extras = this.earningsExtras();
    return this.computeSnapshot(companies, counts, events, companyId, now, extras);
  }

  snapshots(): CompanySnapshot[] {
    const now = Date.now();
    const companies = this.deps.db.companies();
    const byId = new Map(companies.map((c) => [c.id, c] as const));
    const events = clusterEvents(this.deps.db.scoredMentions(now - DAY_MS));
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
    const items = clusterEvents(
      this.deps.db.scoredMentions(now - windowMs).filter((m) => m.companyId === companyId),
    );
    return smoothedSeries(items, windowMs, bucketMsFor(windowHours), now);
  }
}
