import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AlertDeliveryCursor, Desk, DeliverySourceSchedule, MentionFeedFilter, MentionPageCursor, ScoreBucketCursor } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { MarketData } from "./market.js";
import type { Pipeline } from "./pipeline.js";
import { forwardReturn, rankIC, SERIES_BUCKET_MS, summarizeReactions, validateSignal } from "./scoring.js";
import { buildRadar, isRadarEventType, radarEvidencePage } from "./radar.js";

/**
 * HTTP surface: read APIs, an explicitly confirmed single-item Jev retry, and
 * the SSE stream. Static assets come from dist/web in production; in dev the
 * Vite server hosts the UI and proxies /api here.
 */

export interface AppDeps {
  db: Desk;
  dbPath: string;
  pipeline: Pipeline;
  market: MarketData;
  hub: Hub;
  health: HealthTracker;
  version: string;
  opportunityRadarEnabled?: boolean;
  webRoot?: string;
  deliverySources: DeliverySourceSchedule[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_SERIES_REFRESH_AGE_MS = 5 * 60 * 1000;
const retryConfirmationSchema = z.object({
  confirmNewCharge: z.literal(true),
  reviewedProviderUsage: z.boolean(),
});
const unscoredCursorSchema = z.object({
  orderAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ingestedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1).max(200),
});
const scoreBucketCursorSchema = z.object({
  scoredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1).max(200),
});
const alertDeliveryCursorSchema = z.object({
  priority: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  alertId: z.string().uuid(),
}).strict();
const mentionFeedFilterSchema = z.enum(["all", "bull", "bear", "material", "offtarget", "failed"]);
const mentionLookupSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(900)
    .refine((ids) => new Set(ids).size === ids.length),
});

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const runtimeId = randomUUID();

  app.onError((err, c) => {
    console.error(`[http] ${c.req.path}:`, err);
    return c.json({ error: "internal" }, 500);
  });

  app.get("/api/health", (c) => {
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = statSync(deps.dbPath).size;
    } catch {
      /* db file not yet created */
    }
    const healthSnapshot = deps.health.snapshot();
    const alertPage = deps.db.alertDeliveryPage(10);
    return c.json({
      ok: true,
      externalRequestsEnabled: healthSnapshot.externalRequestsEnabled,
      opportunityRadarEnabled: deps.opportunityRadarEnabled === true,
      version: deps.version,
      runtimeId,
      uptimeSec: Math.floor(process.uptime()),
      sseClients: deps.hub.size,
      dbSizeBytes,
      health: healthSnapshot,
      deliveries: deps.db.deliverySummary(),
      deliveryHealth: deps.db.deliveryHealth(deps.deliverySources),
      alertDelivery: {
        configured: deps.pipeline.alertDeliveryConfigured,
        enabled: deps.pipeline.alertDeliveryEnabled,
        counts: deps.db.alertDeliveryCounts(),
        recent: alertPage.items,
        nextCursor: alertPage.nextCursor == null ? null : JSON.stringify(alertPage.nextCursor),
      },
      usage: deps.db.usageSince(startOfDayUtc.getTime()),
      events: deps.db.recentEvents(20),
    });
  });

  app.get("/api/alerts", (c) => {
    const rawCursor = c.req.query("cursor");
    let cursor: AlertDeliveryCursor | null = null;
    if (rawCursor != null) {
      if (rawCursor.length > 500) return c.json({ error: "invalid_cursor" }, 400);
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawCursor);
      } catch {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      const parsed = alertDeliveryCursorSchema.safeParse(decoded);
      if (!parsed.success) return c.json({ error: "invalid_cursor" }, 400);
      cursor = parsed.data;
    }
    const page = deps.db.alertDeliveryPage(clampNumber(c.req.query("limit"), 1, 20, 10), cursor);
    return c.json({
      items: page.items,
      nextCursor: page.nextCursor == null ? null : JSON.stringify(page.nextCursor),
    });
  });

  app.get("/api/quotes", (c) => c.json(deps.market.current()));

  app.get("/api/mentions/:id/jev-attempts", (c) => {
    const id = c.req.param("id");
    if (!deps.db.mentionRow(id)) return c.json({ error: "unknown mention" }, 404);
    return c.json(deps.db.jevAttemptHistory(id));
  });

  app.get("/api/companies", (c) => c.json(deps.pipeline.snapshots()));

  app.get("/api/companies/:id/mentions", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    const limit = clampNumber(c.req.query("limit"), 1, 200, 100);
    const ms = deps.db.mentionsForCompany(id, Date.now() - hours * 60 * 60 * 1000, limit);
    return c.json(ms);
  });

  app.get("/api/companies/:id/mentions-page", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 1, 168, 168);
    const limit = clampNumber(c.req.query("limit"), 1, 100, 100);
    const parsedFilter = mentionFeedFilterSchema.safeParse(c.req.query("filter") ?? "all");
    if (!parsedFilter.success) return c.json({ error: "invalid_filter" }, 400);
    const filter: MentionFeedFilter = parsedFilter.data;
    const rawCursor = c.req.query("cursor");
    let cursor: MentionPageCursor | null = null;
    if (rawCursor != null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawCursor);
      } catch {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      const parsed = unscoredCursorSchema.safeParse(decoded);
      if (!parsed.success) return c.json({ error: "invalid_cursor" }, 400);
      cursor = parsed.data;
    }
    // Failed and pending work must remain recoverable after the normal seven-day
    // investor window; all other filters stay within the disclosed seven days.
    const sinceMs = filter === "failed" ? 0 : Date.now() - hours * 60 * 60 * 1000;
    return c.json(deps.db.mentionsForCompanyPage({ companyId: id, sinceMs, limit, cursor, filter }));
  });

  app.post("/api/companies/:id/mentions/lookup", async (c) => {
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) return c.json({ error: "unknown company" }, 404);
    const input = mentionLookupSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_mention_lookup" }, 400);
    return c.json({ items: deps.db.mentionsByIds(id, input.data.ids) });
  });

  app.post("/api/mentions/:id/retry", async (c) => {
    const input = retryConfirmationSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "retry_confirmation_required" }, 400);

    const result = deps.pipeline.retryFailed(c.req.param("id"), input.data.reviewedProviderUsage);
    switch (result) {
      case "queued":
        return c.json({ status: "accepted" }, 202);
      case "usage_review_required":
        return c.json({ error: "provider_usage_review_required" }, 409);
      case "not_retryable":
        return c.json({ error: "mention_not_retryable" }, 409);
      case "jev_unavailable":
        return c.json({ error: "jev_not_configured" }, 503);
      case "budget_exhausted":
        return c.json({ error: "jev_daily_budget_exhausted" }, 429);
      default: {
        const exhaustive: never = result;
        return c.json({ error: String(exhaustive) }, 500);
      }
    }
  });

  app.get("/api/companies/:id/radar", (c) => {
    if (deps.opportunityRadarEnabled !== true) return c.json({ error: "opportunity_radar_not_enabled" }, 404);
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) {
      return c.json({ error: "unknown company" }, 404);
    }
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    const now = Date.now();
    const rawAsOf = c.req.query("asOf");
    let asOf = now;
    if (rawAsOf != null) {
      if (!/^\d+$/.test(rawAsOf)) return c.json({ error: "invalid snapshot time" }, 400);
      asOf = Number(rawAsOf);
      if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf > now) {
        return c.json({ error: "invalid snapshot time" }, 400);
      }
    }
    const duration = hours * 60 * 60 * 1000;
    const currentFrom = asOf - duration;
    const previousFrom = currentFrom - duration;
    const uncounted = deps.db.radarUncounted(id, currentFrom, asOf, asOf);
    const coverage = deps.db.deliveryHealth(deps.deliverySources, now).filter(({ collector }) =>
      ["google_news_rss", "yahoo_finance_rss", "gdelt_doc_api", "sec_edgar", "finnhub", "reddit", "x"].includes(collector),
    );
    return c.json({
      ...buildRadar({
        hours,
        now: asOf,
        currentRows: deps.db.radarEvidence(id, currentFrom, asOf, asOf),
        previousRows: deps.db.radarEvidence(id, previousFrom, currentFrom, asOf),
        untimedScored: uncounted.untimedScored,
        unjudged: uncounted.unjudged,
      }),
      coverage,
    });
  });

  app.get("/api/companies/:id/radar/evidence", (c) => {
    if (deps.opportunityRadarEnabled !== true) return c.json({ error: "opportunity_radar_not_enabled" }, 404);
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) {
      return c.json({ error: "unknown company" }, 404);
    }
    const rawEventType = c.req.query("eventType") ?? "";
    if (!isRadarEventType(rawEventType)) return c.json({ error: "unknown event type" }, 400);
    const rawPeriod = c.req.query("period") ?? "current";
    if (rawPeriod !== "current" && rawPeriod !== "previous") return c.json({ error: "unknown period" }, 400);
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    const now = Date.now();
    const rawAsOf = c.req.query("asOf");
    let asOf = now;
    if (rawAsOf != null) {
      if (!/^\d+$/.test(rawAsOf)) return c.json({ error: "invalid snapshot time" }, 400);
      asOf = Number(rawAsOf);
      if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf > now) {
        return c.json({ error: "invalid snapshot time" }, 400);
      }
    }
    const duration = hours * 60 * 60 * 1000;
    const currentFrom = asOf - duration;
    const from = rawPeriod === "current" ? currentFrom : currentFrom - duration;
    const to = rawPeriod === "current" ? asOf : currentFrom;
    const offset = clampNumber(c.req.query("offset"), 0, 5_000, 0);
    const limit = clampNumber(c.req.query("limit"), 1, 25, 5);
    return c.json({
      generatedAt: asOf,
      hours,
      period: rawPeriod,
      ...radarEvidencePage({
        rows: deps.db.radarEvidence(id, from, to, asOf),
        eventType: rawEventType,
        offset,
        limit,
      }),
    });
  });

  /**
   * Exploratory reaction description: timely forward prices after a
   * source-identified judgment became available. Publisher time remains for
   * context; it is not used as the reaction baseline.
   */
  app.get("/api/companies/:id/reactions", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 6, 168, 24);
    const ticker = deps.db.companies().find((x) => x.id === id)?.ticker;
    if (!ticker) return c.json({ error: "unknown company" }, 404);
    const now = Date.now();
    const since = now - hours * 60 * 60 * 1000;
    const mentions = deps.db.scoredReactionEventsForCompany(id, since, now);
    const series = deps.db.priceWindow(ticker, since - 60 * 60 * 1000, now);
    const events = mentions.map((m) => ({
      id: m.id,
      title: m.title,
      publishedAt: m.publishedAt,
      sentiment: m.sentiment,
      eventScore: m.eventScore,
      eventType: m.eventType,
      availableAt: m.availableAt,
      r30: forwardReturn(series, m.availableAt, 30 * 60_000, now),
      r240: forwardReturn(series, m.availableAt, 4 * 60 * 60_000, now),
    }));
    const bull = summarizeReactions(events.filter((e) => e.sentiment === "positive"));
    const bear = summarizeReactions(events.filter((e) => e.sentiment === "negative"));
    const all = summarizeReactions(events);
    const measured = events.filter((e) => e.r30 != null || e.r240 != null);
    const examples = [...measured]
      .sort((a, b) => b.eventScore - a.eventScore || b.availableAt - a.availableAt || a.id.localeCompare(b.id))
      .slice(0, 8);
    return c.json({ ticker, events: examples, measuredEventCount: measured.length, bull, bear, all });
  });

  app.get("/api/companies/:id/series", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    return c.json(deps.pipeline.series(id, hours));
  });

  app.get("/api/companies/:id/score-bucket", (c) => {
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) return c.json({ error: "unknown company" }, 404);
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    const throughMs = Number(c.req.query("through"));
    const now = Date.now();
    if (!Number.isSafeInteger(throughMs) || throughMs < now - hours * 60 * 60_000 - SERIES_BUCKET_MS || throughMs > now) {
      return c.json({ error: "invalid_score_bucket" }, 400);
    }
    const rawIncludeFromBoundary = c.req.query("includeFromBoundary");
    if (rawIncludeFromBoundary != null && rawIncludeFromBoundary !== "true" && rawIncludeFromBoundary !== "false") {
      return c.json({ error: "invalid_score_bucket_boundary" }, 400);
    }
    const includeFromBoundary = rawIncludeFromBoundary === "true";
    const rawCursor = c.req.query("cursor");
    let cursor: ScoreBucketCursor | null = null;
    if (rawCursor != null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawCursor);
      } catch {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      const parsed = scoreBucketCursorSchema.safeParse(decoded);
      if (!parsed.success) return c.json({ error: "invalid_cursor" }, 400);
      if (parsed.data.scoredAt > throughMs) return c.json({ error: "invalid_cursor" }, 400);
      cursor = parsed.data;
    }
    const page = deps.db.mentionsForScoreBucket({
      companyId: id,
      fromMs: throughMs - SERIES_BUCKET_MS,
      throughMs,
      includeFromBoundary,
      limit: clampNumber(c.req.query("limit"), 1, 100, 50),
      cursor,
    });
    return c.json({
      bucketFromMs: throughMs - SERIES_BUCKET_MS,
      bucketThroughMs: throughMs,
      includeFromBoundary,
      items: page.items,
      nextCursor: page.nextCursor,
    });
  });

  app.get("/api/companies/:id/price", async (c) => {
    const id = c.req.param("id");
    const ticker = (c.req.query("ticker") ?? "").toUpperCase();
    if (!/^[A-Z^.\-=]{1,12}$/.test(ticker)) return c.json({ error: "bad ticker" }, 400);
    const company = deps.db.companies().find((candidate) => candidate.id === id);
    if (!company) return c.json({ error: "unknown company" }, 404);
    if (company.ticker !== ticker) return c.json({ error: "company_ticker_mismatch" }, 409);
    const hours = clampNumber(c.req.query("hours"), 1, 720, 24);
    const now = Date.now();
    const since = now - hours * 60 * 60 * 1000;
    // Only source-attributed Yahoo chart history is eligible for this pane;
    // legacy points with unknown origin or currency are quarantined in SQLite.
    let pts: Array<{
      t: number;
      price: number;
      currency: string;
      collector?: "yahoo_chart" | "yahoo_quote";
      retrievedAt?: number;
      adapterVersion?: string;
      deliveryId?: string;
    }> = deps.db.priceWindow(ticker, since);
    const savedHistoryLatestAt = deps.db.priceWindow(ticker, now - 168 * 60 * 60 * 1000, now).at(-1)?.t ?? null;
    let seriesDelivery: "network" | "memory_cache" | "local_store" = "local_store";
    let seriesServedAt = Date.now();
    let refreshError: string | null = null;
    let cacheAgeMs: number | null = null;
    const latestRetrievedAt = pts.reduce<number | null>((latest, point) =>
      typeof point.retrievedAt === "number" && Number.isFinite(point.retrievedAt)
        && point.retrievedAt > 0 && point.retrievedAt <= now
        ? Math.max(latest ?? point.retrievedAt, point.retrievedAt)
        : latest, null);
    const seriesNeedsRefresh = pts.length < 8
      || latestRetrievedAt == null
      || now - latestRetrievedAt > PRICE_SERIES_REFRESH_AGE_MS;
    if (seriesNeedsRefresh) {
      try {
        const result = await deps.market.priceSeries(ticker, hours);
        if (result.points.length > 0) {
          const byTimestamp = new Map(pts.map((point) => [point.t, point]));
          for (const point of result.points) byTimestamp.set(point.t, point);
          pts = [...byTimestamp.values()].sort((a, b) => a.t - b.t);
        }
        seriesDelivery = result.points.length === 0 && pts.length > 0 ? "local_store" : result.delivery;
        seriesServedAt = result.servedAt;
        cacheAgeMs = result.cacheAgeMs;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (pts.length === 0 && savedHistoryLatestAt == null) return c.json({ error: message }, 502);
        refreshError = message;
        seriesDelivery = "local_store";
        seriesServedAt = Date.now();
      }
    }
    // Price values and timestamps are provider observations. Do not carry a
    // stale close into later buckets or relabel it as an observation at a
    // generated display timestamp; closed-market windows can be empty.
    const observed = pts
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price) && point.price > 0
        && typeof point.currency === "string" && /^[A-Z]{3}$/.test(point.currency)
        && typeof point.retrievedAt === "number" && Number.isFinite(point.retrievedAt)
        && point.retrievedAt > 0 && point.retrievedAt <= now
        && typeof point.adapterVersion === "string" && point.adapterVersion.length > 0
        && typeof point.deliveryId === "string" && point.deliveryId.length > 0
        && point.t > 0 && point.t <= now)
      .sort((a, b) => a.t - b.t);
    const inWindow = observed.filter((point) => point.t >= since);
    const currencies = new Set(inWindow.map((point) => point.currency));
    if (currencies.size > 1) return c.json({ error: "price_currency_mismatch" }, 502);
    const observedLatestAt = observed.at(-1)?.t ?? null;
    const sourceLatestAt = [savedHistoryLatestAt, observedLatestAt]
      .filter((value): value is number => value != null && value > 0 && value <= now)
      .reduce<number | null>((latest, value) => Math.max(latest ?? value, value), null);
    return c.json({
      points: inWindow.map((point) => ({
        ...point,
        collector: point.collector ?? "yahoo_chart",
        adapterVersion: point.adapterVersion ?? "yahoo-chart/1",
        deliveryId: point.deliveryId,
      })),
      delivery: seriesDelivery,
      servedAt: seriesServedAt,
      sourceLatestAt,
      cacheAgeMs,
      refreshError,
      resampling: "source_observations_in_window",
    });
  });

  /**
  * Exploratory watchlist-wide item-level description; not a Jev quality
  * evaluation, causal estimate, or clustered return study.
  */
  app.get("/api/validation", (c) => {
    const hours = clampNumber(c.req.query("hours"), 24, 168, 120);
    const now = Date.now();
    const since = now - hours * 60 * 60 * 1000;
    const events = deps.db.scoredMentionEvents(since, now);
    const seriesByTicker = new Map<string, Array<{ t: number; price: number; retrievedAt: number }>>();
    for (const e of events) {
      if (!seriesByTicker.has(e.ticker)) {
        seriesByTicker.set(e.ticker, deps.db.priceWindow(e.ticker, since - 60 * 60 * 1000, now));
      }
    }
    const rows = events.map((e) => ({
      eventScore: e.eventScore,
      sentiment: e.sentiment,
      r30: forwardReturn(seriesByTicker.get(e.ticker) ?? [], e.availableAt, 30 * 60_000, now),
    }));
    const measured = rows
      .filter((r) => r.r30 != null)
      .map((r) => [r.eventScore, Math.abs(r.r30 ?? 0)] as [number, number]);
    return c.json({
      hours,
      totalEvents: events.length,
      withReaction: measured.length,
      rankIC: rankIC(measured),
      buckets: validateSignal(rows),
      generatedAt: now,
    });
  });

  app.get("/api/tape", (c) => {
    const limit = clampNumber(c.req.query("limit"), 1, 100, 40);
    return c.json(deps.db.recentVisible(limit));
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      let hb: ReturnType<typeof setInterval> | undefined;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
      const cleanup = () => {
        if (!open) return;
        open = false;
        deps.hub.remove(send);
        if (hb) clearInterval(hb);
        resolveClosed();
      };
      // The hub serializes payloads; send() receives pre-encoded strings.
      const send = (event: string, data: string): Promise<void> => {
        if (!open) return Promise.resolve();
        return stream.writeSSE({ event, data }).catch(() => {
          cleanup();
        }) as Promise<void>;
      };
      deps.hub.add(send, cleanup);
      stream.onAbort(cleanup);
      await send("hello", JSON.stringify({ now: Date.now(), runtimeId }));
      if (open) hb = setInterval(() => void send("ping", String(Date.now())), 15_000);
      await closed;
    }),
  );

  const webRoot = deps.webRoot ?? path.resolve("dist/web");
  if (existsSync(path.join(webRoot, "index.html"))) {
    const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
    app.use("*", serveStatic({ root: path.relative(process.cwd(), webRoot) }));
    app.get("*", (c) => c.html(indexHtml));
  } else {
    app.get("*", (c) =>
      c.text("Sentiment Desk API is running. In dev, run `npm run dev:web` and open the Vite URL.", 200),
    );
  }

  return app;
}

function clampNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export { DAY_MS };
