import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  CategoricalSnapshotUnavailableError,
  FollowedBaselineConflictError,
  FollowedBaselineLimitError,
  AnalystResearchQueueLimitError,
  InvalidCategoricalBucketError,
  ScoreBucketSnapshotConflictError,
} from "./db.js";
import type { AlertDeliveryCursor, Desk, DeliverySourceSchedule, FollowedEvidenceCursor, MentionFeedFilter, MentionPageCursor, ScoreBucketCursor } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Hub } from "./hub.js";
import type { MarketData } from "./market.js";
import type { Pipeline } from "./pipeline.js";
import type { CompanyFundamentals } from "./company-fundamentals.js";
import type { SecFilingsInbox } from "./sec-filings-inbox.js";
import type { SecFilingDetailService } from "./sec-filing-detail.js";
import { MAX_ANALYST_RESEARCH_QUESTION_CHARS } from "../shared/analyst-research.js";
import { savedSourceSearchCursorSchema, type SavedSourceSearchCursor } from "../shared/saved-source-search.js";
import { secFilingArchiveCikPath, type SecFilingInboxRow } from "../shared/sec-filings-inbox.js";
import { forwardReturn, impactDistribution, rankIC, SERIES_BUCKET_MS, summarizeReactions, validateSignal, weightedIndex } from "./scoring.js";
import { buildRadar, isRadarEventType, radarEvidencePage } from "./radar.js";
import type { CategoricalBucketCursor } from "./types.js";

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
  companyFundamentals?: CompanyFundamentals;
  secFilingsInbox?: SecFilingsInbox;
  secFilingDetail?: SecFilingDetailService;
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
  companyId: z.string().min(1).max(200),
  scoredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1).max(200),
  fromMs: z.number().int().max(Number.MAX_SAFE_INTEGER),
  throughMs: z.number().int().max(Number.MAX_SAFE_INTEGER),
  impactBin: z.number().int().min(0).max(19).nullable(),
  snapshotKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const categoricalBucketCursorSchema = z.object({
  classifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1).max(200),
}).strict();
const followedEvidenceCursorSchema = z.object({
  companyId: z.string().min(1).max(200),
  baselineId: z.string().uuid(),
  snapshotAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  snapshotMaxRowId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ingestedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1).max(200),
}).strict();
const followedBaselineCaptureSchema = z.object({
  captureKey: z.string().uuid(),
  expectedBaselineId: z.string().uuid().nullable(),
}).strict();
const alertDeliveryCursorSchema = z.object({
  priority: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  alertId: z.string().uuid(),
}).strict();
const mentionFeedFilterSchema = z.enum(["all", "bull", "bear", "material", "offtarget", "failed", "history", "identity_review"]);
const mentionLookupSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(900)
    .refine((ids) => new Set(ids).size === ids.length),
});
const fundamentalRefreshSchema = z.object({ requestKey: z.string().uuid() }).strict();
const secFilingsInboxActivationSchema = z.object({ confirmUse: z.literal(true) }).strict();
const secFilingResearchTaskSchema = z.object({ cik: z.string().regex(/^\d{10}$/), accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
  nextQuestion: z.string().max(500).optional() }).strict();
const secFilingDetailSchema = z.object({ cik: z.string().regex(/^\d{10}$/), accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), confirmUse: z.literal(true) }).strict();
const analystResearchReviewSchema = z.object({
  disposition: z.enum(["investigate", "dismissed"]),
  nextQuestion: z.string().max(MAX_ANALYST_RESEARCH_QUESTION_CHARS),
}).strict();

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
      storage: deps.db.storageCapacity(),
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
      classifierUsage: deps.db.classifierUsageSince(startOfDayUtc.getTime()),
      events: deps.db.recentEvents(20),
    });
  });

  app.get("/api/first-run-evidence", (c) => {
    const eligibleObservationCount = deps.db.realObservationCount();
    const runtimeHealth = deps.health.snapshot();
    const classifierSecAllowed = runtimeHealth.classifier.provider === "openai_luna"
      ? runtimeHealth.sourceApproval.openaiAllowedCollectors?.includes("sec_edgar") === true
      : runtimeHealth.sourceApproval.jevAllowedCollectors.includes("sec_edgar");
    return c.json({
      eligibleObservationCount,
      secCollectorEnabled: runtimeHealth.sec.enabled,
      jevSecScoringEnabled: runtimeHealth.jev.enabled && runtimeHealth.sourceApproval.jevAllowedCollectors.includes("sec_edgar"),
      classifierProvider: runtimeHealth.classifier.provider,
      classifierSecClassificationEnabled: runtimeHealth.classifier.enabled && classifierSecAllowed,
      classifierBlockedReason: runtimeHealth.classifier.blockedReason,
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
    const rawIncludeDismissed = c.req.query("includeDismissed");
    if (rawIncludeDismissed != null && rawIncludeDismissed !== "true" && rawIncludeDismissed !== "false") {
      return c.json({ error: "invalid_include_dismissed" }, 400);
    }
    const includeDismissed = rawIncludeDismissed === "true";
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
    // Recovery work and explicit History browsing remain reachable after the
    // normal seven-day investor window; ordinary views stay time-bounded.
    const sinceMs = filter === "failed" || filter === "history" || filter === "identity_review"
      ? 0 : Date.now() - hours * 60 * 60 * 1000;
    return c.json(deps.db.mentionsForCompanyPage({ companyId: id, sinceMs, limit, cursor, filter, includeDismissed }));
  });

  app.get("/api/companies/:id/followed-evidence", (c) => {
    const companyId = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === companyId)) return c.json({ error: "unknown_company" }, 404);
    const limit = clampNumber(c.req.query("limit"), 1, 100, 25);
    const rawCursor = c.req.query("cursor");
    let cursor: FollowedEvidenceCursor | null = null;
    if (rawCursor != null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawCursor);
      } catch {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      const parsed = followedEvidenceCursorSchema.safeParse(decoded);
      if (!parsed.success) return c.json({ error: "invalid_cursor" }, 400);
      cursor = parsed.data;
    }
    try {
      return c.json(deps.db.followedCompanyEvidence({ companyId, limit, cursor }));
    } catch (error) {
      if (error instanceof FollowedBaselineConflictError) {
        return c.json({ error: "baseline_changed", currentBaseline: error.currentBaseline }, 409);
      }
      throw error;
    }
  });

  app.get("/api/companies/:id/fundamentals", (c) => {
    const companyId = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === companyId)) return c.json({ error: "unknown_company" }, 404);
    if (!deps.companyFundamentals) return c.json({ error: "company_fundamentals_unavailable" }, 503);
    return c.json(deps.companyFundamentals.read(companyId));
  });

  app.get("/api/sec-filings-inbox", async (c) => {
    if (!deps.secFilingsInbox) return c.json({ error: "sec_filings_inbox_unavailable" }, 503);
    return c.json(await deps.secFilingsInbox.read());
  });

  app.post("/api/sec-filings-inbox/evidence", async (c) => {
    const requestUrl = new URL(c.req.url);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const hostHeader = c.req.header("host")?.toLowerCase();
    const originHeader = c.req.header("origin");
    let sameOrigin = true;
    if (originHeader) { try { sameOrigin = new URL(originHeader).origin === requestUrl.origin; } catch { sameOrigin = false; } }
    if (!localHosts.has(requestUrl.hostname.toLowerCase()) || (hostHeader != null && hostHeader !== requestUrl.host.toLowerCase())
      || !sameOrigin || c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") return c.json({ error: "unsafe_external_request_origin" }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "json_content_type_required" }, 415);
    if (!deps.secFilingsInbox || !deps.secFilingDetail) return c.json({ error: "sec_filing_detail_unavailable" }, 503);
    const input = secFilingDetailSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_sec_filing_detail_request" }, 400);
    const current = await deps.secFilingsInbox.read();
    const row = current.rows.find((item) => item.cik === input.data.cik && item.accession === input.data.accession && item.form === "8-K");
    if (row && /^\d{10}$/.test(row.cik) && row.filingUrl != null) return c.json(await deps.secFilingDetail.inspect(row));
    if (!deps.db.hasSecFilingResearchTaskStore()) return c.json({ error: "sec_filing_research_tasks_unavailable" }, 503);
    const saved = deps.db.secFilingResearchTasks().find((task) => task.cik === input.data.cik && task.triggeringAccession === input.data.accession);
    if (!saved || !/^\d{10}$/.test(saved.cik)) return c.json({ error: "filing_not_in_current_sec_inbox" }, 404);
    const filingCikPath = secFilingArchiveCikPath(saved.filingUrl, saved.triggeringAccession);
    if (!filingCikPath) return c.json({ error: "saved_filing_url_invalid" }, 409);
    const savedRow: SecFilingInboxRow = {
      cik: saved.cik,
      accession: saved.triggeringAccession,
      accessionCik: saved.triggeringAccession.slice(0, 10),
      filingCikPath,
      issuer: saved.issuer,
      form: "8-K",
      filedOn: null,
      acceptedAt: null,
      feedPublishedAt: null,
      feedUpdatedAt: saved.feedUpdatedAt,
      filingUrl: saved.filingUrl,
    };
    return c.json(await deps.secFilingDetail.inspect(savedRow));
  });

  app.get("/api/sec-filing-research-tasks", (c) => {
    if (!deps.db.hasSecFilingResearchTaskStore()) return c.json({ error: "sec_filing_research_tasks_unavailable" }, 503);
    return c.json({ items: deps.db.secFilingResearchTasks() });
  });

  app.post("/api/sec-filing-research-tasks", async (c) => {
    const requestUrl = new URL(c.req.url);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const hostHeader = c.req.header("host")?.toLowerCase();
    const originHeader = c.req.header("origin");
    let sameOrigin = true;
    if (originHeader) { try { sameOrigin = new URL(originHeader).origin === requestUrl.origin; } catch { sameOrigin = false; } }
    if (!localHosts.has(requestUrl.hostname.toLowerCase()) || (hostHeader != null && hostHeader !== requestUrl.host.toLowerCase())
      || !sameOrigin || c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") return c.json({ error: "unsafe_external_request_origin" }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "json_content_type_required" }, 415);
    if (!deps.secFilingsInbox) return c.json({ error: "sec_filings_inbox_unavailable" }, 503);
    const input = secFilingResearchTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_sec_filing_research_task" }, 400);
    if (!deps.db.hasSecFilingResearchTaskStore()) return c.json({ error: "sec_filing_research_tasks_unavailable" }, 503);
    const existing = deps.db.secFilingResearchTasks().find((item) => item.cik === input.data.cik && item.triggeringAccession === input.data.accession);
    let currentFeed: Awaited<ReturnType<SecFilingsInbox["read"]>> | null = null;
    let source: Awaited<ReturnType<SecFilingsInbox["read"]>>["rows"][number] | undefined;
    if (!existing) {
      currentFeed = await deps.secFilingsInbox.read();
      if (currentFeed.state !== "ready" || currentFeed.freshness !== "current") {
        return c.json({ error: "sec_feed_not_current" }, 409);
      }
      source = currentFeed.rows.find((row) => row.cik === input.data.cik && row.accession === input.data.accession && row.form === "8-K");
    }
    if (!existing && (!source || !/^\d{10}$/.test(source.cik) || source.filingUrl == null)) {
      return c.json({ error: "filing_not_in_current_sec_inbox" }, 404);
    }
    if (existing && input.data.nextQuestion === undefined) return c.json(existing, 200);
    const accepted = existing ? {
      cik: existing.cik, issuer: existing.issuer, accession: existing.triggeringAccession, filingUrl: existing.filingUrl,
      receiptId: existing.feedReceiptId, feedUpdatedAt: existing.feedUpdatedAt, retrievedAt: existing.retrievedAt,
    } : {
      cik: source!.cik, issuer: source!.issuer, accession: source!.accession, filingUrl: source!.filingUrl!,
      receiptId: currentFeed!.receiptId, feedUpdatedAt: currentFeed!.feedUpdatedAt, retrievedAt: currentFeed!.retrievedAt,
    };
    if (!accepted.receiptId) return c.json({ error: "sec_feed_receipt_missing" }, 409);
    try {
      deps.db.saveSecFilingResearchTask({ cik: accepted.cik, issuer: accepted.issuer, triggeringAccession: accepted.accession,
        filingUrl: accepted.filingUrl, nextQuestion: input.data.nextQuestion ?? existing?.nextQuestion ?? "",
      feedReceiptId: accepted.receiptId, feedUpdatedAt: accepted.feedUpdatedAt, retrievedAt: accepted.retrievedAt });
    } catch { return c.json({ error: "sec_filing_research_task_storage_failed" }, 503); }
    const saved = deps.db.secFilingResearchTasks().find((item) => item.cik === accepted.cik && item.triggeringAccession === accepted.accession);
    if (!saved) return c.json({ error: "sec_filing_research_task_readback_failed" }, 503);
    return c.json(saved, existing ? 200 : 201);
  });

  app.delete("/api/sec-filing-research-tasks/:cik/:accession", (c) => {
    const requestUrl = new URL(c.req.url);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const hostHeader = c.req.header("host")?.toLowerCase();
    const originHeader = c.req.header("origin");
    let sameOrigin = true;
    if (originHeader) { try { sameOrigin = new URL(originHeader).origin === requestUrl.origin; } catch { sameOrigin = false; } }
    if (!localHosts.has(requestUrl.hostname.toLowerCase()) || (hostHeader != null && hostHeader !== requestUrl.host.toLowerCase())
      || !sameOrigin || c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") return c.json({ error: "unsafe_external_request_origin" }, 403);
    const cik = c.req.param("cik");
    const accession = c.req.param("accession");
    if (!/^\d{10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return c.json({ error: "invalid_sec_filing_research_task_identity" }, 400);
    if (!deps.db.hasSecFilingResearchTaskStore()) return c.json({ error: "sec_filing_research_tasks_unavailable" }, 503);
    deps.db.removeSecFilingResearchTask(cik, accession);
    return c.json({ items: deps.db.secFilingResearchTasks() });
  });

  app.post("/api/sec-filings-inbox/activate", async (c) => {
    const requestUrl = new URL(c.req.url);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const hostHeader = c.req.header("host")?.toLowerCase();
    const originHeader = c.req.header("origin");
    let sameOrigin = true;
    if (originHeader) {
      try { sameOrigin = new URL(originHeader).origin === requestUrl.origin; }
      catch { sameOrigin = false; }
    }
    if (!localHosts.has(requestUrl.hostname.toLowerCase())
      || (hostHeader != null && hostHeader !== requestUrl.host.toLowerCase())
      || !sameOrigin || c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") {
      return c.json({ error: "unsafe_external_request_origin" }, 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ error: "json_content_type_required" }, 415);
    }
    if (!deps.secFilingsInbox) return c.json({ error: "sec_filings_inbox_unavailable" }, 503);
    const input = secFilingsInboxActivationSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "sec_filings_inbox_confirmation_required" }, 400);
    return c.json(await deps.secFilingsInbox.activate());
  });

  app.post("/api/companies/:id/fundamentals/refresh", async (c) => {
    const requestUrl = new URL(c.req.url);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const hostHeader = c.req.header("host")?.toLowerCase();
    const originHeader = c.req.header("origin");
    let sameOrigin = true;
    if (originHeader) {
      try { sameOrigin = new URL(originHeader).origin === requestUrl.origin; }
      catch { sameOrigin = false; }
    }
    if (!localHosts.has(requestUrl.hostname.toLowerCase())
      || (hostHeader != null && hostHeader !== requestUrl.host.toLowerCase())
      || !sameOrigin || c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") {
      return c.json({ error: "unsafe_external_request_origin" }, 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ error: "json_content_type_required" }, 415);
    }
    const companyId = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === companyId)) return c.json({ error: "unknown_company" }, 404);
    if (!deps.companyFundamentals) return c.json({ error: "company_fundamentals_unavailable" }, 503);
    const input = fundamentalRefreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_company_fundamentals_refresh" }, 400);
    try {
      return c.json(await deps.companyFundamentals.refresh(companyId, input.data.requestKey));
    } catch (error) {
      if (error instanceof Error && error.message === "unknown_company") return c.json({ error: "unknown_company" }, 404);
      throw error;
    }
  });

  app.post("/api/companies/:id/followed-evidence/baseline", async (c) => {
    const companyId = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === companyId)) return c.json({ error: "unknown_company" }, 404);
    const input = followedBaselineCaptureSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_followed_baseline_request" }, 400);
    try {
      return c.json(deps.db.captureFollowedCompanyBaseline({ companyId, ...input.data }));
    } catch (error) {
      if (error instanceof FollowedBaselineConflictError) {
        return c.json({ error: "baseline_changed", currentBaseline: error.currentBaseline }, 409);
      }
      if (error instanceof FollowedBaselineLimitError) {
        return c.json({ error: "followed_baseline_observation_limit_exceeded", maximum: 50_000 }, 422);
      }
      if (error instanceof Error && error.message === "unknown_company") return c.json({ error: "unknown_company" }, 404);
      if (error instanceof Error && error.message === "followed_baseline_capture_key_reused") return c.json({ error: "capture_key_reused" }, 409);
      throw error;
    }
  });

  app.get("/api/research-queue", (c) => c.json({ items: deps.db.analystResearchQueue() }));

  app.get("/api/mentions/:id/research-review", (c) => {
    const mention = deps.db.mentionRow(c.req.param("id"));
    if (!mention) return c.json({ error: "unknown_real_source_observation" }, 404);
    return c.json({ review: deps.db.analystSourceReview(mention.id) });
  });

  app.put("/api/mentions/:id/research-review", async (c) => {
    const mention = deps.db.mentionRow(c.req.param("id"));
    if (!mention) return c.json({ error: "unknown_real_source_observation" }, 404);
    const input = analystResearchReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_analyst_research_review" }, 400);
    try {
      const previous = deps.db.analystSourceReview(mention.id);
      const review = deps.db.saveAnalystSourceReview({
        observationId: mention.id,
        companyId: mention.company_id,
        disposition: input.data.disposition,
        nextQuestion: input.data.nextQuestion,
      });
      if (!review) return c.json({ error: "unknown_real_source_observation" }, 404);
      if (previous?.updatedAt !== review.updatedAt) {
        deps.hub.broadcast("research_review", {
          observationId: review.observationId,
          companyId: review.companyId,
          disposition: review.disposition,
          updatedAt: review.updatedAt,
        });
      }
      return c.json({ review });
    } catch (error) {
      if (error instanceof AnalystResearchQueueLimitError) {
        return c.json({ error: "analyst_research_queue_limit_exceeded", scope: error.scope, maximum: error.limit }, 409);
      }
      if (error instanceof Error && error.message === "invalid_analyst_research_question") {
        return c.json({ error: "invalid_analyst_research_review" }, 400);
      }
      throw error;
    }
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
      case "classifier_not_configured":
        return c.json({ error: "classifier_not_configured" }, 503);
      case "classifier_source_not_allowed":
        return c.json({ error: "classifier_source_not_allowed" }, 403);
      case "classifier_daily_budget_exhausted":
        return c.json({ error: "classifier_daily_budget_exhausted" }, 429);
      case "budget_exhausted":
        return c.json({ error: "jev_daily_budget_exhausted" }, 429);
      case "storage_paused":
        return c.json({ error: "storage_capacity_paused", message: "Saved evidence remains available, but new provider work is paused until database capacity is restored." }, 503);
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

  app.get("/api/companies/:id/jev-history-week", (c) => {
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) return c.json({ error: "unknown_company" }, 404);
    const rawWeek = c.req.query("week") ?? "latest";
    let weekStartMs: number | null = null;
    if (rawWeek !== "latest") {
      if (!/^\d{13}$/.test(rawWeek)) return c.json({ error: "invalid_jev_history_week" }, 400);
      weekStartMs = Number(rawWeek);
      const date = new Date(weekStartMs);
      if (!Number.isSafeInteger(weekStartMs) || date.getUTCDay() !== 1 || date.getUTCHours() !== 0
        || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
        return c.json({ error: "invalid_jev_history_week" }, 400);
      }
    }
    const result = deps.pipeline.jevHistoryWeek(id, weekStartMs);
    if (!result) return c.json({ error: "jev_history_week_unavailable" }, 404);
    return c.json(result);
  });

  app.get("/api/companies/:id/categorical-series", (c) => {
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) return c.json({ error: "unknown_company" }, 404);
    const rawHours = c.req.query("hours") ?? "24";
    if (!/^\d{1,3}$/.test(rawHours)) return c.json({ error: "invalid_categorical_window" }, 400);
    const hours = Number(rawHours);
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) return c.json({ error: "invalid_categorical_window" }, 400);
    try {
      return c.json(deps.pipeline.categoricalSeries(id, hours));
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_categorical_window") return c.json({ error: "invalid_categorical_window" }, 400);
      throw error;
    }
  });

  app.get("/api/companies/:id/categorical-bucket", (c) => {
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) return c.json({ error: "unknown_company" }, 404);
    const snapshotKey = c.req.query("snapshot") ?? "";
    const rawBucket = c.req.query("at") ?? "";
    const rawSpan = c.req.query("span") ?? "900000";
    const rawLimit = c.req.query("limit") ?? "50";
    if (!snapshotKey || snapshotKey.length > 2048 || !/^\d{1,16}$/.test(rawBucket) || !/^\d{1,8}$/.test(rawSpan) || !/^\d{1,3}$/.test(rawLimit)) {
      return c.json({ error: "invalid_categorical_bucket" }, 400);
    }
    const bucketStartMs = Number(rawBucket);
    const bucketDurationMs = Number(rawSpan);
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(bucketStartMs) || ![900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000].includes(bucketDurationMs)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ error: "invalid_categorical_bucket" }, 400);
    }
    const rawCursor = c.req.query("cursor");
    let cursor: CategoricalBucketCursor | null = null;
    if (rawCursor != null) {
      let decoded: unknown;
      try { decoded = JSON.parse(rawCursor); } catch { return c.json({ error: "invalid_cursor" }, 400); }
      const parsed = categoricalBucketCursorSchema.safeParse(decoded);
      if (!parsed.success) return c.json({ error: "invalid_cursor" }, 400);
      cursor = parsed.data;
    }
    try {
      return c.json(deps.pipeline.categoricalBucketEvidence({ companyId: id, snapshotKey, bucketStartMs, bucketDurationMs, limit, cursor }));
    } catch (error) {
      if (error instanceof CategoricalSnapshotUnavailableError) return c.json({ error: "categorical_snapshot_unavailable" }, 409);
      if (error instanceof InvalidCategoricalBucketError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.get("/api/companies/:id/score-bucket", (c) => {
    const id = c.req.param("id");
    if (!deps.db.companies().some((company) => company.id === id)) return c.json({ error: "unknown company" }, 404);
    const hours = clampNumber(c.req.query("hours"), 1, 168, 24);
    const fromMs = Number(c.req.query("from"));
    const throughMs = Number(c.req.query("through"));
    const now = Date.now();
    const rawArchiveWeek = c.req.query("archiveWeek");
    let archiveWeekStartMs: number | null = null;
    if (rawArchiveWeek != null) {
      if (!/^\d{13}$/.test(rawArchiveWeek)) return c.json({ error: "invalid_score_bucket_archive_week" }, 400);
      archiveWeekStartMs = Number(rawArchiveWeek);
      const weekDate = new Date(archiveWeekStartMs);
      if (!Number.isSafeInteger(archiveWeekStartMs) || weekDate.getUTCDay() !== 1 || weekDate.getUTCHours() !== 0
        || weekDate.getUTCMinutes() !== 0 || weekDate.getUTCSeconds() !== 0 || weekDate.getUTCMilliseconds() !== 0) {
        return c.json({ error: "invalid_score_bucket_archive_week" }, 400);
      }
    }
    const oldestPermittedFromMs = now - hours * 60 * 60_000 - SERIES_BUCKET_MS;
    const sameUtcBucket = Number.isSafeInteger(fromMs) && Number.isSafeInteger(throughMs)
      && Math.floor(fromMs / SERIES_BUCKET_MS) === Math.floor((throughMs - 1) / SERIES_BUCKET_MS);
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(throughMs)
      || (archiveWeekStartMs == null && fromMs < oldestPermittedFromMs)
      || (archiveWeekStartMs != null && (fromMs < archiveWeekStartMs || throughMs > archiveWeekStartMs + 7 * DAY_MS))
      || (archiveWeekStartMs == null && throughMs > now) || throughMs <= fromMs
      || throughMs - fromMs > SERIES_BUCKET_MS || !sameUtcBucket) {
      return c.json({ error: "invalid_score_bucket" }, 400);
    }
    const rawSnapshot = c.req.query("snapshot");
    if (rawSnapshot != null && !/^[a-f0-9]{64}$/.test(rawSnapshot)) return c.json({ error: "invalid_score_bucket_snapshot" }, 400);
    const rawImpactBin = c.req.query("impactBin");
    const impactBin = rawImpactBin == null ? null : Number(rawImpactBin);
    if (rawImpactBin != null && (!Number.isInteger(impactBin) || impactBin! < 0 || impactBin! > 19)) {
      return c.json({ error: "invalid_score_bucket_impact_bin" }, 400);
    }
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
      if (parsed.data.companyId !== id || parsed.data.scoredAt >= throughMs || parsed.data.scoredAt < fromMs
        || parsed.data.fromMs !== fromMs || parsed.data.throughMs !== throughMs
        || parsed.data.impactBin !== impactBin || parsed.data.snapshotKey !== rawSnapshot) {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      cursor = parsed.data;
    }
    try {
      const page = deps.db.mentionsForScoreBucket({
        companyId: id,
        fromMs,
        throughMs,
        limit: clampNumber(c.req.query("limit"), 1, 100, 50),
        cursor,
        expectedSnapshotKey: rawSnapshot,
        impactBin,
      });
      return c.json({
        bucketFromMs: fromMs,
        bucketThroughMs: throughMs,
        recordCount: page.recordCount,
        matchingRecordCount: page.matchingRecordCount,
        impactBin: page.impactBin,
        weightedMeanImpact: weightedIndex(page.eligibleRecords),
        recordImpactMin: page.impactValues.length ? Math.min(...page.impactValues) : null,
        recordImpactMax: page.impactValues.length ? Math.max(...page.impactValues) : null,
        snapshotKey: page.snapshotKey,
        impactDistribution: impactDistribution(page.impactValues),
        coverageSummary: page.coverageSummary,
        items: page.items,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof ScoreBucketSnapshotConflictError) return c.json({ error: "score_bucket_snapshot_changed" }, 409);
      if (error instanceof Error && error.message === "invalid_score_bucket_interval") return c.json({ error: "invalid_score_bucket" }, 400);
      throw error;
    }
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
    const legacyUnknownRows = deps.db.legacyUnknownPriceRowCount(ticker);
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
      quarantine: { legacyUnknownRows, scope: "all_saved_history" as const },
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

  app.get("/api/saved-source-coverage", (c) => {
    return c.json(deps.db.savedSourceCoverage(3, Date.now()));
  });

  app.get("/api/saved-source-search", (c) => {
    const query = c.req.query("q")?.trim() ?? "";
    if (query.length < 2 || query.length > 120) return c.json({ error: "invalid_search_query" }, 400);
    const companyId = c.req.query("companyId")?.trim() || null;
    if (companyId != null && (companyId.length > 160 || !deps.db.companies().some((company) => company.id === companyId))) {
      return c.json({ error: "unknown_company" }, 404);
    }
    const publisher = c.req.query("publisher")?.trim() || null;
    if (publisher != null && publisher.length > 120) return c.json({ error: "invalid_publisher_filter" }, 400);
    const rawIncludeDismissed = c.req.query("includeDismissed");
    if (rawIncludeDismissed != null && rawIncludeDismissed !== "true" && rawIncludeDismissed !== "false") {
      return c.json({ error: "invalid_include_dismissed" }, 400);
    }
    const rawSnapshotAt = c.req.query("snapshotAt");
    let snapshotAt: number | null = null;
    if (rawSnapshotAt != null) {
      if (!/^\d{1,16}$/.test(rawSnapshotAt)) return c.json({ error: "invalid_search_snapshot" }, 400);
      snapshotAt = Number(rawSnapshotAt);
      if (!Number.isSafeInteger(snapshotAt)) return c.json({ error: "invalid_search_snapshot" }, 400);
    }
    const rawReviewRevision = c.req.query("reviewRevision");
    let reviewRevision: number | null = null;
    if (rawReviewRevision != null) {
      if (!/^\d{1,16}$/.test(rawReviewRevision)) return c.json({ error: "invalid_search_review_revision" }, 400);
      reviewRevision = Number(rawReviewRevision);
      if (!Number.isSafeInteger(reviewRevision)) return c.json({ error: "invalid_search_review_revision" }, 400);
    }
    const rawCursor = c.req.query("cursor");
    let cursor: SavedSourceSearchCursor | null = null;
    if (rawCursor != null) {
      if (rawCursor.length > 1200) return c.json({ error: "invalid_cursor" }, 400);
      let decoded: unknown;
      try { decoded = JSON.parse(rawCursor); }
      catch { return c.json({ error: "invalid_cursor" }, 400); }
      const parsed = savedSourceSearchCursorSchema.safeParse(decoded);
      if (!parsed.success) return c.json({ error: "invalid_cursor" }, 400);
      cursor = parsed.data;
    }
    try {
      return c.json(deps.db.savedSourceSearch({
        query,
        companyId,
        publisher,
        includeDismissed: rawIncludeDismissed === "true",
        snapshotAt,
        reviewRevision,
        cursor,
        limit: clampNumber(c.req.query("limit"), 1, 50, 25),
      }));
    } catch (error) {
      if (error instanceof Error && (error.message === "saved_source_search_cursor_scope_mismatch"
        || error.message === "invalid_saved_source_search_request")) return c.json({ error: error.message }, 400);
      if (error instanceof Error && error.message === "saved_source_search_snapshot_changed") {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
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
        if (event === "mention") {
          try {
            const mention = JSON.parse(data) as { id?: unknown } & Record<string, unknown>;
            if (typeof mention.id === "string") {
              const companyId = typeof mention.companyId === "string" ? mention.companyId : null;
              const saved = companyId == null ? undefined : deps.db.mentionsByIds(companyId, [mention.id])[0];
              const review = deps.db.analystSourceReview(mention.id);
              data = JSON.stringify({
                ...mention,
                issuerIdentityStrong: saved?.issuerIdentityStrong ?? false,
                analystResearchDisposition: review?.disposition ?? null,
                analystResearchDispositionUpdatedAt: review?.updatedAt ?? null,
              });
            }
          } catch {
            // Preserve the original event if a future mention payload is not JSON.
          }
        }
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
