import { serve } from "@hono/node-server";
import { VERSION, config, loadCompanies } from "./config.js";
import { intersectClassifierSourceAllowlist, intersectCollectorAllowlists, secFilingsInboxRequestsEnabled } from "./collector-policy.js";
import { Desk } from "./db.js";
import { HealthTracker } from "./health.js";
import { Hub } from "./hub.js";
import { Pipeline } from "./pipeline.js";
import { createApp } from "./app.js";
import { CodexLunaService } from "./codex-luna-service.js";
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
import { dirname, resolve, join } from "node:path";
import { isIP } from "node:net";
import { PrivateEvidenceStore } from "./private-evidence-store.js";
import { createPrivateEvidenceAnalysisService } from "./private-evidence-analysis-service.js";
import { ChatGPTPlanPrivateEvidenceAnalyzer } from "./chatgpt-plan-private-evidence.js";
import { ChatGPTPlanAuth } from "./chatgpt-plan-auth.js";
import {
  chatGPTPlanFailureMessage,
  ChatGPTPlanResponses,
  ChatGPTPlanResponsesError,
  type ChatGPTPlanFailureKind,
} from "./chatgpt-plan-responses.js";
import { ChatGPTPlanClassifier } from "./chatgpt-plan-classifier.js";
import { ModelProviderCredentialVault } from "./model-provider-credential-vault.js";
import { CompanyEvidenceAssessmentService } from "./company-evidence-assessment.js";
import { automaticPlanClassifierCollectors, manualByokClassifierCollectors } from "./local-byok-source-policy.js";
import { TypeSafeJevByokService } from "./typesafe-jev-byok.js";
import { ModelProviderClassifier } from "./model-provider-classifier.js";
import { ModelProviderClassificationService } from "./model-provider-classification-service.js";
import { CompanyUpdatesService } from "./company-updates.js";
import { createChatGPTPlanOptIn, verifyPrivatePlanSessionAccess } from "./chatgpt-plan-opt-in.js";

const CHATGPT_PLAN_PROVIDER_PAUSE_KEY = "chatgpt-plan:provider-pause:v1";
const PLAN_PROVIDER_BACKOFF_MS = 30_000;
const MAX_PLAN_PROVIDER_BACKOFF_MS = 5 * 60_000;
const planFailureKinds: readonly ChatGPTPlanFailureKind[] = [
  "usage_limit", "account_not_eligible", "authorization", "unsupported_capability",
  "unsupported_route", "temporary_unavailable", "provider_rejected", "unknown",
];
type StoredPlanProviderPause = {
  kind: ChatGPTPlanFailureKind;
  status: number | null;
  code: string | null;
  requestId: string | null;
  pausedAt: number;
  retryAt: number | null;
};

function readPlanProviderPause(raw: string | undefined): StoredPlanProviderPause | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!planFailureKinds.includes(value.kind as ChatGPTPlanFailureKind) || !Number.isSafeInteger(value.pausedAt) ||
        (value.status !== null && (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599)) ||
        (value.retryAt !== null && (!Number.isSafeInteger(value.retryAt) || (value.retryAt as number) < 0)) ||
        (value.code !== null && (typeof value.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(value.code))) ||
        (value.requestId !== null && (typeof value.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value.requestId)))) return {
      kind: "unknown", status: null, code: null, requestId: null, pausedAt: Date.now(), retryAt: null,
    };
    return value as StoredPlanProviderPause;
  } catch {
    return { kind: "unknown", status: null, code: null, requestId: null, pausedAt: Date.now(), retryAt: null };
  }
}

function planPauseMessage(pause: StoredPlanProviderPause): string {
  const base = chatGPTPlanFailureMessage(pause.kind, pause.status, pause.code);
  const reference = pause.requestId ? ` Support reference: ${pause.requestId}.` : "";
  if (pause.kind === "temporary_unavailable" && pause.retryAt) {
    return `${base} Retry is scheduled after ${new Date(pause.retryAt).toISOString()}.${reference}`;
  }
  return `${base}${reference}`;
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
}

/**
 * Boot order matters: DB first (schema + seed), then pipeline, then HTTP, then
 * pollers. Every subsystem is failure-isolated; nothing below can take the
 * HTTP surface down. Shutdown stops pollers first so no ingestion lands in a
 * half-closed database.
 */

async function main(): Promise<void> {
  const companies = loadCompanies();
  const db = new Desk(config.dbPath, config.storage);
  let privateEvidence: PrivateEvidenceStore | undefined;
  const privateEvidenceEnabled = isLoopbackHost(config.host);
  const chatgptPlanOptIn = createChatGPTPlanOptIn(db);
  if (privateEvidenceEnabled) {
    try {
      privateEvidence = new PrivateEvidenceStore(join(dirname(resolve(config.dbPath)), "private-evidence", "evidence.sqlite"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown initialization failure";
      console.warn(`[desk] private evidence unavailable (${reason})`);
    }
  }
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
  // Default to the currently supported public news feeds only. A broader
  // classifier surface requires an explicit OPENAI_ALLOWED_COLLECTORS list.
  const defaultPlanClassifiers = new Set<CollectorId>(["google_news_rss", "yahoo_finance_rss"]);
  const requestedClassifierCollectors = config.openai.allowedCollectors.size > 0
    ? config.openai.allowedCollectors
    : defaultPlanClassifiers;
  const requestedApprovedClassifierCollectors = intersectClassifierSourceAllowlist(
    requestedClassifierCollectors,
    config.externalSourceCollectors,
    config.sourceRightsApprovedCollectors,
  );
  const openaiAllowedCollectors = automaticPlanClassifierCollectors(requestedApprovedClassifierCollectors);
  // Manual BYOK is an explicit per-item action with a user-visible source
  // preview. Keep its SEC filings eligible when SEC rights are approved, but
  // do not widen the automatic ChatGPT Plan pipeline above.
  const manualByokAllowedCollectors = manualByokClassifierCollectors(openaiAllowedCollectors,activeSourceCollectors);
  let planConnected = false;
  let planModelAvailable: boolean | null = null;
  let planClassifierReady = false;
  let planProviderPause = readPlanProviderPause(db.getKv(CHATGPT_PLAN_PROVIDER_PAUSE_KEY));
  let planBlockedReason: string | null = planProviderPause ? planPauseMessage(planProviderPause) : privateEvidenceEnabled
    ? "Connect a ChatGPT plan to enable GPT-6 Luna."
    : "The ChatGPT plan connection is available only in the local loopback installation.";
  let pipelineForPlanPause: Pipeline | null = null;
  let healthForPlanPause: HealthTracker | null = null;
  let activatePlanClassifierAfterBackoff: (() => Promise<boolean>) | null = null;
  let providerResumeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleTemporaryPlanResume = () => {
    if (providerResumeTimer) clearTimeout(providerResumeTimer);
    if (planProviderPause?.kind !== "temporary_unavailable" || !planProviderPause.retryAt) return;
    const delay = Math.max(0, planProviderPause.retryAt - Date.now());
    providerResumeTimer = setTimeout(() => {
      providerResumeTimer = null;
      if (planProviderPause?.kind === "temporary_unavailable") void activatePlanClassifierAfterBackoff?.();
    }, delay + 25);
    providerResumeTimer.unref?.();
  };
  const recordPlanProviderFailure = (error: ChatGPTPlanResponsesError) => {
    if (!error.failureKind) return;
    const now = Date.now();
    const retryAt = error.failureKind === "temporary_unavailable"
      ? now + Math.min(MAX_PLAN_PROVIDER_BACKOFF_MS, Math.max(PLAN_PROVIDER_BACKOFF_MS, error.retryAfterMs ?? 0))
      : null;
    const pause: StoredPlanProviderPause = {
      kind: error.failureKind, status: error.status, code: error.providerCode,
      requestId: error.requestId, pausedAt: now, retryAt,
    };
    planProviderPause = pause;
    planClassifierReady = false;
    planBlockedReason = planPauseMessage(pause);
    try { db.setKv(CHATGPT_PLAN_PROVIDER_PAUSE_KEY, JSON.stringify(pause)); }
    catch { planBlockedReason = `${planBlockedReason} The pause could not be saved; storage controls are also stopping new requests.`; }
    pipelineForPlanPause?.setClassifier(null, "chatgpt_plan");
    healthForPlanPause?.setClassifierAvailability({ configured: planConnected, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: planBlockedReason });
    if (retryAt) scheduleTemporaryPlanResume();
    else if (providerResumeTimer) { clearTimeout(providerResumeTimer); providerResumeTimer = null; }
  };
  const chatgptPlanAuth = privateEvidenceEnabled
    ? new ChatGPTPlanAuth({ path: join(dirname(resolve(config.dbPath)), "chatgpt-plan.credentials.enc") })
    : null;
  const chatgptPlanResponses = chatgptPlanAuth
    ? new ChatGPTPlanResponses({ tokenProvider: chatgptPlanAuth, onProviderFailure: recordPlanProviderFailure })
    : null;
  const chatgptPlanClassifier = chatgptPlanResponses ? new ChatGPTPlanClassifier(chatgptPlanResponses) : null;
  const providerVault = privateEvidenceEnabled
    ? new ModelProviderCredentialVault(join(dirname(resolve(config.dbPath)), "model-provider-credentials"))
    : undefined;
  const companyEvidenceAssessment = privateEvidenceEnabled && providerVault
    ? new CompanyEvidenceAssessmentService({loopbackBound:true,externalRequestsEnabled:()=>config.externalRequestsEnabled,db,vault:providerVault,fetcher:fetch})
    : undefined;
  const modelProviderService = privateEvidenceEnabled && providerVault
    ? new ModelProviderClassificationService({
      loopbackBound: true,
      db,
      vault: providerVault,
      classifier: new ModelProviderClassifier(),
      externalRequestsEnabled: config.externalRequestsEnabled,
      storageAllowsProviderRequests: () => db.externalRequestAllowed(),
      allowedCollectors: manualByokAllowedCollectors,
    })
    : undefined;
  const typesafeJevByokService = privateEvidenceEnabled && providerVault
    ? new TypeSafeJevByokService({ loopbackBound: true, db, vault: providerVault,
      externalRequestsEnabled: config.externalRequestsEnabled,
      storageAllowsProviderRequests: () => db.externalRequestAllowed(), allowedCollectors: manualByokAllowedCollectors })
    : undefined;
  if (planProviderPause?.kind === "temporary_unavailable" && planProviderPause.retryAt !== null && planProviderPause.retryAt <= Date.now()) {
    planProviderPause = null;
    try { db.setKv(CHATGPT_PLAN_PROVIDER_PAUSE_KEY, ""); } catch { /* remain fail-closed below */ }
  }
  // An earlier session's saved public-classifier grant is intentionally not
  // restored. The user must explicitly Activate for every server session.

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
      openaiAccountUseApproved: planConnected,
      openaiAllowedCollectors: [...openaiAllowedCollectors].sort(),
      openaiBlockedCollectors: [...config.openai.allowedCollectors].filter((collector) => !openaiAllowedCollectors.has(collector)).sort(),
    },
    {
      provider: "openai_luna",
      model: config.openai.model,
      configured: planConnected,
      enabled: planClassifierReady,
      accountingRoute: "chatgpt_plan",
      blockedReason: planClassifierReady ? null : planBlockedReason,
    },
  );
  healthForPlanPause = health;

  const privateEvidenceAnalysis = createPrivateEvidenceAnalysisService({
    loopbackBound: privateEvidenceEnabled,
    privateStoreReady: privateEvidence !== undefined,
    externalRequestsEnabled: config.externalRequestsEnabled,
    // This is only the per-item analyst path. The app validates the saved plan
    // after the user confirms one exact note, before invoking this service.
    planConnected: () => chatgptPlanAuth !== null,
    modelAvailable: () => null,
    planProviderPaused: () => planProviderPause !== null,
    maxRequestsPerDay: config.openai.maxRequestsPerDay,
    maxRequestBytesPerDay: config.openai.maxRequestBytesPerDay,
    db,
    analyzer: chatgptPlanResponses ? new ChatGPTPlanPrivateEvidenceAnalyzer(chatgptPlanResponses) : undefined,
  });

  const pipeline = new Pipeline({
    db,
    judge: null,
    classifier: planClassifierReady && chatgptPlanClassifier
      ? (prepared) => chatgptPlanClassifier.classifyPrepared(prepared)
      : null,
    accountingRoute: "chatgpt_plan",
    provider: "openai_luna",
    hub,
    health,
    engineLabel: config.openai.model,
    inputPricePerMTok: 0,
    // ChatGPT-plan usage is a user subscription allowance. Keep provider
    // dispatch serial so a feed burst cannot consume the local daily cap at once.
    concurrency: 1,
    allowedCollectors: openaiAllowedCollectors,
    externalRequestsEnabled: config.externalRequestsEnabled,
    dailyBudget: {
      utcDay: () => new Date().toISOString().slice(0, 10),
      maxRequests: config.openai.maxRequestsPerDay,
      maxRequestBytes: config.openai.maxRequestBytesPerDay,
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
  pipelineForPlanPause = pipeline;
  const companyUpdates = new CompanyUpdatesService({
    db,
    pipeline,
    allowedCollectors: activeSourceCollectors,
    externalRequestsEnabled: config.externalRequestsEnabled,
  });

  const deactivatePlanClassifier = (reason: string) => {
    planClassifierReady = false;
    planBlockedReason = reason;
    pipeline.setClassifier(null, "chatgpt_plan");
    health.setClassifierAvailability({ configured: planConnected, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: reason });
  };
  const activatePlanClassifier = async (explicitUserAction = false): Promise<boolean> => {
    if (explicitUserAction && !chatgptPlanOptIn.hasSuccessfulAuthorizationThisSession()) {
      deactivatePlanClassifier("Sign in to a ChatGPT plan in this session before activating public GPT-6 Luna classification.");
      return false;
    }
    if (!explicitUserAction && !chatgptPlanOptIn.isEnabled()) {
      deactivatePlanClassifier("Enable the ChatGPT plan connection from Model providers before using GPT-6 Luna.");
      return false;
    }
    if (planProviderPause?.kind === "temporary_unavailable" && planProviderPause.retryAt !== null &&
        planProviderPause.retryAt > Date.now()) {
      planBlockedReason = planPauseMessage(planProviderPause);
      health.setClassifierAvailability({ configured: planConnected, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: planBlockedReason });
      return false;
    }
    if (!chatgptPlanResponses || !chatgptPlanClassifier || !config.externalRequestsEnabled || openaiAllowedCollectors.size === 0 ||
        config.openai.maxRequestsPerDay <= 0 || config.openai.maxRequestBytesPerDay <= 0 || !db.canStartExternalWork()) {
      const reason = !config.externalRequestsEnabled ? "External requests are disabled."
        : openaiAllowedCollectors.size === 0 ? "No approved public-news source is enabled for Luna classification."
          : !db.canStartExternalWork() ? "Local storage controls are pausing new provider requests."
            : "Finite local ChatGPT-plan request and byte limits are disabled.";
      deactivatePlanClassifier(reason);
      return false;
    }
    try {
      planConnected = chatgptPlanAuth ? await chatgptPlanAuth.isConnected() : false;
      if (!planConnected) {
        deactivatePlanClassifier("Connect a ChatGPT plan to enable GPT-6 Luna.");
        return false;
      }
      planModelAvailable = (await chatgptPlanResponses.checkModelAccess()).modelAvailable;
      if (!planModelAvailable) {
        if (planProviderPause) {
          planBlockedReason = planPauseMessage(planProviderPause);
          health.setClassifierAvailability({ configured: true, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: planBlockedReason });
        } else deactivatePlanClassifier("GPT-6 Luna is not available for this ChatGPT account.");
        return false;
      }
      try { db.setKv(CHATGPT_PLAN_PROVIDER_PAUSE_KEY, ""); }
      catch {
        deactivatePlanClassifier("The provider pause could not be cleared from local storage; classification remains paused.");
        return false;
      }
      if (explicitUserAction && !chatgptPlanOptIn.enable()) {
        deactivatePlanClassifier("The ChatGPT plan activation could not be saved locally; classification remains paused.");
        return false;
      }
      planProviderPause = null;
      planClassifierReady = true;
      planBlockedReason = null;
      if (providerResumeTimer) { clearTimeout(providerResumeTimer); providerResumeTimer = null; }
      pipeline.setClassifier((prepared) => chatgptPlanClassifier.classifyPrepared(prepared), "chatgpt_plan");
      health.setClassifierAvailability({ configured: true, enabled: true, accountingRoute: "chatgpt_plan", blockedReason: null });
      return true;
    } catch {
      planModelAvailable = null;
      if (planProviderPause) {
        planBlockedReason = planPauseMessage(planProviderPause);
        health.setClassifierAvailability({ configured: planConnected, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: planBlockedReason });
      } else deactivatePlanClassifier("GPT-6 Luna access could not be verified. Classification remains paused.");
      return false;
    }
  };
  const authorizePrivatePlanAnalysis = async (): Promise<boolean> => {
    if (!chatgptPlanAuth || !chatgptPlanResponses) {
      planBlockedReason = "ChatGPT plan analysis is unavailable in this installation.";
      return false;
    }
    if (!chatgptPlanOptIn.canAuthorizePrivateAnalysis()) {
      planBlockedReason = "Reconnect the ChatGPT plan before analyzing another private note.";
      return false;
    }
    if (!config.externalRequestsEnabled || !db.canStartExternalWork() ||
        config.openai.maxRequestsPerDay <= 0 || config.openai.maxRequestBytesPerDay <= 0) {
      planBlockedReason = !config.externalRequestsEnabled ? "External requests are disabled."
        : !db.canStartExternalWork() ? "Local storage controls are pausing new provider requests."
          : "Finite local ChatGPT-plan request and byte limits are disabled.";
      return false;
    }
    if (planProviderPause) {
      planBlockedReason = planPauseMessage(planProviderPause);
      return false;
    }
    try {
      const access = await verifyPrivatePlanSessionAccess(
        chatgptPlanOptIn,
        chatgptPlanAuth,
        async () => (await chatgptPlanResponses.checkModelAccess()).modelAvailable,
      );
      if (!access.sessionAuthorized) {
        planBlockedReason = "Connect a ChatGPT plan in this server session before analyzing a selected private note.";
        return false;
      }
      planConnected = access.connected;
      if (!access.connected) {
        planModelAvailable = null;
        planBlockedReason = "Connect a ChatGPT plan before analyzing this selected private note.";
        return false;
      }
      planModelAvailable = access.modelAvailable;
      if (!access.modelAvailable) {
        planBlockedReason = "GPT-6 Luna is not available for this ChatGPT account.";
        return false;
      }
      if (!planClassifierReady) {
        planBlockedReason = "Public classification remains paused until you explicitly choose Activate.";
      }
      health.setClassifierAvailability({
        configured: true,
        enabled: planClassifierReady,
        accountingRoute: "chatgpt_plan",
        blockedReason: planClassifierReady ? null : planBlockedReason,
      });
      return true;
    } catch {
      planModelAvailable = null;
      planBlockedReason = planProviderPause
        ? planPauseMessage(planProviderPause)
        : "ChatGPT plan access could not be verified for this selected private note.";
      return false;
    }
  };
  activatePlanClassifierAfterBackoff = () => activatePlanClassifier(false);
  if (planProviderPause?.kind === "temporary_unavailable") scheduleTemporaryPlanResume();
  if (planClassifierReady && chatgptPlanClassifier) {
    pipeline.setClassifier((prepared) => chatgptPlanClassifier.classifyPrepared(prepared), "chatgpt_plan");
  }

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
    acquisitionEnabled: secFilingsInboxRequestsEnabled(config.externalRequestsEnabled, activeSourceCollectors),
    secUserAgent: config.secUserAgent,
    listingSnapshotStore: {
      read: () => db.readSecListingSnapshot(),
      write: (snapshot) => db.saveSecListingSnapshot(snapshot),
    },
    directSnapshotStore: {
      readLatest: () => db.readLatestSecFilingsInboxSnapshot(),
      write: (snapshot) => db.saveSecFilingsInboxSnapshot(snapshot),
    },
  });
  const secFilingDetail = new SecFilingDetailService({
    enabled: collectorEnabled("sec_edgar") && collectorEnabled("sec_latest_filings_8k") && config.secUserAgent !== "",
    userAgent: config.secUserAgent,
  });
  // Pending work drains only after the ChatGPT-plan grant, exact model,
  // source rights and local request/byte caps are all verified.
  // Existing completed scores remain untouched when the current rubric changes.
  const drained = planClassifierReady ? pipeline.drainPending(5_000) : 0;
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
    companyEvidenceAssessment,
    secFilingsInbox,
    secFilingDetail,
    privateEvidence,
    privateEvidenceEnabled,
    privateEvidenceCompanyIds: new Set(companies
      .filter((company) => company.listingStatus === "publicly_listed")
      .map((company) => company.id)),
    configuredPublicCompanyIds: new Set(companies
      .filter((company) => company.listingStatus === "publicly_listed")
      .map((company) => company.id)),
    privateEvidenceAnalysis,
    chatgptPlan: chatgptPlanAuth && chatgptPlanResponses ? {
      loopbackBound: privateEvidenceEnabled,
      localOrigin: config.chatgptPlanLocalOrigin,
      redirectUri: `http://127.0.0.1:${config.port}/auth/callback`,
      auth: chatgptPlanAuth ? chatgptPlanOptIn.wrapAuth(chatgptPlanAuth, {
        onConnected: () => {
          planConnected = true;
          planModelAvailable = null;
          planBlockedReason = "Public classification remains paused until you explicitly choose Activate.";
          health.setClassifierAvailability({ configured: true, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: planBlockedReason });
        },
        onDisconnected: () => {
          planConnected = false;
          planModelAvailable = null;
          planClassifierReady = false;
          planBlockedReason = "ChatGPT plan connection was disconnected.";
          health.setClassifierAvailability({ configured: false, enabled: false, accountingRoute: "chatgpt_plan", blockedReason: planBlockedReason });
        },
      }) : chatgptPlanAuth,
      responses: chatgptPlanResponses,
      enabled: () => planClassifierReady,
      modelAvailable: () => planModelAvailable,
      blockedReason: () => planBlockedReason,
      sources: [...openaiAllowedCollectors].sort(),
      dailyRequestLimit: config.openai.maxRequestsPerDay,
      dailyByteLimit: config.openai.maxRequestBytesPerDay,
      activate: () => activatePlanClassifier(true),
      deactivate: deactivatePlanClassifier,
      authorizePrivateAnalysis: authorizePrivatePlanAnalysis,
    } : undefined,
    modelProviders: modelProviderService,
    codexLuna: privateEvidenceEnabled ? new CodexLunaService({ db,
      externalRequestsEnabled: () => config.externalRequestsEnabled, allowedCollectors: manualByokAllowedCollectors }) : undefined,
    typesafeJevByok: typesafeJevByokService,
    companyUpdates,
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
    // Keep this bounded local poller alive so a post-startup plan connection
    // can process eligible pending items without restarting collection.
    schedulers.push(startJevRetryPoller(pipeline));
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
      : planClassifierReady
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
    : !planConnected
      ? "[desk] ChatGPT plan not connected; real observations stay pending without classification failures."
      : !planClassifierReady
        ? `[desk] ChatGPT plan classifier paused: ${planBlockedReason ?? "Luna access is unavailable."}`
        : "[desk] GPT-6 Luna classification uses the connected ChatGPT plan; no API-key fallback is active.");
  if (config.externalRequestsEnabled && !config.finnhubKey)
    console.log("[desk] finnhub: no key — free tier adds news, EPS surprises, earnings dates");
  if (config.externalRequestsEnabled && !(config.redditClientId && config.redditClientSecret))
    console.log("[desk] reddit: no app credentials — free tier adds the social tier");
  if (config.externalRequestsEnabled && config.externalSourceCollectors.size > activeSourceCollectors.size) {
    console.log(`[desk] blocked unapproved source requests: ${[...config.externalSourceCollectors]
      .filter((collector) => !config.sourceRightsApprovedCollectors.has(collector)).sort().join(", ")}`);
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
      privateEvidence?.close();
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
