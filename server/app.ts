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
    const limit = clampNumber(c.req.query("limit"), 1, 200, 60);
    return c.json(deps.db.mentionsForCompany(id, Date.now() - hours * 60 * 60 * 1000, limit));
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
    try {
      return c.json(await deps.market.priceSeries(ticker, hours));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  app.get("/api/tape", (c) => {
    const limit = clampNumber(c.req.query("limit"), 1, 100, 40);
    return c.json(deps.db.recentScored(limit));
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
