import { serve } from "@hono/node-server";
import { config, loadCompanies } from "./config.js";
import { Desk } from "./db.js";
import { HealthTracker } from "./health.js";
import { Hub } from "./hub.js";
import { JevClient } from "./jev.js";
import { Pipeline, type JudgeFn } from "./pipeline.js";
import { RUBRIC } from "./rubric.js";
import { createApp } from "./app.js";
import { startDemoLoop, startRssPoller, startXPoller, type SchedulerControl } from "./schedule.js";
import { demoJudge } from "./demo.js";

/**
 * Boot order matters: DB first (schema + seed), then pipeline, then HTTP, then
 * pollers. Every subsystem is failure-isolated; nothing below can take the
 * HTTP surface down. Shutdown stops pollers first so no ingestion lands in a
 * half-closed database.
 */

async function main(): Promise<void> {
  const companies = loadCompanies();
  const db = new Desk(config.dbPath);
  db.seedCompanies(companies);

  const hub = new Hub();
  const health = new HealthTracker(config.xBearer !== "", config.jev.apiKey !== "" || config.demo, config.jev.model);

  const jevClient = new JevClient({
    apiKey: config.jev.apiKey,
    baseUrl: config.jev.baseUrl,
    model: config.jev.model,
    timeoutMs: config.jev.timeoutMs,
  });

  let judge: JudgeFn | null;
  let engineLabel: string;
  if (config.demo) {
    judge = demoJudge;
    engineLabel = "demo-sim";
  } else if (jevClient.configured) {
    judge = (state) => jevClient.judge(state, RUBRIC);
    engineLabel = config.jev.model;
  } else {
    judge = null;
    engineLabel = "unconfigured";
  }

  const pipeline = new Pipeline({
    db,
    judge,
    hub,
    health,
    engineLabel,
    inputPricePerMTok: config.jev.inputPricePerMTok,
    concurrency: config.scoreConcurrency,
  });

  const app = createApp({ db, pipeline, hub, health, demo: config.demo });

  const server = serve({ fetch: app.fetch, port: config.port });

  // Demo mode is fully synthetic: no real sources, no mixed data.
  const schedulers: SchedulerControl[] = [];
  if (!config.demo) {
    schedulers.push(
      startRssPoller({
        companies,
        pipeline,
        db,
        health,
        intervalSeconds: config.pollRssSeconds,
      }),
    );
  }
  if (!config.demo && config.xBearer) {
    schedulers.push(
      startXPoller({
        bearer: config.xBearer,
        companies,
        pipeline,
        db,
        health,
        intervalSeconds: config.pollXSeconds,
      }),
    );
  }
  if (config.demo) {
    schedulers.push(startDemoLoop({ companies, pipeline }));
  }

  const mode = config.demo ? "DEMO" : judge ? "LIVE" : "LIVE (no key: mentions stay pending)";
  console.log(`[desk] sentiment desk ${mode} on http://localhost:${config.port}`);
  console.log(`[desk] watchlist: ${companies.length} companies | db: ${config.dbPath}`);
  if (!config.demo && !jevClient.configured) {
    console.warn("[desk] TYPESAFE_API_KEY not set; mentions will stay pending. Set it or run with DEMO=1.");
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[desk] ${signal}: shutting down`);
    for (const s of schedulers) s.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[desk] fatal boot error:", err);
  process.exit(1);
});
