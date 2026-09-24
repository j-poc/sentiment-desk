import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Desk } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { MarketData } from "./market.js";
import type { Pipeline } from "./pipeline.js";
import { clusterConfirmations, forwardReturn, summarizeReactions, validateSignal } from "./scoring.js";

/**
 * HTTP surface: read-only JSON APIs plus the SSE stream. No client can write
 * anything; the only writer is the server's own pipeline. Static assets come
 * from dist/web in production; in dev the Vite server hosts the UI and proxies
 * /api here.
 */

export interface AppDeps {
  db: Desk;
  dbPath: string;
  pipeline: Pipeline;
  market: MarketData;
  hub: Hub;
  health: HealthTracker;
  demo: boolean;
  version: string;
  webRoot?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

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
    return c.json({
      ok: true,
      version: deps.version,
      demo: deps.demo,
      uptimeSec: Math.floor(process.uptime()),
      sseClients: deps.hub.size,
      dbSizeBytes,
      health: deps.health.snapshot(),
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
    const confirmations = clusterConfirmations(
      ms.map((m) => ({ id: m.id, title: m.title, publishedAt: m.publishedAt, companyId: m.companyId })),
    );
    return c.json(ms.map((m) => ({ ...m, confirmations: confirmations.get(m.id) ?? 1 })));
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
      .filter((m) => m.status === "scored" && m.score);
    const series = deps.db.priceWindow(ticker, since - 60 * 60 * 1000);
    const events = mentions.map((m) => ({
      id: m.id,
      title: m.title,
      publishedAt: m.publishedAt,
      sentiment: m.score?.sentiment ?? "neutral",
      eventScore: m.score?.eventScore ?? 0,
      eventType: m.score?.eventType ?? "other",
      r30: forwardReturn(series, m.publishedAt, 30 * 60_000),
      r240: forwardReturn(series, m.publishedAt, 4 * 60 * 60_000),
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
    const ticker = (c.req.query("ticker") ?? "").toUpperCase();
    if (!/^[A-Z^.\-=]{1,12}$/.test(ticker)) return c.json({ error: "bad ticker" }, 400);
    const hours = clampNumber(c.req.query("hours"), 1, 720, 24);
    // Our own accumulated price history first (poller points + Yahoo backfill);
    // it spans the full window once the desk has run. Yahoo is the fallback.
    const local = deps.db.priceWindow(ticker, Date.now() - hours * 60 * 60 * 1000);
    if (local.length >= 8) return c.json(local);
    try {
      return c.json(await deps.market.priceSeries(ticker, hours));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
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
    return c.json({
      hours,
      totalEvents: events.length,
      withReaction: rows.filter((r) => r.r30 != null).length,
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
      // The hub serializes payloads; send() receives pre-encoded strings.
      const send = (event: string, data: string): Promise<void> => {
        if (!open) return Promise.resolve();
        return stream.writeSSE({ event, data }).catch(() => {
          open = false;
          deps.hub.remove(send);
        }) as Promise<void>;
      };
      deps.hub.add(send);
      stream.onAbort(() => {
        open = false;
        deps.hub.remove(send);
        if (hb) clearInterval(hb);
      });
      await send("hello", JSON.stringify({ demo: deps.demo, now: Date.now() }));
      hb = setInterval(() => void send("ping", String(Date.now())), 15_000);
      // Hold the stream open until the client disconnects; onAbort cleans up.
      await new Promise<never>(() => {});
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
