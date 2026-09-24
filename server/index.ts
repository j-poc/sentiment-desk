import { serve } from "@hono/node-server";
import { VERSION, config, apiKeySource, loadCompanies } from "./config.js";
import { Desk } from "./db.js";
import { HealthTracker } from "./health.js";
import { Hub } from "./hub.js";
import { JevClient } from "./jev.js";
import { Pipeline, type JudgeFn } from "./pipeline.js";
import { RUBRIC, RUBRIC_SHA } from "./rubric.js";
import { createApp } from "./app.js";
import { MarketData, startQuotesPoller } from "./market.js";
import {
  startDemoLoop,
  startFinnhubPoller,
  startGdeltPoller,
  startRedditPoller,
  startRssPoller,
  startSecPoller,
  startXPoller,
  type SchedulerControl,
} from "./schedule.js";
import { fetchTickerCikMap } from "./sources/sec.js";
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
  const health = new HealthTracker(
    config.xBearer !== "",
    config.jev.apiKey !== "" || config.demo,
    config.jev.model,
    !config.demo && config.secUserAgent !== "",
    config.finnhubKey !== "" && !config.demo,
    config.redditClientId !== "" && config.redditClientSecret !== "" && !config.demo,
  );

  // Resolve CIKs once at boot; SEC source degrades gracefully if this fails.
  let cikByTicker = new Map<string, string>();
  if (!config.demo && config.secUserAgent) {
    try {
      cikByTicker = await fetchTickerCikMap(config.secUserAgent);
      console.log(`[desk] sec edgar: ${cikByTicker.size} tickers resolved`);
    } catch (err) {
      console.warn(`[desk] sec edgar disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
    alert: config.alertWebhookUrl
      ? {
          webhookUrl: config.alertWebhookUrl,
          eventScore: config.alertEventScore,
          impact: config.alertImpact,
          freshMinutes: config.alertFreshMinutes,
        }
      : undefined,
  });

  const market = new MarketData({ companies, indices: config.indices, hub, health, db });

  // Syndication cleanup: remove near-duplicate rows already stored.
  const dupes = db.dedupeNearDuplicates();
  if (dupes > 0) console.log(`[desk] removed ${dupes} syndication duplicates`);

  // Rubric migration: re-judge anything scored under an older rubric so the
  // whole history answers to the current questions (including investor
  // relevance). One-time cost per rubric change; fail-closed preserved.
  const requeued = db.resetOutdatedRubric(RUBRIC_SHA);
  if (requeued > 0) {
    console.log(`[desk] rubric changed: re-queueing ${requeued} mentions for re-judgment`);
  }
  // Pending work always drains on boot, whether it came from the migration,
  // an earlier crash, or scoring that was interrupted by a missing key.
  const drained = pipeline.drainPending(5_000);
  if (drained > 0) console.log(`[desk] re-queued ${drained} pending mentions`);

  const app = createApp({
    db,
    dbPath: config.dbPath,
    pipeline,
    market,
    hub,
    health,
    demo: config.demo,
    version: VERSION,
  });

  const server = serve({ fetch: app.fetch, port: config.port });

  // Quotes run in every mode: they are read-only market context.
  const schedulers: SchedulerControl[] = [
    startQuotesPoller({ market, db, intervalSeconds: config.pollQuotesSeconds }),
  ];
  // Demo mode is fully synthetic on the sentiment side: no real sources mixed in.
  if (!config.demo) {
    schedulers.push(
      startRssPoller({
      companies,
      pipeline,
      db,
      health,
      intervalSeconds: config.pollRssSeconds,
      concurrency: config.rssConcurrency,
    }),
    );
  }
  if (!config.demo && config.secUserAgent && cikByTicker.size > 0) {
    schedulers.push(
      startSecPoller({
        companies,
        cikByTicker,
        userAgent: config.secUserAgent,
        pipeline,
        db,
        health,
        intervalSeconds: config.pollSecSeconds,
      }),
    );
  }
  if (!config.demo) {
    schedulers.push(
      startGdeltPoller({ companies, pipeline, db, health, intervalSeconds: config.pollGdeltSeconds }),
    );
  }
  if (!config.demo && config.finnhubKey) {
    schedulers.push(
      startFinnhubPoller({
        companies,
        token: config.finnhubKey,
        pipeline,
        db,
        health,
        intervalSeconds: config.pollFinnhubSeconds,
        backfillDays: config.backfillDays,
      }),
    );
  }
  if (!config.demo && config.redditClientId && config.redditClientSecret) {
    schedulers.push(
      startRedditPoller({
        companies,
        creds: { clientId: config.redditClientId, clientSecret: config.redditClientSecret },
        pipeline,
        db,
        health,
        intervalSeconds: config.pollRedditSeconds,
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

  const mode = config.demo ? "DEMO" : judge ? "LIVE" : "AWAITING KEY (mentions stay pending)";
  console.log(`[desk] sentiment desk v${VERSION} ${mode} on http://localhost:${config.port}`);
  if (config.secUserAgent.includes("personal research desk")) {
    console.warn("[desk] SEC_USER_AGENT is the generic default; personalize it in .env (name + email) for long unattended runs.");
  }
  console.log(`[desk] watchlist: ${companies.length} companies | db: ${config.dbPath}`);
  if (!config.demo) {
    console.log(
      jevClient.configured
        ? `[desk] jev key resolved from ${apiKeySource}`
        : "[desk] TYPESAFE_API_KEY not found (env or ~/.newsjack/.env). Add it to .env to start scoring.",
    );
    if (!config.finnhubKey)
      console.log("[desk] finnhub: no key — free tier adds news, EPS surprises, earnings dates");
    if (!(config.redditClientId && config.redditClientSecret))
      console.log("[desk] reddit: no app credentials — free tier adds the social tier");
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
