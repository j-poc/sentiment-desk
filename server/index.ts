import { serve } from "@hono/node-server";
import { VERSION, config, loadCompanies } from "./config.js";
import { intersectClassifierSourceAllowlist, intersectCollectorAllowlists } from "./collector-policy.js";
import { Desk } from "./db.js";
import { HealthTracker } from "./health.js";
import { Hub } from "./hub.js";
import { OpenAIClassifier } from "./openai-classifier.js";
import { Pipeline } from "./pipeline.js";
import { createApp } from "./app.js";
import { CompanyFundamentals } from "./company-fundamentals.js";
import { SecFilingsInbox } from "./sec-filings-inbox.js";
import { SecFilingDetailService } from "./sec-filing-detail.js";
import { MarketData, startQuotesPoller } from "./market.js";
import { SEC_EVIDENCE_ADAPTER_VERSION } from "./sources/sec.js";
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
import { installExternalRequestGate } from "./external-request-gate.js";

/**
 * Boot order matters: DB first (schema + seed), then pipeline, then HTTP, then
 * pollers. Every subsystem is failure-isolated; nothing below can take the
 * HTTP surface down. Shutdown stops pollers first so no ingestion lands in a
 * half-closed database.
 */

async function main(): Promise<void> {
  const companies = loadCompanies();
  const db = new Desk(config.dbPath, config.storage);
  const uninstallExternalRequestGate = installExternalRequestGate(
    () => config.externalRequestsEnabled && db.externalRequestAllowed(),
  );
  db.seedCompanies(companies);
  const activeSourceCollectors = intersectCollectorAllowlists(
    config.externalSourceCollectors,
    config.sourceRightsApprovedCollectors,
  );
  const collectorEnabled = (collector: CollectorId) =>
    config.externalRequestsEnabled && activeSourceCollectors.has(collector);
  const openaiAllowedCollectors = intersectClassifierSourceAllowlist(
    config.openai.allowedCollectors,
    config.externalSourceCollectors,
    config.sourceRightsApprovedCollectors,
  );
  const openaiDispatchEnabled = config.externalRequestsEnabled && config.openai.apiKey !== "" &&
    config.openai.accountUseApproved && openaiAllowedCollectors.size > 0 &&
    config.openai.maxRequestsPerDay > 0 && config.openai.maxRequestBytesPerDay > 0 && config.openai.maxDailyCostMicros > 0;
  const activeProviderEnabled = openaiDispatchEnabled;

  const hub = new Hub();
  const health = new HealthTracker(
    config.xBearer !== "",
    false,
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
      typesafeAccountUseApproved: false,
      jevAllowedCollectors: [],
      openaiAccountUseApproved: config.openai.accountUseApproved,
      openaiAllowedCollectors: [...openaiAllowedCollectors].sort(),
      openaiBlockedCollectors: [...config.openai.allowedCollectors].filter((collector) => !openaiAllowedCollectors.has(collector)).sort(),
    },
    {
      provider: "openai_luna",
      model: config.openai.model,
      configured: config.openai.apiKey !== "",
      enabled: activeProviderEnabled,
      blockedReason: activeProviderEnabled ? null : !config.externalRequestsEnabled ? "external requests are disabled"
        : !config.openai.apiKey ? "OpenAI API key is missing" : !config.openai.accountUseApproved ? "OpenAI account use is not approved"
          : openaiAllowedCollectors.size === 0 ? "OpenAI source allowlist or rights approval is missing"
            : config.openai.maxRequestsPerDay <= 0 || config.openai.maxRequestBytesPerDay <= 0 || config.openai.maxDailyCostMicros <= 0 ? "OpenAI daily budgets are disabled" : "OpenAI classifier is unavailable",
    },
  );

  const openaiClassifier = new OpenAIClassifier({
    apiKey: config.openai.apiKey, model: config.openai.model, timeoutMs: config.openai.timeoutMs,
  });

  const pipeline = new Pipeline({
    db,
    judge: null,
    classifier: openaiClassifier.configured && openaiDispatchEnabled
      ? (prepared) => openaiClassifier.classifyPrepared(prepared)
      : null,
    provider: "openai_luna",
    hub,
    health,
    engineLabel: config.openai.model,
    inputPricePerMTok: 0,
    concurrency: config.scoreConcurrency,
    allowedCollectors: openaiAllowedCollectors,
    externalRequestsEnabled: config.externalRequestsEnabled,
    dailyBudget: {
      utcDay: () => new Date().toISOString().slice(0, 10),
      maxRequests: config.openai.maxRequestsPerDay,
      maxRequestBytes: config.openai.maxRequestBytesPerDay,
      maxDailyCostMicros: config.openai.maxDailyCostMicros,
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
  const companyFundamentals = new CompanyFundamentals({
    db,
    externalRequestsEnabled: config.externalRequestsEnabled,
    secCompanyFactsEnabled: activeSourceCollectors.has("sec_company_facts"),
    userAgent: config.secUserAgent,
  });
  const secFilingsInbox = new SecFilingsInbox({
    acquisitionEnabled: collectorEnabled("sec_latest_filings_8k"),
  });
  const secFilingDetail = new SecFilingDetailService({
    enabled: collectorEnabled("sec_edgar") && collectorEnabled("sec_latest_filings_8k") && config.secUserAgent !== "",
    userAgent: config.secUserAgent,
  });
  // Pending work drains on boot only when the selected OpenAI Luna route is
  // authorized and within its configured budget. Otherwise real observations
  // remain pending and create no scoring failure attempts.
  // Existing completed scores remain untouched when the current rubric changes.
  const drained = activeProviderEnabled ? pipeline.drainPending(5_000) : 0;
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
    companyFundamentals,
    secFilingsInbox,
    secFilingDetail,
    deliverySources: [
      { collector: "google_news_rss", enabled: collectorEnabled("google_news_rss"), intervalSeconds: config.pollRssSeconds, targetCount: companies.length },
      { collector: "yahoo_finance_rss", enabled: collectorEnabled("yahoo_finance_rss"), intervalSeconds: config.pollRssSeconds, targetCount: companies.length },
      { collector: "gdelt_doc_api", enabled: collectorEnabled("gdelt_doc_api"), intervalSeconds: config.pollGdeltSeconds, targetCount: companies.length },
      { collector: "sec_edgar", enabled: collectorEnabled("sec_edgar") && config.secUserAgent !== "", intervalSeconds: config.pollSecSeconds, targetCount: companies.length,
        healthAdapterVersions: ["sec-ticker-mapping/1", "sec-submissions/1", SEC_EVIDENCE_ADAPTER_VERSION] },
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
    if (activeProviderEnabled) schedulers.push(startJevRetryPoller(pipeline));
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
  const hasScheduledSourceCollection = [...activeSourceCollectors].some((collector) => collector !== "sec_company_facts");
  const mode = !config.externalRequestsEnabled
    ? "OFFLINE (saved data only)"
    : activeSourceCollectors.size === 0
      ? config.externalSourceCollectors.size === 0
        ? "REQUESTS ENABLED (source allowlist empty)"
        : "REQUESTS ENABLED (source approvals missing)"
      : activeProviderEnabled
      ? "LIVE"
      : !hasScheduledSourceCollection
        ? "ON-DEMAND FACTS ONLY (classification paused)"
      : "AWAITING CLASSIFIER CONFIGURATION (mentions stay pending)";
  console.log(`[desk] sentiment desk v${VERSION} ${mode} on http://localhost:${config.port}`);
  if (config.secUserAgent.includes("personal research desk")) {
    console.warn("[desk] SEC_USER_AGENT is the generic default; personalize it in .env (name + email) for long unattended runs.");
  }
  console.log(`[desk] watchlist: ${companies.length} companies | db: ${config.dbPath}`);
  console.log(!config.externalRequestsEnabled
    ? "[desk] external requests are paused by EXTERNAL_REQUESTS_ENABLED=false; credentials are unused"
    : !config.openai.apiKey
      ? "[desk] OpenAI API key missing; real observations stay pending without failures."
      : !activeProviderEnabled
        ? "[desk] OpenAI classification blocked by account approval, source rights, or daily budgets."
        : "[desk] OpenAI Luna categorical classification enabled.");
  if (config.externalRequestsEnabled && !config.finnhubKey)
    console.log("[desk] finnhub: no key — free tier adds news, EPS surprises, earnings dates");
  if (config.externalRequestsEnabled && !(config.redditClientId && config.redditClientSecret))
    console.log("[desk] reddit: no app credentials — free tier adds the social tier");
  if (config.externalRequestsEnabled && config.externalSourceCollectors.size > activeSourceCollectors.size) {
    console.log(`[desk] blocked unapproved source requests: ${[...config.externalSourceCollectors]
      .filter((collector) => !config.sourceRightsApprovedCollectors.has(collector)).sort().join(", ")}`);
  }
  if (config.externalRequestsEnabled && config.openai.apiKey && !config.openai.accountUseApproved) {
    console.log("[desk] OpenAI dispatch blocked: OPENAI_ACCOUNT_USE_APPROVED is not set");
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
      await pipeline.waitForAlertIdle();
      pipeline.stop();
      // SSE responses otherwise keep server.close() pending indefinitely.
      hub.closeAll();
      // Tear down any remaining keep-alive or stalled HTTP sockets after the SSE routes close.
      if ("closeAllConnections" in server) server.closeAllConnections();
      await httpClosed;
      uninstallExternalRequestGate();
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
