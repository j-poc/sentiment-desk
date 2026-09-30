import { serve } from "@hono/node-server";
import { VERSION, config, apiKeySource, loadCompanies } from "./config.js";
import { intersectCollectorAllowlists, intersectJevSourceAllowlist } from "./collector-policy.js";
import { Desk } from "./db.js";
import { HealthTracker } from "./health.js";
import { Hub } from "./hub.js";
import { JevClient } from "./jev.js";
import { Pipeline, type JudgeFn } from "./pipeline.js";
import { RUBRIC } from "./rubric.js";
import { createApp } from "./app.js";
import { MarketData, startQuotesPoller } from "./market.js";
import {
  startFinnhubPoller,
  startGdeltPoller,
  startJevRetryPoller,
  startRedditPoller,
  startRssPoller,
  startSecCollector,
  startSecPoller,
  startXPoller,
} from "./schedule.js";
import type { SchedulerControl } from "./scheduler.js";
import type { CollectorId } from "./types.js";

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
  const activeSourceCollectors = intersectCollectorAllowlists(
    config.externalSourceCollectors,
    config.sourceRightsApprovedCollectors,
  );
  const collectorEnabled = (collector: CollectorId) =>
    config.externalRequestsEnabled && activeSourceCollectors.has(collector);
  const jevAllowedCollectors = intersectJevSourceAllowlist(
    config.jev.allowedCollectors,
    config.externalSourceCollectors,
    config.sourceRightsApprovedCollectors,
  );
  const jevDispatchEnabled = config.externalRequestsEnabled && config.jev.apiKey !== "" &&
    config.jev.accountUseApproved &&
    jevAllowedCollectors.size > 0 &&
    config.jev.maxRequestsPerDay > 0 &&
    config.jev.maxRequestBytesPerDay > 0;

  const hub = new Hub();
  const health = new HealthTracker(
    config.xBearer !== "",
    jevDispatchEnabled,
    config.jev.model,
    config.secUserAgent !== "",
    config.finnhubKey !== "",
    config.redditClientId !== "" && config.redditClientSecret !== "",
    config.externalRequestsEnabled,
    activeSourceCollectors,
    {
      requestedCollectors: [...config.externalSourceCollectors].sort(),
      approvedCollectors: [...activeSourceCollectors].sort(),
      blockedRequestedCollectors: [...config.externalSourceCollectors]
        .filter((collector) => !config.sourceRightsApprovedCollectors.has(collector))
        .sort(),
      typesafeAccountUseApproved: config.jev.accountUseApproved,
      jevAllowedCollectors: [...jevAllowedCollectors].sort(),
    },
  );

  const jevClient = new JevClient({
    apiKey: config.jev.apiKey,
    baseUrl: config.jev.baseUrl,
    model: config.jev.model,
    timeoutMs: config.jev.timeoutMs,
  });

  let judge: JudgeFn | null;
  let engineLabel: string;
  if (jevClient.configured && jevDispatchEnabled) {
    judge = (state) => jevClient.judge(state, RUBRIC);
    engineLabel = config.jev.model;
  } else {
    judge = null;
    engineLabel = "unconfigured";
    if (config.externalRequestsEnabled && config.jev.apiKey && !jevDispatchEnabled) {
      console.log("[desk] Jev dispatch disabled: configure an explicit source allowlist and finite daily limits");
    }
  }

  const pipeline = new Pipeline({
    db,
    judge,
    hub,
    health,
    engineLabel,
    inputPricePerMTok: config.jev.inputPricePerMTok,
    concurrency: config.scoreConcurrency,
    allowedCollectors: jevAllowedCollectors,
    dailyBudget: {
      utcDay: () => new Date().toISOString().slice(0, 10),
      maxRequests: config.jev.maxRequestsPerDay,
      maxRequestBytes: config.jev.maxRequestBytesPerDay,
    },
    alert: config.alertWebhookUrl
      ? {
          webhookUrl: config.alertWebhookUrl,
          eventScore: config.alertEventScore,
          impact: config.alertImpact,
          freshMinutes: config.alertFreshMinutes,
        }
      : undefined,
  });

  const market = new MarketData({
    companies,
    indices: config.indices,
    hub,
    health,
    db,
    externalRequestsEnabled: config.externalRequestsEnabled,
    quoteRequestsEnabled: collectorEnabled("yahoo_quote"),
    chartRequestsEnabled: collectorEnabled("yahoo_chart"),
  });
  // Pending work drains on boot only when Jev is configured. Without a key,
  // real observations remain pending and create no scoring failure attempts.
  // Existing completed scores remain untouched when the current rubric changes.
  const drained = pipeline.drainPending(5_000);
  if (drained > 0) console.log(`[desk] re-queued ${drained} pending mentions`);

  const app = createApp({
    db,
    dbPath: config.dbPath,
    pipeline,
    market,
    hub,
    health,
    version: VERSION,
    opportunityRadarEnabled: false,
    deliverySources: [
      { collector: "google_news_rss", enabled: collectorEnabled("google_news_rss"), intervalSeconds: config.pollRssSeconds, targetCount: companies.length },
      { collector: "yahoo_finance_rss", enabled: collectorEnabled("yahoo_finance_rss"), intervalSeconds: config.pollRssSeconds, targetCount: companies.length },
      { collector: "gdelt_doc_api", enabled: collectorEnabled("gdelt_doc_api"), intervalSeconds: config.pollGdeltSeconds, targetCount: companies.length },
      { collector: "sec_edgar", enabled: collectorEnabled("sec_edgar") && config.secUserAgent !== "", intervalSeconds: config.pollSecSeconds, targetCount: companies.length },
      { collector: "finnhub", enabled: collectorEnabled("finnhub") && config.finnhubKey !== "", intervalSeconds: config.pollFinnhubSeconds, targetCount: companies.length, healthAdapterVersions: ["finnhub-news/1"] },
      { collector: "reddit", enabled: collectorEnabled("reddit") && config.redditClientId !== "" && config.redditClientSecret !== "", intervalSeconds: config.pollRedditSeconds, targetCount: companies.length },
      { collector: "x", enabled: collectorEnabled("x") && config.xBearer !== "", intervalSeconds: config.pollXSeconds, targetCount: companies.length },
      { collector: "yahoo_quote", enabled: collectorEnabled("yahoo_quote"), intervalSeconds: config.pollQuotesSeconds, targetCount: companies.length, healthCompanyOnly: true },
      { collector: "yahoo_chart", enabled: collectorEnabled("yahoo_chart"), intervalSeconds: config.pollQuotesSeconds, targetCount: companies.length },
    ],
  });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });

  // Read-only quote context still requires global opt-in and the Yahoo quote allowlist entry.
  const schedulers: SchedulerControl[] = [];
  if (config.externalRequestsEnabled) {
    if (collectorEnabled("yahoo_quote")) {
      schedulers.push(startQuotesPoller({ market, db, intervalSeconds: config.pollQuotesSeconds }));
    }
    if (judge) schedulers.push(startJevRetryPoller(pipeline));
    if (collectorEnabled("google_news_rss") || collectorEnabled("yahoo_finance_rss")) {
      schedulers.push(startRssPoller({
        companies,
        pipeline,
        db,
        health,
        intervalSeconds: config.pollRssSeconds,
        concurrency: config.rssConcurrency,
        enabledCollectors: activeSourceCollectors,
      }));
    }
    if (collectorEnabled("sec_edgar") && config.secUserAgent) {
      schedulers.push(startSecCollector({
        companies,
        userAgent: config.secUserAgent,
        pipeline,
        db,
        health,
        intervalSeconds: config.pollSecSeconds,
      }));
    }
    if (collectorEnabled("gdelt_doc_api")) {
      schedulers.push(startGdeltPoller({ companies, pipeline, db, health, intervalSeconds: config.pollGdeltSeconds }));
    }
    if (collectorEnabled("finnhub") && config.finnhubKey) {
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
    if (collectorEnabled("reddit") && config.redditClientId && config.redditClientSecret) {
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
    if (collectorEnabled("x") && config.xBearer) {
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
  } else {
    console.log("[desk] external requests disabled; serving stored local data only");
  }
  const mode = !config.externalRequestsEnabled
    ? "OFFLINE (saved data only)"
    : activeSourceCollectors.size === 0
      ? config.externalSourceCollectors.size === 0
        ? "REQUESTS ENABLED (source allowlist empty)"
        : "REQUESTS ENABLED (source approvals missing)"
      : judge
      ? "LIVE"
      : "AWAITING KEY (mentions stay pending)";
  console.log(`[desk] sentiment desk v${VERSION} ${mode} on http://localhost:${config.port}`);
  if (config.secUserAgent.includes("personal research desk")) {
    console.warn("[desk] SEC_USER_AGENT is the generic default; personalize it in .env (name + email) for long unattended runs.");
  }
  console.log(`[desk] watchlist: ${companies.length} companies | db: ${config.dbPath}`);
  console.log(!config.externalRequestsEnabled
    ? "[desk] source and Jev requests are paused by EXTERNAL_REQUESTS_ENABLED=false; credentials are unused"
    : jevClient.configured
    ? `[desk] jev key resolved from ${apiKeySource}`
    : apiKeySource === "disabled by env"
      ? "[desk] Jev disabled by explicit empty TYPESAFE_API_KEY; live observations stay pending."
      : "[desk] TYPESAFE_API_KEY not found (env or ~/.newsjack/.env). Add it to .env to start scoring.");
  if (config.externalRequestsEnabled && !config.finnhubKey)
    console.log("[desk] finnhub: no key — free tier adds news, EPS surprises, earnings dates");
  if (config.externalRequestsEnabled && !(config.redditClientId && config.redditClientSecret))
    console.log("[desk] reddit: no app credentials — free tier adds the social tier");
  if (config.externalRequestsEnabled && config.externalSourceCollectors.size > activeSourceCollectors.size) {
    console.log(`[desk] blocked unapproved source requests: ${[...config.externalSourceCollectors]
      .filter((collector) => !config.sourceRightsApprovedCollectors.has(collector)).sort().join(", ")}`);
  }
  if (config.externalRequestsEnabled && config.jev.apiKey && !config.jev.accountUseApproved) {
    console.log("[desk] Jev dispatch blocked: TYPESAFE_ACCOUNT_USE_APPROVED is not set");
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[desk] ${signal}: shutting down`);
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    void (async () => {
      await Promise.all(schedulers.map((scheduler) => scheduler.stop()));
      await market.waitForIdle();
      await pipeline.waitForIdle();
      // SSE responses otherwise keep server.close() pending indefinitely.
      hub.closeAll();
      // Tear down any remaining keep-alive or stalled HTTP sockets after the SSE routes close.
      if ("closeAllConnections" in server) server.closeAllConnections();
      await httpClosed;
      db.close();
      process.exit(0);
    })().catch((error: unknown) => {
      console.error("[desk] graceful shutdown failed:", error);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[desk] fatal boot error:", err);
  process.exit(1);
});
