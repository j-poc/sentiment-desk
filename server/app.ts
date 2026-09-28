import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Desk, DeliverySourceSchedule } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { MarketData } from "./market.js";
import type { Pipeline } from "./pipeline.js";
import { forwardReturn, rankIC, summarizeReactions, validateSignal } from "./scoring.js";
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
  webRoot?: string;
  deliverySources: DeliverySourceSchedule[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const retryConfirmationSchema = z.object({
  confirmNewCharge: z.literal(true),
  reviewedProviderUsage: z.boolean(),
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
    return c.json({
      ok: true,
      version: deps.version,
      runtimeId,
      uptimeSec: Math.floor(process.uptime()),
      sseClients: deps.hub.size,
      dbSizeBytes,
      health: healthSnapshot,
      deliveries: deps.db.deliverySummary(),
      deliveryHealth: deps.db.deliveryHealth(deps.deliverySources),
      usage: deps.db.usageSince(startOfDayUtc.getTime()),
      events: deps.db.recentEvents(20),
    });
  });

  app.get("/api/quotes", (c) => c.json(deps.market.current()));

  app.get("/api/companies", (c) => c.json(deps.pipeline.snapshots()));

  app.get("/api/companies/:id/mentions", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    const limit = clampNumber(c.req.query("limit"), 1, 200, 100);
    const ms = deps.db.mentionsForCompany(id, Date.now() - hours * 60 * 60 * 1000, limit);
    return c.json(ms);
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
   * Outcome verification: forward price returns after each judged event, plus
   * aggregate hit-rate stats. Reaction is evidence, not causation; the payload
   * carries n so small samples stay visibly small.
   */
  app.get("/api/companies/:id/reactions", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 6, 168, 24);
    const ticker = deps.db.companies().find((x) => x.id === id)?.ticker;
    if (!ticker) return c.json({ error: "unknown company" }, 404);
    const since = Date.now() - hours * 60 * 60 * 1000;
    const mentions = deps.db
      .mentionsForCompany(id, since, 200)
      .filter((m) => m.status === "scored" && m.score && m.publishedAt != null);
    const series = deps.db.priceWindow(ticker, since - 60 * 60 * 1000);
    const events = mentions.map((m) => ({
      id: m.id,
      title: m.title,
      publishedAt: m.publishedAt!,
      sentiment: m.score?.sentiment ?? "neutral",
      eventScore: m.score?.eventScore ?? 0,
      eventType: m.score?.eventType ?? "other",
      r30: forwardReturn(series, m.publishedAt!, 30 * 60_000),
      r240: forwardReturn(series, m.publishedAt!, 4 * 60 * 60_000),
    }));
    const bull = summarizeReactions(events.filter((e) => e.sentiment === "positive"));
    const bear = summarizeReactions(events.filter((e) => e.sentiment === "negative"));
    const all = summarizeReactions(events);
    return c.json({ ticker, events, bull, bear, all });
  });

  app.get("/api/companies/:id/series", (c) => {
    const id = c.req.param("id");
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    return c.json(deps.pipeline.series(id, hours));
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
    // Our own accumulated price history first (poller points + Yahoo backfill);
    // Yahoo is the fallback when local history is thin.
    let pts: Array<{ t: number; price: number }> = deps.db.priceWindow(ticker, since);
    let seriesDelivery: "network" | "memory_cache" | "local_store" = "local_store";
    let seriesServedAt = Date.now();
    let sourceLatestAt = pts.at(-1)?.t ?? null;
    let cacheAgeMs: number | null = null;
    if (pts.length < 8) {
      try {
        const result = await deps.market.priceSeries(ticker, hours);
        pts = result.points;
        seriesDelivery = result.delivery;
        seriesServedAt = result.servedAt;
        sourceLatestAt = result.sourceLatestAt;
        cacheAgeMs = result.cacheAgeMs;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 502);
      }
    }
    // Price values and timestamps are provider observations. Do not carry a
    // stale close into later buckets or relabel it as an observation at a
    // generated display timestamp; closed-market windows can be empty.
    const observed = pts
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.price) && point.price > 0 && point.t > 0 && point.t <= now)
      .sort((a, b) => a.t - b.t);
    const inWindow = observed.filter((point) => point.t >= since);
    sourceLatestAt = observed.at(-1)?.t ?? null;
    return c.json({
      points: inWindow,
      delivery: seriesDelivery,
      servedAt: seriesServedAt,
      sourceLatestAt,
      cacheAgeMs,
      resampling: "source_observations_in_window",
    });
  });

  /**
  * Signal validation across the whole watchlist: judged events bucketed by
  * strength, measured against realized 30-minute price reactions.
  */
  app.get("/api/validation", (c) => {
    const hours = clampNumber(c.req.query("hours"), 24, 168, 120);
    const since = Date.now() - hours * 60 * 60 * 1000;
    const events = deps.db.scoredMentionEvents(since);
    const seriesByTicker = new Map<string, Array<{ t: number; price: number }>>();
    for (const e of events) {
      if (!seriesByTicker.has(e.ticker)) {
        seriesByTicker.set(e.ticker, deps.db.priceWindow(e.ticker, since - 60 * 60 * 1000));
      }
    }
    const rows = events.map((e) => ({
      eventScore: e.eventScore,
      sentiment: e.sentiment,
      r30: forwardReturn(seriesByTicker.get(e.ticker) ?? [], e.publishedAt, 30 * 60_000),
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
      generatedAt: Date.now(),
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
