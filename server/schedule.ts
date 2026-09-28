import type { CollectorId, Company } from "./types.js";
import type { Desk } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Pipeline } from "./pipeline.js";
import { fetchGdeltArticles, GDELT_ARTICLE_LIMIT, GdeltHttpError, type GdeltFetchResult } from "./sources/gdelt.js";
import { fetchEarningsHistory, fetchFinnhubNews, fetchUpcomingEarnings, latestSurprise } from "./sources/finnhub.js";
import { getRedditToken, RedditPaginationRestartError, searchReddit, type RedditClient } from "./sources/reddit.js";
import { tierForHost } from "./sources/tiers.js";
import { fetchFeed, googleNewsUrl, yahooFinanceUrl } from "./sources/rss.js";
import { searchRecent, XPaginationTokenRejectedError, xQuery } from "./sources/x.js";
import { isFinanceRelevant } from "./scoring.js";
import { fetchPrimaryDocText, fetchRecent8Ks, fetchTickerCikMap, titleForItems } from "./sources/sec.js";
import { classifyDeliveryError, recordDelivery } from "./delivery.js";
import { scheduleTask, type SchedulerControl } from "./scheduler.js";
import {
  clearProviderRateLimit,
  ProviderRateLimitError,
  providerCoolingDown,
  recordProviderRateLimit,
  type RateLimitedProvider,
} from "./provider-cooldown.js";

/**
 * Polling schedulers. Each source loop is failure-isolated: one company's feed
 * erroring never blocks the others, and failures land in health counters and
 * the events table. The RSS rotation sleeps briefly between companies to stay
 * polite to the feed host.
 */

export function startRssPoller(deps: {
  companies: Company[];
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  concurrency: number;
  enabledCollectors?: ReadonlySet<CollectorId>;
  fetchFeed?: typeof fetchFeed;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
}): SchedulerControl {
  const fetch = deps.fetchFeed ?? fetchFeed;
  const pause = deps.pause ?? sleep;
  const now = deps.now ?? Date.now;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Two feeds per company: Google News for breadth, Yahoo Finance's
      // per-ticker feed for speed. Fetched with a small worker pool so a full
      // sweep completes in seconds, not minutes: detection lag is the product.
      const feeds: Array<{
        company: Company;
        url: string;
        fallbackName: string;
        collector: "google_news_rss" | "yahoo_finance_rss";
        provider: "google_news" | "yahoo";
      }> = [];
      for (const company of deps.companies) {
        if (deps.enabledCollectors == null || deps.enabledCollectors.has("google_news_rss")) {
          feeds.push({ company, url: googleNewsUrl(company), fallbackName: company.name, collector: "google_news_rss", provider: "google_news" });
        }
        if (deps.enabledCollectors == null || deps.enabledCollectors.has("yahoo_finance_rss")) {
          feeds.push({ company, url: yahooFinanceUrl(company), fallbackName: "Yahoo Finance", collector: "yahoo_finance_rss", provider: "yahoo" });
        }
      }
      const pausedThisCycle = new Set<RateLimitedProvider>();
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const job = feeds[next];
          next += 1;
          if (!job) return;
          const { company, feed } = { company: job.company, feed: { url: job.url, fallbackName: job.fallbackName, collector: job.collector } };
          if (pausedThisCycle.has(job.provider) || providerCoolingDown(deps.db, job.provider, now())) {
            await pause(100);
            continue;
          }
          const startedAt = Date.now();
          let items: Awaited<ReturnType<typeof fetchFeed>> = [];
          try {
            items = await fetch(feed.url);
            let added = 0;
            let dropped = 0;
            for (const item of items) {
              if (!matchesCompany(company, item.title, item.snippet)) continue;
              if (
                !isFinanceRelevant({
                  title: item.title,
                  snippet: item.snippet,
                  tier: item.tier,
                  kind: "rss",
                  ticker: company.ticker,
                })
              ) {
                dropped += 1;
                continue;
              }
              const inserted = deps.pipeline.ingest({
                companyId: company.id,
                kind: "rss",
                sourceName: item.sourceName || feed.fallbackName,
                publisherName: item.sourceName || feed.fallbackName,
                sourceUrl: item.url,
                sourceItemId: item.sourceItemId,
                collector: feed.collector,
                adapterVersion: `${feed.collector}/2`,
                tier: item.tier,
                title: item.title,
                snippet: item.snippet,
                publishedAt: item.publishedAt,
                retrievedAt: Date.now(),
                scoped: feed.fallbackName === "Yahoo Finance",
              });
              if (inserted) added += 1;
            }
            recordDelivery({
              db: deps.db, collector: feed.collector, companyId: company.id,
              requestKey: feed.url, startedAt, adapterVersion: `${feed.collector}/2`,
              result: items.length === 0 ? "empty" : "success", parsedItemCount: items.length,
              normalizedItems: items,
            });
            deps.health.recordRss(true);
            clearProviderRateLimit(deps.db, job.provider, startedAt);
            if (added > 0) {
              deps.db.logEvent("info", "rss", `${company.ticker}: ${added} new mentions`);
            }
            if (dropped > 0) {
              deps.db.logEvent("info", "relevance", `${company.ticker}: ${dropped} dropped by ingest guard`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            recordDelivery({
              db: deps.db, collector: feed.collector, companyId: company.id,
              requestKey: feed.url, startedAt, adapterVersion: `${feed.collector}/2`,
              result: items.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: items.length,
              normalizedItems: items, error: err,
            });
            deps.health.recordRss(false, `${company.ticker}: ${message}`);
            deps.db.logEvent("warn", "rss", `${company.ticker}: ${message}`);
            if (err instanceof ProviderRateLimitError) {
              pausedThisCycle.add(err.provider);
              recordProviderRateLimit({
                db: deps.db,
                provider: err.provider,
                minDelayMs: deps.intervalSeconds * 1_000,
                retryAfterMs: err.retryAfterMs,
                now: now(),
              });
            }
          }
          await pause(1_000);
        }
      };
      const workers = Array.from({ length: Math.max(1, deps.concurrency) }, () => worker());
      await Promise.all(workers);
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

export function startXPoller(deps: {
  bearer: string;
  companies: Company[];
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
}): SchedulerControl {
  type XPageCheckpoint = {
    sinceId: string | null;
    newestId: string | null;
    nextToken: string;
    page: number;
    query: string;
    maxResults: number;
  };
  type XCommittedCursor = {
    sinceId: string | null;
    query: string;
    maxResults: number;
  };
  const pageSize = 25;
  const checkpointKey = (companyId: string): string => `x:pagination:${companyId}`;
  const committedCursorKey = (companyId: string): string => `x:since-state:${companyId}`;
  const legacyCursorKey = (companyId: string): string => `x:since:${companyId}`;
  const readCommittedCursor = (companyId: string, query: string): string | null => {
    const raw = deps.db.getKv(committedCursorKey(companyId));
    if (raw) {
      try {
        const value = JSON.parse(raw) as Partial<XCommittedCursor>;
        if (
          (value.sinceId === null || (typeof value.sinceId === "string" && /^\d+$/.test(value.sinceId))) &&
          typeof value.query === "string" && Number.isSafeInteger(value.maxResults)
        ) {
          if (value.query === query && value.maxResults === pageSize) return value.sinceId ?? null;
        }
      } catch {
        // A damaged cursor is treated as unverified and replayed from the recent window.
      }
      deps.db.setKv(committedCursorKey(companyId), "");
      deps.db.setKv(legacyCursorKey(companyId), "");
      return null;
    }
    if (deps.db.getKv(legacyCursorKey(companyId))) {
      // Pre-fingerprint IDs cannot be proven to belong to this query. Replaying
      // the provider's recent window is safer; ingested post IDs are idempotent.
      deps.db.setKv(legacyCursorKey(companyId), "");
    }
    return null;
  };
  const readCheckpoint = (companyId: string, query: string, sinceId: string | null): XPageCheckpoint | null => {
    const raw = deps.db.getKv(checkpointKey(companyId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<XPageCheckpoint>;
      if (
        typeof value.nextToken === "string" && value.nextToken.length > 0 &&
        value.sinceId === sinceId &&
        (value.newestId === null || typeof value.newestId === "string") &&
        Number.isSafeInteger(value.page) && Number(value.page) >= 1 &&
        value.query === query && value.maxResults === pageSize
      ) {
        return value as XPageCheckpoint;
      }
    } catch {
      // A damaged in-progress cursor must not replace the last committed since_id.
    }
    deps.db.setKv(checkpointKey(companyId), "");
    return null;
  };
  const newestId = (...ids: Array<string | undefined | null>): string | undefined => {
    const numeric = ids.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id));
    return numeric.reduce<string | undefined>((latest, id) => {
      if (latest == null || id.length > latest.length || (id.length === latest.length && id > latest)) return id;
      return latest;
    }, undefined);
  };
  let running = false;
  const tick = async (): Promise<void> => {
    if (providerCoolingDown(deps.db, "x")) return;
    if (running) return;
    running = true;
    try {
      for (const company of deps.companies) {
        if (providerCoolingDown(deps.db, "x")) break;
        const startedAt = Date.now();
        let posts: Awaited<ReturnType<typeof searchRecent>>["posts"] = [];
        const query = xQuery(company);
        const committedSinceId = readCommittedCursor(company.id, query);
        const checkpoint = readCheckpoint(company.id, query, committedSinceId);
        const sinceId = checkpoint ? checkpoint.sinceId : committedSinceId;
        const page = checkpoint?.page ?? 1;
        const requestKey = `x:${company.id}:${sinceId ?? "initial"}:page:${page}`;
        try {
          const res = await searchRecent({
            bearer: deps.bearer,
            company,
            sinceId: sinceId ?? undefined,
            paginationToken: checkpoint?.nextToken,
            maxResults: pageSize,
          });
          posts = res.posts;
          if (res.rateLimited) {
            recordDelivery({
              db: deps.db, collector: "x", companyId: company.id,
              requestKey, startedAt,
              adapterVersion: "x-search/1", result: "rate_limited", parsedItemCount: 0,
              error: "X API rate limited this request",
            });
            deps.health.recordX(false, "rate limited");
            deps.db.logEvent("warn", "x", `${company.ticker}: rate limited, pausing this cycle`);
            recordProviderRateLimit({
              db: deps.db,
              provider: "x",
              minDelayMs: deps.intervalSeconds * 1_000,
              retryAfterMs: res.resetAt == null ? undefined : Math.max(0, res.resetAt - Date.now()),
            });
            break;
          }
          let added = 0;
          for (const post of res.posts) {
            if (!matchesCompany(company, post.text)) continue;
            if (
              !isFinanceRelevant({
                title: post.text,
                snippet: "",
                tier: "social",
                kind: "x",
                ticker: company.ticker,
              })
            ) {
              continue;
            }
            const url = `https://x.com/${post.handle}/status/${post.id}`;
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "x",
              sourceName: `@${post.handle}`,
              sourceUrl: url,
              tier: "social",
              title: post.text.slice(0, 140),
              snippet: post.text.slice(0, 600),
              publishedAt: Number.isFinite(post.createdAt) ? post.createdAt : null,
              collector: "x",
              sourceItemId: post.id,
              publisherName: `@${post.handle}`,
              publisherDomain: "x.com",
              adapterVersion: "x-search/1",
              retrievedAt: Date.now(),
              scoped: true,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "x", companyId: company.id,
            requestKey, startedAt,
            adapterVersion: "x-search/1", result: res.nextToken ? "partial" : posts.length === 0 ? "empty" : "success",
            parsedItemCount: posts.length, normalizedItems: posts,
          });
          const newestSeenId = newestId(checkpoint?.newestId, res.newestId, ...posts.map((post) => post.id));
          if (res.nextToken) {
            deps.db.setKv(checkpointKey(company.id), JSON.stringify({
              sinceId,
              newestId: newestSeenId ?? null,
              nextToken: res.nextToken,
              page: page + 1,
              query,
              maxResults: pageSize,
            } satisfies XPageCheckpoint));
          } else {
            const nextSinceId = newestSeenId ?? sinceId;
            deps.db.setKv(committedCursorKey(company.id), JSON.stringify({
              sinceId: nextSinceId,
              query,
              maxResults: pageSize,
            } satisfies XCommittedCursor));
            deps.db.setKv(legacyCursorKey(company.id), nextSinceId ?? "");
            deps.db.setKv(checkpointKey(company.id), "");
          }
          deps.health.recordX(true);
          clearProviderRateLimit(deps.db, "x", startedAt);
          if (added > 0) deps.db.logEvent("info", "x", `${company.ticker}: ${added} new posts`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof XPaginationTokenRejectedError && checkpoint) {
            // Keep x:since unchanged so the next scheduled request can replay
            // from the last fully drained search window.
            deps.db.setKv(checkpointKey(company.id), "");
          }
          recordDelivery({
            db: deps.db, collector: "x", companyId: company.id,
            requestKey, startedAt, adapterVersion: "x-search/1",
            result: posts.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: posts.length,
            normalizedItems: posts, error: err,
          });
          deps.health.recordX(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "x", `${company.ticker}: ${message}`);
        }
        await sleep(300);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/**
 * SEC EDGAR poller: recent 8-Ks per watchlisted company, with the primary
 * document fetched for state text. Filings are ground truth; acceptance
 * timestamps are exchange-accepted instants, not estimates.
 */
export function startSecPoller(deps: {
  companies: Company[];
  cikByTicker: Map<string, string>;
  userAgent: string;
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  fetchFilings?: typeof fetchRecent8Ks;
}): SchedulerControl {
  const fetchFilings = deps.fetchFilings ?? fetchRecent8Ks;
  let running = false;
  const tick = async (): Promise<void> => {
    if (providerCoolingDown(deps.db, "sec")) return;
    if (running) return;
    running = true;
    try {
      const since = Date.now() - 3 * 24 * 60 * 60 * 1000;
      for (const company of deps.companies) {
        const cik = deps.cikByTicker.get(company.ticker);
        if (!cik) continue;
        const startedAt = Date.now();
        let filings: Awaited<ReturnType<typeof fetchRecent8Ks>> = [];
        try {
          filings = await fetchFilings({ cik, ticker: company.ticker, sinceMs: since, userAgent: deps.userAgent });
          let added = 0;
          let unavailableDocuments = 0;
          for (const f of filings) {
            let snippet = "";
            try {
              snippet = await fetchPrimaryDocText(f.primaryDocUrl, deps.userAgent);
            } catch (err) {
              if (err instanceof ProviderRateLimitError) throw err;
            }
            if (!snippet) {
              unavailableDocuments += 1;
              continue;
            }
            const url = f.primaryDocUrl || `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.accessionNo.replace(/-/g, "")}/`;
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "sec",
              scoped: true,
              sourceName: "SEC EDGAR",
              sourceUrl: url,
              tier: "filing",
              title: titleForItems(f.formType, f.items),
              snippet,
              publishedAt: f.acceptanceAt,
              collector: "sec_edgar",
              sourceItemId: f.accessionNo,
              publisherName: "SEC EDGAR",
              publisherDomain: "sec.gov",
              adapterVersion: "sec-submissions/1",
              filedAt: f.filedAt ?? undefined,
              retrievedAt: Date.now(),
            });
            if (inserted) added += 1;
          }
          const partialError = unavailableDocuments > 0
            ? `${unavailableDocuments} SEC filing document(s) unavailable; omitted from Jev input`
            : undefined;
          recordDelivery({
            db: deps.db, collector: "sec_edgar", companyId: company.id,
            requestKey: `sec:${cik}:8-k:${since}`, startedAt, adapterVersion: "sec-submissions/1",
            result: filings.length === 0 ? "empty" : unavailableDocuments > 0 ? "partial" : "success",
            parsedItemCount: filings.length, normalizedItems: filings, error: partialError,
          });
          deps.health.recordSec(unavailableDocuments === 0, partialError);
          clearProviderRateLimit(deps.db, "sec", startedAt);
          if (added > 0) deps.db.logEvent("info", "sec", `${company.ticker}: ${added} new 8-K filings`);
          if (partialError) deps.db.logEvent("warn", "sec", `${company.ticker}: ${partialError}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "sec_edgar", companyId: company.id,
            requestKey: `sec:${cik}:8-k:${since}`, startedAt, adapterVersion: "sec-submissions/1",
            result: filings.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: filings.length,
            normalizedItems: filings, error: err,
          });
          deps.health.recordSec(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "sec", `${company.ticker}: ${message}`);
          if (err instanceof ProviderRateLimitError) {
            recordProviderRateLimit({
              db: deps.db,
              provider: "sec",
              minDelayMs: deps.intervalSeconds * 1_000,
              retryAfterMs: err.retryAfterMs,
            });
            break;
          }
        }
        await sleep(150); // SEC fair-access pacing: ~6.7 req/s ceiling
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/** Resolve the SEC ticker directory in the background and retry failed bootstrap attempts. */
export function startSecCollector(deps: {
  companies: Company[];
  userAgent: string;
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  resolveTickerCiks?: typeof fetchTickerCikMap;
  fetchFilings?: typeof fetchRecent8Ks;
}): SchedulerControl {
  const resolveTickerCiks = deps.resolveTickerCiks ?? fetchTickerCikMap;
  let poller: SchedulerControl | null = null;
  const bootstrap = scheduleTask(async () => {
    if (poller || providerCoolingDown(deps.db, "sec")) return;
    const startedAt = Date.now();
    const requestKey = `sec:ticker-directory:${startedAt}`;
    try {
      const cikByTicker = await resolveTickerCiks(deps.userAgent);
      if (cikByTicker.size === 0) throw new Error("SEC ticker directory returned no ticker mappings");
      recordDelivery({
        db: deps.db,
        collector: "sec_edgar",
        companyId: null,
        requestKey,
        startedAt,
        adapterVersion: "sec-company-tickers/1",
        result: "success",
        parsedItemCount: cikByTicker.size,
        normalizedItems: { tickerCount: cikByTicker.size },
      });
      clearProviderRateLimit(deps.db, "sec", startedAt);
      deps.health.recordSec(true);
      deps.db.logEvent("info", "sec", `${cikByTicker.size} ticker CIKs resolved`);
      poller = startSecPoller({
        companies: deps.companies,
        cikByTicker,
        userAgent: deps.userAgent,
        pipeline: deps.pipeline,
        db: deps.db,
        health: deps.health,
        intervalSeconds: deps.intervalSeconds,
        fetchFilings: deps.fetchFilings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordDelivery({
        db: deps.db,
        collector: "sec_edgar",
        companyId: null,
        requestKey,
        startedAt,
        adapterVersion: "sec-company-tickers/1",
        result: classifyDeliveryError(err),
        parsedItemCount: 0,
        error: err,
      });
      deps.health.recordSec(false, `SEC ticker directory: ${message}`);
      deps.db.logEvent("warn", "sec", `ticker directory: ${message}`);
      if (err instanceof ProviderRateLimitError) {
        recordProviderRateLimit({
          db: deps.db,
          provider: "sec",
          minDelayMs: deps.intervalSeconds * 1_000,
          retryAfterMs: err.retryAfterMs,
        });
      }
    }
  }, deps.intervalSeconds * 1_000);

  return {
    async stop() {
      await bootstrap.stop();
      await poller?.stop();
    },
  };
}

/**
 * GDELT poller: slow, spaced, breadth-only. Two seconds between companies so
 * a full 24-name rotation takes under a minute against a 5-minute cycle.
 */
export function startGdeltPoller(deps: {
  companies: Company[];
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  fetchArticles?: (query: string) => Promise<GdeltFetchResult>;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}): SchedulerControl {
  const intervalMs = deps.intervalSeconds * 1000;
  const maxBackoffMs = 60 * 60 * 1000;
  const retryAtKey = "gdelt:rate-limit:retry-at";
  const failureCountKey = "gdelt:rate-limit:consecutive";
  const now = deps.now ?? Date.now;
  const fetchArticles = deps.fetchArticles ?? fetchGdeltArticles;
  const pause = deps.pause ?? sleep;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const persistedRetryAt = deps.db.getKv(retryAtKey);
      const retryAt = persistedRetryAt === undefined ? 0 : Number(persistedRetryAt);
      if (persistedRetryAt !== undefined && (!Number.isSafeInteger(retryAt) || retryAt < 0)) {
        const safeRetryAt = now() + maxBackoffMs;
        deps.db.setKv(retryAtKey, String(safeRetryAt));
        deps.db.logEvent("warn", "gdelt", "invalid persisted rate-limit cooldown; delaying requests for one hour");
        return;
      }
      if (retryAt > now()) return;

      for (const company of deps.companies) {
        const startedAt = now();
        let result: GdeltFetchResult = {
          articles: [], providerResultCount: 0, requestedLimit: GDELT_ARTICLE_LIMIT, saturated: false,
        };
        try {
          const query = `"${company.name}" OR "${company.ticker}"`;
          result = await fetchArticles(query);
          const truncationNotice = result.saturated
            ? `GDELT reached the requested ${result.requestedLimit}-article limit; older matching articles may be omitted`
            : undefined;
          let added = 0;
          let dropped = 0;
          for (const a of result.articles) {
            if (!matchesCompany(company, a.title)) continue;
            if (
              !isFinanceRelevant({
                title: a.title,
                snippet: "",
                tier: tierForHost(a.url),
                kind: "rss",
                ticker: company.ticker,
              })
            ) {
              dropped += 1;
              continue;
            }
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "rss",
              sourceName: a.domain,
              sourceUrl: a.url,
              tier: tierForHost(a.url),
              title: a.title,
              snippet: "",
              publishedAt: null,
              providerObservedAt: a.seenAt,
              collector: "gdelt_doc_api",
              sourceItemId: a.url,
              publisherName: a.domain,
              publisherDomain: a.domain,
              adapterVersion: "gdelt-doc/1",
              retrievedAt: Date.now(),
              scoped: false,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "gdelt_doc_api", companyId: company.id,
            requestKey: `gdelt:${query}`, startedAt, adapterVersion: "gdelt-doc/1",
            result: truncationNotice ? "partial" : result.providerResultCount === 0 ? "empty" : "success",
            parsedItemCount: result.providerResultCount, normalizedItems: result.articles, error: truncationNotice,
          });
          deps.health.recordGdelt(true);
          deps.db.setKv(retryAtKey, "0");
          deps.db.setKv(failureCountKey, "0");
          if (added > 0) deps.db.logEvent("info", "gdelt", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `gdelt ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "gdelt_doc_api", companyId: company.id,
            requestKey: `gdelt:${company.id}`, startedAt, adapterVersion: "gdelt-doc/1",
            result: result.providerResultCount > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: result.providerResultCount,
            normalizedItems: result.articles, error: err,
          });
          deps.health.recordGdelt(false, `gdelt ${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "gdelt", `${company.ticker}: ${message}`);
          if (err instanceof GdeltHttpError && err.status === 429) {
            const previousCount = Number(deps.db.getKv(failureCountKey) ?? "0");
            const consecutive429 = Number.isSafeInteger(previousCount) && previousCount >= 0
              ? previousCount + 1
              : 1;
            const fallbackMs = Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(consecutive429 - 1, 16));
            const requestedMs = err.retryAfterMs === undefined
              ? fallbackMs
              : Math.max(intervalMs, err.retryAfterMs);
            const delayMs = Math.max(intervalMs, requestedMs);
            deps.db.setKv(failureCountKey, String(consecutive429));
            deps.db.setKv(retryAtKey, String(now() + delayMs));
            // GDELT throttling is source-wide; further company requests in this
            // sweep would repeat the same rejected call and worsen the limit.
            break;
          }
        }
        await pause(2_000);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/**
 * Finnhub poller: per-symbol company news on the fast clock, and a slow
 * earnings refresh (latest EPS surprise + upcoming calendar) stored in kv so
 * snapshots can carry measured surprise instead of model guesses.
 */
export function startFinnhubPoller(deps: {
  companies: Company[];
  token: string;
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  backfillDays: number;
}): SchedulerControl {
  let running = false;
  let lastEarningsRefresh = 0;
  let backfilled = false;
  const runBackfill = async (): Promise<void> => {
    if (backfilled || deps.backfillDays <= 0 || providerCoolingDown(deps.db, "finnhub")) return;
    let complete = true;
    for (const company of deps.companies) {
      if (providerCoolingDown(deps.db, "finnhub")) {
        complete = false;
        break;
      }
      const startedAt = Date.now();
      let news: Awaited<ReturnType<typeof fetchFinnhubNews>> = [];
      try {
        news = await fetchFinnhubNews(company.ticker, deps.token, deps.backfillDays);
        let added = 0;
        for (const n of news) {
          if (!matchesCompany(company, n.headline, n.summary)) continue;
          if (
            !isFinanceRelevant({
              title: n.headline,
              snippet: n.summary,
              tier: tierForHost(n.url),
              kind: "finnhub",
              ticker: company.ticker,
            })
          ) {
            continue;
          }
          const inserted = deps.pipeline.ingest({
            companyId: company.id,
            kind: "finnhub",
            sourceName: n.source,
            sourceUrl: n.url,
            tier: tierForHost(n.url),
            title: n.headline,
            snippet: n.summary,
            publishedAt: n.datetime,
            collector: "finnhub",
            sourceItemId: n.url,
            publisherName: n.source,
            adapterVersion: "finnhub-news/1",
            retrievedAt: Date.now(),
          });
          if (inserted) added += 1;
        }
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:${company.ticker}:backfill:${deps.backfillDays}`, startedAt,
          adapterVersion: "finnhub-news/1", result: news.length === 0 ? "empty" : "success",
          parsedItemCount: news.length, normalizedItems: news,
        });
        clearProviderRateLimit(deps.db, "finnhub", startedAt);
        deps.db.logEvent("info", "backfill", `${company.ticker}: ${added} historical mentions`);
      } catch (err) {
        complete = false;
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:${company.ticker}:backfill:${deps.backfillDays}`, startedAt,
          adapterVersion: "finnhub-news/1", result: news.length > 0 ? "partial" : classifyDeliveryError(err),
          parsedItemCount: news.length, normalizedItems: news, error: err,
        });
        deps.db.logEvent("warn", "backfill", `${company.ticker}: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof ProviderRateLimitError) {
          recordProviderRateLimit({
            db: deps.db,
            provider: "finnhub",
            minDelayMs: deps.intervalSeconds * 1_000,
            retryAfterMs: err.retryAfterMs,
          });
          break;
        }
      }
      await sleep(300);
    }
    if (complete) backfilled = true;
  };
  const refreshEarnings = async (): Promise<void> => {
    if (providerCoolingDown(deps.db, "finnhub")) return;
    const symbols = new Set(deps.companies.map((c) => c.ticker));
    const calendarStartedAt = Date.now();
    try {
      const upcoming = await fetchUpcomingEarnings(deps.token, symbols);
      for (const company of deps.companies) {
        const at = upcoming.get(company.ticker);
        if (at) deps.db.setKv(`finnhub:earnings:${company.id}`, String(at));
      }
      recordDelivery({
        db: deps.db, collector: "finnhub", companyId: null,
        requestKey: `finnhub:earnings-calendar:${[...symbols].sort().join(",")}`,
        startedAt: calendarStartedAt, adapterVersion: "finnhub-calendar/1",
        result: upcoming.size === 0 ? "empty" : "success", parsedItemCount: upcoming.size,
        normalizedItems: [...upcoming.entries()],
      });
      deps.health.recordFinnhub(true);
      clearProviderRateLimit(deps.db, "finnhub", calendarStartedAt);
    } catch (err) {
      recordDelivery({
        db: deps.db, collector: "finnhub", companyId: null,
        requestKey: `finnhub:earnings-calendar:${[...symbols].sort().join(",")}`,
        startedAt: calendarStartedAt, adapterVersion: "finnhub-calendar/1",
        result: classifyDeliveryError(err), parsedItemCount: 0, error: err,
      });
      deps.health.recordFinnhub(false, `calendar: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof ProviderRateLimitError) {
        recordProviderRateLimit({
          db: deps.db,
          provider: "finnhub",
          minDelayMs: deps.intervalSeconds * 1_000,
          retryAfterMs: err.retryAfterMs,
        });
        return;
      }
    }
    for (const company of deps.companies) {
      if (providerCoolingDown(deps.db, "finnhub")) return;
      const startedAt = Date.now();
      let entries: Awaited<ReturnType<typeof fetchEarningsHistory>> = [];
      try {
        entries = await fetchEarningsHistory(company.ticker, deps.token);
        const surprise = latestSurprise(entries);
        if (surprise) deps.db.setKv(`finnhub:surprise:${company.id}`, JSON.stringify(surprise));
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:earnings-history:${company.ticker}`, startedAt,
          adapterVersion: "finnhub-earnings/1", result: entries.length === 0 ? "empty" : "success",
          parsedItemCount: entries.length, normalizedItems: entries,
        });
        deps.health.recordFinnhub(true);
        clearProviderRateLimit(deps.db, "finnhub", startedAt);
      } catch (err) {
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:earnings-history:${company.ticker}`, startedAt,
          adapterVersion: "finnhub-earnings/1", result: entries.length > 0 ? "partial" : classifyDeliveryError(err),
          parsedItemCount: entries.length, normalizedItems: entries, error: err,
        });
        deps.health.recordFinnhub(false, `${company.ticker}: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof ProviderRateLimitError) {
          recordProviderRateLimit({
            db: deps.db,
            provider: "finnhub",
            minDelayMs: deps.intervalSeconds * 1_000,
            retryAfterMs: err.retryAfterMs,
          });
          return;
        }
      }
      await sleep(300);
    }
    lastEarningsRefresh = Date.now();
  };
  const tick = async (): Promise<void> => {
    if (providerCoolingDown(deps.db, "finnhub")) return;
    if (running) return;
    running = true;
    try {
      await runBackfill();
      if (Date.now() - lastEarningsRefresh > 6 * 60 * 60 * 1000) {
        await refreshEarnings();
      }
      for (const company of deps.companies) {
        if (providerCoolingDown(deps.db, "finnhub")) break;
        const startedAt = Date.now();
        let news: Awaited<ReturnType<typeof fetchFinnhubNews>> = [];
        try {
          news = await fetchFinnhubNews(company.ticker, deps.token);
          let added = 0;
          let dropped = 0;
          for (const n of news) {
            if (!matchesCompany(company, n.headline, n.summary)) continue;
            if (
              !isFinanceRelevant({
                title: n.headline,
                snippet: n.summary,
                tier: tierForHost(n.url),
                kind: "finnhub",
                ticker: company.ticker,
              })
            ) {
              dropped += 1;
              continue;
            }
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "finnhub",
              sourceName: n.source,
              sourceUrl: n.url,
              tier: tierForHost(n.url),
              title: n.headline,
              snippet: n.summary,
              publishedAt: n.datetime,
              collector: "finnhub",
              sourceItemId: n.url,
              publisherName: n.source,
              adapterVersion: "finnhub-news/1",
              retrievedAt: Date.now(),
              scoped: true,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "finnhub", companyId: company.id,
            requestKey: `finnhub:${company.ticker}:recent`, startedAt,
            adapterVersion: "finnhub-news/1", result: news.length === 0 ? "empty" : "success",
            parsedItemCount: news.length, normalizedItems: news,
          });
          deps.health.recordFinnhub(true);
          clearProviderRateLimit(deps.db, "finnhub", startedAt);
          if (added > 0) deps.db.logEvent("info", "finnhub", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `finnhub ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "finnhub", companyId: company.id,
            requestKey: `finnhub:${company.ticker}:recent`, startedAt,
            adapterVersion: "finnhub-news/1", result: news.length > 0 ? "partial" : classifyDeliveryError(err),
            parsedItemCount: news.length, normalizedItems: news, error: err,
          });
          deps.health.recordFinnhub(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "finnhub", `${company.ticker}: ${message}`);
          if (err instanceof ProviderRateLimitError) {
            recordProviderRateLimit({
              db: deps.db,
              provider: "finnhub",
              minDelayMs: deps.intervalSeconds * 1_000,
              retryAfterMs: err.retryAfterMs,
            });
            break;
          }
        }
        await sleep(250);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/** Reddit poller: social search per company with cached OAuth tokens. */
export function startRedditPoller(deps: {
  companies: Company[];
  creds: { clientId: string; clientSecret: string };
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  pause?: (ms: number) => Promise<void>;
}): SchedulerControl {
  const pause = deps.pause ?? sleep;
  type RedditPageCheckpoint = { after: string; page: number; query: string; limit: number };
  const pageSize = 25;
  const checkpointKey = (companyId: string): string => `reddit:pagination:${companyId}`;
  const readCheckpoint = (companyId: string, query: string): RedditPageCheckpoint | null => {
    const raw = deps.db.getKv(checkpointKey(companyId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<RedditPageCheckpoint>;
      if (
        typeof value.after === "string" && value.after.trim() !== "" &&
        Number.isSafeInteger(value.page) && Number(value.page) >= 2 &&
        value.query === query && value.limit === pageSize
      ) return value as RedditPageCheckpoint;
    } catch {
      // Invalid persisted cursors are replayed from the newest page.
    }
    deps.db.setKv(checkpointKey(companyId), "");
    return null;
  };
  let running = false;
  let client: RedditClient | null = null;
  const tick = async (): Promise<void> => {
    if (providerCoolingDown(deps.db, "reddit")) return;
    if (running) return;
    running = true;
    try {
      try {
        client = await getRedditToken(deps.creds, client ?? undefined);
      } catch (err) {
        recordDelivery({
          db: deps.db, collector: "reddit", companyId: null, requestKey: "reddit:oauth",
          startedAt: Date.now(), adapterVersion: "reddit-oauth/1",
          result: classifyDeliveryError(err), parsedItemCount: 0, error: err,
        });
        deps.health.recordReddit(false, err instanceof Error ? err.message : String(err));
        if (err instanceof ProviderRateLimitError) {
          recordProviderRateLimit({
            db: deps.db,
            provider: "reddit",
            minDelayMs: deps.intervalSeconds * 1_000,
            retryAfterMs: err.retryAfterMs,
          });
        }
        return;
      }
      for (const company of deps.companies) {
        if (providerCoolingDown(deps.db, "reddit")) break;
        const active = client;
        if (!active) break;
        const startedAt = Date.now();
        let posts: Awaited<ReturnType<typeof searchReddit>>["posts"] = [];
        let requestKey = `reddit:${company.id}:${company.ticker}`;
        try {
          const query = `"${company.name}" OR "$${company.ticker}"`;
          const checkpoint = readCheckpoint(company.id, query);
          const page = checkpoint?.page ?? 1;
          requestKey = `reddit:${company.id}:${query}:page:${page}`;
          const result = await searchReddit(active, query, {
            after: checkpoint?.after,
            limit: pageSize,
          });
          posts = result.posts;
          let added = 0;
          let dropped = 0;
          for (const p of posts) {
            if (!matchesCompany(company, p.title, p.selftext)) continue;
            if (
              !isFinanceRelevant({
                title: p.title,
                snippet: p.selftext,
                tier: "social",
                kind: "reddit",
                ticker: company.ticker,
              })
            ) {
              dropped += 1;
              continue;
            }
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "reddit",
              sourceName: `r/${p.subreddit}`,
              sourceUrl: p.permalink,
              tier: "social",
              title: p.title,
              snippet: p.selftext,
              publishedAt: p.createdAt,
              collector: "reddit",
              sourceItemId: p.id,
              publisherName: `r/${p.subreddit}`,
              publisherDomain: "reddit.com",
              adapterVersion: "reddit-search/1",
              retrievedAt: Date.now(),
              scoped: true,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "reddit", companyId: company.id,
            requestKey, startedAt,
            adapterVersion: "reddit-search/1",
            result: result.nextAfter ? "partial" : posts.length === 0 ? "empty" : "success",
            parsedItemCount: posts.length, normalizedItems: posts,
            error: result.nextAfter ? `Reddit listing page ${page}; more results remain` : undefined,
          });
          if (result.nextAfter) {
            deps.db.setKv(checkpointKey(company.id), JSON.stringify({
              after: result.nextAfter,
              page: page + 1,
              query,
              limit: pageSize,
            } satisfies RedditPageCheckpoint));
          } else {
            deps.db.setKv(checkpointKey(company.id), "");
          }
          deps.health.recordReddit(true);
          clearProviderRateLimit(deps.db, "reddit", startedAt);
          if (added > 0) deps.db.logEvent("info", "reddit", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `reddit ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof RedditPaginationRestartError) {
            deps.db.setKv(checkpointKey(company.id), "");
          }
          recordDelivery({
            db: deps.db, collector: "reddit", companyId: company.id,
            requestKey, startedAt, adapterVersion: "reddit-search/1",
            result: posts.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: posts.length,
            normalizedItems: posts, error: err,
          });
          deps.health.recordReddit(false, `${company.ticker}: ${message}`);
          client = null; // force token refresh next cycle
          deps.db.logEvent("warn", "reddit", `${company.ticker}: ${message}`);
          if (err instanceof ProviderRateLimitError) {
            recordProviderRateLimit({
              db: deps.db,
              provider: "reddit",
              minDelayMs: deps.intervalSeconds * 1_000,
              retryAfterMs: err.retryAfterMs,
            });
            break;
          }
        }
        await pause(1_500);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

export function startJevRetryPoller(pipeline: Pipeline): SchedulerControl {
  return scheduleTask(() => { pipeline.drainPending(5_000); }, 15_000, { immediate: false });
}

/**
 * Company match guard with word boundaries, so "AAL" does not match "AALIANT"
 * and "Meta" does not match "metabolic". Compiled per call; watchlists are
 * small and cycles are seconds apart.
 */
export function matchesCompany(company: Company, ...texts: string[]): boolean {
  const hay = texts.join(" ");
  const words = [...company.aliases, company.name, company.ticker].map(escapeRegex);
  const re = new RegExp(`\\b(?:${words.join("|")})\\b`, "i");
  return re.test(hay);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
